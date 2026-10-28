/**
 * Service worker: the only writer.
 *
 * Keeps the signed-in account, its latest numbers, and two follower snapshots.
 * X's own page requests provide the data; the extension never calls its API.
 */

import {
  COUNT_FIELDS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  hydrateState,
  sameHandle,
} from './lib/constants.js';
import {
  FOLLOWERS_KEY,
  FOLLOWERS_VERSION,
  MAX_FOLLOWERS,
  collectEntries,
  diffFollowers,
  hydrateFollowers,
  isCompleteCapture,
} from './lib/followers.js';
import { findOwner, findViewerUser, graphqlRoot, normalizeUser, opFromUrl } from './lib/parse.js';

let cache = null;
let loading = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  if (!loading) {
    loading = chrome.storage.local
      .get(STORAGE_KEY)
      .then((result) => {
        cache = hydrateState(result?.[STORAGE_KEY]);
        return cache;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * Serialize writes so a capture and a self-hint cannot clobber each other.
 * Resolves to false when the callback decided there was nothing to store.
 */
function mutate(fn) {
  const run = writeChain.then(async () => {
    const state = await load();
    const changed = fn(state) !== false;
    if (!changed) return false;
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    return true;
  });
  writeChain = run.catch(() => {});
  return run;
}

function notify() {
  try {
    const sent = chrome.runtime.sendMessage({ type: 'ACCOUNT_UPDATED' });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    // No panel open; nothing to tell.
  }
}

function mergeSelf(base, user) {
  return {
    id: user.id || base?.id || null,
    handle: user.handle || base?.handle || '',
    name: user.name || base?.name || '',
    avatar: user.avatar || base?.avatar || '',
    verified: typeof user.verified === 'boolean' ? user.verified : Boolean(base?.verified),
    createdAt: user.createdAt || base?.createdAt || null,
  };
}

function pickCounts(user) {
  const counts = {};
  let any = false;
  for (const field of COUNT_FIELDS) {
    if (typeof user[field] === 'number' && Number.isFinite(user[field])) {
      counts[field] = user[field];
      any = true;
    }
  }
  return any ? counts : null;
}

async function handleSelfHint(self) {
  const handle = String(self?.handle || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false };
  const name = typeof self?.name === 'string' ? self.name.trim().slice(0, 80) : '';
  const avatar = /^https?:\/\//.test(self?.avatar || '') ? self.avatar : '';

  const changed = await mutate((state) => {
    const prev = state.self;
    const same = prev && sameHandle(prev.handle, handle);
    if (same && (!name || prev.name === name) && (!avatar || prev.avatar === avatar)) return false;
    state.self = mergeSelf(same ? prev : null, { handle, name, avatar });
    // Numbers belong to the account that produced them.
    if (state.profile && !sameHandle(state.profile.handle, handle)) state.profile = null;
    return true;
  });
  if (changed) notify();
  return { ok: true };
}

/**
 * Last resort: some responses (for example UsersByRestIds) nest the user
 * instead of exposing it at a known path. Look for the account we already know
 * about, so an unexpected shape cannot hide the numbers.
 */
function findKnownUser(root, handle) {
  const seen = new Set();
  let found = null;
  const visit = (node, depth) => {
    if (found || !node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
    seen.add(node);
    if (node.__typename && typeof node.__typename === 'string' && /User/.test(node.__typename)) {
      const user = normalizeUser(node);
      if (user && sameHandle(user.handle, handle)) {
        found = user;
        return;
      }
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(root, 0);
  return found;
}

async function handleCapture(message, sender = {}) {
  const op = message.op || opFromUrl(message.url || '');
  const root = graphqlRoot(message.payload);
  if (!op || !root) return;

  const isViewer = op.startsWith('Viewer');
  const known = (await load()).self?.handle || '';

  let user = isViewer ? findViewerUser(root) : findOwner(root);
  if (!user && known) user = findKnownUser(root, known);
  if (!user?.handle) return;

  const counts = pickCounts(user);
  const changed = await mutate((state) => {
    const current = state.self?.handle || '';
    // A Viewer response is the only one that proves who is logged in. Every
    // other shape is only evidence about *you* when it names the account we
    // already know — otherwise opening someone else's page would make them you.
    if (!isViewer && (!current || !sameHandle(current, user.handle))) return false;

    // Numbers belong to the account they came from.
    if (state.profile && !sameHandle(state.profile.handle, user.handle)) state.profile = null;
    state.self = mergeSelf(state.self, user);
    if (counts) state.profile = { handle: user.handle, ...counts, ts: Date.now() };
    return true;
  });
  if (!changed) return;
  recordFollowerCount(user.handle, counts?.followers, message.doc, sender);
  notify();
  if (counts) settleRefresh(user.handle, message.doc);
}

/**
 * Counts read straight from your profile page. X caches its GraphQL responses,
 * so a revisit can update the DOM without any request the hook could observe.
 * The content script only sends this after confirming the page is your own.
 */
async function handleProfileHint(hint, doc, sender = {}) {
  const handle = String(hint?.handle || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false };

  const counts = pickCounts({ ...(hint.counts || {}) });
  const changed = await mutate((state) => {
    const current = state.self?.handle || '';
    // Stay strict: a hint may only describe the account we already know, or
    // bootstrap one when the page itself proved it is your own profile.
    if (current && !sameHandle(current, handle)) return false;
    if (!current && !hint.verified) return false;
    if (!current && !counts) return false;

    if (!current) state.self = mergeSelf(null, { handle, name: hint.name || '' });
    if (state.profile && !sameHandle(state.profile.handle, handle)) state.profile = null;
    if (counts) {
      state.profile = {
        handle,
        ...(state.profile || {}),
        ...counts,
        ts: Date.now(),
      };
    }
    return true;
  });
  if (!changed) return { ok: true };
  // Compact labels such as "1.2K" are useful on the card, but cannot verify
  // that exactly 1,200 people were read.
  if (hint.followersExact === true) recordFollowerCount(handle, counts?.followers, doc, sender);
  notify();
  if (counts) settleRefresh(handle, doc);
  return { ok: true };
}

/** True when two urls point at the same page (path, case-insensitive). */
function samePath(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const host = (u) => u.hostname.replace(/^www\./, '').toLowerCase();
    if (host(ua) !== host(ub)) return false;
    const path = (u) => u.pathname.replace(/\/+$/, '').toLowerCase();
    return path(ua) === path(ub);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manual refresh
// ---------------------------------------------------------------------------

/**
 * When each document first reported, in first-seen order. Used for documents
 * that do not carry their own start time.
 */
const documents = new Map();
const DOCUMENT_LIMIT = 24;

function firstSeen(doc) {
  if (typeof doc !== 'string' || !doc) return 0;
  if (!documents.has(doc)) {
    documents.set(doc, Date.now());
    if (documents.size > DOCUMENT_LIMIT) documents.delete(documents.keys().next().value);
  }
  return documents.get(doc);
}

/** The content script prefixes its document id with when that page was created. */
function documentStart(doc) {
  const match = /^(\d{10,})~/.exec(String(doc || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * A pending refresh. Counts can only come from X itself, so a refresh has to
 * make a page load: either the profile tab the user already has open, or a
 * hidden tab we open and close. This holds the promise that resolves when the
 * numbers actually arrive.
 */
let waiter = null;

/** Resolve a pending refresh once numbers from a page loaded after it started land. */
function settleRefresh(handle, doc) {
  if (!waiter || !sameHandle(waiter.handle, handle)) return;
  // A page that already existed when the button was pressed is the one being
  // replaced, however late its first report happens to arrive.
  const seen = documentStart(doc) || firstSeen(doc);
  if (!seen || seen < waiter.since) return;
  const done = waiter;
  waiter = null;
  clearTimeout(done.timer);
  done.resolve({ ok: true });
}

// Overridable so tests do not have to sit through the real timeout.
const refreshTimeout = () => Number(globalThis.__xmonitorRefreshTimeoutMs) || 15_000;

/**
 * Start waiting for counts. Registered before any tab work, because the page
 * can answer faster than `chrome.tabs.create` resolves.
 */
function startWaiter(handle) {
  let entry = null;
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (waiter === entry) waiter = null;
      clearTimeout(entry.timer);
      resolve(value);
    };
    entry = {
      handle,
      since: Date.now(),
      resolve: finish,
      timer: setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), refreshTimeout()),
    };
    waiter = entry;
  });
  return { promise, cancel: () => entry.resolve({ ok: false, error: 'TAB_FAILED' }) };
}

async function refreshAccount() {
  if (waiter || collector) return { ok: false, error: 'BUSY' };

  const state = await load();
  const handle = state.self?.handle;
  if (!handle) return { ok: false, error: 'NO_ACCOUNT' };
  if (waiter || collector) return { ok: false, error: 'BUSY' };

  const pending = startWaiter(handle);
  const profileUrl = `https://x.com/${handle}`;
  let createdTab = null;

  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    const onProfile = tabs.find((tab) => tab.id != null && samePath(tab.url, profileUrl));

    if (onProfile) {
      // Already looking at the profile: reloading it is expected, and it
      // re-runs X's boot queries so the numbers are fresh rather than cached.
      await chrome.tabs.reload(onProfile.id);
    } else {
      // Load it hidden instead: reloading whatever the user is reading would
      // throw away their position. The tab closes itself as soon as we are done.
      const tab = await chrome.tabs.create({ url: profileUrl, active: false });
      createdTab = tab?.id ?? null;
    }
  } catch {
    pending.cancel();
    return pending.promise;
  }

  const result = await pending.promise;

  if (createdTab != null) {
    try {
      await chrome.tabs.remove(createdTab);
    } catch {
      // The tab was already gone.
    }
  }

  return result;
}

/** Only expose numbers that belong to the account currently shown. */
function publicAccount(state) {
  return {
    self: state.self,
    profile: state.profile && (!state.self || sameHandle(state.profile.handle, state.self.handle))
      ? state.profile
      : null,
    updatedAt: state.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Follower snapshots
// ---------------------------------------------------------------------------

/**
 * A follower list can only be compared with the one before it, so a capture is
 * stored only when it can be trusted. `isCompleteCapture` decides that; this
 * section only keeps the storage and the run in order.
 */
let followersCache = null;
let followersLoading = null;

async function loadFollowers() {
  if (followersCache) return followersCache;
  if (!followersLoading) {
    followersLoading = chrome.storage.local.get(FOLLOWERS_KEY)
      .then((result) => {
        followersCache = hydrateFollowers(result?.[FOLLOWERS_KEY]);
        return followersCache;
      })
      .finally(() => { followersLoading = null; });
  }
  return followersLoading;
}

async function saveFollowers(next) {
  await chrome.storage.local.set({ [FOLLOWERS_KEY]: next });
  followersCache = next;
}

/** The snapshot, but only while it describes the account on screen. */
function belongsToAccount(snapshot, self) {
  return sameHandle(snapshot.handle, self?.handle)
    && (!snapshot.accountId || snapshot.accountId === self?.id);
}

async function publicFollowers(state) {
  const snapshot = await loadFollowers();
  if (!snapshot.ts || !belongsToAccount(snapshot, state.self)) return null;
  return {
    handle: snapshot.handle,
    ts: snapshot.ts,
    total: snapshot.total,
    diff: snapshot.diff,
  };
}

const collectTimeout = () => Number(globalThis.__xmonitorCollectTimeoutMs) || 60_000;

/** One capture at a time; the tab it opened is remembered so it can be closed. */
let collector = null;

function recordFollowerCount(handle, followers, doc, sender) {
  if (!collector || !sameHandle(collector.handle, handle)
    || !Number.isSafeInteger(followers) || followers < 0
    || (sender.frameId != null && sender.frameId !== 0)) return;
  const started = documentStart(doc);
  const counter = collector.counter;
  if (counter && started >= counter.since
    && samePath(sender.url || sender.tab?.url, `https://x.com/${handle}`)) {
    const value = { expected: followers, expectedTs: Date.now() };
    if (sender.tab?.id === counter.tabId) counter.finish(value);
    else if (counter.tabId == null && sender.tab?.id != null && counter.early.size < 4) {
      // The new profile can answer before tabs.create returns its id. Bind
      // these early counts to that id before trusting any of them.
      counter.early.set(sender.tab.id, value);
    }
    return;
  }
  if (sender.tab?.id === collector.tabId && started >= collector.since
    && (!collector.doc || collector.doc === doc)) {
    collector.expected = followers;
    collector.expectedTs = Date.now();
  }
}

/** Followers responses may contain only a timeline, not profile counters. */
async function readFreshFollowerCount(entry) {
  const remaining = entry.since + collectTimeout() - Date.now();
  if (remaining <= 0) return null;
  const counter = { since: Date.now(), tabId: null, timer: null, early: new Map() };
  const result = new Promise((resolve) => {
    let done = false;
    counter.finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(counter.timer);
      resolve(value);
    };
    counter.timer = setTimeout(() => counter.finish(null),
      Math.min(Number(globalThis.__xmonitorCounterTimeoutMs) || 15_000, remaining));
  });
  entry.counter = counter;
  entry.stage = 'verifying';
  notify();
  try {
    const tab = await chrome.tabs.create({ url: `https://x.com/${entry.handle}`, active: false });
    counter.tabId = tab?.id ?? null;
    if (counter.tabId == null) counter.finish(null);
    else if (counter.early.has(counter.tabId)) counter.finish(counter.early.get(counter.tabId));
    return await result;
  } catch {
    counter.finish(null);
    return null;
  } finally {
    counter.finish(null);
    entry.counter = null;
    if (counter.tabId != null) {
      try {
        await chrome.tabs.remove(counter.tabId);
      } catch {
        // The temporary profile was already closed.
      }
    }
  }
}

function startCollector(handle, accountId) {
  let entry = null;
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      resolve(value);
    };
    entry = {
      handle,
      accountId,
      id: crypto.randomUUID(),
      since: Date.now(),
      resolve: finish,
      tabId: null,
      doc: '',
      expected: null,
      expectedTs: 0,
      captured: 0,
      stage: 'reading',
      settled: false,
      timer: setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), collectTimeout()),
    };
    collector = entry;
  });
  return { entry, promise };
}

