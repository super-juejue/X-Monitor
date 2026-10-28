/**
 * Service worker: the only writer of extension state.
 *
 * Capture path:
 *   page-hook (MAIN) -> content.js (ISOLATED) -> CAPTURE message -> here
 *
 * Sync path:
 *   side panel -> RUN_SYNC -> background opens the relevant x.com tab -> the
 *   content script scrolls it -> background diffs the captured lists.
 */

import {
  STORAGE_KEY,
  LIMITS,
  CAPTURE_OPS,
  activeAccount,
  ensureAccount,
  accountKey,
  hydrateState,
  sanitizeSettings,
} from './lib/constants.js';
import {
  graphqlRoot,
  extractTimeline,
  findOwner,
  findViewerUser,
  handleFromUrl,
  isRateLimitPayload,
} from './lib/parse.js';
import { dayKey } from './lib/time.js';
import { computeBadge } from './lib/stats.js';

const ALARM_BADGE = 'xmonitor-badge';
const ALARM_DIGEST = 'xmonitor-digest';

let stateCache = null;
let statePromise = null;
let saveTimer = null;
let saveChain = Promise.resolve();
let mutationChain = Promise.resolve();
let badgeTimer = null;
let sync = null;
let lastSyncResult = null;
let lastBroadcastAt = 0;
const pendingByOwner = new Map();

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

async function loadState() {
  if (stateCache) return stateCache;
  if (!statePromise) {
    statePromise = chrome.storage.local
      .get(STORAGE_KEY)
      .then((result) => {
        stateCache = hydrateState(result?.[STORAGE_KEY]);
        return stateCache;
      })
      .finally(() => {
        statePromise = null;
      });
  }
  return statePromise;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave().catch(() => {});
  }, 350);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!stateCache) return Promise.resolve();
  const snapshot = structuredClone(stateCache);
  saveChain = saveChain
    .then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }))
    .catch((error) => console.warn('[X Monitor] save failed', error));
  return saveChain;
}

function mutate(fn, { flush = false } = {}) {
  const job = mutationChain.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    state.meta.updatedAt = Date.now();
    if (flush) await flushSave();
    else scheduleSave();
    return result;
  });
  mutationChain = job.then(
    () => {},
    () => {},
  );
  return job;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mergeSelf(base, user) {
  const self = base || {};
  return {
    ...self,
    id: user.id || self.id || null,
    handle: user.handle || self.handle || '',
    name: user.name || self.name || '',
    avatar: user.avatar || self.avatar || '',
    verified: typeof user.verified === 'boolean' ? user.verified : Boolean(self.verified),
    createdAt: user.createdAt || self.createdAt || null,
  };
}

function snapshotProfile(acct, user, now) {
  if (!acct || !user) return;
  const fields = ['followers', 'following', 'tweets', 'likes', 'media', 'listed'];
  const snapshot = { ts: now };
  let hasAny = false;
  for (const field of fields) {
    const value = user[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      snapshot[field] = value;
      hasAny = true;
    }
  }
  if (!hasAny) return;
  acct.profile.current = { ...(acct.profile.current || {}), ...snapshot };
  const key = dayKey(now);
  acct.profile.history[key] = { ...(acct.profile.history[key] || {}), ...snapshot, ts: now };
  const keys = Object.keys(acct.profile.history);
  if (keys.length > LIMITS.historyDays) {
    keys.sort();
    for (const stale of keys.slice(0, keys.length - LIMITS.historyDays)) {
      delete acct.profile.history[stale];
    }
  }
}

