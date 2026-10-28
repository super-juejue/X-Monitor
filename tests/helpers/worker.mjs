/**
 * Test harness for the service worker.
 *
 * Installs a minimal `chrome` stub, then imports background.js so the worker
 * runs against an in-memory store. Each test file gets its own module instance
 * and its own process, so the store starts empty (or seeded) per file.
 */

export const STORAGE_KEY = 'xmonitor_state';

/**
 * @param seed initial stored state
 * @param options.reuseTab pretend the user already has an x.com followers tab
 *   open, so a sync has to reuse it instead of creating one.
 * @param options.tabUrl url reported for that pre-existing tab
 */
export async function bootWorker(seed = null, options = {}) {
  const store = {};
  if (seed) store[STORAGE_KEY] = structuredClone(seed);

  const reuseTab = Boolean(options.reuseTab);
  const tabUrl = options.tabUrl || 'https://x.com/testuser/followers';

  const badge = { text: '', color: '' };
  const notifications = [];
  const removedTabs = [];
  const reloadedTabs = [];
  const updatedTabs = [];
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  let messageListener = null;
  let connectListener = null;
  let tabCounter = 100;

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: clone(store[key]) };
          return clone(store);
        },
        async set(patch) {
          for (const [k, v] of Object.entries(patch)) store[k] = clone(v);
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      onConnect: { addListener(fn) { connectListener = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (path) => `chrome-extension://test/${path}`,
      async sendMessage() {},
    },
    tabs: {
      async create() {
        tabCounter += 1;
        return { id: tabCounter, windowId: 1, status: 'loading' };
      },
      async get(tabId) {
        return { id: tabId, status: 'complete' };
      },
      async query() {
        if (!reuseTab) return [{ id: 1, active: true }];
        return [{ id: 1, active: true, url: tabUrl, lastAccessed: Date.now() }];
      },
      async sendMessage(tabId, message) {
        if (message?.type === 'PING') {
          // A live document answers with the moment it was created. The reused
          // tab is reloaded, so the answer is always newer than the reload.
          return { ok: true, href: tabUrl, docStartedAt: Date.now() };
        }
        return { ok: true };
      },
      async remove(tabId) {
        removedTabs.push(tabId);
      },
      async update(tabId, props) {
        updatedTabs.push({ tabId, props });
        return { id: tabId, ...props };
      },
      async reload(tabId) {
        reloadedTabs.push(tabId);
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: {
      async update() {},
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
    },
    notifications: {
      async create(id, options) {
        notifications.push({ id, ...options });
        return id;
      },
      async clear() {},
      onClicked: { addListener() {} },
    },
    alarms: {
      create() {},
      onAlarm: { addListener() {} },
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

  const wait = (ms = 420) => new Promise((resolve) => setTimeout(resolve, ms));

  const stateNow = () => store[STORAGE_KEY];

  const openSyncPort = (tabId) => {
    let onMessage = null;
    let onDisconnect = null;
    connectListener({
      name: 'x-monitor-sync',
      sender: { tab: { id: tabId } },
      onMessage: { addListener(fn) { onMessage = fn; } },
      onDisconnect: { addListener(fn) { onDisconnect = fn; } },
      disconnect() {},
      postMessage() {},
    });
    if (!onMessage) throw new Error('background did not register a sync port listener');
    return {
      send: (message) => onMessage(message),
      disconnect: () => onDisconnect?.(),
    };
  };

  return { store, badge, notifications, removedTabs, reloadedTabs, updatedTabs, call, wait, stateNow, openSyncPort };
}

// ---------------------------------------------------------------------------
// GraphQL fixtures
// ---------------------------------------------------------------------------

export const profile = {
  __typename: 'User',
  rest_id: '42',
  core: { screen_name: 'testuser', name: 'Test User', created_at: 'Wed Oct 10 20:19:24 +0000 2018' },
  avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
  is_blue_verified: true,
  legacy: {
    followers_count: 3,
    friends_count: 40,
    statuses_count: 120,
    favourites_count: 300,
    media_count: 12,
    listed_count: 2,
  },
};

export function person(id, handle, followers = 1) {
  return {
    __typename: 'User',
    rest_id: id,
    core: { screen_name: handle, name: handle.toUpperCase() },
    legacy: {
      followers_count: followers,
      friends_count: 1,
      profile_image_url_https: `https://pbs.twimg.com/profile_images/${id}/x_normal.jpg`,
    },
  };
}

export function followersPayload(users, ownerCount = 3) {
  const owner = { ...profile, legacy: { ...profile.legacy, followers_count: ownerCount } };
  return {
    data: {
      user: {
        result: {
          ...owner,
          timeline: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: [
                  ...users.map((user) => ({
                    entryId: `user-${user.rest_id}`,
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: { itemType: 'TimelineUser', user_results: { result: user } },
                    },
                  })),
                  {
                    entryId: 'cursor-bottom-1',
                    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'abc' },
                  },
                ],
              }],
            },
          },
        },
      },
    },
  };
}

export const followersCapture = (payload) => ({
  type: 'CAPTURE',
  op: 'Followers',
  url: 'https://x.com/testuser/followers',
  status: 200,
  payload,
});
