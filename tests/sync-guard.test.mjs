/**
 * Regression test for the "partial scan" guard: when a supposedly complete
 * scan suddenly misses a large slice of the tracked list, the worker must keep
 * the data instead of reporting a mass unfollow.
 *
 * The store is seeded before the worker boots, so the list is already large
 * when the first sync runs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STORAGE_KEY,
  bootWorker,
  followersCapture,
  followersPayload,
  person,
} from './helpers/worker.mjs';

const PEOPLE = 250;
const now = Date.now();

function seed() {
  const people = {};
  for (let i = 10; i < 10 + PEOPLE; i += 1) {
    people[String(i)] = {
      id: String(i),
      handle: `u${i}`,
      name: `U${i}`,
      firstSeen: now - 10 * 86_400_000,
      lastSeen: now - 86_400_000,
      seeded: true,
    };
  }
  return {
    version: 1,
    currentHandle: 'testuser',
    accounts: {
      testuser: {
        self: { id: '42', handle: 'testuser', name: 'Test User', avatar: '', verified: true, createdAt: null },
        profile: { current: { followers: PEOPLE, ts: now }, history: { } },
        people: { followers: people, following: {}, exFollowers: {}, exFollowing: {} },
        events: [],
        tweets: {},
        daily: {},
        flags: { followersBaselineAt: now - 30 * 86_400_000, followingBaselineAt: null },
        sync: {},
        createdAt: now - 30 * 86_400_000,
        updatedAt: now,
      },
    },
    settings: {},
    meta: { createdAt: now, updatedAt: now, lastCaptureAt: null, lastDigestAt: 0 },
  };
}

const worker = await bootWorker(seed());

test('a scan that loses a large part of the list is not trusted', async () => {
  const started = await worker.call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true, JSON.stringify(started));

  const port = worker.openSyncPort(started.tabId);
  // Only two of 250 followers show up: clearly a broken scan.
  await worker.call(
    followersCapture(followersPayload([person('1', 'alpha'), person('2', 'beta')], PEOPLE)),
    { tab: { id: started.tabId } },
  );
  await worker.wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'stalled' });
  await worker.wait();

  const acct = worker.stateNow().accounts.testuser;
  // The two captured people are new, so they are added; nobody is removed.
  assert.equal(Object.keys(acct.people.followers).length, PEOPLE + 2, 'list is preserved');
  assert.equal(Object.keys(acct.people.exFollowers).length, 0, 'nobody is marked as unfollowed');
  assert.equal(acct.sync.followers.complete, false, 'scan is reported as incomplete');
  assert.equal(acct.sync.followers.lastReason, 'partial');

  const state = worker.stateNow();
  assert.equal(state.currentHandle, 'testuser');
  assert.equal(worker.store[STORAGE_KEY].accounts.testuser.flags.followersBaselineAt,
    now - 30 * 86_400_000, 'the original baseline is kept');
});

test('a normal complete scan still removes real unfollows', async () => {
  const started = await worker.call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);

  const port = worker.openSyncPort(started.tabId);
  const users = Object.values(worker.stateNow().accounts.testuser.people.followers)
    .slice(1)
    .map((entry) => person(entry.id, entry.handle));
  await worker.call(followersCapture(followersPayload(users, PEOPLE)), { tab: { id: started.tabId } });
  await worker.wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await worker.wait();

  const acct = worker.stateNow().accounts.testuser;
  assert.equal(Object.keys(acct.people.followers).length, PEOPLE + 1);
  assert.equal(Object.keys(acct.people.exFollowers).length, 1);
  assert.equal(acct.events.filter((event) => event.type === 'unfollow').length, 1);
  assert.equal(acct.sync.followers.complete, true);
});