function pushEvent(acct, type, user, now) {
  const event = {
    id: `${type}-${user.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    ts: now,
    userId: user.id,
    handle: user.handle || '',
    name: user.name || '',
    avatar: user.avatar || '',
  };
  acct.events.unshift(event);
  if (acct.events.length > LIMITS.events) acct.events.length = LIMITS.events;

  const key = dayKey(now);
  const day = acct.daily[key] || (acct.daily[key] = {
    follow: 0,
    unfollow: 0,
    following_new: 0,
    following_lost: 0,
  });
  day[type] = (day[type] || 0) + 1;

  const dailyKeys = Object.keys(acct.daily);
  if (dailyKeys.length > LIMITS.historyDays) {
    dailyKeys.sort();
    for (const stale of dailyKeys.slice(0, dailyKeys.length - LIMITS.historyDays)) {
      delete acct.daily[stale];
    }
  }
}

function trimMap(map, max, field = 'lastSeen') {
  const entries = Object.entries(map);
  if (entries.length <= max) return;
  entries.sort((a, b) => (a[1]?.[field] || 0) - (b[1]?.[field] || 0));
  for (const [key] of entries.slice(0, entries.length - max)) delete map[key];
}

function applyPeople(acct, kind, users, now) {
  if (!Array.isArray(users) || !users.length) return 0;
  const map = acct.people[kind];
  const exKey = kind === 'followers' ? 'exFollowers' : 'exFollowing';
  const exMap = acct.people[exKey];
  const baselineKey = kind === 'followers' ? 'followersBaselineAt' : 'followingBaselineAt';
  const hasBaseline = Boolean(acct.flags[baselineKey]);
  let added = 0;

  for (const user of users) {
    if (!user?.id) continue;
    const existing = map[user.id];
    if (existing) {
      existing.lastSeen = now;
      if (user.handle) existing.handle = user.handle;
      if (user.name) existing.name = user.name;
      if (user.avatar) existing.avatar = user.avatar;
      if (typeof user.verified === 'boolean') existing.verified = user.verified;
      continue;
    }
    map[user.id] = {
      id: user.id,
      handle: user.handle || '',
      name: user.name || user.handle || '',
      avatar: user.avatar || '',
      verified: Boolean(user.verified),
      firstSeen: now,
      lastSeen: now,
      seeded: !hasBaseline,
    };
    if (exMap[user.id]) delete exMap[user.id];
    added += 1;
    if (hasBaseline) {
      pushEvent(acct, kind === 'followers' ? 'follow' : 'following_new', user, now);
    }
  }

  if (Object.keys(map).length > LIMITS.people) trimMap(map, LIMITS.people, 'lastSeen');
  return added;
}

function removePerson(acct, kind, id, now) {
  const map = acct.people[kind];
  const person = map[id];
  if (!person) return false;
  delete map[id];
  const exKey = kind === 'followers' ? 'exFollowers' : 'exFollowing';
  const exMap = acct.people[exKey];
  exMap[id] = { ...person, lostAt: now };
  if (Object.keys(exMap).length > LIMITS.exPeople) trimMap(exMap, LIMITS.exPeople, 'lostAt');
  pushEvent(acct, kind === 'followers' ? 'unfollow' : 'following_lost', person, now);
  return true;
}

function upsertTweets(acct, tweets, now) {
  if (!Array.isArray(tweets) || !tweets.length) return 0;
  const handle = acct.self?.handle || '';
  let changed = 0;
  for (const tweet of tweets) {
    if (!tweet?.id || !tweet.createdAt) continue;
    const existing = acct.tweets[tweet.id];
    acct.tweets[tweet.id] = {
      ...(existing || {}),
      ...tweet,
      url: `https://x.com/${handle}/status/${tweet.id}`,
      capturedAt: existing?.capturedAt || now,
      updatedAt: now,
    };
    changed += 1;
  }
  if (Object.keys(acct.tweets).length > LIMITS.tweets) {
    const entries = Object.entries(acct.tweets).sort(
      (a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0),
    );
    for (const [id] of entries.slice(LIMITS.tweets)) delete acct.tweets[id];
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Capture ingestion
// ---------------------------------------------------------------------------

function applyCapture(state, op, root, pageUrl, now) {
  const noAccounts = Object.keys(state.accounts).length === 0;
  // The request url is an /i/api/graphql/... endpoint, so it never carries a
  // handle. Owner lookups come from the payload; the page url is the fallback.
  const pageHandle = handleFromUrl(pageUrl || '');
  const owner = findOwner(root);

  if (op === 'Viewer') {
    const user = findViewerUser(root);
    if (!user?.handle) return null;
    const acct = ensureAccount(state, user.handle, now);
    acct.self = mergeSelf(acct.self, user);
    snapshotProfile(acct, user, now);
    acct.updatedAt = now;
    state.meta.lastCaptureAt = now;
    return { accountKey: accountKey(user.handle), kind: 'profile', profile: user };
  }

  if (op.startsWith('UserByScreenName')) {
    const user = owner;
    if (!user?.handle) return null;
    const key = accountKey(user.handle);
    const acct = state.accounts[key];
    if (!acct) {
      if (!noAccounts) return null;
      return { buffered: true, kind: 'profile', ownerHandle: user.handle, ownerKey: key, profile: user, ts: now };
    }
    acct.self = mergeSelf(acct.self, user);
    snapshotProfile(acct, user, now);
    acct.updatedAt = now;
    state.meta.lastCaptureAt = now;
    return { accountKey: key, kind: 'profile', profile: user };
  }

  if (op === 'Followers' || op === 'Following') {
    const handle = owner?.handle || pageHandle;
    if (!handle) return null;
    const key = accountKey(handle);
    const kind = op === 'Followers' ? 'followers' : 'following';
    const { users } = extractTimeline(root);
    const acct = state.accounts[key];
    if (!acct) {
      if (!noAccounts || (!users.length && typeof owner?.followers !== 'number')) return null;
      return { buffered: true, kind, ownerHandle: handle, ownerKey: key, owner, users, ts: now };
    }
    if (owner) acct.self = mergeSelf(acct.self, owner);
    if (typeof owner?.followers === 'number') snapshotProfile(acct, owner, now);
    const added = applyPeople(acct, kind, users, now);
    acct.updatedAt = now;
    state.meta.lastCaptureAt = now;
    return { accountKey: key, kind, owner: owner || { handle }, users, added, empty: users.length === 0 };
  }

  if (op.startsWith('UserTweets') || op === 'UserMedia') {
    // The timeline owner is in the payload; the page url (for example
    // /someone) is only a fallback for responses that omit it.
    const handle = owner?.handle || pageHandle;
    if (!handle) return null;
    const key = accountKey(handle);
    const { tweets } = extractTimeline(root);
    const acct = state.accounts[key];
    if (!acct) {
      if (!noAccounts || !tweets.length) return null;
      return { buffered: true, kind: 'tweets', ownerHandle: handle, ownerKey: key, tweets, ts: now };
    }
    // Replies and quote tweets are authored by the owner; retweets are not.
    const own = tweets.filter((tweet) => !tweet.isRetweet
      && (!tweet.authorHandle || accountKey(tweet.authorHandle) === key));
    if (!own.length) return null;
    upsertTweets(acct, own, now);
    acct.updatedAt = now;
    state.meta.lastCaptureAt = now;
    return { accountKey: key, kind: 'tweets', added: own.length, tweets: own };
  }

  return null;
}

function bufferOutcome(outcome) {
  if (!outcome?.ownerKey) return;
  const now = Date.now();
  let pending = pendingByOwner.get(outcome.ownerKey);
  if (!pending || now - pending.ts > 90_000) {
    pending = {
      ts: now,
      profile: null,
      profileTs: 0,
      followers: [],
      followersTs: 0,
      following: [],
      followingTs: 0,
      tweets: [],
      tweetsTs: 0,
    };
    pendingByOwner.set(outcome.ownerKey, pending);
  }
  pending.ts = now;
  if (outcome.kind === 'profile' && outcome.profile) {
    pending.profile = outcome.profile;
    pending.profileTs = now;
  } else if (outcome.kind === 'followers' || outcome.kind === 'following') {
    const merged = new Map((pending[outcome.kind] || []).map((user) => [user.id, user]));
    for (const user of outcome.users || []) {
      if (user?.id) merged.set(user.id, user);
    }
    pending[outcome.kind] = [...merged.values()].slice(-5000);
    pending[`${outcome.kind}Ts`] = now;
  } else if (outcome.kind === 'tweets') {
    pending.tweets = outcome.tweets || [];
    pending.tweetsTs = now;
  }
  if (pendingByOwner.size > 4) {
    const oldest = [...pendingByOwner.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) pendingByOwner.delete(oldest[0]);
  }
}

async function flushPending(key) {
  const pending = pendingByOwner.get(key);
  if (!pending) return;
  pendingByOwner.delete(key);
  await mutate(
    (state) => {
      const acct = state.accounts[key];
      if (!acct) return;
      if (pending.profile) {
        acct.self = mergeSelf(acct.self, pending.profile);
        snapshotProfile(acct, pending.profile, pending.profileTs || Date.now());
      }
      if (pending.followers.length) {
        applyPeople(acct, 'followers', pending.followers, pending.followersTs || Date.now());
      }
      if (pending.following.length) {
        applyPeople(acct, 'following', pending.following, pending.followingTs || Date.now());
      }
      if (pending.tweets.length) {
        upsertTweets(acct, pending.tweets, Date.now());
      }
    },
    { flush: true },
  );
  if (sync && sync.accountKey === key) {
    if (sync.kind === 'followers') {
      for (const user of pending.followers) if (user.id) sync.seenIds.add(user.id);
    }
    if (sync.kind === 'following') {
      for (const user of pending.following) if (user.id) sync.seenIds.add(user.id);
    }
    sync.captured = Math.max(sync.captured, sync.seenIds.size);
  }
}

async function handleCapture(message, sender) {
  const tabId = sender?.tab?.id;
  const op = typeof message.op === 'string' ? message.op : '';
  const payload = message.payload;

  if (!CAPTURE_OPS.includes(op)) return;
  // Both a hard 429 and a 200 response carrying error 88 mean "you are being
  // rate limited": stop the scan cleanly instead of waiting for the timeout.
  if (message.status === 429 || (payload && isRateLimitPayload(payload))) {
    if (sync && sync.tabId === tabId) finishSync({ endReached: false, reason: 'rate_limited' }).catch(() => {});
    return;
  }

  const root = graphqlRoot(payload);
  if (!root) return;

  const outcome = await mutate((state) => applyCapture(state, op, root, message.pageUrl || '', Date.now()));
  if (!outcome) return;
  if (outcome.buffered) {
    bufferOutcome(outcome);
    return;
  }
  handleSyncOutcome(outcome, tabId);
  maybeUpdateBadge();
}

function handleSyncOutcome(outcome, tabId) {
  if (!sync || sync.finishing) return;
  if (sync.tabId != null && tabId != null && sync.tabId !== tabId) return;
  if (outcome.accountKey !== sync.accountKey) return;

  if (outcome.kind === 'followers' || outcome.kind === 'following') {
    if (outcome.kind !== sync.kind) return;
    const users = outcome.users || [];
    if (users.length) {
      if (sync.endTimer) {
        clearTimeout(sync.endTimer);
        sync.endTimer = null;
      }
      for (const user of users) if (user.id) sync.seenIds.add(user.id);
      sync.captured = sync.seenIds.size;
      sync.pages += 1;
      sync.lastResponseAt = Date.now();
      broadcastSync();
      return;
    }
    const ownerCount = sync.kind === 'followers'
      ? outcome.owner?.followers
      : outcome.owner?.following;
    if (sync.pages > 0 || ownerCount === 0) {
      if (!sync.endTimer) {
        sync.endTimer = setTimeout(() => {
          if (sync && !sync.finishing) {
            finishSync({ endReached: true, reason: 'end_of_list' }).catch(() => {});
          }
        }, 2500);
      }
    }
  } else if (outcome.kind === 'tweets' && sync.kind === 'tweets') {
    sync.pages += 1;
    sync.lastResponseAt = Date.now();
    broadcastSync();
  }
}

// ---------------------------------------------------------------------------
// Sync lifecycle
// ---------------------------------------------------------------------------

function publicSync() {
  if (!sync) return null;
  return {
    running: true,
    id: sync.id,
    kind: sync.kind,
    handle: sync.handle,
    accountKey: sync.accountKey,
    startedAt: sync.startedAt,
    tabId: sync.tabId,
    pages: sync.pages,
    captured: sync.captured,
    ticks: sync.ticks,
    status: sync.status,
    hidden: Boolean(sync.contentHidden),
  };
}

function broadcast(message) {
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    // Panel not open.
  }
}

