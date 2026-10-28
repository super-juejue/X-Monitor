/**
 * Version history.
 *
 * Every sync writes one version, complete or not. Comparing the newest version
 * with the one before it is what answers "who unfollowed me": a person present
 * in an earlier version and absent from a later, applied one has left.
 */

import { formatInt, relativeTime } from '../../lib/time.js';
import { avatar, emptyState, enter, esc, icon, verifiedMark } from '../ui.js';

const REASON_LABELS = {
  end_of_list: '滚动到底',
  stalled: '列表不再加载',
  max_ticks: '达到时长上限',
  timeout: '超时',
  rate_limited: '被 X 限流',
  empty_scan: '没有抓到名单',
  partial: '名单异常偏少',
  cancelled: '手动停止',
  tab_closed: '标签页被关闭',
  disconnected: '连接中断',
  page_not_ready: '页面未就绪',
  navigated: '页面被跳转',
  login_required: '需要登录',
};

export function historyView(ctx) {
  const dash = ctx.dash;
  if (!dash.hasAccount) {
    return `<div class="stack">${emptyState({
      iconName: 'list',
      title: '还没有识别到账号',
      body: '在 Chrome 打开并登录 x.com，插件会自动识别你的账号。',
      action: `<button class="btn primary" data-action="open-x">${icon('external', 14)} 打开 X</button>`,
    })}</div>`;
  }

  const versions = dash.versions || [];
  const latest = versions[0];

  return `<div class="stack">
    <div class="view-head">
      <div>
        <h1 class="view-title">变动历史</h1>
        <p class="view-sub">
          每次同步存一个版本${versions.length ? ` · 已记录 ${formatInt(versions.length)} 版` : ''}
        </p>
      </div>
    </div>

    ${versions.length
      ? `${compareCard(latest, ctx)}${versions.map((version, index) => versionCard(
        version,
        versions.slice(index + 1).find((older) => older.kind === version.kind),
        index,
        ctx,
      )).join('')}`
      : emptyState({
        iconName: 'list',
        title: '还没有版本',
        body: '同步一次粉丝或关注列表，就会生成第一个版本。之后每次同步都能和上一版对比。',
        action: `<div class="empty-actions">
          <button class="btn primary" data-action="sync" data-kind="followers">${icon('user-plus', 13)} 同步粉丝</button>
          <button class="btn" data-action="sync" data-kind="following">${icon('users', 13)} 同步关注</button>
        </div>`,
      })}

    ${versions.length ? `<p class="footnote">${icon('shield', 12)} 只有「完整」版本才会把消失的人判定为取关。部分版本只记录本次看到了谁，不会误删。</p>` : ''}
  </div>`;
}

/** The headline: newest version versus the one before it. */
function compareCard(latest, ctx) {
  const kindLabel = latest.kind === 'following' ? '关注' : '粉丝';
  const gained = latest.addedCount || 0;
  const lost = latest.missingCount || 0;
  const changed = gained || lost;
  // A zero next to "取关了你" reads like a bug; say it plainly instead.
  const lostLabel = latest.applied
    ? (lost ? (latest.kind === 'following' ? '已取关' : '取关了你') : '无人取关')
    : '本次未见到';
  const gainedLabel = latest.kind === 'following' ? '新关注' : '新出现';

  return `<article class="card compare-card">
    <header class="card-head">
      <div>
        <h2>本次变动</h2>
        <p class="card-sub">第 ${formatInt(latest.n)} 版 · ${relativeTime(latest.at, ctx.now)} · ${kindLabel}</p>
      </div>
      ${statusBadge(latest)}
    </header>
    <div class="compare-grid">
      <div class="compare-cell ${gained ? 'pos' : 'muted'}">
        <span class="compare-num" data-count="${gained}" data-count-key="cmp.gained">${formatInt(gained)}</span>
        <span class="compare-label">${gained ? gainedLabel : '没有新人'}</span>
      </div>
      <div class="compare-cell ${lost && latest.applied ? 'neg' : 'muted'}">
        <span class="compare-num" data-count="${lost}" data-count-key="cmp.lost">${latest.applied ? formatInt(lost) : '—'}</span>
        <span class="compare-label">${lostLabel}</span>
      </div>
    </div>
    ${changed ? '' : `<p class="compare-flat">${latest.baseline ? '这是基线版本，只用来做后续对比。' : '和已知名单相比没有变化。'}</p>`}
    ${!latest.complete ? `<div class="callout warn">${icon('alert', 13)}<span>${incompleteText(latest)}</span></div>` : ''}
  </article>`;
}

