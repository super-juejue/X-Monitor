/**
 * Manual refresh.
 *
 * The panel cannot fetch from X, so a refresh has to make X load a page and
 * wait for the numbers it then captures. These tests cover the tab it picks,
 * what it does with that tab afterwards, and every way it can give up.
 *
 * Runs in its own file, and runs in order: background.js is a singleton, so
 * the account has to be established by the first test and kept for the rest.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootWorker, user, viewerPayload } from './helpers/worker.mjs';

const worker = await bootWorker();
const { call, wait, tabs, calls } = worker;

/** Replace the tab strip and forget what the last test did to it. */
function stage(...urls) {
  tabs.length = 0;
  urls.forEach((url, index) => tabs.push({ id: 900 + index, url }));
  for (const log of Object.values(calls)) log.length = 0;
}

/**
 * A document id shaped like the content script's: the moment the page was
 * created, then a random tail.
 */
let docSeq = 0;
const bornAt = (ms) => `${ms}~doc${++docSeq}`;
const newDoc = () => bornAt(Date.now());

const capture = (counts, handle = 'testuser', { doc } = {}) => ({
  type: 'CAPTURE',
  op: 'Viewer',
  url: 'https://x.com/i/api/graphql/abc/Viewer',
  pageUrl: `https://x.com/${handle}`,
  doc: doc || newDoc(),
  payload: viewerPayload(user({ handle, counts })),
});

/** What a freshly loaded page reports, as the content script does it. */
const freshReport = (counts, handle = 'testuser') => capture(counts, handle, { doc: newDoc() });

test('refreshing with no account does nothing', async () => {
  stage('https://x.com/home');

  const result = await call({ type: 'REFRESH' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_ACCOUNT');
  assert.equal(calls.create.length, 0);
  assert.equal(calls.reload.length, 0);

  // Everything below needs a known account; this is where it is established.
  // The hint also registers the document that is already open, so later tests
  // can prove that its reports no longer count.
  await call({ type: 'SELF_HINT', doc: newDoc(), self: { handle: 'testuser', name: 'Test User' } });
  await wait();
});

test('the open profile tab is reloaded, not duplicated', async () => {
  stage('https://x.com/testuser');

  const pending = call({ type: 'REFRESH' });
  await wait();

  assert.deepEqual(calls.reload, [900], 'the profile tab is reloaded');
  assert.equal(calls.create.length, 0, 'no second tab is opened');

  await call(freshReport({ followers: 40, following: 248, tweets: 1284 }));
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(tabs.length, 1);
  assert.equal(calls.remove.length, 0, 'a tab the user had is never closed');
});

test('a different x.com tab is left alone; a hidden one is loaded instead', async () => {
  stage('https://x.com/home');

  const pending = call({ type: 'REFRESH' });
  await wait();

  assert.equal(calls.reload.length, 0, 'the tab the user is reading is not reloaded');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].url, 'https://x.com/testuser');
  assert.equal(calls.create[0].active, false);

  const hiddenId = calls.create[0].id;
  await call(freshReport({ followers: 41 }));
  const result = await pending;

  assert.equal(result.ok, true);
  assert.deepEqual(calls.remove, [hiddenId], 'the tab it opened is closed again');
  assert.deepEqual(tabs.map((tab) => tab.url), ['https://x.com/home']);
});

test('the numbers from a refresh replace the stored ones', async () => {
  stage('https://x.com/testuser');

  const pending = call({ type: 'REFRESH' });
  await wait();
  await call(freshReport({ followers: 40, following: 248, tweets: 1284 }));
  assert.equal((await pending).ok, true);

  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.profile.followers, 40);
  assert.equal(account.profile.tweets, 1284);
});

test('numbers read off the reloaded page also end the refresh', async () => {
  stage('https://x.com/testuser');

  const pending = call({ type: 'REFRESH' });
  await wait();

  // The DOM path reports the whole hint under "hint" and the document at the
  // top level, exactly as the content script sends it.
  await call({
    type: 'PROFILE_HINT',
    doc: newDoc(),
    hint: { handle: 'testuser', verified: true, counts: { followers: 62, following: 249 } },
  });

  const result = await pending;
  assert.equal(result.ok, true, 'the page view is enough to answer a refresh');
  assert.equal((await call({ type: 'GET_ACCOUNT' })).profile.followers, 62);
});

test('a page with no start time falls back to when it was first heard from', async () => {
  stage('https://x.com/testuser');

  const pending = call({ type: 'REFRESH' });
  await wait();

  // Older builds sent an id without a timestamp. Nothing to compare against,
  // so the first time it is seen is the best evidence available.
  await call(capture({ followers: 71, following: 250 }, 'testuser', { doc: 'legacy-page-a' }));

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal((await call({ type: 'GET_ACCOUNT' })).profile.followers, 71);
});

test('a page that was already open cannot end the refresh', async () => {
  stage('https://x.com/testuser');

  const pending = call({ type: 'REFRESH' });
  await wait();

  // The old document still had timers queued; its last report holds the very
  // numbers already on screen. Accepting it would report success without ever
  // showing anything new — even if this is the first message it ever sent.
  const bornBefore = bornAt(Date.now() - 5000);
  let settled = false;
  pending.then(() => { settled = true; });
  await call(capture({ followers: 40 }, 'testuser', { doc: bornBefore }));
  await wait(30);
  assert.equal(settled, false, 'a report from the old page is ignored');

  await call(freshReport({ followers: 51 }));
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal((await call({ type: 'GET_ACCOUNT' })).profile.followers, 51);
});

test('a refresh with no answer gives up and still closes its tab', async () => {
  stage('https://x.com/home');
  globalThis.__xmonitorRefreshTimeoutMs = 80;
  try {
    const result = await call({ type: 'REFRESH' });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'TIMEOUT');
    assert.equal(tabs.length, 1, 'no stray tab is left behind');
  } finally {
    delete globalThis.__xmonitorRefreshTimeoutMs;
  }
});

test('a second refresh while one is running is refused', async () => {
  stage('https://x.com/testuser');

  const first = call({ type: 'REFRESH' });
  await wait();

  const second = await call({ type: 'REFRESH' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'BUSY');
  assert.equal(calls.reload.length, 1, 'the second click did not reload again');

  await call(freshReport({ followers: 40 }));
  assert.equal((await first).ok, true);

  // The lock is released, so a later click works again.
  const third = call({ type: 'REFRESH' });
  await wait();
  await call(freshReport({ followers: 42 }));
  assert.equal((await third).ok, true);
});

test('counts for someone else do not satisfy the refresh', async () => {
  stage('https://x.com/testuser');
  globalThis.__xmonitorRefreshTimeoutMs = 120;
  try {
    const pending = call({ type: 'REFRESH' });
    await wait();

    await call(freshReport({ followers: 9 }, 'stranger'));

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TIMEOUT');
  } finally {
    delete globalThis.__xmonitorRefreshTimeoutMs;
  }
});
