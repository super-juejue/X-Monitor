/**
 * Parsers for X's internal GraphQL payloads.
 *
 * X renames query ids constantly, so everything keys off the operation name in
 * the url, never the id. Shapes cover both the older schema (counts in
 * `legacy`) and the newer one (`core` + `legacy`).
 */

import { parseTwitterDate } from './time.js';

export function graphqlRoot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.data ?? payload;
}

export function opFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://x.com');
    const parts = url.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('graphql');
    return i >= 0 ? parts[i + 2] || '' : '';
  } catch {
    return '';
  }
}

export function toCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeUser(input) {
  if (!input || typeof input !== 'object') return null;
  let user = input;
  if (user.__typename === 'UserWithVisibilityResults' && user.user) user = user.user;
  if (!user || typeof user !== 'object') return null;
  if (user.__typename === 'UserUnavailable' || user.reason) return null;

  const legacy = user.legacy && typeof user.legacy === 'object' ? user.legacy : {};
  const core = user.core && typeof user.core === 'object' ? user.core : {};
  const handle = core.screen_name || legacy.screen_name || user.screen_name || '';
  const id = user.rest_id || user.id_str || legacy.id_str || '';
  if (!handle && !id) return null;

  return {
    id: String(id || ''),
    handle: String(handle || ''),
    name: core.name || legacy.name || user.name || handle || '',
    avatar: user.avatar?.image_url || legacy.profile_image_url_https || '',
    verified: Boolean(user.is_blue_verified || legacy.verified),
    createdAt: parseTwitterDate(core.created_at || legacy.created_at || user.created_at),
    description: legacy.description || '',
    location: legacy.location || '',
    followers: toCount(legacy.followers_count),
    following: toCount(legacy.friends_count),
    tweets: toCount(legacy.statuses_count),
    likes: toCount(legacy.favourites_count),
    media: toCount(legacy.media_count),
    listed: toCount(legacy.listed_count),
  };
}

/** The logged-in account from the Viewer query, if present. */
export function findViewerUser(root) {
  const direct = root?.viewer?.user_results?.result
    || root?.viewer_v2?.user_results?.result
    || root?.user_results?.result;
  if (direct) return normalizeUser(direct);

  const candidates = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
    seen.add(node);
    if (node.user_results?.result) {
      const user = normalizeUser(node.user_results.result);
      if (user && typeof user.followers === 'number') candidates.push(user);
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  visit(root, 0);
  const unique = [...new Map(candidates.map((u) => [u.id || u.handle, u])).values()];
  return unique.length === 1 ? unique[0] : null;
}

/** The subject of a UserByScreenName query. */
export function findOwner(root) {
  return normalizeUser(root?.user?.result ?? root?.user_result?.result);
}
