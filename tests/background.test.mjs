/**
 * Integration tests for the service worker.
 *
 * background.js runs against a stubbed `chrome`, driven through the same
 * message / port API as the content script and side panel. This covers what the
 * pure parsers cannot: capture ingestion, baseline handling, unfollow diffing,
 * the sync lifecycle, settings and badge state.
 *
 * Tests share one worker session on purpose: they walk through the lifecycle of
 * a real account in order.
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

const alpha = person('1', 'alpha');
const beta = person('2', 'beta');
const gamma = person('3', 'gamma');
const delta = person('4', 'delta');

const worker = await bootWorker();
const { call, wait, stateNow, openSyncPort } = worker;

test('self hint creates the account and stores the profile capture', async () => {
  const hint = await call({
    type: 'SELF_HINT',
    self: { handle: 'testuser', name: 'Test User', avatar: 'https://pbs.twimg.com/a.jpg' },
  }, { tab: { id: 1 } });
  assert.equal(hint.ok, true);
  await wait();

  let state = stateNow();
  assert.equal(state.currentHandle, 'testuser');
  assert.equal(state.accounts.testuser.self.name, 'Test User');

  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/testuser',
    payload: { data: { user: { result: profile } } },
  }, { tab: { id: 1 } });
  await wait();

  state = stateNow();
  const acct = state.accounts.testuser;
  assert.equal(acct.self.verified, true);
  assert.equal(acct.profile.current.followers, 3);
  assert.equal(acct.profile.current.following, 40);
  assert.equal(acct.profile.current.tweets, 120);
  assert.equal(acct.profile.current.likes, 300);
  const today = Object.keys(acct.profile.history)[0];
  assert.equal(acct.profile.history[today].followers, 3);
});

test('first follower capture seeds people without inventing follow events', async () => {
  await call(followersCapture(followersPayload([alpha, beta])), { tab: { id: 1 } });
  await wait();

  const acct = stateNow().accounts.testuser;
  assert.equal(Object.keys(acct.people.followers).length, 2);
  assert.equal(acct.people.followers['1'].seeded, true);
  assert.equal(acct.events.length, 0);
  assert.equal(acct.flags.followersBaselineAt, null);
});

test('a full sync establishes the baseline without unfollow events', async () => {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true, JSON.stringify(started));

  const port = openSyncPort(started.tabId);
  await call(followersCapture(followersPayload([alpha, beta, gamma])), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await wait();

  const state = stateNow();
  const acct = state.accounts.testuser;
  assert.ok(acct.flags.followersBaselineAt, 'baseline should be set');
  assert.equal(acct.sync.followers.complete, true);
  assert.equal(Object.keys(acct.people.followers).length, 3);
  assert.equal(acct.events.length, 0, 'baseline must not fabricate follow events');
  assert.equal(worker.badge.text, '', 'no net change yet');
  assert.ok(worker.removedTabs.includes(started.tabId), 'sync tab is closed afterwards');
});

test('a later sync records new followers and detected unfollows', async () => {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);

  const port = openSyncPort(started.tabId);
  // gamma is gone, delta is new.
  await call(followersCapture(followersPayload([alpha, beta, delta])), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await wait();

  const acct = stateNow().accounts.testuser;
  const ids = Object.keys(acct.people.followers);
  assert.deepEqual(ids.sort(), ['1', '2', '4']);
  assert.equal(acct.people.followers['4'].seeded, false);

  const types = acct.events.map((event) => `${event.type}:${event.handle}`).sort();
  assert.deepEqual(types, ['follow:delta', 'unfollow:gamma']);

  assert.equal(acct.people.exFollowers['3'].handle, 'gamma');
  const today = Object.keys(acct.daily).sort().pop();
  assert.equal(acct.daily[today].follow, 1);
  assert.equal(acct.daily[today].unfollow, 1);
  assert.equal(worker.badge.text, '', 'net is zero');
});

test('an incomplete sync keeps the list and reports failure', async () => {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);

  const port = openSyncPort(started.tabId);
  await call(followersCapture(followersPayload([alpha])), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached: false, reason: 'timeout' });
  await wait();

  const state = stateNow();
  const acct = state.accounts.testuser;
  assert.equal(acct.sync.followers.complete, false);
  assert.equal(acct.sync.followers.lastReason, 'timeout');
  assert.equal(Object.keys(acct.people.followers).length, 3, 'nothing is removed');
  assert.equal(acct.people.exFollowers['3'].handle, 'gamma', 'only the real unfollow is recorded');
});

test('settings are sanitized before they are stored', async () => {
  await call({ type: 'UPDATE_SETTINGS', settings: { syncMinutes: 999, theme: 'neon', badge: false } });
  await wait();

  const settings = stateNow().settings;
  assert.equal(settings.syncMinutes, 30);
  assert.equal(settings.theme, 'system');
  assert.equal(settings.badge, false);
  assert.equal(worker.badge.text, '', 'badge is cleared when disabled');
});

test('unknown accounts are ignored once an account exists', async () => {
  const before = stateNow().accounts.testuser.self.handle;
  await call({
    type: 'CAPTURE',
    op: 'UserByScreenName',
    url: 'https://x.com/stranger',
    payload: {
      data: {
        user: {
          result: { ...profile, core: { screen_name: 'stranger', name: 'Stranger' }, rest_id: '99' },
        },
      },
    },
  }, { tab: { id: 1 } });
  await wait();

  const state = stateNow();
  assert.equal(state.accounts.stranger, undefined);
  assert.equal(state.currentHandle, 'testuser');
  assert.equal(state.accounts.testuser.self.handle, before);
});

test('tweets are captured from the GraphQL api url', async () => {
  const tweet = {
    __typename: 'Tweet',
    rest_id: '9001',
    core: {
      user_results: { result: { ...profile } },
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    },
    legacy: {
      full_text: 'a real post',
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 2,
      quote_count: 1,
    },
    views: { count: '456' },
  };
  const payload = {
    data: {
      user: {
        result: {
          ...profile,
          timeline: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: [{
                  entryId: 'tweet-9001',
                  content: {
                    entryType: 'TimelineTimelineItem',
                    itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweet } },
                  },
                }],
              }],
            },
          },
        },
      },
    },
  };

  // The api url has no handle in it; only the page url does.
  await call({
    type: 'CAPTURE',
    op: 'UserTweets',
    url: 'https://x.com/i/api/graphql/abc123/UserTweets?variables=%7B%7D',
    pageUrl: 'https://x.com/testuser',
    status: 200,
    payload,
  }, { tab: { id: 1 } });
  await wait();

  const acct = stateNow().accounts.testuser;
  assert.deepEqual(Object.keys(acct.tweets), ['9001']);
  assert.equal(acct.tweets['9001'].text, 'a real post');
  assert.equal(acct.tweets['9001'].likes, 12);
  assert.equal(acct.tweets['9001'].views, 456);
  assert.equal(acct.tweets['9001'].url, 'https://x.com/testuser/status/9001');
});

test('the badge shows the signed daily net change', async () => {
  await call({ type: 'UPDATE_SETTINGS', settings: { badge: true } });
  await wait();

  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);
  const port = openSyncPort(started.tabId);
  const users = [alpha, beta, delta, person('5', 'epsilon')];
  await call(followersCapture(followersPayload(users)), { tab: { id: started.tabId } });
  await wait(80);
  port.send({ type: 'finish', endReached: true, reason: 'end_of_list' });
  await wait(900);

  assert.equal(worker.badge.text, '+1');
  assert.equal(worker.badge.color, '#10B981');
});

test('a 429 response stops the sync as rate limited', async () => {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);
  const port = openSyncPort(started.tabId);
  await call(followersCapture(followersPayload([alpha, beta, delta])), { tab: { id: started.tabId } });
  await wait(80);

  await call({
    type: 'CAPTURE',
    op: 'Followers',
    url: 'https://x.com/testuser/followers',
    status: 429,
    payload: null,
  }, { tab: { id: started.tabId } });
  await wait(300);

  const status = await call({ type: 'GET_SYNC_STATUS' });
  assert.equal(status.status, null, 'sync is finished');
  assert.equal(status.lastSync.reason, 'rate_limited');
  assert.equal(status.lastSync.complete, false);

  const acct = stateNow().accounts.testuser;
  assert.equal(acct.sync.followers.lastReason, 'rate_limited');
  assert.equal(acct.sync.followers.complete, false);
  assert.ok(Object.keys(acct.people.followers).length >= 4, 'captured data survives');
});

test('cancelling a sync keeps captured data and marks it incomplete', async () => {
  const started = await call({ type: 'RUN_SYNC', kind: 'followers' });
  assert.equal(started.ok, true);
  openSyncPort(started.tabId);
  await call(followersCapture(followersPayload([alpha, beta])), { tab: { id: started.tabId } });
  await wait(80);

  const cancel = await call({ type: 'CANCEL_SYNC' });
  assert.equal(cancel.ok, true);
  await wait(200);

  const acct = stateNow().accounts.testuser;
  assert.equal(acct.sync.followers.lastReason, 'cancelled');
  assert.equal(acct.sync.followers.complete, false);
  assert.equal(Object.keys(acct.people.followers).length, 4, 'captured people remain');
});
