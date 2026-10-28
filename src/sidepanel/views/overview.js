import { areaChart, netBars, sparkline } from '../charts.js';
import { formatBig, formatInt, formatSigned, relativeTime } from '../../lib/time.js';
import {
  avatar,
  deltaPill,
  emptyState,
  enter,
  esc,
  icon,
  livePill,
  logoMark,
  verifiedMark,
} from '../ui.js';

export function overviewView(ctx) {
  const dash = ctx.dash;
  if (!dash.hasAccount) return onboardingView(ctx);
  return `<div class="stack">
    ${heroCard(ctx)}
    ${changeCard(ctx)}
    ${todayTiles(ctx)}
    ${chartCard(ctx)}
    ${miniStats(ctx)}
    ${!dash.capturedAt ? startCard(ctx) : ''}
    ${activityCard(ctx)}
    ${syncCard(ctx)}
  </div>`;
}

function onboardingView(ctx) {
  const hasTabs = ctx.ui.xTabCount > 0;
  return `<div class="stack onboard">
    <div class="onboard-hero">
      <div class="onboard-logo logo">${logoMark(32)}</div>
      <h1>把你的 X 数据<br>变成一张仪表盘</h1>
      <p>粉丝增长、取关、帖子互动，全部安静记录。无需 API Key，所有数据只留在你的浏览器。</p>
      <div class="onboard-actions">
        <button class="btn primary" data-action="open-x">${icon('external', 14)} 打开 X</button>
        <button class="btn" data-action="open-sync-sheet">${icon('refresh', 14)} 同步说明</button>
      </div>
      ${hasTabs ? `<div class="inline-hint">${icon('radio', 13)} 已检测到 X 标签页，刷新页面即可自动识别账号</div>` : ''}
    </div>
    <div class="steps">
      <div class="step"><span class="step-num">1</span><div><strong>登录 X</strong><span>在 Chrome 中打开 x.com，并保持登录状态。</span></div></div>
      <div class="step"><span class="step-num">2</span><div><strong>自动识别账号</strong><span>打开任意 X 页面，插件会从侧边栏读取当前账号。</span></div></div>
      <div class="step"><span class="step-num">3</span><div><strong>记录一次主页</strong><span>打开你的主页，记录粉丝、关注、帖子等最新计数。</span></div></div>
      <div class="step"><span class="step-num">4</span><div><strong>同步粉丝列表</strong><span>建立基线后，每天的新增关注与取关都会出现在这里。</span></div></div>
    </div>
    <div class="privacy-note">${icon('shield', 14)} 本地存储 · 不上传 · 不读取密码</div>
  </div>`;
}

function heroCard(ctx) {
  const dash = ctx.dash;
  const self = dash.self || {};
  const followers = dash.current?.followers;
  const net = typeof dash.today.net === 'number'
    ? dash.today.net
    : (dash.today.follow || dash.today.unfollow ? dash.today.listNet : null);
  const netLabel = typeof dash.today.net === 'number' ? (dash.today.netLabel || '今日') : '今日';
  const spark = sparkline(dash.sparks.followers, { width: 320, height: 58, animate: ctx.animate });
  const tracked = dash.people.trackedFollowers;

  return `<article class="card hero">
    <div class="hero-top">
      ${avatar(self, 42)}
      <div class="hero-id">
        <div class="hero-name">${esc(self.name || self.handle || '你的账号')} ${self.verified ? verifiedMark() : ''}</div>
        <div class="hero-handle">@${esc(self.handle || '')}</div>
      </div>
      ${livePill(dash.live)}
    </div>
    <div class="hero-metric">
      <span class="metric-label">关注者</span>
      <div class="metric-row">
        ${typeof followers === 'number'
          ? `<span class="metric-value" data-count="${followers}" data-count-key="followers" data-count-format="big">${formatBig(followers)}</span>`
          : '<span class="metric-value metric-empty">—</span>'}
        ${net !== null ? deltaPill(net, { label: netLabel }) : ''}
      </div>
    </div>
    ${spark ? `<div class="hero-spark">${spark}</div>` : (typeof followers === 'number' ? '<div class="hero-flat"><span></span></div>' : '')}
    <div class="hero-foot">
      <span>${dash.capturedAt ? `更新于 ${relativeTime(dash.capturedAt, ctx.now)}` : '尚未记录主页数据'}</span>
      <span class="dot-sep"></span>
      <span>${tracked ? `追踪中 ${formatInt(tracked)} 位粉丝` : '同步粉丝以建立基线'}</span>
    </div>
  </article>`;
}

