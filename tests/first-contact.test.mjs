/**
 * First contact with X.
 *
 * This runs in its own file because background.js is a singleton: a fresh
 * process is the only way to test "nothing is known yet". The rule under test
 * is that a profile page alone never identifies the logged-in account —
 * otherwise the first stranger's profile you open becomes "you".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootWorker,
  screenNamePayload,
  user,
  viewerPayload,
} from './helpers/worker.mjs';

const worker = await bootWorker();
const { call, wait } = worker;

test('a stranger\'s profile is not mistaken for the logged-in account', async () => {
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/i/api/graphql/abc/UserByScreenName',
    pageUrl: 'https://x.com/stranger',
    payload: screenNamePayload(user({ id: '77', handle: 'stranger', counts: { followers: 5, following: 6, tweets: 7 } })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self, null);
  assert.equal(account.profile, null);
});

test('the Viewer query is authoritative on first contact', async () => {
  await call({
    type: 'CAPTURE',
    op: 'Viewer',
    url: 'https://x.com/i/api/graphql/abc/Viewer',
    payload: viewerPayload(user({ counts: { followers: 1200, following: 248, tweets: 1284 } })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'testuser');
  assert.equal(account.profile.followers, 1200);
});

test('after that, only your own profile updates the numbers', async () => {
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/i/api/graphql/abc/UserByScreenName',
    pageUrl: 'https://x.com/stranger',
    payload: screenNamePayload(user({ id: '77', handle: 'stranger', counts: { followers: 5, following: 6, tweets: 7 } })),
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'testuser');
  assert.equal(account.profile.followers, 1200);
});