function broadcastSync(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 700) return;
  lastBroadcastAt = now;
  broadcast({
    type: 'SYNC_STATUS',
    status: publicSync(),
    lastSync: lastSyncResult,
    at: now,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish();
    };
    const timer = setTimeout(finish, Math.min(timeout, 22_000));
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === 'complete') finish();
      })
      .catch(() => finish());
  });
}

async function waitForContent(tabId, timeout) {
  const started = Date.now();
  await waitForTabComplete(tabId, timeout);
  while (Date.now() - started < timeout) {
    if (await pingTab(tabId)) return true;
    await sleep(350);
  }
  return false;
}

async function runSync(kind) {
  if (!['followers', 'following', 'tweets'].includes(kind)) {
    return { ok: false, error: 'BAD_KIND' };
  }
  if (sync) return { ok: false, error: 'SYNC_RUNNING' };

  const state = await loadState();
  const acct = activeAccount(state);
  if (!acct?.self?.handle) return { ok: false, error: 'NO_ACCOUNT' };

  const handle = acct.self.handle;
  const key = accountKey(handle);
  const url = kind === 'followers'
    ? `https://x.com/${handle}/followers`
    : kind === 'following'
      ? `https://x.com/${handle}/following`
      : `https://x.com/${handle}`;
  const minutes = Math.min(30, Math.max(2, Number(state.settings.syncMinutes) || 10));
  const tickMs = Math.min(2000, Math.max(500, Number(state.settings.syncTickMs) || 800));
  const maxTicks = Math.floor((minutes * 60_000) / (tickMs + 320));

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (error) {
    console.warn('[X Monitor] cannot open sync tab', error);
    return { ok: false, error: 'TAB_FAILED' };
  }
  if (tab.windowId != null) {
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  sync = {
    id: crypto.randomUUID(),
    kind,
    handle,
    accountKey: key,
    url,
    tabId: tab.id,
    createdTab: true,
    startedAt: Date.now(),
    seenIds: new Set(),
    pages: 0,
    captured: 0,
    ticks: 0,
    status: 'starting',
    finishing: false,
    contentHidden: false,
    lastResponseAt: 0,
    endTimer: null,
    watchdog: null,
  };
  broadcastSync(true);

  const ready = await waitForContent(tab.id, 25_000);
  if (!sync || sync.tabId !== tab.id) return { ok: false, error: 'CANCELLED' };
  if (!ready) {
    await finishSync({ endReached: false, reason: 'page_not_ready' });
    return { ok: false, error: 'PAGE_NOT_READY' };
  }

  sync.status = 'running';
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SYNC_START',
      sessionId: sync.id,
      kind,
      url,
      tickMs,
      maxTicks,
    });
  } catch {
    await finishSync({ endReached: false, reason: 'disconnected' });
    return { ok: false, error: 'FAILED' };
  }
  broadcastSync(true);

  sync.watchdog = setTimeout(() => {
    if (sync && !sync.finishing) {
      finishSync({ endReached: false, reason: 'timeout' }).catch(() => {});
    }
  }, minutes * 60_000 + 120_000);

  return { ok: true, tabId: tab.id };
}