/** A content script that is still loading cannot answer yet. */
async function askTab(entry, attempts = Number(globalThis.__xmonitorAskAttempts) || 30) {
  const delay = () => Number(globalThis.__xmonitorAskDelayMs) || 400;
  for (let i = 0; i < attempts; i += 1) {
    if (entry.settled) return { ok: true };
    try {
      const answer = await chrome.tabs.sendMessage(entry.tabId, {
        type: 'FOLLOWERS_COLLECT',
        handle: entry.handle,
        accountId: entry.accountId,
        captureId: entry.id,
        since: entry.since,
      });
      if (answer?.ok && documentStart(answer.doc) >= entry.since) {
        if (entry.doc && entry.doc !== answer.doc) return { ok: false, error: 'NO_ANSWER' };
        entry.doc = answer.doc;
        return answer;
      }
      if (answer?.error && answer.error !== 'NO_ANSWER') return answer;
    } catch {
      // No listener in that tab yet; wait and try again.
    }
    await new Promise((resolve) => setTimeout(resolve, delay()));
  }
  return { ok: false, error: 'NO_ANSWER' };
}

async function collectFollowers() {
  if (collector || waiter) return { ok: false, error: 'BUSY' };

  const state = await load();
  const handle = state.self?.handle;
  if (!handle) return { ok: false, error: 'NO_ACCOUNT' };
  if (collector || waiter) return { ok: false, error: 'BUSY' };
  const target = `https://x.com/${handle}/followers`;
  const { entry, promise } = startCollector(handle, state.self.id || '');
  notify();

  try {
    try {
      // Never read a cached, already-scrolled list. A separate fresh document
      // also leaves every tab the user is reading untouched.
      const tab = await chrome.tabs.create({ url: target, active: false });
      entry.tabId = tab?.id ?? null;
      if (entry.tabId == null) {
        entry.resolve({ ok: false, error: 'TAB_FAILED' });
      } else {
        // A broken message channel must not prevent timeout or tab cleanup.
        const answer = await Promise.race([askTab(entry), promise.then(() => ({ ok: true }))]);
        if (!answer?.ok) entry.resolve({ ok: false, error: answer?.error || 'NO_ANSWER' });
      }
    } catch {
      entry.resolve({ ok: false, error: 'TAB_FAILED' });
    }

    const outcome = await promise;
    if (!outcome.ok) return outcome;
    if (!Array.isArray(outcome.entries) || outcome.tooLarge || outcome.entries.length > MAX_FOLLOWERS) {
      return { ok: false, error: 'LIMIT' };
    }

    const entries = collectEntries(outcome.entries);
    let expected = Number.isSafeInteger(outcome.expected) && outcome.expected >= 0
      ? outcome.expected : entry.expected;
    let expectedTs = expected === outcome.expected ? Date.now() : entry.expectedTs;
    if (entries.length !== outcome.entries.length || entries.some((person) => !person.id)) {
      return { ok: false, error: 'INCOMPLETE', reason: 'INVALID_ENTRIES', captured: entries.length };
    }
    if (outcome.reachedEnd !== true || outcome.pages === 0) {
      const errors = { NO_PAGES: 'NO_PAGES', FORMAT: 'UNSUPPORTED', OWNER: 'IDENTITY', COUNT_CHANGED: 'COUNT_CHANGED' };
      return {
        ok: false,
        error: outcome.pages === 0 ? 'NO_PAGES' : errors[outcome.reason] || 'INCOMPLETE',
        reason: 'NOT_FINISHED',
        captured: entries.length,
        pages: outcome.pages,
        expected,
      };
    }
    // Do not require profile fields to be embedded in a Followers response.
    // Read a new, account-scoped profile counter instead of trusting old storage.
    if (!Number.isSafeInteger(expected) || expected < 0) {
      entry.captured = entries.length;
      const fresh = await readFreshFollowerCount(entry);
      if (!fresh) return { ok: false, error: 'NO_COUNT', captured: entries.length };
      ({ expected, expectedTs } = fresh);
    }
    const conflictingCounts = entry.expected !== null && Number.isSafeInteger(outcome.expected)
      && entry.expected !== outcome.expected;
    if (conflictingCounts) return { ok: false, error: 'COUNT_CHANGED', captured: entries.length };
    if (!isCompleteCapture({
      reachedEnd: outcome.reachedEnd === true,
      captured: entries.length,
      expected,
      expectedTs,
    })) {
      return { ok: false, error: 'INCOMPLETE', reason: 'COUNT_MISMATCH', captured: entries.length, expected };
    }
    const previous = await loadFollowers();
    const current = (await load()).self;
    if (!sameHandle(current?.handle, handle) || (entry.accountId && current?.id !== entry.accountId)) {
      return { ok: false, error: 'ACCOUNT_CHANGED' };
    }
    if (outcome.ownerId && current?.id && outcome.ownerId !== current.id) {
      return { ok: false, error: 'IDENTITY', captured: entries.length };
    }
    const sameAccount = previous.ts > 0 && belongsToAccount(previous, current);
    const diff = sameAccount ? { ...diffFollowers(previous.entries, entries), fromTs: previous.ts } : null;
    const next = {
      version: FOLLOWERS_VERSION,
      handle,
      accountId: current.id || '',
      ts: Date.now(),
      total: entries.length,
      expected,
      entries,
      diff,
      previous: sameAccount ? {
        handle: previous.handle,
        accountId: previous.accountId,
        ts: previous.ts,
        total: previous.total,
        expected: previous.expected,
        entries: previous.entries,
      } : null,
    };
    // Leave room in Chrome's 10 MiB local quota for the account record.
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 8 * 1024 * 1024) {
      return { ok: false, error: 'LIMIT' };
    }
    try {
      await saveFollowers(next);
    } catch {
      return { ok: false, error: 'STORAGE' };
    }
    return {
      ok: true,
      total: entries.length,
      first: !sameAccount,
      unfollowed: diff?.unfollowedCount || 0,
      followed: diff?.followedCount || 0,
    };
  } finally {
    entry.resolve({ ok: false, error: 'FAILED' });
    if (entry.tabId != null) {
      try {
        await chrome.tabs.remove(entry.tabId);
      } catch {
        // Already closed.
      }
    }
    if (collector === entry) collector = null;
    notify();
  }
}

