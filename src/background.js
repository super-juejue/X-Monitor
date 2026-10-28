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
import { findOwner, findViewerUser, graphqlRoot, opFromUrl } from './lib/parse.js';

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

async function handleCapture(message) {
  const op = message.op || opFromUrl(message.url || '');
  const root = graphqlRoot(message.payload);
  if (!op || !root) return;

  let user = null;
  let authoritative = false;
  if (op === 'Viewer') {
    // The Viewer query is by definition the logged-in account.
    user = findViewerUser(root);
    authoritative = Boolean(user);
  } else if (op.startsWith('UserByScreenName') || op === 'UserByRestId') {
    user = findOwner(root);
  }
  if (!user?.handle) return;

  const changed = await mutate((state) => {
    const known = state.self?.handle || '';
    // A profile page is only evidence about *you* when it is your own profile.
    // Without a known handle this capture says nothing about who is logged in,
    // so opening somebody else's page first must not make them "you".
    if (!authoritative && (!known || !sameHandle(known, user.handle))) return false;

    // Numbers belong to the account they came from.
    if (state.profile && !sameHandle(state.profile.handle, user.handle)) state.profile = null;
    state.self = mergeSelf(state.self, user);
    const counts = pickCounts(user);
    if (counts) state.profile = { handle: user.handle, ...counts, ts: Date.now() };
    return true;
  });
  if (changed) notify();
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

    case 'GET_ACCOUNT':
      load()
        .then((state) => sendResponse({ ok: true, ...publicAccount(state) }))
        .catch(() => sendResponse({ ok: false }));
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
