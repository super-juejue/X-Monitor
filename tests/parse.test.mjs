import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractTimeline,
  findOwner,
  findViewerUser,
  handleFromUrl,
  normalizeTweet,
  normalizeUser,
  opFromUrl,
} from '../src/lib/parse.js';
import { computeBadge, computeDashboard } from '../src/lib/stats.js';
import { ensureAccount, hydrateState } from '../src/lib/constants.js';
import { dayKey, daysBack, parseTwitterDate } from '../src/lib/time.js';

const userA = {
  __typename: 'User',
  rest_id: '123',
  core: {
    created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    name: '测试用户',
    screen_name: 'TestUser',
  },
  avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
  legacy: {
    followers_count: 12345,
    friends_count: 321,
    statuses_count: 999,
    favourites_count: 4567,
    media_count: 88,
    listed_count: 7,
    verified: false,
    protected: false,
  },
  is_blue_verified: true,
};

const userB = {
  __typename: 'User',
  rest_id: '456',
  legacy: {
    screen_name: 'second',
    name: 'Second User',
    followers_count: 10,
    friends_count: 20,
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/b_normal.jpg',
  },
};

function followersRoot() {
  return {
    user: {
      result: {
        __typename: 'User',
        rest_id: '123',
        core: { screen_name: 'TestUser', name: '测试用户' },
        legacy: { followers_count: 2, friends_count: 3 },
        timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'user-123',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: { itemType: 'TimelineUser', user_results: { result: userA } },
                    },
                  },
                  {
                    entryId: 'user-456',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: { itemType: 'TimelineUser', user_results: { result: userB } },
                    },
                  },
                  {
                    entryId: 'cursor-bottom-abc',
                    content: {
                      entryType: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: 'cursor-value',
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

function tweetsRoot() {
  const tweet = {
    __typename: 'Tweet',
    rest_id: '999',
    core: {
      user_results: { result: userA },
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    },
    legacy: {
      full_text: 'hello world',
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
      favorite_count: 10,
      retweet_count: 2,
      reply_count: 1,
      quote_count: 3,
      lang: 'en',
      entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/x.jpg' }] },
    },
    views: { count: '1234' },
  };
  return {
    user: { result: { __typename: 'User', rest_id: '123', core: { screen_name: 'TestUser' } } },
    timeline: {
      timeline: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: 'tweet-999',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    itemType: 'TimelineTweet',
                    tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet } },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

test('normalizeUser supports the new core/avatar schema', () => {
  const user = normalizeUser(userA);
  assert.equal(user.handle, 'TestUser');
  assert.equal(user.name, '测试用户');
  assert.equal(user.followers, 12345);
  assert.equal(user.following, 321);
  assert.equal(user.tweets, 999);
  assert.equal(user.likes, 4567);
  assert.equal(user.media, 88);
  assert.equal(user.verified, true);
  assert.equal(user.createdAt, Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.match(user.avatar, /^https:\/\/pbs\.twimg\.com/);
});

test('normalizeUser supports the legacy-only schema', () => {
  const user = normalizeUser(userB);
  assert.equal(user.handle, 'second');
  assert.equal(user.name, 'Second User');
  assert.equal(user.followers, 10);
  assert.equal(user.following, 20);
  assert.match(user.avatar, /b_normal/);
});

test('extractTimeline pulls users, cursors and owner', () => {
  const root = followersRoot();
  const result = extractTimeline(root);
  assert.equal(result.users.length, 2);
  assert.equal(result.users[0].handle, 'TestUser');
  assert.equal(result.users[1].handle, 'second');
  assert.equal(result.bottomCursor, 'cursor-value');
  assert.equal(findOwner(root).handle, 'TestUser');
});

test('extractTimeline pulls tweets and normalizes wrapped tweets', () => {
  const result = extractTimeline(tweetsRoot());
  assert.equal(result.tweets.length, 1);
  const tweet = result.tweets[0];
  assert.equal(tweet.id, '999');
  assert.equal(tweet.text, 'hello world');
  assert.equal(tweet.authorHandle, 'TestUser');
  assert.equal(tweet.likes, 10);
  assert.equal(tweet.retweets, 2);
  assert.equal(tweet.quotes, 3);
  assert.equal(tweet.views, 1234);
  assert.equal(tweet.createdAt, Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.match(tweet.media, /media\/x\.jpg/);
});

test('long tweets prefer note_tweet text', () => {
  const tweet = normalizeTweet({
    __typename: 'Tweet',
    rest_id: '1',
    legacy: { full_text: 'short', created_at: 'Wed Oct 10 20:19:24 +0000 2018' },
    note_tweet: { note_tweet_results: { result: { text: 'a much longer body' } } },
  });
  assert.equal(tweet.text, 'a much longer body');
});

test('findViewerUser finds a single viewer user', () => {
  const root = { viewer: { user_results: { result: userA } } };
  assert.equal(findViewerUser(root).handle, 'TestUser');
  const noViewer = findViewerUser({ some: { user_results: { result: userA } } });
  assert.equal(noViewer.handle, 'TestUser');
  assert.equal(findViewerUser({ data: { something: true } }), null);
});

test('handle and operation parsing ignores reserved routes', () => {
  assert.equal(handleFromUrl('https://x.com/TestUser/followers'), 'TestUser');
  assert.equal(handleFromUrl('https://x.com/TestUser'), 'TestUser');
  assert.equal(handleFromUrl('https://x.com/home'), null);
  assert.equal(handleFromUrl('https://x.com/i/flow/login'), null);
  assert.equal(opFromUrl('https://x.com/i/api/graphql/abc123/Followers?variables=%7B%7D'), 'Followers');
  assert.equal(opFromUrl('https://x.com/i/api/graphql/abc123/UserByScreenName?x=1'), 'UserByScreenName');
});

test('parseTwitterDate respects the UTC offset', () => {
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018'), Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 +0800 2018'), Date.UTC(2018, 9, 10, 12, 19, 24));
  assert.equal(parseTwitterDate('not a date'), null);
});

test('daysBack returns local calendar days', () => {
  const days = daysBack(3, new Date(2026, 0, 2, 12, 0, 0));
  assert.deepEqual(days, ['2025-12-31', '2026-01-01', '2026-01-02']);
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 59)), '2026-01-02');
});

test('dashboard aggregates deltas, people and tweets', () => {
  const state = hydrateState(null);
  const acct = ensureAccount(state, 'TestUser');
  const now = Date.now();
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);

  acct.flags.followersBaselineAt = now - 30 * 86_400_000;
  acct.profile.history[yesterday] = { followers: 100, following: 10, tweets: 20, likes: 30, media: 5, ts: yesterdayDate.getTime() };
  acct.profile.history[today] = { followers: 105, following: 11, tweets: 22, likes: 31, media: 5, ts: now };
  acct.profile.current = { ...acct.profile.history[today] };
  acct.daily[today] = { follow: 7, unfollow: 2, following_new: 1, following_lost: 0 };
  acct.people.followers = {
    1: { id: '1', handle: 'newbie', name: 'New', firstSeen: now - 60_000, lastSeen: now, seeded: false },
    2: { id: '2', handle: 'old', name: 'Old', firstSeen: now - 40 * 86_400_000, lastSeen: now, seeded: true },
  };
  acct.people.following = {
    3: { id: '3', handle: 'friend', name: 'Friend', firstSeen: now - 60_000, lastSeen: now },
  };
  acct.people.exFollowers = {
    4: { id: '4', handle: 'gone', name: 'Gone', firstSeen: now - 9 * 86_400_000, lastSeen: now - 4 * 86_400_000, lostAt: now - 3_600_000 },
  };
  acct.tweets = {
    t1: { id: 't1', text: 'one', createdAt: now - 3_600_000, likes: 10, retweets: 2, replies: 1, quotes: 0 },
    t2: { id: 't2', text: 'two', createdAt: now - 90_000_000, likes: 5, retweets: 0, replies: 0, quotes: 1 },
  };

  const dash = computeDashboard(state);
  assert.equal(dash.hasAccount, true);
  assert.equal(dash.today.net, 5);
  assert.equal(dash.today.follow, 7);
  assert.equal(dash.today.unfollow, 2);
  assert.equal(dash.today.tweets, 1);
  assert.equal(dash.people.trackedFollowers, 2);
  assert.equal(dash.people.trackedFollowing, 1);
  assert.equal(dash.people.trackedLost, 1);
  assert.equal(dash.people.newFollowersCount, 1);
  assert.equal(dash.people.exFollowers[0].handle, 'gone');
  assert.equal(dash.tweets.total, 2);
  assert.equal(dash.tweets.mix.likes, 15);
  assert.equal(dash.tweets.engagement, 19);
  assert.equal(dash.chart.followers.filter((p) => p.value !== null).length, 2);
  assert.equal(dash.totals.followers, 105);
  assert.equal(computeBadge(state).net, 5);
});

test('hydrateState repairs old / incomplete state', () => {
  const state = hydrateState({
    version: 0,
    currentHandle: 'nope',
    accounts: {
      testuser: { self: { handle: 'TestUser' }, people: {}, events: null, sync: null },
    },
    settings: { theme: 'light' },
  });
  assert.equal(state.currentHandle, 'testuser');
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.accounts.testuser.self.handle, 'TestUser');
  assert.deepEqual(state.accounts.testuser.people.followers, {});
  assert.deepEqual(state.accounts.testuser.events, []);
});