/**
 * The answer to "who unfollowed me", directly on the overview. If the newest
 * version is a usable one, its missing list is the unfollow answer; otherwise
 * we say plainly that this run did not decide it.
 */
function changeCard(ctx) {
  const dash = ctx.dash;
  const latest = dash.lastVersion;
  if (!latest) return '';

  const isFollower = latest.kind === 'followers';
  const kindLabel = isFollower ? '粉丝' : '关注';
  const lost = latest.missingCount || 0;
  const gained = latest.addedCount || 0;
  const decided = latest.applied;
  // "0 取关了你" reads like a glitch, so a zero gets its own wording.
  const lostText = !decided
    ? '未判定取关'
    : lost
      ? `${formatInt(lost)} ${isFollower ? '取关了你' : '你已取关'}`
      : '无人取关';

  if (!lost && !gained && decided && !latest.baseline) return '';

  const shown = (latest.missing || []).slice(0, 3);
  return `<article class="card change-card">
    <header class="card-head">
      <div>
        <h2>第 ${formatInt(latest.n)} 版对比</h2>
        <p class="card-sub">${kindLabel} · ${relativeTime(latest.at, ctx.now)}${latest.baseline ? ' · 基线版本' : ''}</p>
      </div>
      <button class="text-btn" data-action="tab" data-tab="history">${icon('chevron-right', 12)} 全部</button>
    </header>
    <div class="change-row">
      <span class="change-pill ${lost ? (decided ? 'neg' : 'muted') : 'flat'}">
        ${icon(isFollower ? 'user-minus' : 'users', 11)} ${esc(lostText)}
      </span>
      <span class="change-pill ${gained ? 'pos' : 'flat'}">
        ${icon('user-plus', 11)} ${gained ? `${formatInt(gained)} 新关注` : '暂无新增'}
      </span>
    </div>
    ${shown.length
      ? `<ul class="change-people">${shown.map((person) => `<li>
          ${avatar(person, 24)}
          <span>${esc(person.name || person.handle || '未知账号')}</span>
          <span class="cp-handle">@${esc(person.handle || '')}</span>
        </li>`).join('')}</ul>`
      : ''}
    ${!decided
      ? `<p class="change-note">${icon('alert', 11)} 本次${kindLabel}同步未完整，只记录看到了谁，暂不判定取关。</p>`
      : ''}
  </article>`;
}

function todayTiles(ctx) {
  const today = ctx.dash.today;
  const net = typeof today.net === 'number'
    ? today.net
    : (today.follow || today.unfollow ? today.listNet : null);
  return `<div class="tile-grid">
    ${tile({
      label: '新增关注',
      value: today.follow,
      iconName: 'user-plus',
      tone: 'pos',
      sub: '今日累计',
      key: 'today.follow',
    })}
    ${tile({
      label: '取关',
      value: today.unfollow,
      iconName: 'user-minus',
      tone: 'neg',
      sub: '今日累计',
      key: 'today.unfollow',
    })}
    ${tile({
      label: '净变化',
      value: net,
      iconName: typeof net === 'number' && net < 0 ? 'trend-down' : 'trend-up',
      tone: typeof net === 'number' && net < 0 ? 'neg' : 'pos',
      sub: typeof today.net === 'number' ? '按主页计数' : '按名单变化',
      key: 'today.net',
      signed: true,
    })}
    ${tile({
      label: '今日帖子',
      value: today.tweets,
      iconName: 'chart',
      tone: 'accent',
      sub: '已捕获',
      key: 'today.tweets',
    })}
  </div>`;
}

function tile({ label, value, iconName, tone, sub, key, signed = false }) {
  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const display = hasValue ? (signed ? formatSigned(value) : formatInt(value)) : '—';
  const attrs = hasValue
    ? ` data-count="${value}" data-count-key="${key}"${signed ? ' data-count-format="signed"' : ''}`
    : '';
  // Only a real change gets a colour; "0" stays neutral.
  const valueTone = !hasValue || value === 0 ? 'flat' : tone;
  return `<div class="tile">
    <div class="tile-top">
      <span class="tile-icon ${tone}">${icon(iconName, 12)}</span>
      <span>${esc(label)}</span>
    </div>
    <div class="tile-value ${valueTone}"${attrs}>${display}</div>
    <div class="tile-sub">${esc(sub)}</div>
  </div>`;
}