async function finishSync({ endReached, reason }) {
  const current = sync;
  if (!current || current.finishing) return;
  current.finishing = true;
  current.status = 'finishing';
  if (current.endTimer) {
    clearTimeout(current.endTimer);
    current.endTimer = null;
  }
  if (current.watchdog) {
    clearTimeout(current.watchdog);
    current.watchdog = null;
  }
  broadcastSync(true);

  if (current.tabId != null) {
    chrome.tabs
      .sendMessage(current.tabId, { type: 'SYNC_STOP', sessionId: current.id })
      .catch(() => {});
  }

  const captured = current.seenIds.size;
  const finalize = await mutate(
    (state) => {
      const acct = state.accounts[current.accountKey];
      if (!acct) return { ok: false, total: 0, expected: null, complete: false };

      const now = Date.now();
      const isFollowers = current.kind === 'followers';
      const isFollowing = current.kind === 'following';
      const expected = isFollowing
        ? (typeof acct.profile?.current?.following === 'number' ? acct.profile.current.following : null)
        : (typeof acct.profile?.current?.followers === 'number' ? acct.profile.current.followers : null);
      const suspiciousRatio = 0.2;
      // A scan that captured nobody proves nothing, unless the account really
      // has an empty list. Never let it set a baseline or remove anyone.
      const capturedNothing = captured === 0 && expected !== 0;
      const safeEnd = Boolean(endReached) && !capturedNothing;

      if (isFollowers || isFollowing) {
        const kind = isFollowers ? 'followers' : 'following';
        const map = acct.people[kind];
        const baselineKey = isFollowers ? 'followersBaselineAt' : 'followingBaselineAt';
        const hadBaseline = Boolean(acct.flags[baselineKey]);
        const missing = Object.keys(map).filter((id) => {
          const person = map[id];
          if (!person) return false;
          if (current.seenIds.has(id)) return false;
          // Anything captured after the scan started may come from another
          // tab the user is browsing, so never treat those as gone.
          return (person.lastSeen || 0) <= current.startedAt;
        });
        // A scan that "lost" a fifth of the list is a broken scan, not a mass
        // unfollow event. Keep the data and report it as incomplete.
        const suspicious = safeEnd
          && hadBaseline
          && missing.length > Math.max(25, Math.round(Object.keys(map).length * suspiciousRatio));

        if (safeEnd && !suspicious) {
          if (hadBaseline) {
            for (const id of missing) removePerson(acct, kind, id, now);
          } else {
            // First complete scan = baseline. Do not invent follow events.
            for (const id of missing) delete map[id];
          }
          acct.flags[baselineKey] = acct.flags[baselineKey] || now;
        }

        const complete = safeEnd && !suspicious;
        acct.sync[kind] = {
          lastAt: now,
          lastCompleteAt: complete ? now : (acct.sync[kind]?.lastCompleteAt || null),
          complete,
          count: Object.keys(map).length,
          lastReason: capturedNothing ? 'empty_scan' : suspicious ? 'partial' : reason,
          lastCaptured: captured,
        };
        acct.updatedAt = now;
        return { ok: true, total: Object.keys(map).length, expected, complete };
      }

      if (current.kind === 'tweets') {
        // Tweets are additive: partial scans are still useful, only a failed
        // start or a cancel counts as incomplete.
        const complete = !['cancelled', 'rate_limited', 'login_required', 'navigated', 'disconnected', 'timeout', 'page_not_ready', 'tab_closed'].includes(reason);
        acct.sync.tweets = {
          lastAt: now,
          count: Object.keys(acct.tweets || {}).length,
          lastReason: reason,
          lastCaptured: captured,
        };
        acct.updatedAt = now;
        return {
          ok: true,
          total: Object.keys(acct.tweets || {}).length,
          expected,
          complete,
        };
      }

      return { ok: false, total: 0, expected, complete: false };
    },
    { flush: true },
  );

  const settings = stateCache?.settings || {};
  if (current.createdTab && current.tabId != null && settings.closeSyncTab) {
    chrome.tabs.remove(current.tabId).catch(() => {});
  }

  lastSyncResult = {
    kind: current.kind,
    accountKey: current.accountKey,
    handle: current.handle,
    captured,
    complete: Boolean(finalize?.complete),
    reason,
    at: Date.now(),
    total: finalize?.total ?? 0,
    expected: finalize?.expected ?? null,
  };

  sync = null;
  broadcastSync(true);
  maybeUpdateBadge();
}

