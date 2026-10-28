/**
 * Follower capture, end to end in the worker.
 *
 * The rules under test are the ones that keep a comparison honest: a capture
 * that did not reach the end is thrown away, a capture for another account is
 * ignored, and the tab opened for the job is always closed.
 *
 * Runs in its own file, and in order: background.js is a singleton.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootWorker, screenNamePayload, user, viewerPayload } from './helpers/worker.mjs';

const worker = await bootWorker();
const { call, wait, tabs, calls, tabMessages } = worker;

const person = (id, handle) => ({ id: String(id), handle, name: handle.toUpperCase() });

function stage(...urls) {
  tabs.length = 0;
  urls.forEach((url, index) => tabs.push({ id: 900 + index, url }));
  for (const log of Object.values(calls)) log.length = 0;
  tabMessages.length = 0;
}

// The worker asks the tab to start; the content script answers, then reports.
const ack = (_id, message) => ({ ok: true, doc: `${message.since}~${message.captureId}` });
worker.answerTabs(ack);

/** Pretend the content script finished reading the list. */
const report = (entries, { reachedEnd = true, handle = 'testuser', expected = 3, pages = 1, ...overrides } = {}, sender = {}) => {
  const active = tabMessages.at(-1);
  const url = `https://x.com/${active.message.handle}/followers`;
  return call({
    type: 'FOLLOWERS_RESULT',
    handle,
    entries,
    reachedEnd,
    expected,
    pages,
    captureId: active.message.captureId,
    doc: `${active.message.since}~${active.message.captureId}`,
    ...overrides,
  }, { tab: { id: active.id, url }, url, frameId: 0, ...sender });
};

test('a capture with no account is refused', async () => {
  stage('https://x.com/home');
  const result = await call({ type: 'COLLECT_FOLLOWERS' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_ACCOUNT');
  assert.equal(calls.create.length, 0);
});

test('the first capture is stored without a comparison', async () => {
  // Establish the account and its count, which the capture is checked against.
  await call({
    type: 'CAPTURE',
    op: 'Viewer',
    url: 'https://x.com/i/api/graphql/abc/Viewer',
    payload: viewerPayload(user({ handle: 'testuser', counts: { followers: 3 } })),
  });
  await wait();
  stage('https://x.com/home');

  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].url, 'https://x.com/testuser/followers');
  assert.equal(calls.create[0].active, false, 'the list is read in a hidden tab');
  assert.equal(tabMessages[0].message.type, 'FOLLOWERS_COLLECT');
  assert.equal(tabMessages[0].message.handle, 'testuser');

  await report([person(1, 'a'), person(2, 'b'), person(3, 'c')]);
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(result.first, true);
  assert.equal(worker.followersNow().total, 3);
  assert.equal(calls.remove.length, 1, 'the hidden tab is closed again');
});

test('the next capture reports exactly who left', async () => {
  stage('https://x.com/home');

  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.first, false);
  assert.equal(result.unfollowed, 1);
  assert.equal(result.followed, 1);

  const stored = worker.followersNow();
  assert.deepEqual(stored.diff.unfollowed.map((e) => e.handle), ['b']);
  assert.deepEqual(stored.diff.followed.map((e) => e.handle), ['d']);
  assert.deepEqual(stored.previous.entries.map((e) => e.handle), ['a', 'b', 'c']);
  assert.equal(stored.previous.previous, undefined, 'retention is bounded to two snapshots');

  // What the panel is allowed to see: the summary, never the whole list.
  const account = await call({ type: 'GET_ACCOUNT' });
  assert.ok(account.followers);
  assert.equal(account.followers.total, 3);
  assert.ok(account.followers.ts > 0);
  assert.equal(account.followers.entries, undefined, 'the full list is not shipped to the panel');
  assert.deepEqual(account.followers.diff.unfollowed.map((e) => e.handle), ['b']);
});

test('a capture that stopped before the end is thrown away', async () => {
  const before = worker.followersNow();

  stage('https://x.com/home');
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  // The real failure: X served one page and stopped, so most people are missing.
  await report([person(1, 'a')], { reachedEnd: false });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'INCOMPLETE');
  assert.equal(result.captured, 1);
  assert.equal(result.expected, 3);
  assert.deepEqual(worker.followersNow(), before, 'the previous snapshot is untouched');
  assert.equal(calls.remove.length, 1, 'the tab is closed even when it fails');
});

test('a capture well short of the counter is thrown away even if it claims the end', async () => {
  const before = worker.followersNow();

  stage('https://x.com/home');
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a')], { reachedEnd: true });
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.error, 'INCOMPLETE');
  assert.deepEqual(worker.followersNow(), before);
});