function statusBadge(version) {
  if (version.baseline) return '<span class="version-badge baseline">基线</span>';
  if (version.complete) return '<span class="version-badge complete">完整</span>';
  return '<span class="version-badge partial">部分</span>';
}

function incompleteText(version) {
  const reason = REASON_LABELS[version.reason] || '未完成';
  if (version.reason === 'rate_limited') {
    return `${reason}。已保留本次数据，等约 15 分钟后可再同步一次补齐。`;
  }
  if (version.reason === 'empty_scan') {
    return `${reason}。请确认 x.com 已登录并且标签页保持着。`;
  }
  const rest = version.total - version.seen;
  if (rest > 0) {
    return `${reason}。这次读到 ${formatInt(version.seen)} 人，还有 ${formatInt(rest)} 位没读到，本次不判定取关。`;
  }
  return `${reason}。本次只记录看到了谁，不会判定取关。`;
}

function versionCard(version, previousSame, index, ctx) {
  const kindLabel = version.kind === 'following' ? '关注' : '粉丝';
  const gained = version.addedCount || 0;
  const lost = version.missingCount || 0;
  // Coverage, not the profile total: X hides suspended / private accounts, so
  // "名单 39 / 主页 142" would look like a bug even on a clean scan.
  const seenText = version.total > version.seen
    ? `读到 ${formatInt(version.seen)} / ${formatInt(version.total)} 人`
    : `${formatInt(version.seen)} 人`;

  return `<article class="card version-card" ${enter(index, ctx.animate, 'version')}>
    <header class="version-head">
      <div class="version-title">
        <strong>第 ${formatInt(version.n)} 版</strong>
        <span>${kindLabel} · ${relativeTime(version.at, ctx.now)}</span>
      </div>
      ${statusBadge(version)}
    </header>

    <div class="version-meta">
      <span>${icon('users', 11)} ${seenText}</span>
      ${gained ? `<span class="pos">+${formatInt(gained)}</span>` : ''}
      ${lost ? `<span class="${version.applied ? 'neg' : 'muted'}">-${formatInt(lost)}</span>` : ''}
      ${previousSame ? `<span class="muted">对比第 ${formatInt(previousSame.n)} 版</span>` : '<span class="muted">首版</span>'}
    </div>

    ${gained ? peopleList(version.added, version.addedCount, 'added', version, ctx) : ''}
    ${lost ? peopleList(version.missing, version.missingCount, version.applied ? 'lost' : 'unseen', version, ctx) : ''}
    ${!version.complete ? `<p class="version-note">${incompleteText(version)}</p>` : ''}
  </article>`;
}

function peopleList(people, total, tone, version, ctx) {
  const shown = (people || []).slice(0, 4);
  const labels = {
    added: version.kind === 'following' ? '新关注' : '新出现',
    lost: version.kind === 'following' ? '已取关' : '取关了你',
    unseen: '本次未见到',
  };
  return `<div class="version-people ${tone}">
    <div class="version-people-head">
      <span>${labels[tone]}</span>
      <strong>${formatInt(total)}</strong>
    </div>
    <ul>
      ${shown.map((person) => `<li>
        ${avatar(person, 22)}
        <span class="vp-name">${esc(person.name || person.handle || '未知账号')}${person.verified ? verifiedMark() : ''}</span>
        <span class="vp-handle">@${esc(person.handle || '')}</span>
      </li>`).join('')}
      ${total > shown.length ? `<li class="vp-more">还有 ${formatInt(total - shown.length)} 位</li>` : ''}
    </ul>
  </div>`;
}