function chartCard(ctx) {
  const dash = ctx.dash;
  const mode = ctx.ui.chartMode === 'net' ? 'net' : 'followers';
  return `<article class="card">
    <header class="card-head">
      <div>
        <h2>关注者${mode === 'net' ? '净增' : '趋势'}</h2>
        <p class="card-sub">最近 30 天</p>
      </div>
      <div class="chart-toggle">
        <button type="button" data-action="chart-mode" data-mode="followers" class="${mode === 'followers' ? 'active' : ''}">趋势</button>
        <button type="button" data-action="chart-mode" data-mode="net" class="${mode === 'net' ? 'active' : ''}">净增</button>
      </div>
    </header>
    <div class="chart-wrap">
      ${mode === 'net'
        ? netBars(dash.chart.net, { animate: ctx.animate })
        : areaChart(dash.chart.followers, { animate: ctx.animate })}
    </div>
  </article>`;
}

function miniStats(ctx) {
  const dash = ctx.dash;
  const items = [
    { label: '正在关注', value: dash.current?.following, delta: dash.deltas.following, key: 'following', spark: dash.sparks.following },
    { label: '帖子', value: dash.current?.tweets, delta: dash.deltas.tweets, key: 'tweets', spark: dash.sparks.tweets },
    { label: '喜欢', value: dash.current?.likes, delta: dash.deltas.likes, key: 'likes', spark: dash.sparks.likes },
    { label: '媒体', value: dash.current?.media, delta: dash.deltas.media, key: 'media', spark: dash.sparks.media },
  ];
  return `<div class="stats-grid">${items.map((item) => {
    const hasValue = typeof item.value === 'number' && Number.isFinite(item.value);
    const spark = sparkline(item.spark, {
      width: 150,
      height: 26,
      animate: false,
      fill: false,
      strokeWidth: 1.5,
      pad: 2,
    });
    return `<div class="mini-card">
      <div class="mini-head">
        <span>${esc(item.label)}</span>
        ${typeof item.delta === 'number' && item.delta !== 0 ? deltaPill(item.delta) : ''}
      </div>
      <div class="mini-value"${hasValue ? ` data-count="${item.value}" data-count-key="stat.${item.key}" data-count-format="big"` : ''}>${hasValue ? formatBig(item.value) : '—'}</div>
      ${spark ? `<div class="mini-spark">${spark}</div>` : '<div class="mini-spark"></div>'}
    </div>`;
  }).join('')}</div>`;
}

function startCard(ctx) {
  return `<article class="card start-card">
    <header class="card-head">
      <div><h2>开始记录</h2><p class="card-sub">只需要两步</p></div>
      <span class="accent-icon">${icon('sparkles', 15)}</span>
    </header>
    <div class="mini-steps">
      <div class="mini-step">
        <span>1</span>
        <div><strong>打开你的主页</strong><p>自动记录粉丝、关注、帖子计数</p></div>
        <button class="btn sm" data-action="open-profile">打开</button>
      </div>
      <div class="mini-step">
        <span>2</span>
        <div><strong>同步粉丝列表</strong><p>建立基线，追踪新增与取关</p></div>
        <button class="btn sm" data-action="sync" data-kind="followers">同步</button>
      </div>
    </div>
  </article>`;
}

function activityCard(ctx) {
  const activity = ctx.dash.activity;
  return `<article class="card">
    <header class="card-head">
      <div><h2>最近动态</h2><p class="card-sub">粉丝与帖子</p></div>
      ${activity.length ? '<button class="text-btn" data-action="tab" data-tab="people">查看全部</button>' : ''}
    </header>
    ${activity.length
      ? `<ul class="activity">${activity.slice(0, 8).map((item, index) => activityRow(item, index, ctx)).join('')}</ul>`
      : emptyState({
        iconName: 'radio',
        title: '还没有动态',
        body: '打开 X 或同步一次数据，新的关注、取关和帖子会出现在这里。',
      })}
  </article>`;
}