test('a report for another account cannot become your snapshot', async () => {
  globalThis.__xmonitorCollectTimeoutMs = 150;
  try {
    const before = worker.followersNow();

    stage('https://x.com/home');
    const pending = call({ type: 'COLLECT_FOLLOWERS' });
    await wait();
    await report([person(7, 'stranger')], { handle: 'stranger' });

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TIMEOUT');
    assert.deepEqual(worker.followersNow(), before);
  } finally {
    delete globalThis.__xmonitorCollectTimeoutMs;
  }
});

test('an already open followers tab stays untouched while a fresh list is captured', async () => {
  stage('https://x.com/testuser/followers');

  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();

  assert.equal(calls.create.length, 1, 'a fresh document cannot contain cached pages');
  assert.equal(calls.reload.length, 0, 'the page the user has is not reloaded');
  assert.notEqual(tabMessages[0].id, 900);

  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(calls.remove.length, 1, 'only the created tab is closed');
  assert.ok(tabs.some((tab) => tab.id === 900), 'the user tab is still there');
});

test('a second capture while one is running is refused', async () => {
  stage('https://x.com/home');

  const first = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  const second = await call({ type: 'COLLECT_FOLLOWERS' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'BUSY');

  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  assert.equal((await first).ok, true);
});

test('the panel is told what the snapshot contains, not who it knows', async () => {
  const account = await call({ type: 'GET_ACCOUNT' });

  assert.ok(account.followers);
  assert.equal(account.followers.total, 3);
  assert.equal(account.followers.entries, undefined);
  assert.equal(typeof account.followers.diff.followedCount, 'number');
});

test('a broken report does not overwrite a good snapshot', async () => {
  const before = worker.followersNow();

  stage('https://x.com/home');
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([{ handle: 'not a handle' }, null, 'text'], { reachedEnd: true });

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INCOMPLETE', 'junk is rejected instead of stored');
  assert.deepEqual(worker.followersNow(), before);
});

test('a capture that brings back nobody is refused, not stored as a wipe', async () => {
  const before = worker.followersNow();

  stage('https://x.com/home');
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([], { reachedEnd: true });

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INCOMPLETE');
  assert.deepEqual(worker.followersNow(), before, 'everyone would have looked like an unfollower');
});

test('the counter from the fresh capture replaces the old profile counter', async () => {
  stage('https://x.com/home');
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c')], { expected: 2 });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.unfollowed, 1);
  assert.equal(worker.followersNow().expected, 2);
});

test('a real zero-follower snapshot is saved when the fresh counter is zero', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([], { expected: 0 });
  assert.equal((await pending).ok, true);
  assert.equal(worker.followersNow().total, 0);
  assert.equal(worker.followersNow().diff.unfollowedCount, 2);
  const account = await call({ type: 'GET_ACCOUNT' });
  assert.equal(account.followers.total, 0, 'zero is still a saved snapshot');
});

test('a timeline-only follower response is verified against a fresh profile tab', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')], { expected: null });
  await wait(10);
  assert.equal(calls.create.length, 2, 'read a fresh counter, not an old cached profile');
  const counterTab = calls.create[1];
  assert.equal(counterTab.url, 'https://x.com/testuser');
  const doc = `${Date.now()}~counter`;
  await call({
    type: 'PROFILE_HINT', doc,
    hint: { handle: 'testuser', counts: { followers: 3 }, followersExact: true },
  }, { tab: { id: counterTab.id }, url: counterTab.url, frameId: 0 });
  assert.equal((await pending).ok, true);
  assert.equal(worker.followersNow().total, 3);
  assert.equal(calls.remove.length, 2, 'both temporary tabs are closed');
});

test('a fresh API count verifies a timeline-only capture after the total changed', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c')], { expected: null });
  await wait(5);
  const counterTab = calls.create[1];
  assert.equal((await call({ type: 'GET_ACCOUNT' })).capture.stage, 'verifying');
  await call({
    type: 'CAPTURE', op: 'UserByScreenName', doc: `${Date.now()}~new-counter`,
    payload: screenNamePayload(user({ counts: { followers: 2 } })),
  }, { tab: { id: counterTab.id }, url: counterTab.url, frameId: 0 });
  assert.equal((await pending).ok, true);
  assert.equal(worker.followersNow().expected, 2);
});

