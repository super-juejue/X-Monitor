/**
 * Service worker: the only writer.
 *
 * It keeps exactly two things — who is logged in, and their latest profile
 * numbers — and hands them to the side panel. X's own GraphQL responses are the
 * only source, so nothing is ever requested from the network.
 */

import {
  COUNT_FIELDS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  hydrateState,
  sameHandle,
} from './lib/constants.js';
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

async function handleCapture(message) {
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
  notify();
  if (counts) settleRefresh(user.handle, message.doc);
}

/**
 * Counts read straight from your profile page. X caches its GraphQL responses,
 * so a revisit can update the DOM without any request the hook could observe.
 * The content script only sends this after confirming the page is your own.
 */
async function handleProfileHint(hint, doc) {
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
  if (waiter) return { ok: false, error: 'BUSY' };

  const state = await load();
  const handle = state.self?.handle;
  if (!handle) return { ok: false, error: 'NO_ACCOUNT' };
  if (waiter) return { ok: false, error: 'BUSY' };

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  // Stamp the sending document before any await, so a refresh can tell the
  // page it just caused to load apart from the one that was already there.
  if (message.doc) firstSeen(message.doc);

  switch (message.type) {
    case 'CAPTURE':
      handleCapture(message)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'SELF_HINT':
      handleSelfHint(message.self)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'PROFILE_HINT':
      handleProfileHint(message.hint, message.doc)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'GET_ACCOUNT':
      load()
        .then((state) => sendResponse({ ok: true, ...publicAccount(state) }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'REFRESH':
      refreshAccount()
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: 'FAILED' }));
      return true;

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