async function cancelSync() {
  if (!sync) return { ok: false };
  await finishSync({ endReached: false, reason: 'cancelled' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Self detection + account switching
// ---------------------------------------------------------------------------

async function handleSelfHint(self, sender) {
  if (!self || typeof self.handle !== 'string') return { ok: false };
  const handle = self.handle.replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false };
  const key = accountKey(handle);

  let isActive = true;
  if (sender?.tab?.id != null) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      isActive = activeTab?.id === sender.tab.id;
    } catch {
      isActive = true;
    }
  }

  const result = await mutate(
    (state) => {
      const existed = Boolean(state.accounts[key]);
      const acct = ensureAccount(state, handle);
      if (!acct) return { ok: false };
      if (self.name && !acct.self.name) acct.self.name = String(self.name).slice(0, 80);
      if (self.avatar && /^https?:\/\//.test(self.avatar)) acct.self.avatar = self.avatar;
      if (!state.currentHandle || (isActive && (!sync || sync.accountKey === key))) {
        state.currentHandle = key;
      }
      acct.updatedAt = Date.now();
      return { ok: true, isNew: !existed };
    },
    { flush: true },
  );

  await flushPending(key);
  if (result?.ok) maybeUpdateBadge();
  return result;
}

async function setActiveAccount(handle) {
  const key = accountKey(handle);
  await mutate(
    (state) => {
      if (state.accounts[key]) state.currentHandle = key;
    },
    { flush: true },
  );
  await updateBadge();
}

async function clearActiveAccount() {
  if (sync) await finishSync({ endReached: false, reason: 'cancelled' });
  await mutate(
    (state) => {
      if (state.currentHandle) delete state.accounts[state.currentHandle];
      state.currentHandle = Object.keys(state.accounts)[0] || null;
      state.meta.lastCaptureAt = null;
    },
    { flush: true },
  );
  await updateBadge();
}

async function updateSettings(patch) {
  const safe = sanitizeSettings(patch);
  await mutate(
    (state) => {
      state.settings = { ...state.settings, ...safe };
    },
    { flush: true },
  );
  setupAlarms();
  await updateBadge();
}

// ---------------------------------------------------------------------------
// Badge / notifications
// ---------------------------------------------------------------------------

function maybeUpdateBadge() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadge().catch(() => {});
  }, 700);
}