function activityRow(item, index, ctx) {
  const now = ctx.now;
  if (item.kind === 'tweet') {
    const tweet = item.tweet;
    const url = tweet.url || '#';
    return `<li ${enter(index, ctx.animate, 'act')}>
      <span class="act-avatar">
        ${avatar(ctx.dash.self, 30)}
        <span class="act-badge accent">${icon('chart', 9)}</span>
      </span>
      <div class="act-body">
        <div class="act-title">发布了新帖子</div>
        <div class="act-text">${esc(tweet.text || '')}</div>
        <div class="act-meta">${relativeTime(item.ts, now)} · ${formatInt(tweet.likes || 0)} 喜欢</div>
      </div>
      <a class="act-link" href="${esc(url)}" target="_blank" rel="noreferrer" aria-label="打开帖子">${icon('arrow-up-right', 12)}</a>
    </li>`;
  }

  const event = item.event;
  const type = event.type;
  const person = { name: event.name, handle: event.handle, avatar: event.avatar };
  const profileUrl = event.handle ? `https://x.com/${event.handle}` : '#';
  const config = {
    follow: { iconName: 'user-plus', tone: 'pos', badge: 'pos', title: `<strong>${esc(event.name || event.handle || '有人')}</strong> 关注了你` },
    unfollow: { iconName: 'user-minus', tone: 'neg', badge: 'neg', title: `<strong>${esc(event.name || event.handle || '有人')}</strong> 取关了你` },
    following_new: { iconName: 'users', tone: 'accent', badge: 'accent', title: `你关注了 <strong>${esc(event.name || event.handle || '一个账号')}</strong>` },
    following_lost: { iconName: 'user-minus', tone: 'neg', badge: 'neg', title: `你取消关注了 <strong>${esc(event.name || event.handle || '一个账号')}</strong>` },
  }[type];
  if (!config) return '';

  return `<li ${enter(index, ctx.animate, 'act')}>
    <span class="act-avatar">
      ${avatar(person, 30)}
      <span class="act-badge ${config.badge}">${icon(config.iconName, 9)}</span>
    </span>
    <div class="act-body">
      <div class="act-title">${config.title}</div>
      <div class="act-meta">@${esc(event.handle || '')} · ${relativeTime(item.ts, now)}</div>
    </div>
    <a class="act-link" href="${esc(profileUrl)}" target="_blank" rel="noreferrer" aria-label="打开主页">${icon('arrow-up-right', 12)}</a>
  </li>`;
}

function syncCard(ctx) {
  const dash = ctx.dash;
  const followersSync = dash.sync?.followers;
  const followingSync = dash.sync?.following;
  const baseline = dash.flags.followersBaselineAt;
  const busy = Boolean(ctx.ui.sync?.running);
  return `<article class="card sync-card">
    <header class="card-head">
      <div><h2>数据同步</h2><p class="card-sub">完整同步后才能准确识别取关</p></div>
      <span class="sync-indicator ${busy ? 'on' : ''}"></span>
    </header>
    <div class="sync-rows">
      <div><span>粉丝列表</span><strong>${followersSync?.lastAt ? relativeTime(followersSync.lastAt, ctx.now) : '尚未同步'}</strong></div>
      <div><span>追踪数量</span><strong>${formatInt(dash.people.trackedFollowers)}</strong></div>
      <div><span>关注列表</span><strong>${followingSync?.lastAt ? relativeTime(followingSync.lastAt, ctx.now) : '尚未同步'}</strong></div>
    </div>
    <div class="sync-actions">
      <button class="btn primary sm" data-action="sync" data-kind="followers" ${busy ? 'disabled' : ''}>${icon('user-plus', 14)} 同步粉丝</button>
      <button class="btn sm" data-action="sync" data-kind="following" ${busy ? 'disabled' : ''}>${icon('users', 14)} 同步关注</button>
      <button class="btn ghost sm" data-action="sync" data-kind="tweets" ${busy ? 'disabled' : ''}>${icon('refresh', 14)} 更新帖子</button>
    </div>
    ${!baseline
      ? '<p class="sync-hint">首次完整同步只建立基线，不会把已有粉丝记成新增。</p>'
      : '<p class="sync-hint">平时浏览 X 时，粉丝数、帖子和互动数据会自动记录。</p>'}
  </article>`;
}
