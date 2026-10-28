/**
 * Parsers for X's internal GraphQL payloads.
 *
 * X renames query ids frequently, so every parser keys off the operation name
 * found in the URL, never the id. Shapes below cover both the older
 * ("legacy" holds everything) and newer ("core" + "legacy") user schemas.
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

const RESERVED_PATHS = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
  'compose', 'bookmarks', 'jobs', 'communities', 'premium', 'lists', 'tos',
  'privacy', 'login', 'logout', 'signup', 'account', 'download', 'intent',
]);

/** First path segment if it looks like a handle, e.g. /jack/followers -> jack */
export function handleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://x.com');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0];
    if (RESERVED_PATHS.has(first.toLowerCase())) return null;
    return /^[A-Za-z0-9_]{1,15}$/.test(first) ? first : null;
  } catch {
    return null;
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
    protected: Boolean(legacy.protected || user.privacy?.protected),
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

export function normalizeTweet(input) {
  if (!input || typeof input !== 'object') return null;
  let tweet = input;
  if (tweet.__typename === 'TweetWithVisibilityResults' && tweet.tweet) tweet = tweet.tweet;
  if (!tweet || typeof tweet !== 'object' || tweet.__typename === 'TweetUnavailable') return null;

  const legacy = tweet.legacy && typeof tweet.legacy === 'object' ? tweet.legacy : {};
  const core = tweet.core && typeof tweet.core === 'object' ? tweet.core : {};
  const author = core.user_results?.result ? normalizeUser(core.user_results.result) : null;

  const note = tweet.note_tweet?.note_tweet_results?.result;
  const text = note?.text || legacy.full_text || tweet.full_text || '';
  const id = tweet.rest_id || legacy.id_str || '';
  if (!id) return null;

  return {
    id: String(id),
    text,
    createdAt: parseTwitterDate(legacy.created_at || core.created_at),
    authorHandle: author?.handle || legacy.user?.screen_name || '',
    authorName: author?.name || legacy.user?.name || '',
    authorAvatar: author?.avatar || '',
    likes: toCount(legacy.favorite_count) ?? 0,
    retweets: toCount(legacy.retweet_count) ?? 0,
    replies: toCount(legacy.reply_count) ?? 0,
    quotes: toCount(legacy.quote_count) ?? 0,
    views: toCount(tweet.views?.count) ?? toCount(legacy.views?.count),
    isRetweet: Boolean(legacy.retweeted_status_result),
    media: legacy.entities?.media?.[0]?.media_url_https || null,
    lang: legacy.lang || '',
  };
}

function instructionScore(list) {
  let score = 0;
  for (const ins of list) {
    if (Array.isArray(ins?.entries)) score += ins.entries.length;
    if (Array.isArray(ins?.moduleItems)) score += ins.moduleItems.length;
  }
  return score;
}

function findInstructions(root) {
  const candidates = [
    root?.user?.result?.timeline?.timeline?.instructions,
    root?.user?.result?.timeline_v2?.timeline?.instructions,
    root?.user?.result?.timeline?.instructions,
    root?.timeline?.timeline?.instructions,
    root?.timeline?.instructions,
    root?.home?.home_timeline_urt?.instructions,
  ].filter(Array.isArray);
  if (!candidates.length) {
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node.instructions) && node.instructions.length) {
        candidates.push(node.instructions);
        return;
      }
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    };
    visit(root, 0);
  }
  candidates.sort((a, b) => instructionScore(b) - instructionScore(a));
  return candidates[0] || [];
}

/**
 * Pull timeline users / tweets out of any GraphQL timeline response.
 */
export function extractTimeline(root) {
  const instructions = findInstructions(root);
  const users = [];
  const tweets = [];
  const seenUsers = new Set();
  const seenTweets = new Set();
  let bottomCursor = null;

  const addUser = (raw) => {
    const user = normalizeUser(raw);
    if (!user?.id || seenUsers.has(user.id)) return;
    seenUsers.add(user.id);
    users.push(user);
  };
  const addTweet = (raw) => {
    const tweet = normalizeTweet(raw);
    if (!tweet?.id || seenTweets.has(tweet.id)) return;
    seenTweets.add(tweet.id);
    tweets.push(tweet);
  };
  const readContent = (content) => {
    if (!content || typeof content !== 'object') return;
    if (content.itemType === 'TimelineUser' || content.user_results) {
      addUser(content.user_results?.result);
    }
    if (content.itemType === 'TimelineTweet' || content.tweet_results) {
      addTweet(content.tweet_results?.result);
    }
  };
  const readItem = (item) => {
    if (!item) return;
    readContent(item.item?.itemContent || item.itemContent);
  };

  for (const ins of instructions) {
    if (!ins || typeof ins !== 'object') continue;
    if (ins.type === 'TimelineAddEntries' && Array.isArray(ins.entries)) {
      for (const entry of ins.entries) {
        const content = entry?.content;
        if (!content) continue;
        if (content.cursorType === 'Bottom' || /^cursor-bottom/.test(entry.entryId || '')) {
          bottomCursor = content.value || bottomCursor;
        }
        if (content.itemContent) readContent(content.itemContent);
        if (Array.isArray(content.items)) content.items.forEach(readItem);
      }
    } else if (ins.type === 'TimelineAddToModule' && Array.isArray(ins.moduleItems)) {
      ins.moduleItems.forEach(readItem);
    } else if (ins.type === 'TimelineReplaceEntry') {
      const content = ins.entry?.content;
      if (content?.cursorType === 'Bottom') bottomCursor = content.value || bottomCursor;
    }
  }

  return { users, tweets, bottomCursor };
}

/** The account that owns a Followers/Following/Tweets timeline. */
export function findOwner(root) {
  return normalizeUser(root?.user?.result ?? root?.user_result?.result);
}

/** Logged-in account from the Viewer query, if present. */
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

export function isRateLimitPayload(payload) {
  const errors = payload?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((err) => err?.code === 88 || /rate limit/i.test(String(err?.message || '')));
}