async function updateBadge() {
  const state = await loadState();
  if (!state.settings.badge) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  const { net, hasData } = computeBadge(state);
  if (!hasData || !net) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  const magnitude = Math.abs(net);
  const text = `${net > 0 ? '+' : '-'}${magnitude > 999 ? '999' : magnitude}`;
  chrome.action.setBadgeBackgroundColor({ color: net > 0 ? '#10B981' : '#F43F5E' }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

function setupAlarms() {
  chrome.alarms.create(ALARM_BADGE, { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_DIGEST, { periodInMinutes: 30 });
}

async function maybeDigest() {
  const state = await loadState();
  if (!state.settings.notifications) return;
  const acct = activeAccount(state);
  if (!acct?.self?.handle) return;

  const now = Date.now();
  const since = state.meta.lastDigestAt || 0;
  const events = (acct.events || []).filter(
    (event) => event.ts > since
      && event.ts > now - 24 * 60 * 60_000
      && (event.type === 'follow' || event.type === 'unfollow'),
  );
  if (!events.length) return;

  const follows = events.filter((event) => event.type === 'follow').length;
  const unfollows = events.filter((event) => event.type === 'unfollow').length;
  const parts = [];
  if (follows) parts.push(`新增 ${follows} 位关注者`);
  if (unfollows) parts.push(`${unfollows} 人取关`);

  const id = `xmonitor-digest-${now}`;
  chrome.notifications
    .create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'X Monitor',
      message: parts.join(' · '),
      contextMessage: `@${acct.self.handle}`,
      priority: 1,
    })
    .catch(() => {});

  await mutate(
    (next) => {
      next.meta.lastDigestAt = now;
    },
    { flush: true },
  );
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('xmonitor')) return;
  chrome.notifications.clear(id).catch(() => {});
  const state = await loadState();
  const acct = activeAccount(state);
  if (acct?.self?.handle) {
    chrome.tabs.create({ url: `https://x.com/${acct.self.handle}` }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Messaging / lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case 'CAPTURE':
      handleCapture(message, sender)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.warn('[X Monitor] capture failed', error);
          sendResponse({ ok: false });
        });
      return true;

    case 'SELF_HINT':
      handleSelfHint(message.self, sender)
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'GET_SYNC_STATUS':
      sendResponse({ status: publicSync(), lastSync: lastSyncResult });
      return undefined;

    case 'RUN_SYNC':
      runSync(message.kind)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: 'FAILED', message: String(error?.message || error) }));
      return true;

    case 'CANCEL_SYNC':
      cancelSync()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'UPDATE_SETTINGS':
      updateSettings(message.settings)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'SET_ACCOUNT':
      setActiveAccount(message.handle)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'CLEAR_ACCOUNT':
      clearActiveAccount()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'REFRESH_BADGE':
      updateBadge()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    default:
      return undefined;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'x-monitor-sync') return;
  const tabId = port.sender?.tab?.id;
  if (!sync || tabId == null || sync.tabId !== tabId) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
    return;
  }

  port.onMessage.addListener((message) => {
    if (!sync || sync.tabId !== tabId) return;
    if (message?.sessionId && message.sessionId !== sync.id) return;

    if (message?.type === 'hello') {
      sync.status = 'running';
      sync.contentHidden = Boolean(message.hidden);
      broadcastSync(true);
    } else if (message?.type === 'progress') {
      sync.ticks = Number(message.ticks) || sync.ticks;
      sync.contentHidden = Boolean(message.hidden);
      broadcastSync();
    } else if (message?.type === 'finish') {
      finishSync({
        endReached: Boolean(message.endReached),
        reason: message.reason || 'finished',
      }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (sync && sync.tabId === tabId && !sync.finishing) {
      finishSync({ endReached: false, reason: 'disconnected' }).catch(() => {});
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sync && sync.tabId === tabId && !sync.finishing) {
    finishSync({ endReached: false, reason: 'tab_closed' }).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BADGE) updateBadge().catch(() => {});
  if (alarm.name === ALARM_DIGEST) maybeDigest().catch(() => {});
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function bootstrap() {
  await loadState();
  setupAlarms();
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  maybeUpdateBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch(() => {});
});
bootstrap().catch(() => {});
