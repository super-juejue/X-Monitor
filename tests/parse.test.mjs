/**
 * Parser tests. Payload shapes come from X's own responses, so these cover the
 * two schemas in use: counts in `legacy`, and handles in `core`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findOwner,
  findViewerUser,
  graphqlRoot,
  normalizeUser,
  opFromUrl,
  toCount,
} from '../src/lib/parse.js';
import { parseTwitterDate } from '../src/lib/time.js';

test('normalizeUser reads the core + legacy schema', () => {
  const user = normalizeUser({
    rest_id: '42',
    core: { screen_name: 'jack', name: 'Jack', created_at: 'Wed Oct 10 20:19:24 +0000 2018' },
    avatar: { image_url: 'https://pbs.twimg.com/a_normal.jpg' },
    is_blue_verified: true,
    legacy: {
      followers_count: 1200,
      friends_count: 248,
      statuses_count: 1284,
      favourites_count: 5821,
      media_count: 96,
      listed_count: 12,
    },
  });

  assert.equal(user.id, '42');
  assert.equal(user.handle, 'jack');
  assert.equal(user.name, 'Jack');
  assert.equal(user.verified, true);
  assert.equal(user.followers, 1200);
  assert.equal(user.following, 248);
  assert.equal(user.tweets, 1284);
  assert.equal(user.likes, 5821);
  assert.equal(user.createdAt, Date.UTC(2018, 9, 10, 20, 19, 24));
});

test('normalizeUser still understands the older schema', () => {
  const user = normalizeUser({
    id_str: '7',
    legacy: {
      screen_name: 'old',
      name: 'Old',
      profile_image_url_https: 'https://pbs.twimg.com/b_normal.jpg',
      followers_count: 5,
      friends_count: 6,
    },
  });
  assert.equal(user.handle, 'old');
  assert.equal(user.name, 'Old');
  assert.equal(user.avatar, 'https://pbs.twimg.com/b_normal.jpg');
  assert.equal(user.followers, 5);
  assert.equal(user.verified, false);
});

test('normalizeUser unwraps visibility results and rejects unavailable users', () => {
  const wrapped = normalizeUser({
    __typename: 'UserWithVisibilityResults',
    user: { rest_id: '9', core: { screen_name: 'wrapped', name: 'W' } },
  });
  assert.equal(wrapped.handle, 'wrapped');

  assert.equal(normalizeUser({ __typename: 'UserUnavailable', reason: 'suspended' }), null);
  assert.equal(normalizeUser(null), null);
  assert.equal(normalizeUser({}), null);
});

test('toCount accepts numbers and comma strings, rejects junk', () => {
  assert.equal(toCount(12), 12);
  assert.equal(toCount('1,234'), 1234);
  assert.equal(toCount(''), null);
  assert.equal(toCount('abc'), null);
  assert.equal(toCount(undefined), null);
});

test('opFromUrl ignores the rotating query id', () => {
  assert.equal(opFromUrl('https://x.com/i/api/graphql/aBc123/Viewer'), 'Viewer');
  assert.equal(
    opFromUrl('https://x.com/i/api/graphql/xyz/UserByScreenName?variables=%7B%7D'),
    'UserByScreenName',
  );
  assert.equal(opFromUrl('https://x.com/home'), '');
  assert.equal(opFromUrl('not a url'), '');
});

test('graphqlRoot unwraps data and tolerates a bare payload', () => {
  assert.deepEqual(graphqlRoot({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(graphqlRoot({ a: 1 }), { a: 1 });
  assert.equal(graphqlRoot(null), null);
});

test('findViewerUser reads the viewer slot', () => {
  const user = findViewerUser({ viewer: { user_results: { result: { rest_id: '1', core: { screen_name: 'me' } } } } });
  assert.equal(user.handle, 'me');
});

test('findViewerUser finds a single nested user, but not an ambiguous one', () => {
  const nested = findViewerUser({
    some: { user_results: { result: { rest_id: '2', core: { screen_name: 'one' }, legacy: { followers_count: 3 } } } },
  });
  assert.equal(nested.handle, 'one');

  const ambiguous = findViewerUser({
    a: { user_results: { result: { rest_id: '3', core: { screen_name: 'a' }, legacy: { followers_count: 1 } } } },
    b: { user_results: { result: { rest_id: '4', core: { screen_name: 'b' }, legacy: { followers_count: 2 } } } },
  });
  assert.equal(ambiguous, null);
});

test('findOwner reads the subject of a UserByScreenName query', () => {
  const user = findOwner({ user: { result: { rest_id: '5', core: { screen_name: 'someone' } } } });
  assert.equal(user.handle, 'someone');
  assert.equal(findOwner({}), null);
});

test('parseTwitterDate respects the UTC offset', () => {
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018'), Date.UTC(2018, 9, 10, 20, 19, 24));
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 +0800 2018'), Date.UTC(2018, 9, 10, 12, 19, 24));
  assert.equal(parseTwitterDate(''), null);
});