test('a profile counter arriving before tab creation resolves is not lost', async () => {
  globalThis.__xmonitorCounterTimeoutMs = 80;
  worker.whenCreatingTabs(async (tab) => {
    if (tab.url !== 'https://x.com/testuser') return;
    await call({
      type: 'CAPTURE', op: 'UserByScreenName', doc: `${Date.now()}~early-counter`,
      payload: screenNamePayload(user({ counts: { followers: 2 } })),
    }, { tab: { id: tab.id }, url: tab.url, frameId: 0 });
  });
  try {
    stage();
    const pending = call({ type: 'COLLECT_FOLLOWERS' });
    await wait();
    await report([person(1, 'a'), person(3, 'c')], { expected: null });
    assert.equal((await pending).ok, true);
    assert.equal(calls.remove.length, 2);
  } finally {
    worker.whenCreatingTabs();
    delete globalThis.__xmonitorCounterTimeoutMs;
  }
});

test('rounded labels, old documents and unrelated tabs cannot verify a missing counter', async () => {
  globalThis.__xmonitorCounterTimeoutMs = 40;
  try {
    for (const mode of ['rounded', 'old-document', 'other-tab', 'subframe']) {
      const before = worker.followersNow();
      stage();
      const pending = call({ type: 'COLLECT_FOLLOWERS' });
      await wait();
      await report([person(1, 'a'), person(3, 'c')], { expected: null });
      await wait(5);
      const counterTab = calls.create[1];
      await call({
        type: 'PROFILE_HINT',
        doc: mode === 'old-document' ? '1000000000000~old' : `${Date.now()}~counter`,
        hint: { handle: 'testuser', counts: { followers: 2 }, followersExact: mode !== 'rounded' },
      }, {
        tab: { id: mode === 'other-tab' ? -1 : counterTab.id },
        url: counterTab.url,
        frameId: mode === 'subframe' ? 1 : 0,
      });
      assert.equal((await pending).error, 'NO_COUNT', mode);
      assert.deepEqual(worker.followersNow(), before);
      assert.equal(calls.remove.length, 2, 'failure still closes both temporary tabs');
    }
  } finally {
    delete globalThis.__xmonitorCounterTimeoutMs;
  }
});

test('zero followers can be verified using the separate profile counter too', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([], { expected: null });
  await wait(5);
  const counterTab = calls.create[1];
  await call({
    type: 'PROFILE_HINT', doc: `${Date.now()}~zero`,
    hint: { handle: 'testuser', counts: { followers: 0 }, followersExact: true },
  }, { tab: { id: counterTab.id }, url: counterTab.url });
  assert.equal((await pending).ok, true);
  assert.equal(worker.followersNow().total, 0);
});

test('missing initial pages have their own error and cannot create an empty snapshot', async () => {
  const before = worker.followersNow();
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([], { expected: null, reachedEnd: false, pages: 0, reason: 'NO_PAGES' });
  assert.equal((await pending).error, 'NO_PAGES');
  assert.deepEqual(worker.followersNow(), before);
  assert.equal(calls.create.length, 1, 'no counter tab for an unread list');
});

test('another tab, frame, capture or old document cannot report a result', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  const entries = [person(1, 'a'), person(3, 'c'), person(4, 'd')];
  assert.equal((await report(entries, {}, { tab: { id: -1 } })).ok, false);
  assert.equal((await report(entries, {}, { frameId: 1 })).ok, false);
  assert.equal((await report(entries, { captureId: 'old-run' })).ok, false);
  assert.equal((await report(entries, { doc: '1000000000000~old' })).ok, false);
  assert.equal((await report(entries, {}, { url: 'https://x.com/stranger/followers' })).ok, false);
  await report(entries);
  assert.equal((await pending).ok, true);
});

test('a storage failure preserves both the stored snapshot and the worker cache', async () => {
  const before = structuredClone(worker.followersNow());
  worker.failFollowerWrites(new Error('QUOTA_BYTES'));
  try {
    stage();
    const pending = call({ type: 'COLLECT_FOLLOWERS' });
    await wait();
    await report([person(8, 'new')], { expected: 1 });
    assert.equal((await pending).error, 'STORAGE');
    assert.deepEqual(worker.followersNow(), before);
    const account = await call({ type: 'GET_ACCOUNT' });
    assert.equal(account.followers.total, before.total);
    assert.deepEqual(account.followers.diff, before.diff);
  } finally {
    worker.failFollowerWrites();
  }
});

test('the capture stays locked until storage finishes', async () => {
  let release;
  worker.holdFollowerWrites(new Promise((resolve) => { release = resolve; }));
  try {
    stage();
    const pending = call({ type: 'COLLECT_FOLLOWERS' });
    await wait();
    await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
    await wait(10);
    assert.equal((await call({ type: 'COLLECT_FOLLOWERS' })).error, 'BUSY');
    release();
    assert.equal((await pending).ok, true);
  } finally {
    release();
    worker.holdFollowerWrites();
  }
});

