/**
 * Version snapshots: every sync writes a version, and the difference between
 * two versions is what identifies unfollows.
 *
 * Covers the three questions the panel must answer:
 *   - who stopped following me
 *   - who did I stop following
 *   - what did this run actually see, when it could not finish
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootWorker,
  followersCapture,
  followersPayload,
  person,
  profile,
} from './helpers/worker.mjs';

const worker = await bootWorker();
const { call, wait, stateNow, openSyncPort } = worker;

const a = person('1', 'alpha');
const b = person('2', 'beta');
const c = person('3', 'gamma');
const d = person('4', 'delta');
const e = person('5', 'epsilon');

async function syncWith(users, { endReached = true, reason = 'end_of_list', ownerCount = 5 } = {}) {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const port = openSyncPort(started.tabId);
  await call(followersCapture(followersPayload(users, ownerCount)), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached, reason });
  await wait();
  return started;
}

test('onboarding: account exists before any sync', async () => {
  await call({ type: 'SELF_HINT', self: { handle: 'testuser', name: 'Test User', avatar: '' } }, { tab: { id: 1 } });
  await wait();
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/testuser',
    payload: { data: { user: { result: profile } } },
  }, { tab: { id: 1 } });
  await wait();

  const acct = stateNow().accounts.testuser;
  assert.ok(acct, 'account created');
  assert.deepEqual(acct.versions, [], 'no versions before the first sync');
});

test('version 1 is the baseline and lists everyone once', async () => {
  await syncWith([a, b, c], { ownerCount: 3 });

  const acct = stateNow().accounts.testuser;
  assert.equal(acct.versions.length, 1);
  const v1 = acct.versions[0];

  assert.equal(v1.n, 1, 'versions are numbered');
  assert.equal(v1.kind, 'followers');
  assert.equal(v1.baseline, true);
  assert.equal(v1.complete, true);
  assert.equal(v1.applied, true);
  assert.equal(v1.seen, 3);
  assert.equal(v1.total, 3);
  assert.equal(v1.missingCount, 0);
  assert.equal(v1.addedCount, 0, 'a baseline is not a bunch of new followers');
  assert.equal(acct.events.length, 0, 'no fabricated events');
});

test('version 2 answers "who unfollowed me" exactly', async () => {
  // gamma leaves, delta arrives.
  await syncWith([a, b, d], { ownerCount: 3 });

  const acct = stateNow().accounts.testuser;
  assert.equal(acct.versions.length, 2);
  const v2 = acct.versions[1];

  assert.equal(v2.n, 2);
  assert.equal(v2.baseline, false);
  assert.equal(v2.complete, true);
  assert.equal(v2.applied, true, 'a clean version is allowed to conclude');
  assert.equal(v2.addedCount, 1);
  assert.deepEqual(v2.added.map((p) => p.handle), ['delta']);
  assert.equal(v2.missingCount, 1);
  assert.deepEqual(v2.missing.map((p) => p.handle), ['gamma'], 'gamma is the unfollow');

  // And it is reflected in state, not just in the version.
  assert.deepEqual(Object.keys(acct.people.followers).sort(), ['1', '2', '4']);
  assert.equal(acct.people.exFollowers['3'].handle, 'gamma');
});

test('a partial version records who it saw but never concludes', async () => {
  const before = stateNow().accounts.testuser.people.followers;
  const hadIds = Object.keys(before).sort();

  // Only two rows show up and the run reports a stall while hidden.
  await syncWith([a, b], { endReached: false, reason: 'stalled' });

  const acct = stateNow().accounts.testuser;
  const v3 = acct.versions[2];

  assert.equal(v3.n, 3);
  assert.equal(v3.complete, false);
  assert.equal(v3.applied, false, 'a partial run may not conclude anything');
  assert.equal(v3.seen, 2);
  assert.equal(v3.missingCount, 1, 'it still reports who it did not see');
  assert.deepEqual(v3.missing.map((p) => p.handle), ['delta'], 'delta did not appear in this run');

  // Crucially: nobody is removed.
  assert.deepEqual(Object.keys(acct.people.followers).sort(), hadIds);
  assert.equal(acct.people.exFollowers['3'].handle, 'gamma', 'only the real earlier unfollow exists');
  assert.equal(acct.sync.followers.complete, false);
});

test('a version that captured nothing is incomplete and changes nothing', async () => {
  const before = Object.keys(stateNow().accounts.testuser.people.followers).sort();

  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  const port = openSyncPort(started.tabId);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await wait();

  const acct = stateNow().accounts.testuser;
  const v4 = acct.versions[3];

  assert.equal(v4.seen, 0);
  assert.equal(v4.applied, false);
  assert.equal(v4.reason, 'empty_scan');
  assert.equal(v4.complete, false);
  assert.deepEqual(Object.keys(acct.people.followers).sort(), before);
});

test('version history is capped and newest is exposed by the dashboard', async () => {
  const acct = stateNow().accounts.testuser;
  assert.ok(acct.versions.length <= 40, 'history is bounded');
  for (let i = 1; i < acct.versions.length; i += 1) {
    assert.ok(acct.versions[i].n > acct.versions[i - 1].n, 'versions are ordered');
  }

  const { computeDashboard } = await import('../src/lib/stats.js');
  const dash = computeDashboard(stateNow());
  assert.equal(dash.versions[0].n, acct.versions[acct.versions.length - 1].n, 'newest first in the dashboard');
  assert.equal(dash.lastVersion.n, acct.versions[acct.versions.length - 1].n);
});

test('a following sync answers "who did I stop following"', async () => {
  const following = (users) => ({
    type: 'CAPTURE',
    op: 'Following',
    url: 'https://x.com/i/api/graphql/abc/Following',
    pageUrl: 'https://x.com/testuser/following',
    status: 200,
    payload: {
      data: {
        user: {
          result: {
            ...profile,
            timeline: {
              timeline: {
                instructions: [{
                  type: 'TimelineAddEntries',
                  entries: users.map((u) => ({
                    entryId: `user-${u.rest_id}`,
                    content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: u } } },
                  })),
                }],
              },
            },
          },
        },
      },
    },
  });

  const startFollowing = async (users) => {
    const started = await call({ type: 'RUN_SYNC', kind: 'following' });
    assert.equal(started.ok, true, JSON.stringify(started));
    const port = openSyncPort(started.tabId);
    await call(following(users), { tab: { id: started.tabId } });
    await wait(80);
    port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
    await wait();
  };

  await startFollowing([a, b]);
  const afterFirst = stateNow().accounts.testuser.versions.filter((v) => v.kind === 'following');
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].baseline, true);

  await startFollowing([a]);
  const versions = stateNow().accounts.testuser.versions.filter((v) => v.kind === 'following');
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[1].missing.map((p) => p.handle), ['beta'], 'beta is the account you stopped following');
  assert.equal(versions[1].applied, true);
});
