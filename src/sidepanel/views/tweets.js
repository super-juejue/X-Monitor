import { donut } from '../charts.js';
import { formatBig, formatCompact, formatDateTime, formatInt, relativeTime } from '../../lib/time.js';
import { avatar, emptyState, enter, esc, icon, verifiedMark } from '../ui.js';

export function tweetsView(ctx) {
  const dash = ctx.dash;
  if (!dash.hasAccount) {
    return `<div class="stack">${emptyState({
      iconName: 'chart',
      title: '还没有识别到账号',
      body: '在 Chrome 打开并登录 x.com，插件会自动识别你的账号。',
      action: `<button class="btn primary" data-action="open-x">${icon('external', 14)} 打开 X</button>`,
    })}</div>`;
  }

  const busy = Boolean(ctx.ui.sync?.running);
  const lastSync = dash.sync?.tweets?.lastAt;
  const hasTweets = dash.tweets.total > 0;

  return `<div class="stack">
    <div class="view-head">
      <div>
        <h1 class="view-title">帖子与互动</h1>
        <p class="view-sub">
          已记录 ${formatInt(dash.tweets.total)} 条
          ${lastSync ? ` · 最近更新 ${relativeTime(lastSync, ctx.now)}` : ''}
        </p>
      </div>
      <button class="btn primary sm" data-action="sync" data-kind="tweets" ${busy ? 'disabled' : ''}>
        ${icon('refresh', 13)} 更新帖子
      </button>
    </div>

    ${hasTweets ? summaryTiles(dash) : ''}
    ${hasTweets ? mixCard(ctx) : ''}
    ${hasTweets ? topTweetCard(ctx) : ''}

    ${hasTweets
      ? `<div class="tweet-list">${visibleTweets(ctx).map((tweet, index) => tweetCard(tweet, index, ctx)).join('')}</div>`
      : emptyState({
        iconName: 'chart',
        title: '还没有帖子数据',
        body: '打开你的主页并同步帖子，就能看到每条帖子的点赞、转发、回复与阅读数据。',
        action: `<div class="empty-actions">
          <button class="btn primary" data-action="sync" data-kind="tweets">${icon('refresh', 13)} 同步帖子</button>
          <button class="btn" data-action="open-profile">${icon('external', 13)} 打开主页</button>
        </div>`,
      })}

    ${hasTweets && dash.tweets.all.length > visibleTweets(ctx).length
      ? `<button class="btn ghost wide" data-action="more-tweets">加载更多帖子</button>`
      : ''}

    ${hasTweets ? `<p class="footnote">${icon('shield', 12)} 仅统计你本人发布的原创帖子（不含转推），数据来自主页帖子时间线。</p>` : ''}
  </div>`;
}

function summaryTiles(dash) {
  const items = [
    { label: '已记录', value: dash.tweets.total, iconName: 'list' },
    { label: '总点赞', value: dash.tweets.mix.likes, iconName: 'heart' },
    { label: '总转发', value: dash.tweets.mix.retweets, iconName: 'repeat' },
    { label: '平均互动', value: Math.round(dash.tweets.avgEngagement), iconName: 'sparkles' },
  ];
  return `<div class="stats-grid tweet-stats">${items.map((item) => `<div class="mini-card">
    <div class="mini-head"><span>${icon(item.iconName, 11)} ${esc(item.label)}</span></div>
    <div class="mini-value" data-count="${item.value}" data-count-key="tweets.${item.label}" data-count-format="big">${formatBig(item.value)}</div>
  </div>`).join('')}</div>`;
}

