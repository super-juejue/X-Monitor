import { formatBig, formatInt } from '../../lib/time.js';
import { avatar, esc, icon, segmented, switchControl } from '../ui.js';

export function settingsView(ctx) {
  const dash = ctx.dash;
  const settings = dash.settings || {};
  const accounts = dash.accounts || [];
  const version = chrome.runtime.getManifest().version;

  return `<div class="stack">
    <div class="view-head">
      <div>
        <h1 class="view-title">设置</h1>
        <p class="view-sub">外观、同步与本地数据</p>
      </div>
    </div>

    ${dash.hasAccount ? accountCard(ctx, accounts) : `<div class="callout">${icon('radio', 14)}<span>打开并登录 x.com 后，插件会自动识别账号。</span></div>`}

    <section class="card settings-card">
      <div class="settings-head">
        <div><h2>外观</h2><p class="settings-sub">主题跟随系统，或手动指定</p></div>
      </div>
      ${segmented('theme', [['system', '跟随系统'], ['dark', '深色'], ['light', '浅色']], settings.theme || 'system', { className: 'wide' })}
    </section>

    <section class="card settings-card">
      <div class="settings-head">
        <div><h2>通知与徽章</h2><p class="settings-sub">不打扰的轻量提醒</p></div>
      </div>
      ${switchControl({
        setting: 'notifications',
        checked: Boolean(settings.notifications),
        label: '数据摘要通知',
        description: '每 30 分钟汇总新增关注与取关',
      })}
      ${switchControl({
        setting: 'badge',
        checked: Boolean(settings.badge),
        label: '工具栏徽章',
        description: '显示今日净增/净减粉丝数',
      })}
    </section>

    <section class="card settings-card">
      <div class="settings-head">
        <div><h2>同步</h2><p class="settings-sub">复用已打开的 X 页面，没有才新开</p></div>
      </div>
      <div class="range-row">
        <div class="range-head">
          <span>单次同步上限</span>
          <strong data-role="sync-minutes-value">${formatInt(settings.syncMinutes || 10)} 分钟</strong>
        </div>
        <input type="range" min="2" max="30" step="1" value="${Number(settings.syncMinutes) || 10}" data-setting="syncMinutes" data-role="sync-minutes" style="--range-fill:${Math.round((((Number(settings.syncMinutes) || 10) - 2) / 28) * 100)}%">
        <div class="range-scale"><span>2 分钟</span><span>30 分钟</span></div>
      </div>
      ${switchControl({
        setting: 'closeSyncTab',
        checked: Boolean(settings.closeSyncTab),
        label: '完成后关闭插件开的标签页',
        description: '你自己打开的页面会保留',
      })}
      <p class="settings-note">${icon('alert', 12)} 同步会先刷新目标页面再从头滚动，这样才看得出谁不在了。时长越长抓到的粉丝越多；X 可能限制请求频率，遇到限流时已抓取的数据会保留。</p>
    </section>

    <section class="card settings-card">
      <div class="settings-head">
        <div><h2>本地数据</h2><p class="settings-sub">只保存在这台电脑的 Chrome 中</p></div>
      </div>
      <div class="settings-actions">
        <button class="btn" data-action="export-data">${icon('download', 14)} 导出 JSON</button>
        <button class="btn danger" data-action="ask-clear" ${dash.hasAccount ? '' : 'disabled'}>${icon('trash', 14)} 清空当前账号</button>
      </div>
      <p class="settings-note">${icon('shield', 12)} 插件不会上传任何数据，也不会读取你的密码或 Cookie。</p>
    </section>

    <section class="card settings-card about-card">
      <div class="about-logo">${icon('sparkles', 18)}</div>
      <div class="about-copy">
        <strong>X Monitor <span class="version">v${esc(version)}</span></strong>
        <p>一个只在本地运行的 X 数据看板 · 非官方工具</p>
        <a href="https://github.com/super-juejue/X-Monitor" target="_blank" rel="noreferrer">${icon('external', 12)} GitHub 仓库</a>
      </div>
    </section>
  </div>`;
}

function accountCard(ctx, accounts) {
  const dash = ctx.dash;
  const self = dash.self || {};
  return `<section class="card settings-card">
    <div class="settings-head">
      <div><h2>账号</h2><p class="settings-sub">不同账号的数据分开保存</p></div>
      <span class="badge-ok">${icon('check', 10)} 已连接</span>
    </div>
    <div class="account-row">
      ${avatar(self, 36)}
      <div class="account-copy">
        <strong>${esc(self.name || self.handle || '')}</strong>
        <span>@${esc(self.handle || '')} · 追踪 ${formatBig(dash.people.trackedFollowers)} 位粉丝</span>
      </div>
    </div>
    ${accounts.length > 1
      ? `<select class="select" data-role="account-select" aria-label="切换账号">
          ${accounts.map((account) => `<option value="${esc(account.key)}" ${account.key === dash.activeKey ? 'selected' : ''}>@${esc(account.handle)}${account.name ? ` · ${esc(account.name)}` : ''}</option>`).join('')}
        </select>`
      : ''}
  </section>`;
}
