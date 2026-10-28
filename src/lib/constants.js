/**
 * The whole stored model: who is logged in, and the latest numbers from their
 * profile. Nothing else is kept.
 */

export const STORAGE_KEY = 'xmonitor_account';

/** The storage key used by the removed 1.0 implementation. */
export const LEGACY_STORAGE_KEY = 'xmonitor_state';

export const COUNT_FIELDS = ['followers', 'following', 'tweets', 'likes', 'media', 'listed'];

export function createState() {
  return {
    version: 2,
    self: null,
    profile: null,
    updatedAt: 0,
  };
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Keep whatever is still valid, so an older or partial write cannot break the panel. */
export function hydrateState(raw) {
  const state = createState();
  if (!raw || typeof raw !== 'object') return state;

  const self = raw.self;
  if (self && typeof self === 'object' && text(self.handle)) {
    state.self = {
      id: text(self.id, 40) || null,
      handle: text(self.handle, 15),
      name: text(self.name, 80),
      avatar: /^https?:\/\//.test(self.avatar || '') ? self.avatar : '',
      verified: Boolean(self.verified),
      createdAt: Number.isFinite(Number(self.createdAt)) ? Number(self.createdAt) : null,
    };
  }

  const profile = raw.profile;
  if (profile && typeof profile === 'object' && text(profile.handle)) {
    const counts = {};
    let hasCount = false;
    for (const field of COUNT_FIELDS) {
      const value = Number(profile[field]);
      if (Number.isFinite(value)) {
        counts[field] = value;
        hasCount = true;
      }
    }
    if (hasCount) {
      state.profile = { handle: text(profile.handle, 15), ...counts, ts: Number(profile.ts) || 0 };
    }
  }

  state.updatedAt = Number(raw.updatedAt) || 0;
  return state;
}

export function sameHandle(a, b) {
  return Boolean(a) && String(a).toLowerCase() === String(b).toLowerCase();
}
