/**
 * Service worker behaviour: it must remember who is logged in, keep their
 * numbers, and never let another account's profile overwrite them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STORAGE_KEY,
  bootWorker,
  screenNamePayload,
  user,
  viewerPayload,
} from './helpers/worker.mjs';

const worker = await bootWorker({ store: { xmonitor_state: { accounts: { old: {} } } } });
const { call, wait, stateNow } = worker;

test('bootstrap drops the removed implementation\'s snapshot', async () => {
  await wait(80);
  assert.equal(worker.store.xmonitor_state, undefined);
});

test('nothing is known before X is opened', async () => {
  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.ok, true);
  assert.equal(account.self, null);
  assert.equal(account.profile, null);
});

test('the self hint records the account without any numbers yet', async () => {
  await call({
    type: 'SELF_HINT',
    self: { handle: 'testuser', name: 'Test User', avatar: 'https://pbs.twimg.com/a_normal.jpg' },
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'testuser');
  assert.equal(account.self.name, 'Test User');
  assert.equal(account.profile, null);
  assert.equal(stateNow().self.handle, 'testuser');
});

test('a Viewer capture attaches the profile numbers', async () => {
  await call({
    type: 'CAPTURE',
    op: 'Viewer',
    url: 'https://x.com/i/api/graphql/abc/Viewer',
    payload: viewerPayload(user({
      counts: { followers: 1200, following: 248, tweets: 1284, likes: 5821, media: 96, listed: 12 },
    })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.profile.handle, 'testuser');
  assert.equal(account.profile.followers, 1200);
  assert.equal(account.profile.following, 248);
  assert.equal(account.profile.tweets, 1284);
  assert.equal(account.profile.likes, 5821);
  assert.ok(account.profile.ts > 0);
  assert.equal(account.self.verified, true);
  assert.match(account.self.avatar, /x_normal\.jpg$/);
});

test('somebody else\'s profile page is ignored', async () => {
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/i/api/graphql/abc/UserByScreenName',
    pageUrl: 'https://x.com/stranger',
    payload: screenNamePayload(user({ id: '99', handle: 'stranger', counts: { followers: 7, following: 7, tweets: 7 } })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'testuser', 'the account must not be replaced');
  assert.equal(account.profile.followers, 1200, 'the numbers must not be replaced');
});

test('your own profile refreshes the numbers', async () => {
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/i/api/graphql/abc/UserByScreenName',
    pageUrl: 'https://x.com/testuser',
    payload: screenNamePayload(user({ counts: { followers: 1311, following: 250, tweets: 1290 } })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.profile.followers, 1311);
  assert.equal(account.profile.following, 250);
  assert.equal(account.profile.tweets, 1290);
});

test('switching accounts drops the previous numbers', async () => {
  await call({ type: 'SELF_HINT', self: { handle: 'otheruser', name: 'Other' } });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'otheruser');
  assert.equal(account.profile, null, 'counts must not carry over to another account');
});

test('malformed hints and captures are ignored', async () => {
  assert.deepEqual(await call({ type: 'SELF_HINT', self: { handle: 'not a handle!' } }), { ok: false });
  await call({ type: 'CAPTURE', op: 'Viewer', payload: null });
  await call({ type: 'CAPTURE', op: 'Viewer', payload: { data: {} } });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'otheruser');
  assert.ok(worker.store[STORAGE_KEY], 'state stays writable');
});
