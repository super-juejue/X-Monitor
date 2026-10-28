/**
 * Follower snapshots: what counts as the same person, what counts as gone, and
 * when a capture is complete enough to compare at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DIFF_ENTRIES,
  MAX_FOLLOWERS,
  collectEntries,
  diffFollowers,
  entryKey,
  hydrateFollowers,
  isCompleteCapture,
} from '../src/lib/followers.js';

const person = (id, handle, name = handle) => ({ id: String(id), handle, name });

test('an account keeps its identity when it renames', () => {
  const before = [person(1, 'old_name')];
  const after = [person(1, 'new_name')];
  const diff = diffFollowers(before, after);

  assert.equal(diff.unfollowedCount, 0, 'a rename is not an unfollow');
  assert.equal(diff.followedCount, 0, 'a rename is not a new follower');
  assert.equal(entryKey(before[0]), entryKey(after[0]));
});

test('entries without a rest_id still match on the handle', () => {
  const diff = diffFollowers([{ id: '', handle: 'Same_Name' }], [{ id: '', handle: 'same_name' }]);
  assert.equal(diff.unfollowedCount, 0);
  assert.equal(diff.followedCount, 0);
});

test('the diff finds who left and who arrived', () => {
  const before = [person(1, 'a'), person(2, 'b'), person(3, 'c')];
  const after = [person(4, 'd'), person(1, 'a'), person(3, 'c')];
  const diff = diffFollowers(before, after);

  assert.deepEqual(diff.unfollowed.map((e) => e.handle), ['b']);
  assert.deepEqual(diff.followed.map((e) => e.handle), ['d']);
  assert.equal(diff.unfollowedCount, 1);
  assert.equal(diff.followedCount, 1);
});

test('nothing changed means an empty diff, not a full one', () => {
  const list = [person(1, 'a'), person(2, 'b')];
  const diff = diffFollowers(list, list);
  assert.equal(diff.unfollowedCount, 0);
  assert.equal(diff.followedCount, 0);
  assert.deepEqual(diff.unfollowed, []);
});

test('duplicates in a capture cannot multiply the result', () => {
  const diff = diffFollowers([person(1, 'a')], [person(1, 'a'), person(1, 'a'), person(2, 'b')]);
  assert.equal(diff.followedCount, 1);
});

test('a long list of leavers is capped but still counted', () => {
  const before = Array.from({ length: MAX_DIFF_ENTRIES + 40 }, (_, i) => person(i, `u${i}`));
  const diff = diffFollowers(before, []);

  assert.equal(diff.unfollowed.length, MAX_DIFF_ENTRIES);
  assert.equal(diff.unfollowedCount, MAX_DIFF_ENTRIES + 40);
});

test('a capture that is too big is refused rather than truncated', () => {
  const huge = Array.from({ length: MAX_FOLLOWERS + 1 }, (_, i) => person(i, `u${i}`));
  assert.deepEqual(collectEntries(huge), [], 'a truncated list would look like mass unfollows');

  const atLimit = Array.from({ length: MAX_FOLLOWERS }, (_, i) => person(i, `u${i}`));
  assert.equal(collectEntries(atLimit).length, MAX_FOLLOWERS);
});

test('junk entries are dropped, not stored', () => {
  const list = collectEntries([
    null,
    'text',
    { handle: 'not a handle' },
    { id: '9', handle: '' },
    { id: '10', handle: 'ok' },
  ]);
  assert.deepEqual(list.map((e) => e.handle), ['', 'ok']);
});

test('the same person from the API and from the page is one person', () => {
  // The hook yields an id; the rendered list only yields a handle. Keeping both
  // would invent a follower now and an unfollower on the next capture.
  const list = collectEntries([
    { id: '', handle: 'someone', name: 'Someone' },
    { id: '5', handle: 'someone', name: 'Someone' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, '5', 'the copy with an id wins');

  const diff = diffFollowers(
    [{ id: '5', handle: 'someone' }],
    [{ id: '', handle: 'someone' }, { id: '5', handle: 'someone' }],
  );
  assert.equal(diff.unfollowedCount, 0);
  assert.equal(diff.followedCount, 0);
});

// ---------------------------------------------------------------------------
// Is this capture complete enough to compare?
// ---------------------------------------------------------------------------

const now = Date.UTC(2026, 9, 28, 12, 0, 0);
const fresh = now - 60_000;

test('not reaching the end is never complete', () => {
  assert.equal(isCompleteCapture({ reachedEnd: false, captured: 5000, expected: 5000, expectedTs: fresh, now }), false);
});

test('reaching the end without a counter is not enough', () => {
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 12, expected: null, now }), false);
});

test('a capture that stops short of the counter is incomplete', () => {
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 800, expected: 1000, expectedTs: fresh, now }), false);
});

test('even one missing person can be a false unfollow, so the counter must match exactly', () => {
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 995, expected: 1000, expectedTs: fresh, now }), false);
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 999, expected: 1000, expectedTs: fresh, now }), false);
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 1, expected: 1, expectedTs: fresh, now }), true);
});

test('a stale counter cannot authorize a capture', () => {
  const old = now - 24 * 3_600_000;
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 10, expected: 1000, expectedTs: old, now }), false);
});

test('lost followers are not mistaken for an incomplete capture', () => {
  // The counter caught up during the run: fewer followers now is the whole point.
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 950, expected: 950, expectedTs: fresh, now }), true);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('a stored snapshot survives a reload', () => {
  const raw = {
    version: 1,
    handle: 'testuser',
    ts: 123,
    total: 2,
    expected: 2,
    entries: [person(1, 'a'), person(2, 'b')],
    diff: { unfollowed: [person(9, 'gone')], followed: [], unfollowedCount: 1, followedCount: 0, fromTs: 100 },
  };
  const state = hydrateFollowers(raw);

  assert.equal(state.handle, 'testuser');
  assert.equal(state.entries.length, 2);
  assert.equal(state.diff.unfollowed[0].handle, 'gone');
});

test('an empty or broken snapshot reads as no snapshot at all', () => {
  assert.equal(hydrateFollowers(null).entries.length, 0);
  assert.equal(hydrateFollowers({ handle: 'testuser', entries: [] }).entries.length, 0);
  assert.equal(hydrateFollowers({ handle: '', entries: [person(1, 'a')] }).entries.length, 0);
  assert.equal(hydrateFollowers({ version: 99, handle: 'x', entries: [person(1, 'a')] }).entries.length, 0);
});

// ---------------------------------------------------------------------------
// Edge cases that must not invent identity changes
// ---------------------------------------------------------------------------

test('a reassigned handle is still two different accounts', () => {
  const diff = diffFollowers([person(1, 'same')], [person(2, 'same')]);
  assert.equal(diff.unfollowedCount, 1);
  assert.equal(diff.followedCount, 1);
});

test('gaining an API id is not an unfollow when the previous entry only had a handle', () => {
  const diff = diffFollowers([{ handle: 'same' }], [person(1, 'same')]);
  assert.equal(diff.unfollowedCount, 0);
  assert.equal(diff.followedCount, 0);
});

test('a valid zero-follower snapshot survives a reload', () => {
  const snapshot = hydrateFollowers({ version: 1, handle: 'testuser', ts: 123, total: 0, expected: 0, entries: [] });
  assert.equal(snapshot.ts, 123);
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.handle, 'testuser');
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 0, expected: 0, expectedTs: fresh, now }), true);
});

test('an unknown stored counter stays unknown, not zero', () => {
  const snapshot = hydrateFollowers({ handle: 'testuser', ts: 123, total: 1, expected: null, entries: [person(1, 'a')] });
  assert.equal(snapshot.expected, null);
});

test('two snapshots survive rehydration without retaining an unbounded history', () => {
  const snapshot = hydrateFollowers({
    handle: 'testuser', ts: 200, total: 1, expected: 1, entries: [person(2, 'b')],
    previous: {
      handle: 'testuser', ts: 100, total: 1, entries: [person(1, 'a')],
      previous: { handle: 'old' },
    },
  });
  assert.equal(snapshot.previous.ts, 100);
  assert.equal(snapshot.previous.previous, undefined);
  assert.deepEqual(snapshot.diff.unfollowed.map((entry) => entry.handle), ['a']);
  assert.deepEqual(snapshot.diff.followed.map((entry) => entry.handle), ['b']);
});

test('a corrupted stored total cannot seed a comparison', () => {
  assert.equal(hydrateFollowers({
    handle: 'testuser', ts: 123, total: 3, entries: [person(1, 'a')],
  }).ts, 0);
  assert.equal(hydrateFollowers({
    handle: 'testuser', ts: 123, total: 0, entries: [{ handle: 'not a handle' }],
  }).ts, 0);
});

test('invalid and future counters never authorize a capture', () => {
  for (const expected of [-1, 1.5, NaN, Infinity]) {
    assert.equal(isCompleteCapture({ reachedEnd: true, captured: 1, expected, expectedTs: fresh, now }), false);
  }
  assert.equal(isCompleteCapture({ reachedEnd: true, captured: 1, expected: 1, expectedTs: now + 1, now }), false);
});
