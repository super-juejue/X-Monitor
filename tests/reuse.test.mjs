/**
 * Tab reuse: a sync must work inside the x.com tab the user already has open
 * instead of opening a second one, and it must not let that tab's pre-existing
 * rows hide a real unfollow.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootWorker,
  followersCapture,
  followersPayload,
  person,
} from './helpers/worker.mjs';

const REUSED_TAB = 1;

const worker = await bootWorker(null, { reuseTab: true });
const { call, wait, openSyncPort, reloadedTabs, removedTabs, updatedTabs } = worker;

const a = person('1', 'alpha');
const b = person('2', 'beta');
const c = person('3', 'gamma');

async function syncWith(users, { seed = null } = {}) {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.tabId, REUSED_TAB, 'sync must reuse the open tab');
  const port = openSyncPort(started.tabId);
  if (seed) port.send({ type: 'seed', sessionId: started.sessionId, docStartedAt: seed.docStartedAt, handles: seed.handles });
  await call(followersCapture(followersPayload(users, users.length)), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await wait();
  const status = await call({ type: 'GET_SYNC_STATUS' });
  return status.lastSync;
}

test('setup: account exists', async () => {
  await call({ type: 'SELF_HINT', self: { handle: 'testuser', name: 'Test User', avatar: '' } }, { tab: { id: 1 } });
  await wait();
});

test('a sync reuses the open tab, reloads it and never closes it', async () => {
  const last = await syncWith([a, b, c]);

  assert.equal(last.reusedTab, true);
  assert.ok(reloadedTabs.includes(REUSED_TAB), 'the reused tab is reloaded before scanning');
  assert.ok(!removedTabs.includes(REUSED_TAB), 'a reused tab is left alone afterwards');
  assert.ok(updatedTabs.some((entry) => entry.tabId === REUSED_TAB && entry.props.active), 'the reused tab is brought to the front');
  assert.equal(last.complete, true);
  assert.equal(last.missingCount, 0);
});

test('rows from the document that was just replaced cannot hide an unfollow', async () => {
  // The tab is reloaded, so any seed claiming "I still see gamma" comes from
  // the page that no longer exists and must be ignored.
  const last = await syncWith([a, b], { seed: { docStartedAt: 1, handles: ['gamma'] } });

  assert.equal(last.complete, true);
  assert.equal(last.missingCount, 1, 'gamma unfollowed and must be reported');
  assert.equal(last.applied, true);
});

test('rows rendered by the fresh document still count as seen', async () => {
  // gamma follows again, then disappears from the scan while the reloaded page
  // still shows the row it rendered before the scan started. Any document
  // created after the reload counts, so a far-future stamp stands in for it.
  await syncWith([a, b, c]);
  const last = await syncWith([a, b], { seed: { docStartedAt: Number.MAX_SAFE_INTEGER, handles: ['gamma'] } });

  assert.equal(last.complete, true);
  assert.equal(last.missingCount, 0, 'a row the fresh page already rendered is not an unfollow');
});
