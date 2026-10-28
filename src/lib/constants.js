/**
 * Shared state schema and constants.
 * The background worker is the only writer; the side panel reads + sends
 * explicit commands.
 */

export const STORAGE_KEY = 'xmonitor_state';
export const SCHEMA_VERSION = 1;

export const SYNC_KINDS = ['followers', 'following', 'tweets'];
export const SYNC_LABELS = {
  followers: '粉丝',
  following: '关注',
  tweets: '帖子',
};

export const CAPTURE_OPS = [
  'UserByScreenName',
  'UserByScreenNameV2',
  'Followers',
  'Following',
  'UserTweets',
  'UserTweetsAndReplies',
  'UserMedia',
  'Viewer',
];

export const DEFAULT_SETTINGS = {
  theme: 'system',
  notifications: true,
  badge: true,
  closeSyncTab: true,
  syncMinutes: 10,
  syncTickMs: 800,
};

export const LIMITS = {
  events: 2000,
  tweets: 500,
  people: 50000,
  exPeople: 10000,
  historyDays: 400,
  accounts: 6,
};

export function accountKey(handle) {
  return String(handle || '').replace(/^@/, '').trim().toLowerCase();
}

export function createAccount(handle, now = Date.now()) {
  const clean = String(handle || '').replace(/^@/, '').trim();
  return {
    self: {
      id: null,
      handle: clean,
      name: '',
      avatar: '',
      verified: false,
      createdAt: null,
    },
    profile: { current: null, history: {} },
    people: {
      followers: {},
      following: {},
      exFollowers: {},
      exFollowing: {},
    },
    events: [],
    tweets: {},
    daily: {},
    flags: { followersBaselineAt: null, followingBaselineAt: null },
    sync: { followers: null, following: null, tweets: null },
    createdAt: now,
    updatedAt: now,
  };
}

export function createState(now = Date.now()) {
  return {
    version: SCHEMA_VERSION,
    currentHandle: null,
    accounts: {},
    settings: { ...DEFAULT_SETTINGS },
    meta: {
      createdAt: now,
      updatedAt: now,
      lastCaptureAt: null,
      lastDigestAt: 0,
    },
  };
}

function hydrateAccount(raw, key) {
  const base = createAccount(raw?.self?.handle || key);
  const people = raw?.people || {};
  return {
    ...base,
    ...raw,
    self: { ...base.self, ...(raw?.self || {}) },
    profile: {
      current: raw?.profile?.current ?? null,
      history: raw?.profile?.history && typeof raw.profile.history === 'object' ? raw.profile.history : {},
    },
    people: {
      followers: people.followers && typeof people.followers === 'object' ? people.followers : {},
      following: people.following && typeof people.following === 'object' ? people.following : {},
      exFollowers: people.exFollowers && typeof people.exFollowers === 'object' ? people.exFollowers : {},
      exFollowing: people.exFollowing && typeof people.exFollowing === 'object' ? people.exFollowing : {},
    },
    events: Array.isArray(raw?.events) ? raw.events : [],
    tweets: raw?.tweets && typeof raw.tweets === 'object' ? raw.tweets : {},
    daily: raw?.daily && typeof raw.daily === 'object' ? raw.daily : {},
    flags: { ...base.flags, ...(raw?.flags || {}) },
    sync: { ...base.sync, ...(raw?.sync || {}) },
  };
}

export function hydrateState(raw) {
  const base = createState();
  if (!raw || typeof raw !== 'object') return base;
  const state = {
    ...base,
    ...raw,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...(raw.settings || {}) },
    meta: { ...base.meta, ...(raw.meta || {}) },
    accounts: {},
  };
  for (const [key, acct] of Object.entries(raw.accounts || {})) {
    if (acct && typeof acct === 'object') state.accounts[key] = hydrateAccount(acct, key);
  }
  if (!state.currentHandle || !state.accounts[state.currentHandle]) {
    state.currentHandle = Object.keys(state.accounts)[0] || null;
  }
  return state;
}

function pruneAccounts(state) {
  const keys = Object.keys(state.accounts);
  if (keys.length < LIMITS.accounts) return;
  const candidates = keys
    .filter((k) => k !== state.currentHandle)
    .sort((a, b) => (state.accounts[a].updatedAt || 0) - (state.accounts[b].updatedAt || 0));
  if (candidates.length) delete state.accounts[candidates[0]];
}

export function ensureAccount(state, handle, now = Date.now()) {
  const key = accountKey(handle);
  if (!key) return null;
  if (!state.accounts[key]) {
    pruneAccounts(state);
    state.accounts[key] = createAccount(handle, now);
  }
  const acct = state.accounts[key];
  if (!acct.self.handle) acct.self.handle = String(handle).replace(/^@/, '').trim();
  acct.updatedAt = now;
  if (!state.currentHandle) state.currentHandle = key;
  return acct;
}

export function activeAccount(state) {
  if (!state?.currentHandle) return null;
  return state.accounts?.[state.currentHandle] || null;
}

export function accountSummaries(state) {
  return Object.entries(state?.accounts || {})
    .map(([key, acct]) => ({
      key,
      handle: acct.self?.handle || key,
      name: acct.self?.name || '',
      avatar: acct.self?.avatar || '',
      updatedAt: acct.updatedAt || 0,
      followers: typeof acct.profile?.current?.followers === 'number' ? acct.profile.current.followers : null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sanitizeSettings(patch = {}) {
  const out = {};
  if (['system', 'dark', 'light'].includes(patch.theme)) out.theme = patch.theme;
  for (const key of ['notifications', 'badge', 'closeSyncTab']) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  if (Number.isFinite(Number(patch.syncMinutes))) {
    out.syncMinutes = Math.min(30, Math.max(2, Math.round(Number(patch.syncMinutes))));
  }
  if (Number.isFinite(Number(patch.syncTickMs))) {
    out.syncTickMs = Math.min(2000, Math.max(500, Math.round(Number(patch.syncTickMs))));
  }
  return out;
}
