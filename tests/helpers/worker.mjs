/**
 * Test harness for the service worker.
 *
 * Installs a minimal `chrome` stub, then imports background.js so the worker
 * runs against an in-memory store. Each test file gets its own process, so the
 * store starts empty per file.
 */

export const STORAGE_KEY = 'xmonitor_account';

export async function bootWorker(options = {}) {
  const store = { ...(options.store || {}) };
  let messageListener = null;

  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: clone(store[key]) };
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) out[k] = clone(store[k]);
            return out;
          }
          return clone(store);
        },
        async set(patch) {
          for (const [k, v] of Object.entries(patch)) store[k] = clone(v);
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) delete store[k];
        },
      },
    },
    runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (path) => `chrome-extension://test/${path}`,
      async sendMessage() {},
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
  };

  await import('../../src/background.js');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const call = (message, sender = {}) => new Promise((resolve) => {
    const ret = messageListener(message, sender, resolve);
    if (ret !== true) resolve(undefined);
  });

  const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  return { store, call, wait, stateNow: () => store[STORAGE_KEY] };
}

// ---------------------------------------------------------------------------
// Fixtures shaped like X's GraphQL responses
// ---------------------------------------------------------------------------

export function user(overrides = {}) {
  const { id = '42', handle = 'testuser', counts = {}, ...rest } = overrides;
  return {
    __typename: 'User',
    rest_id: id,
    core: { screen_name: handle, name: rest.name || 'Test User', created_at: 'Wed Oct 10 20:19:24 +0000 2018' },
    avatar: { image_url: `https://pbs.twimg.com/profile_images/${id}/x_normal.jpg` },
    is_blue_verified: rest.verified ?? true,
    legacy: {
      followers_count: counts.followers ?? 1200,
      friends_count: counts.following ?? 248,
      statuses_count: counts.tweets ?? 1284,
      favourites_count: counts.likes ?? 5821,
      media_count: counts.media ?? 96,
      listed_count: counts.listed ?? 12,
    },
  };
}

export const viewerPayload = (u) => ({
  data: { viewer: { user_results: { result: u } } },
});

export const screenNamePayload = (u) => ({
  data: { user: { result: u } },
});
