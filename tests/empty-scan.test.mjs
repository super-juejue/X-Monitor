/**
 * An "empty" scan (no rows captured at all) must never be treated as a clean
 * end: it cannot set a baseline and it cannot remove anyone. Runs in its own
 * process because background.js is a singleton module.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootWorker } from './helpers/worker.mjs';

const worker = await bootWorker();

test('a scan that captured nobody never sets a baseline', async () => {
  await worker.call({
    type: 'SELF_HINT',
    self: { handle: 'testuser', name: 'Test User', avatar: '' },
  }, { tab: { id: 1 } });
  await worker.wait();

  const started = await worker.call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const port = worker.openSyncPort(started.tabId);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await worker.wait();

  const acct = worker.stateNow().accounts.testuser;
  assert.equal(acct.flags.followersBaselineAt, null, 'no baseline from an empty scan');
  assert.equal(acct.sync.followers.complete, false);
  assert.equal(acct.sync.followers.lastReason, 'empty_scan');
});