test('start-message retries keep the same capture id', async () => {
  let attempts = 0;
  globalThis.__xmonitorAskDelayMs = 1;
  worker.answerTabs((id, message) => {
    attempts += 1;
    if (attempts < 3) throw new Error('Listener not ready');
    return ack(id, message);
  });
  try {
    stage();
    const pending = call({ type: 'COLLECT_FOLLOWERS' });
    await wait();
    assert.equal(attempts, 3);
    assert.equal(new Set(tabMessages.map((m) => m.message.captureId)).size, 1);
    await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
    assert.equal((await pending).ok, true);
  } finally {
    delete globalThis.__xmonitorAskDelayMs;
    worker.answerTabs(ack);
  }
});

test('a hung start acknowledgement still times out and closes the created tab', async () => {
  globalThis.__xmonitorCollectTimeoutMs = 80;
  worker.answerTabs(() => new Promise(() => {}));
  try {
    stage();
    assert.equal((await call({ type: 'COLLECT_FOLLOWERS' })).error, 'TIMEOUT');
    assert.equal(calls.remove.length, 1);
  } finally {
    delete globalThis.__xmonitorCollectTimeoutMs;
    worker.answerTabs(ack);
  }
});

test('profile counts from the capture document can verify a list without owner counts', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  const active = tabMessages.at(-1);
  await call({
    type: 'CAPTURE', op: 'UserByScreenName',
    payload: screenNamePayload(user({ counts: { followers: 3 } })),
    doc: `${active.message.since}~${active.message.captureId}`,
  }, { tab: { id: active.id } });
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')], { expected: null });
  assert.equal((await pending).ok, true);
});

test('conflicting fresh counters refuse the capture instead of choosing one', async () => {
  const before = worker.followersNow();
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  const active = tabMessages.at(-1);
  await call({
    type: 'CAPTURE', op: 'UserByScreenName',
    payload: screenNamePayload(user({ counts: { followers: 2 } })),
    doc: `${active.message.since}~${active.message.captureId}`,
  }, { tab: { id: active.id } });
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  assert.equal((await pending).error, 'COUNT_CHANGED');
  assert.deepEqual(worker.followersNow(), before);
});

test('progress survives a panel reopen and refresh cannot interrupt a capture', async () => {
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  const active = tabMessages.at(-1);
  const progress = {
    type: 'FOLLOWERS_PROGRESS', handle: 'testuser', captured: 2,
    captureId: active.message.captureId,
    doc: `${active.message.since}~${active.message.captureId}`,
  };
  const sender = { tab: { id: active.id }, url: 'https://x.com/testuser/followers' };
  assert.equal((await call({ ...progress, captureId: 'old' }, sender)).ok, false);
  assert.equal((await call(progress, sender)).ok, true);
  assert.equal((await call({ type: 'GET_ACCOUNT' })).capture.captured, 2);
  assert.equal((await call({ type: 'REFRESH' })).error, 'BUSY');
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  assert.equal((await pending).ok, true);
  assert.equal((await call({ type: 'GET_ACCOUNT' })).capture, null);
});

test('the request owner must match the profile account id before saving', async () => {
  const before = worker.followersNow();
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')], { ownerId: '999' });
  assert.equal((await pending).error, 'IDENTITY');
  assert.deepEqual(worker.followersNow(), before);
});

test('a different account reusing the same handle gets its own baseline', async () => {
  assert.equal(worker.followersNow().accountId, '42');
  await call({
    type: 'CAPTURE', op: 'Viewer',
    payload: viewerPayload(user({ id: '99', counts: { followers: 3 } })),
  });
  assert.equal((await call({ type: 'GET_ACCOUNT' })).followers, null);
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  assert.equal((await pending).first, true);
  assert.equal(worker.followersNow().accountId, '99');
  assert.equal(worker.followersNow().diff, null);
  assert.equal(worker.followersNow().previous, null);
});

test('an account switch while reading does not overwrite the previous snapshot', async () => {
  const before = worker.followersNow();
  stage();
  const pending = call({ type: 'COLLECT_FOLLOWERS' });
  await wait();
  await call({ type: 'SELF_HINT', self: { handle: 'another' } });
  await report([person(1, 'a'), person(3, 'c'), person(4, 'd')]);
  assert.equal((await pending).error, 'ACCOUNT_CHANGED');
  assert.deepEqual(worker.followersNow(), before);
  assert.equal((await call({ type: 'GET_ACCOUNT' })).followers, null);
});
