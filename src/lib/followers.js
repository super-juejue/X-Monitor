/**
 * Follower snapshots.
 *
 * A snapshot is the set of accounts X served for your followers list at one
 * moment. Comparing two of them is how "who unfollowed me" gets answered, so
 * most of the care here is about trust: a capture that might be missing people
 * can never be compared, or everyone it missed would look like an unfollower.
 */

export const FOLLOWERS_KEY = 'xmonitor_followers';
export const FOLLOWERS_VERSION = 1;

/** Storage caps. A snapshot is discarded rather than silently truncated. */
export const MAX_FOLLOWERS = 30_000;

/** How many names the panel keeps for each side of a diff. */
export const MAX_DIFF_ENTRIES = 200;

/** A count older than this cannot vouch for a capture. */
const COUNT_FRESH_MS = 10 * 60_000;

/**
 * Identity used to compare two snapshots. X's rest_id survives a rename, so an
 * account that changes its handle must not appear as "left and came back".
 */
export function entryKey(entry) {
  if (entry?.id) return `id:${entry.id}`;
  const handle = String(entry?.handle || '').toLowerCase();
  return handle ? `h:${handle}` : '';
}

/** Keep only what a snapshot needs, and nothing that could be hostile. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id == null ? '' : String(raw.id).trim().slice(0, 40);
  const handle = String(raw.handle || '').replace(/^@/, '').trim();
  if (handle && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (!id && !handle) return null;
  const name = String(raw.name || '').trim().slice(0, 60);
  return { id, handle, name: name || handle };
}

/** Normalize a list, dropping duplicates. Returns [] when the list is too big. */
export function collectEntries(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const handles = new Set();
  const out = [];

  // Entries with an id first: the same person may also arrive as a handle-only
  // entry (the page shows a name and a link, the API has the rest), and the
  // richer copy is the one worth keeping.
  const normalized = [];
  for (const raw of list) {
    const entry = normalizeEntry(raw);
    if (entry) normalized.push(entry);
  }
  normalized.sort((a, b) => Number(Boolean(b.id)) - Number(Boolean(a.id)));

  for (const entry of normalized) {
    const key = entryKey(entry);
    const handle = entry.handle.toLowerCase();
    if (!key || seen.has(key)) continue;
    if (handle && handles.has(handle)) continue;
    seen.add(key);
    if (handle) handles.add(handle);
    out.push(entry);
    if (out.length > MAX_FOLLOWERS) return [];
  }
  return out;
}

/**
 * Who is gone, and who is new. Previous entries keep their order, which is the
 * order X served them in (most recent follow first).
 */
export function diffFollowers(previous, next) {
  const before = collectEntries(previous);
  const after = collectEntries(next);
  const index = (list) => ({
    ids: new Set(list.filter((entry) => entry.id).map((entry) => entry.id)),
    handles: new Map(list.filter((entry) => entry.handle).map((entry) => [entry.handle.toLowerCase(), entry])),
  });
  const contains = (lookup, entry) => {
    if (entry.id && lookup.ids.has(entry.id)) return true;
    const byHandle = lookup.handles.get(entry.handle.toLowerCase());
    // A handle can be reassigned. Two different ids are never the same person.
    return Boolean(byHandle && (!entry.id || !byHandle.id));
  };
  const inNext = index(after);
  const inPrev = index(before);
  const unfollowed = before.filter((entry) => !contains(inNext, entry));
  const followed = after.filter((entry) => !contains(inPrev, entry));

  return {
    unfollowed: unfollowed.slice(0, MAX_DIFF_ENTRIES),
    followed: followed.slice(0, MAX_DIFF_ENTRIES),
    unfollowedCount: unfollowed.length,
    followedCount: followed.length,
  };
}

/**
 * Can this capture be trusted as a complete list?
 *
 * Reaching the end of the timeline is the only reliable signal that X has
 * nothing left. The profile counter is a second opinion: it is refreshed by the
 * same page load, so a capture that stopped well short of it missed people.
 * Without a fresh, exact counter we cannot rule out a partial list. Refuse the
 * capture rather than inventing unfollows, even when X says it reached the end.
 */
export function isCompleteCapture({ reachedEnd, captured, expected, expectedTs, now = Date.now() }) {
  if (!reachedEnd) return false;
  if (!Number.isSafeInteger(captured) || captured < 0 || captured > MAX_FOLLOWERS) return false;
  if (!Number.isSafeInteger(expected) || expected < 0) return false;
  if (!expectedTs || expectedTs > now || now - expectedTs > COUNT_FRESH_MS) return false;
  return captured === expected;
}

export function createFollowers() {
  return {
    version: FOLLOWERS_VERSION,
    handle: '',
    accountId: '',
    ts: 0,
    total: 0,
    expected: null,
    entries: [],
    diff: null,
    previous: null,
  };
}

function readSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const handle = String(raw.handle || '').replace(/^@/, '').trim();
  const entries = collectEntries(raw.entries);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || !Array.isArray(raw.entries)) return null;
  if (!Number.isFinite(raw.ts) || raw.ts <= 0 || raw.total !== entries.length) return null;
  if (entries.length !== raw.entries.length) return null;
  return {
    handle,
    accountId: typeof raw.accountId === 'string' ? raw.accountId.slice(0, 40) : '',
    ts: raw.ts,
    total: entries.length,
    expected: Number.isSafeInteger(raw.expected) && raw.expected >= 0 ? raw.expected : null,
    entries,
  };
}

/** Keep the latest two complete snapshots, including a valid zero-follower one. */
export function hydrateFollowers(raw) {
  const state = createFollowers();
  if (Number(raw?.version) > FOLLOWERS_VERSION) return state;
  const latest = readSnapshot(raw);
  if (!latest) return state;

  const diff = raw.diff && typeof raw.diff === 'object'
    ? {
      unfollowed: collectEntries(raw.diff.unfollowed).slice(0, MAX_DIFF_ENTRIES),
      followed: collectEntries(raw.diff.followed).slice(0, MAX_DIFF_ENTRIES),
      unfollowedCount: Math.max(0, Number(raw.diff.unfollowedCount) || 0),
      followedCount: Math.max(0, Number(raw.diff.followedCount) || 0),
      fromTs: Math.max(0, Number(raw.diff.fromTs) || 0),
    }
    : null;

  const previous = readSnapshot(raw.previous);
  const sameAccount = previous && previous.handle.toLowerCase() === latest.handle.toLowerCase()
    && (!previous.accountId || previous.accountId === latest.accountId);
  return {
    ...state,
    ...latest,
    previous: sameAccount ? previous : null,
    diff: sameAccount ? { ...diffFollowers(previous.entries, latest.entries), fromTs: previous.ts } : diff,
  };
}
