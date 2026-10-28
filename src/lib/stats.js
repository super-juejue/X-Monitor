/**
 * Pure aggregation helpers. Everything the side panel displays is derived from
 * the persisted state here, so the UI stays a dumb renderer.
 */

import { accountSummaries } from './constants.js';
import { dayKey, daysBack } from './time.js';

const FIELDS = ['followers', 'following', 'tweets', 'likes', 'media', 'listed'];
const DAY = 86_400_000;

function num(obj, key) {
  const value = obj?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latestSnapshot(history) {
  const keys = Object.keys(history || {}).sort();
  const key = keys[keys.length - 1];
  return key ? { key, ...history[key] } : null;
}

function snapshotBefore(history, beforeDay) {
  const keys = Object.keys(history || {}).filter((k) => k < beforeDay).sort();
  const key = keys[keys.length - 1];
  return key ? { key, snap: history[key] } : null;
}

function countEvents(events, type, day) {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => e?.type === type && e.ts && dayKey(e.ts) === day).length;
}

function engagementOf(tweet) {
  return (tweet?.likes || 0) + (tweet?.retweets || 0) + (tweet?.replies || 0) + (tweet?.quotes || 0);
}

export function computeDashboard(state, now = Date.now()) {
  const key = state?.currentHandle;
  const acct = key ? state.accounts?.[key] : null;
  const live = Boolean(state?.meta?.lastCaptureAt && now - state.meta.lastCaptureAt < 90_000);
  const accounts = accountSummaries(state);
  const settings = state?.settings || {};

  if (!acct) {
    return {
      hasAccount: false,
      hasData: false,
      live,
      settings,
      state,
      accounts,
      activeKey: key || null,
    };
  }

  const history = acct.profile?.history || {};
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now - DAY));
  const days = daysBack(30, new Date(now));
  const snaps = days.map((day) => (history[day] ? { key: day, ...history[day] } : null));

  const series = {};
  for (const field of FIELDS) series[field] = [];
  for (const snap of snaps) {
    if (!snap) continue;
    for (const field of FIELDS) {
      const value = num(snap, field);
      if (value !== null) series[field].push({ day: snap.key, value });
    }
  }

  const latest = acct.profile?.current || latestSnapshot(history);
  const latestDay = latest?.ts ? dayKey(latest.ts) : today;
  const prior = snapshotBefore(history, latestDay);

  const deltas = {};
  for (const field of FIELDS) {
    const a = num(latest, field);
    const b = num(prior?.snap, field);
    deltas[field] = a !== null && b !== null ? a - b : null;
  }

  const todaySnap = history[today] || null;
  const priorBeforeToday = snapshotBefore(history, today);
  let netToday = null;
  if (todaySnap && priorBeforeToday) {
    const a = num(todaySnap, 'followers');
    const b = num(priorBeforeToday.snap, 'followers');
    if (a !== null && b !== null) netToday = a - b;
  }
  const netBasis = priorBeforeToday?.key || null;
  const netLabel = netToday === null
    ? null
    : netBasis === yesterday
      ? '今日'
      : netBasis
        ? '较上次'
        : '今日';

  const daily = acct.daily?.[today] || {};
  const followCount = Number(daily.follow) || countEvents(acct.events, 'follow', today);
  const unfollowCount = Number(daily.unfollow) || countEvents(acct.events, 'unfollow', today);
  const followingNew = Number(daily.following_new) || countEvents(acct.events, 'following_new', today);
  const followingLost = Number(daily.following_lost) || countEvents(acct.events, 'following_lost', today);

  const tweets = Object.values(acct.tweets || {}).filter((t) => t && t.id);
  const todayTweets = tweets.filter((t) => t.createdAt && dayKey(t.createdAt) === today).length;

  // Follower change per day, derived from profile snapshots. A gap attributes
  // the whole change to the day of the later snapshot.
  const netSeries = [];
  let previousFollowers = null;
  for (let i = 0; i < days.length; i += 1) {
    const snap = snaps[i];
    let value = null;
    if (snap) {
      const current = num(snap, 'followers');
      if (current !== null) {
        if (previousFollowers !== null) value = current - previousFollowers;
        previousFollowers = current;
      }
    }
    netSeries.push({ day: days[i], value });
  }

  const followerSeries = snaps.map((snap, index) => ({
    day: days[index],
    value: snap ? num(snap, 'followers') : null,
  }));

  const people = acct.people || {};
  const followers = Object.values(people.followers || {});
  const following = Object.values(people.following || {});
  const exFollowers = Object.values(people.exFollowers || {});
  const exFollowing = Object.values(people.exFollowing || {});

  const sortedFollowers = followers
    .map((p) => ({ ...p, isNew: !p.seeded && p.firstSeen && now - p.firstSeen < 7 * DAY }))
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  const sortedFollowing = following
    .map((p) => ({ ...p, isNew: !p.seeded && p.firstSeen && now - p.firstSeen < 7 * DAY }))
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  const sortedLost = exFollowers
    .map((p) => ({ ...p, lostAt: p.lostAt || p.lastSeen || 0 }))
    .sort((a, b) => b.lostAt - a.lostAt);
  const sortedExFollowing = exFollowing
    .map((p) => ({ ...p, lostAt: p.lostAt || p.lastSeen || 0 }))
    .sort((a, b) => b.lostAt - a.lostAt);
  const newFollowers = sortedFollowers.filter((p) => p.isNew);

  const sortedTweets = tweets.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const mix = { likes: 0, retweets: 0, replies: 0, quotes: 0 };
  for (const tweet of tweets) {
    mix.likes += tweet.likes || 0;
    mix.retweets += tweet.retweets || 0;
    mix.replies += tweet.replies || 0;
    mix.quotes += tweet.quotes || 0;
  }
  const engagement = mix.likes + mix.retweets + mix.replies + mix.quotes;
  const topTweets = tweets.slice().sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 5);

  const activity = [];
  for (const event of acct.events || []) {
    if (event?.ts) activity.push({ kind: 'event', type: event.type, ts: event.ts, event });
  }
  for (const tweet of sortedTweets.slice(0, 20)) {
    if (tweet.createdAt) activity.push({ kind: 'tweet', type: 'tweet', ts: tweet.createdAt, tweet });
  }
  activity.sort((a, b) => b.ts - a.ts);

  const trackedFollowers = followers.length;
  const trackedFollowing = following.length;
  const hasData = Boolean(latest || trackedFollowers || trackedFollowing || sortedTweets.length);

  return {
    hasAccount: true,
    hasData,
    live,
    settings,
    state,
    activeKey: key,
    accounts,
    self: acct.self || {},
    current: latest,
    todaySnap,
    history,
    today: {
      follow: followCount,
      unfollow: unfollowCount,
      followingNew,
      followingLost,
      tweets: todayTweets,
      net: netToday,
      netBasis,
      netLabel,
      listNet: followCount - unfollowCount,
    },
    deltas,
    sparks: series,
    chart: { days, net: netSeries, followers: followerSeries },
    people: {
      followers: sortedFollowers,
      following: sortedFollowing,
      exFollowers: sortedLost,
      exFollowing: sortedExFollowing,
      newFollowers,
      newFollowersCount: newFollowers.length,
      trackedFollowers,
      trackedFollowing,
      trackedLost: sortedLost.length,
    },
    tweets: {
      all: sortedTweets,
      top: topTweets,
      mix,
      engagement,
      avgEngagement: tweets.length ? engagement / tweets.length : 0,
      total: tweets.length,
      today: todayTweets,
    },
    activity: activity.slice(0, 30),
    sync: acct.sync || {},
    flags: acct.flags || {},
    totals: {
      followers: num(latest, 'followers'),
      following: num(latest, 'following'),
      tweets: num(latest, 'tweets'),
      likes: num(latest, 'likes'),
      media: num(latest, 'media'),
      listed: num(latest, 'listed'),
    },
    capturedAt: acct.profile?.current?.ts || null,
  };
}

export function computeBadge(state, now = Date.now()) {
  const acct = activeAccountOf(state);
  if (!acct) return { net: 0, hasData: false };
  const today = dayKey(now);
  const daily = acct.daily?.[today];
  let net = 0;
  let hasData = false;
  if (daily) {
    net = (Number(daily.follow) || 0) - (Number(daily.unfollow) || 0);
    hasData = true;
  } else {
    const history = acct.profile?.history || {};
    const todaySnap = history[today];
    const prior = snapshotBefore(history, today);
    if (todaySnap && prior) {
      const a = num(todaySnap, 'followers');
      const b = num(prior.snap, 'followers');
      if (a !== null && b !== null) {
        net = a - b;
        hasData = true;
      }
    }
  }
  return { net, hasData };
}

function activeAccountOf(state) {
  if (!state?.currentHandle) return null;
  return state.accounts?.[state.currentHandle] || null;
}
