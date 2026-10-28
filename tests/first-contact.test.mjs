/**
 * First contact with X.
 *
 * This runs in its own file because background.js is a singleton: a fresh
 * process is the only way to test "nothing is known yet". The rule under test
 * is that a bare profile page never identifies the logged-in account —
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

test('an unverified profile hint cannot create an account', async () => {
  const result = await call({
    type: 'PROFILE_HINT',
    hint: { handle: 'someone', verified: false, counts: { followers: 1, following: 2 } },
  });
  await wait();

  assert.equal(result.ok, true, 'the message itself is well formed');
  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self, null, 'without proof this is your profile, nothing is stored');
});

test('a verified profile hint bootstraps the account with its numbers', async () => {
  // The content script only marks a hint verified after seeing the edit-profile
  // button, which exists solely on your own profile.
  await call({
    type: 'PROFILE_HINT',
    hint: { handle: 'me', verified: true, counts: { followers: 10, following: 20, tweets: 30 } },
  });
  await wait();

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.self.handle, 'me');
  assert.equal(account.profile.followers, 10);
  assert.equal(account.profile.tweets, 30);
});

test('the Viewer query takes over identity when it arrives', async () => {
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
  assert.equal(account.profile.handle, 'testuser', 'counts follow the identity');
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