function mixCard(ctx) {
  const mix = ctx.dash.tweets.mix;
  const segments = [
    { key: 'likes', label: '点赞', value: mix.likes, color: '#fb7185' },
    { key: 'retweets', label: '转发', value: mix.retweets, color: '#34d399' },
    { key: 'replies', label: '回复', value: mix.replies, color: '#22d3ee' },
    { key: 'quotes', label: '引用', value: mix.quotes, color: '#fbbf24' },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) {
    return `<article class="card">
      <header class="card-head"><div><h2>互动构成</h2><p class="card-sub">点赞 · 转发 · 回复 · 引用</p></div></header>
      <div class="chart-empty"><span>这些帖子还没有互动数据</span></div>
    </article>`;
  }
  return `<article class="card">
    <header class="card-head">
      <div><h2>互动构成</h2><p class="card-sub">累计 ${formatCompact(total)} 次互动</p></div>
    </header>
    <div class="mix-body">
      ${donut(segments, { animate: ctx.animate })}
      <div class="legend">
        ${segments.map((segment) => `<div class="legend-row">
          <span class="legend-dot" style="background:${segment.color}"></span>
          <span class="legend-label">${segment.label}</span>
          <strong>${formatCompact(segment.value)}</strong>
          <span class="legend-pct">${Math.round((segment.value / total) * 100)}%</span>
        </div>`).join('')}
      </div>
    </div>
  </article>`;
}

function topTweetCard(ctx) {
  const top = ctx.dash.tweets.top[0];
  if (!top) return '';
  const total = (top.likes || 0) + (top.retweets || 0) + (top.replies || 0) + (top.quotes || 0);
  if (!total) return '';
  return `<article class="card top-tweet">
    <div class="top-tweet-head">
      <span class="hot-badge">${icon('sparkles', 10)} 最热帖子</span>
      <a class="text-btn" href="${esc(top.url || '#')}" target="_blank" rel="noreferrer">${icon('external', 12)} 打开</a>
    </div>
    <p class="top-tweet-text">${esc(top.text || '')}</p>
    <div class="top-tweet-meta">
      <span>${formatDateTime(top.createdAt, ctx.now)}</span>
      <span class="hot-engagement">${icon('heart', 11)} ${formatCompact(top.likes || 0)} · ${icon('repeat', 11)} ${formatCompact(top.retweets || 0)} · ${icon('message', 11)} ${formatCompact(top.replies || 0)}</span>
    </div>
  </article>`;
}

function visibleTweets(ctx) {
  const limit = Math.max(20, Number(ctx.ui.tweetLimit) || 60);
  return ctx.dash.tweets.all.slice(0, limit);
}

function tweetCard(tweet, index, ctx) {
  const total = (tweet.likes || 0) + (tweet.retweets || 0) + (tweet.replies || 0) + (tweet.quotes || 0);
  const url = tweet.url || '#';
  return `<article ${enter(index, ctx.animate, 'card tweet-card')} data-tweet-id="${esc(tweet.id)}">
    <header class="tweet-head">
      <div class="tweet-author">
        ${avatar({ name: ctx.dash.self?.name, handle: ctx.dash.self?.handle, avatar: ctx.dash.self?.avatar }, 26)}
        <div>
          <div class="tweet-author-name">${esc(ctx.dash.self?.name || ctx.dash.self?.handle || '我')} ${ctx.dash.self?.verified ? verifiedMark() : ''}</div>
          <div class="tweet-time">${formatDateTime(tweet.createdAt, ctx.now)}</div>
        </div>
      </div>
      <a class="tweet-open" href="${esc(url)}" target="_blank" rel="noreferrer" aria-label="打开帖子">${icon('arrow-up-right', 13)}</a>
    </header>
    <p class="tweet-text">${esc(tweet.text || '')}</p>
    ${tweet.media ? `<a class="tweet-media" href="${esc(url)}" target="_blank" rel="noreferrer"><img src="${esc(tweet.media)}" alt="" loading="lazy" decoding="async"></a>` : ''}
    <div class="tweet-metrics">
      <span title="回复">${icon('message', 12)} ${formatCompact(tweet.replies || 0)}</span>
      <span title="转发">${icon('repeat', 12)} ${formatCompact(tweet.retweets || 0)}</span>
      <span title="点赞" class="likes">${icon('heart', 12)} ${formatCompact(tweet.likes || 0)}</span>
      ${typeof tweet.views === 'number' ? `<span title="阅读">${icon('eye', 12)} ${formatCompact(tweet.views)}</span>` : ''}
      <span class="tweet-total">互动 ${formatCompact(total)}</span>
    </div>
  </article>`;
}