/** Ignore other tabs, old documents, old captures and non-top-level frames. */
function matchesCollector(message, sender) {
  if (!collector || collector.settled || message.captureId !== collector.id
    || sender.tab?.id !== collector.tabId || (sender.frameId != null && sender.frameId !== 0)
    || !sameHandle(collector.handle, message.handle)
    || !samePath(sender.url || sender.tab?.url, `https://x.com/${collector.handle}/followers`)
    || documentStart(message.doc) < collector.since
    || (collector.doc && collector.doc !== message.doc)) return false;
  collector.doc = message.doc;
  return true;
}

function handleFollowersProgress(message, sender) {
  if (!matchesCollector(message, sender)) return { ok: false };
  if (Number.isSafeInteger(message.captured) && message.captured >= 0 && message.captured <= MAX_FOLLOWERS) {
    collector.captured = message.captured;
    notify();
  }
  return { ok: true };
}

function handleFollowersResult(message, sender) {
  if (!matchesCollector(message, sender)) return { ok: false };
  collector.resolve({
    ok: true,
    entries: message.entries,
    reachedEnd: message.reachedEnd === true,
    expected: message.expected,
    tooLarge: Boolean(message.tooLarge),
    pages: Number.isSafeInteger(message.pages) ? message.pages : 0,
    reason: typeof message.reason === 'string' ? message.reason : '',
    ownerId: typeof message.ownerId === 'string' ? message.ownerId : '',
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  // Stamp the sending document before any await, so a refresh can tell the
  // page it just caused to load apart from the one that was already there.
  if (message.doc) firstSeen(message.doc);

  switch (message.type) {
    case 'CAPTURE':
      handleCapture(message, sender)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'SELF_HINT':
      handleSelfHint(message.self)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'PROFILE_HINT':
      handleProfileHint(message.hint, message.doc, sender)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'GET_ACCOUNT':
      load()
        .then(async (state) => sendResponse({
          ok: true,
          ...publicAccount(state),
          followers: await publicFollowers(state),
          capture: collector ? { captured: collector.captured, stage: collector.stage } : null,
        }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'REFRESH':
      refreshAccount()
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: 'FAILED' }));
      return true;

    case 'COLLECT_FOLLOWERS':
      collectFollowers()
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: 'FAILED' }));
      return true;

    case 'FOLLOWERS_RESULT':
      sendResponse(handleFollowersResult(message, sender));
      return undefined;

    case 'FOLLOWERS_PROGRESS':
      sendResponse(handleFollowersProgress(message, sender));
      return undefined;

    default:
      return undefined;
  }
});

async function bootstrap() {
  await load();
  // The previous implementation's snapshot is not read any more.
  try {
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch(() => {});
});
bootstrap().catch(() => {});
