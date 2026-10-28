import { formatBig, formatInt, relativeTime } from '../../lib/time.js';
import { avatar, emptyState, enter, esc, icon, verifiedMark } from '../ui.js';

export function peopleView(ctx) {
  const dash = ctx.dash;
  if (!dash.hasAccount) {
    return `<div class="stack">${emptyState({
      iconName: 'users',
      title: '还没有识别到账号',
      body: '在 Chrome 打开并登录 x.com，插件会自动识别你的账号。',
      action: `<button class="btn primary" data-action="open-x">${icon('external', 14)} 打开 X</button>`,
    })}</div>`;
  }

  const filter = ['following', 'lost'].includes(ctx.ui.peopleFilter) ? ctx.ui.peopleFilter : 'followers';
  const source = filter === 'following'
    ? dash.people.following
    : filter === 'lost'
      ? dash.people.exFollowers
      : dash.people.followers;
  const query = String(ctx.ui.query || '').trim();
  const normalized = query.toLowerCase();
  const filtered = normalized
    ? source.filter((person) => String(person.name || '').toLowerCase().includes(normalized)
      || String(person.handle || '').toLowerCase().includes(normalized))
    : source;
  const limit = Math.max(100, Number(ctx.ui.peopleLimit) || 200);
  const visible = filtered.slice(0, limit);
  const counts = {
    followers: dash.people.trackedFollowers,
    following: dash.people.trackedFollowing,
    lost: dash.people.trackedLost,
  };
  const syncKind = filter === 'following' ? 'following' : 'followers';
  const busy = Boolean(ctx.ui.sync?.running);
  const lastSync = dash.sync?.[syncKind]?.lastAt;
  const incomplete = dash.sync?.followers && dash.sync.followers.complete === false;
  const expected = dash.current?.followers;

  return `<div class="stack">
    <div class="view-head">
      <div>
        <h1 class="view-title">粉丝与关注</h1>
        <p class="view-sub">
          追踪 ${formatBig(counts.followers)} 位粉丝 · ${formatBig(counts.following)} 个关注
          ${lastSync ? ` · 最近同步 ${relativeTime(lastSync, ctx.now)}` : ''}
        </p>
      </div>
      <button class="btn primary sm" data-action="sync" data-kind="${syncKind}" ${busy ? 'disabled' : ''}>
        ${icon('refresh', 13)} 同步${syncKind === 'following' ? '关注' : '粉丝'}
      </button>
    </div>

    <div class="seg wide people-filter">
      <button type="button" data-action="people-filter" data-filter="followers" class="${filter === 'followers' ? 'active' : ''}">粉丝 <span>${formatBig(counts.followers)}</span></button>
      <button type="button" data-action="people-filter" data-filter="following" class="${filter === 'following' ? 'active' : ''}">关注 <span>${formatBig(counts.following)}</span></button>
      <button type="button" data-action="people-filter" data-filter="lost" class="${filter === 'lost' ? 'active' : ''}">取关 <span>${formatBig(counts.lost)}</span></button>
    </div>

    ${filter === 'followers' && incomplete
      ? `<div class="callout warn">${icon('alert', 14)}<span>上次粉丝同步未完成，取关检测可能不准确。建议保持同步标签页在前台后重试。</span></div>`
      : ''}

    ${filter === 'followers' && !counts.followers && expected
      ? `<div class="callout">${icon('users', 14)}<span>主页显示你有 ${formatBig(expected)} 位粉丝，但名单还未同步。完成一次同步即可查看明细。</span></div>`
      : ''}

    <div class="search">
      ${icon('search', 14)}
      <input type="search" placeholder="搜索昵称或 @handle" value="${esc(query)}" data-role="people-search" data-focus-key="people-search" autocomplete="off" spellcheck="false">
    </div>

    ${visible.length
      ? `<ul class="people">${visible.map((person, index) => personRow(person, index, filter, ctx)).join('')}</ul>`
      : peopleEmpty(filter, query, ctx)}

    ${filtered.length > visible.length
      ? `<button class="btn ghost wide" data-action="more-people">加载更多 · 还剩 ${formatInt(filtered.length - visible.length)} 位</button>`
      : ''}
  </div>`;
}

function peopleEmpty(filter, query, ctx) {
  if (query) {
    return emptyState({
      iconName: 'search',
      title: '没有匹配的账号',
      body: `没有找到与「${query}」相关的记录，换个关键词试试。`,
    });
  }
  if (filter === 'lost') {
    return emptyState({
      iconName: 'user-minus',
      title: '还没有检测到取关',
      body: '完成两次完整同步后，取关的人会出现在这里。首次同步只建立基线。',
      action: `<button class="btn" data-action="sync" data-kind="followers">${icon('refresh', 13)} 同步粉丝</button>`,
    });
  }
  if (filter === 'following') {
    return emptyState({
      iconName: 'users',
      title: '还没有同步关注列表',
      body: '同步后会看到你关注的账号、新增关注，以及你最近取关的人。',
      action: `<button class="btn" data-action="sync" data-kind="following">${icon('refresh', 13)} 同步关注</button>`,
    });
  }
  return emptyState({
    iconName: 'user-plus',
    title: '还没有粉丝名单',
    body: '同步一次后，这里会显示所有粉丝，以及最近取关的人。',
    action: `<button class="btn primary" data-action="sync" data-kind="followers">${icon('refresh', 13)} 同步粉丝</button>`,
  });
}

function personRow(person, index, filter, ctx) {
  const url = person.handle ? `https://x.com/${person.handle}` : '#';
  const isLost = filter === 'lost';
  const meta = isLost
    ? `取关于 ${relativeTime(person.lostAt, ctx.now)}`
    : person.seeded
      ? `首次记录 ${relativeTime(person.firstSeen, ctx.now)}`
      : `记录于 ${relativeTime(person.firstSeen, ctx.now)}`;

  return `<li ${enter(index, ctx.animate, 'person')}>
    <a class="person-link" href="${esc(url)}" target="_blank" rel="noreferrer" title="@${esc(person.handle || '')}">
      ${avatar(person, 36)}
      <span class="person-main">
        <span class="person-name">${esc(person.name || person.handle || '未知账号')} ${person.verified ? verifiedMark() : ''} ${person.isNew ? '<span class="badge-new">新</span>' : ''}</span>
        <span class="person-handle">@${esc(person.handle || '')}</span>
      </span>
      <span class="person-meta">${isLost ? '<span class="lost-dot"></span>' : ''}${esc(meta)}</span>
      <span class="person-open">${icon('arrow-up-right', 12)}</span>
    </a>
  </li>`;
}
