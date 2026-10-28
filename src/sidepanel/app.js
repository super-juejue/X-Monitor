import { STORAGE_KEY, SYNC_LABELS, hydrateState } from '../lib/constants.js';
import { computeDashboard } from '../lib/stats.js';
import { formatInt, relativeTime } from '../lib/time.js';
import { animateNumbers, esc, icon, logoMark, showToast } from './ui.js';
import { overviewView } from './views/overview.js';
import { peopleView } from './views/people.js';
import { tweetsView } from './views/tweets.js';
import { settingsView } from './views/settings.js';

const VIEWS = {
  overview: overviewView,
  people: peopleView,
  tweets: tweetsView,
  settings: settingsView,
};

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'people', label: '粉丝' },
  { id: 'tweets', label: '帖子' },
  { id: 'settings', label: '设置' },
];

const ui = {
  state: hydrateState(null),
  dash: computeDashboard(hydrateState(null)),
  tab: 'overview',
  lastRenderedTab: null,
  lastPeopleFilter: null,
  chartMode: 'followers',
  peopleFilter: 'followers',
  query: '',
  peopleLimit: 200,
  tweetLimit: 60,
  sync: null,
  lastSync: null,
  numbers: {},
  forceAnimate: false,
  forceScrollTop: null,
  sheet: false,
  confirm: null,
  xTabCount: 0,
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ready: false,
};

const els = {};
let renderTimer = null;
let lastStatusUpdate = 0;

init();

async function init() {
  bindGlobal();
  try {
    await loadState();
  } catch (error) {
    console.warn('[X Monitor] failed to load state', error);
  }
  await refreshXTabs();
  applyTheme(resolveTheme());
  els.app = document.getElementById('app');
  els.app.innerHTML = shellHtml();
  els.view = document.getElementById('view');
  els.overlay = document.getElementById('sheet-root');
  els.tabs = document.getElementById('tabs');
  els.statusbar = document.getElementById('statusbar');
  els.syncbar = document.getElementById('syncbar');
  ui.ready = true;

  new ResizeObserver(() => positionIndicator()).observe(els.tabs);
  positionIndicator();
  render();
  bindChrome();
  fetchSyncStatus();
  setInterval(() => {
    if (ui.tab === 'overview' || ui.tab === 'people') scheduleRender(0);
  }, 60_000);
  setInterval(refreshXTabs, 30_000);
}

function bindGlobal() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLImageElement) event.target.classList.add('is-broken');
    },
    true,
  );
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener?.('change', (event) => {
    ui.reduced = event.matches;
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if ((ui.state.settings.theme || 'system') === 'system') {
      applyTheme(resolveTheme());
    }
  });
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  applyRawState(stored?.[STORAGE_KEY]);
}

function applyRawState(raw) {
  ui.state = hydrateState(raw);
  ui.dash = computeDashboard(ui.state);
}

function bindChrome() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const previousTheme = ui.state.settings.theme;
    applyRawState(changes[STORAGE_KEY].newValue);
    if (ui.state.settings.theme !== previousTheme) applyTheme(resolveTheme());
    scheduleRender(ui.sync?.running ? 600 : 140);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'SYNC_STATUS') return;
    const wasRunning = Boolean(ui.sync?.running);
    ui.sync = message.status || null;
    ui.lastSync = message.lastSync || ui.lastSync;
    renderSyncChrome();
    if (wasRunning && !ui.sync) {
      notifySyncResult(ui.lastSync);
      scheduleRender(0);
    } else if (ui.sync) {
      const now = Date.now();
      if (now - lastStatusUpdate > 900) {
        lastStatusUpdate = now;
        scheduleRender(250);
      }
    }
  });
}

async function fetchSyncStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' });
    ui.sync = result?.status || null;
    ui.lastSync = result?.lastSync || ui.lastSync;
    renderSyncChrome();
  } catch {
    // Background unavailable; keep idle state.
  }
}

async function refreshXTabs() {
  let count = ui.xTabCount;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    count = tabs.length;
  } catch {
    count = 0;
  }
  if (count !== ui.xTabCount) {
    ui.xTabCount = count;
    if (ui.tab === 'overview' && !ui.dash.hasAccount) scheduleRender(0);
  }
}

function shellHtml() {
  return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">${logoMark(21)}</div>
        <div class="brand-text"><strong>X Monitor</strong><span id="brand-sub">X 数据看板</span></div>
      </div>
      <div class="top-actions">
        <button class="icon-btn" id="sync-btn" type="button" data-action="open-sheet" title="同步数据">${icon('refresh', 17)}</button>
        <button class="icon-btn" id="open-x-btn" type="button" data-action="open-x" title="打开 X">${icon('external', 17)}</button>
      </div>
    </header>
    <nav class="tabs" id="tabs" role="tablist" aria-label="视图">
      ${TABS.map((tab) => `<button class="tab" type="button" role="tab" data-action="tab" data-tab="${tab.id}">${tab.label}</button>`).join('')}
      <span class="tab-indicator" aria-hidden="true"></span>
    </nav>
    <div id="syncbar"></div>
    <main class="content" id="view" role="tabpanel"></main>
    <footer class="statusbar" id="statusbar"></footer>
  </div>`;
}

function render() {
  if (!ui.ready) return;
  applyTheme(resolveTheme());

  const animate = ui.forceAnimate
    || ui.tab !== ui.lastRenderedTab
    || (ui.tab === 'people' && ui.peopleFilter !== ui.lastPeopleFilter);
  ui.forceAnimate = false;

  const focus = captureFocus();
  const previousScroll = els.view.scrollTop;
  const view = VIEWS[ui.tab] || overviewView;
  const ctx = {
    dash: ui.dash,
    ui,
    animate,
    now: Date.now(),
  };

  els.view.innerHTML = view(ctx);
  els.view.dataset.tab = ui.tab;
  els.view.setAttribute('aria-label', TABS.find((tab) => tab.id === ui.tab)?.label || '');
  animateNumbers(els.view, ui);
  restoreFocus(focus);

  ui.lastRenderedTab = ui.tab;
  ui.lastPeopleFilter = ui.peopleFilter;
  renderTabs();
  renderTopbar();
  renderStatusbar();
  renderSyncbar();
  renderOverlay();

  requestAnimationFrame(() => {
    if (!els.view) return;
    els.view.scrollTop = ui.forceScrollTop != null ? ui.forceScrollTop : previousScroll;
    ui.forceScrollTop = null;
  });
}

function scheduleRender(delay = 120) {
  if (!ui.ready) return;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, delay);
}

function renderTabs() {
  if (!els.tabs) return;
  els.tabs.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === ui.tab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  requestAnimationFrame(positionIndicator);
}

function positionIndicator() {
  if (!els.tabs) return;
  const active = els.tabs.querySelector('.tab.active');
  const indicator = els.tabs.querySelector('.tab-indicator');
  if (!active || !indicator) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

function renderTopbar() {
  const self = ui.dash?.self;
  const sub = document.getElementById('brand-sub');
  if (sub) {
    if (self?.handle) {
      sub.innerHTML = `<span class="brand-dot ${ui.dash.live ? 'on' : ''}"></span>@${esc(self.handle)}`;
    } else {
      sub.textContent = 'X 数据看板';
    }
  }
  const syncBtn = document.getElementById('sync-btn');
  if (syncBtn) {
    syncBtn.innerHTML = `${icon('refresh', 17)}${ui.sync ? '<i class="ping"></i>' : ''}`;
    syncBtn.title = ui.sync ? `正在同步${SYNC_LABELS[ui.sync.kind] || ''}…` : '同步数据';
    syncBtn.classList.toggle('is-active', Boolean(ui.sync));
  }
}

function renderStatusbar() {
  if (!els.statusbar) return;
  const self = ui.dash?.self;
  const lastCapture = ui.state.meta?.lastCaptureAt;
  let label = '等待 X 数据';
  let on = false;
  if (ui.sync) {
    label = `正在同步${SYNC_LABELS[ui.sync.kind] || ''}`;
    on = true;
  } else if (lastCapture) {
    label = `更新于 ${relativeTime(lastCapture)}`;
    on = Boolean(ui.dash.live);
  }
  els.statusbar.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>
    <span class="status-text">${esc(label)}</span>
    <span class="right">${self?.handle ? `@${esc(self.handle)}` : '本地模式'}</span>`;
}

function renderSyncbar() {
  if (!els.syncbar) return;
  if (!ui.sync) {
    els.syncbar.innerHTML = '';
    return;
  }
  els.syncbar.innerHTML = `<div class="syncbar">
    <span class="spinner"></span>
    <span>${esc(syncProgressText(ui.sync))}</span>
    <button type="button" data-action="cancel-sync">停止</button>
  </div>`;
}

function syncProgressText(status) {
  if (!status) return '';
  const label = SYNC_LABELS[status.kind] || '数据';
  if (status.kind === 'tweets') return `正在同步${label} · 已加载 ${formatInt(status.pages || 0)} 页`;
  return `正在同步${label} · 已捕获 ${formatInt(status.captured || 0)} ${status.kind === 'followers' ? '位' : '个'}`;
}

function renderOverlay() {
  if (!els.overlay) return;
  if (ui.confirm === 'clear') {
    els.overlay.innerHTML = confirmHtml();
    return;
  }
  els.overlay.innerHTML = ui.sheet ? sheetHtml() : '';
}

function sheetHtml() {
  if (ui.sync) {
    const running = ui.sync;
    const elapsed = Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
    return `<div class="overlay">
      <div class="overlay-backdrop" data-action="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="正在同步">
        <div class="sheet-grab"></div>
        <div class="sheet-title-row">
          <h2>正在同步${SYNC_LABELS[running.kind] || ''}</h2>
          <span class="live-pill is-live"><i></i>进行中</span>
        </div>
        <p>已打开 X 页面并开始自动滚动。请保持该标签页在前台，完成后会自动关闭。</p>
        <div class="progress">
          <div class="progress-track"><div class="progress-fill"></div></div>
          <div class="progress-stats">
            <span>${esc(syncProgressText(running))}</span>
            <span>${formatInt(running.pages || 0)} 页 · ${elapsed}s</span>
          </div>
        </div>
        ${running.hidden ? `<div class="callout warn">${icon('alert', 14)}<span>同步标签页在后台，滚动可能被浏览器暂停。请切换到该标签页。</span></div>` : ''}
        <button class="btn danger wide" type="button" data-action="cancel-sync">停止同步</button>
        <p class="sheet-note">停止后会保留已抓取的数据，但不会更新取关判断。</p>
      </div>
    </div>`;
  }

  const result = ui.lastSync ? lastSyncLine(ui.lastSync) : '';
  return `<div class="overlay">
    <div class="overlay-backdrop" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="同步数据">
      <div class="sheet-grab"></div>
      <h2>同步数据</h2>
      <p>同步会在新标签页打开你的 X 页面并自动滚动。粉丝/关注列表完整同步一次后，才能准确识别取关。</p>
      ${result}
      ${syncOption('followers', 'user-plus', '粉丝列表', '新增关注、取关，并建立粉丝基线')}
      ${syncOption('following', 'users', '关注列表', '你关注了谁、最近取关了谁')}
      ${syncOption('tweets', 'chart', '我的帖子', '点赞、转发、回复与阅读数据')}
      <p class="sheet-note">${icon('shield', 12)} 平时浏览 X 时也会自动记录，无需每次都同步。</p>
    </div>
  </div>`;
}

function syncOption(kind, iconName, title, description) {
  return `<button class="sync-option" type="button" data-action="sync" data-kind="${kind}">
    <span class="sync-option-icon">${icon(iconName, 17)}</span>
    <span class="sync-option-copy"><strong>${title}</strong><span>${description}</span></span>
    <span class="sync-option-chev">${icon('chevron-right', 15)}</span>
  </button>`;
}

function lastSyncLine(result) {
  const label = SYNC_LABELS[result.kind] || '数据';
  if (result.complete) {
    return `<div class="result-line ok">${icon('check', 13)} 上次${label}同步完成${result.total ? ` · ${formatInt(result.total)} 条` : ''}</div>`;
  }
  const reasons = {
    cancelled: '上次同步已取消',
    rate_limited: 'X 限制了请求频率，请稍后再试',
    login_required: '未检测到已登录的 X 页面',
    page_not_ready: 'X 页面加载超时',
    tab_closed: '同步标签页被关闭',
    navigated: '同步页被跳转，已停止',
    stalled: '同步提前结束，可能未抓全',
    partial: '这次抓取的名单明显偏少，已跳过取关判断',
    empty_scan: '这次同步没有抓到任何名单，已跳过取关判断',
    max_ticks: '已达到同步时长上限',
    disconnected: '同步连接中断',
    timeout: '同步超时',
  };
  return `<div class="result-line warn">${icon('alert', 13)} ${esc(reasons[result.reason] || `上次${label}同步未完成`)}</div>`;
}

function confirmHtml() {
  const handle = ui.dash?.self?.handle;
  return `<div class="overlay">
    <div class="overlay-backdrop" data-action="close-confirm"></div>
    <div class="sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-label="清空数据确认">
      <div class="sheet-grab"></div>
      <h2>清空 @${esc(handle || '当前账号')} 的数据？</h2>
      <p>粉丝、关注、帖子、历史快照都会被删除，且无法恢复。建议先导出 JSON 备份。</p>
      <div class="confirm-actions">
        <button class="btn" type="button" data-action="close-confirm">取消</button>
        <button class="btn danger" type="button" data-action="confirm-clear">删除全部数据</button>
      </div>
    </div>
  </div>`;
}

function notifySyncResult(result) {
  if (!result) return;
  const label = SYNC_LABELS[result.kind] || '数据';
  if (result.reason === 'cancelled') {
    showToast('同步已取消', 'info');
    return;
  }
  if (result.reason === 'rate_limited') {
    showToast('X 限制了请求频率，已保存已抓取的数据，请稍后再试', 'error', 5200);
    return;
  }
  if (result.reason === 'login_required' || result.reason === 'page_not_ready') {
    showToast('未检测到已登录的 X 页面，请登录后重试', 'error', 5000);
    return;
  }
  if (result.complete) {
    showToast(`${label}同步完成${result.total ? ` · ${formatInt(result.total)} 条` : ''}`, 'success');
    return;
  }
  const reasons = {
    tab_closed: '同步标签页被关闭，已保存部分数据',
    navigated: '同步页被跳转，已保存部分数据',
    stalled: '同步提前结束，可能未抓全，已保存部分数据',
    partial: '这次抓取的名单明显偏少，已保存数据但跳过取关判断',
    empty_scan: '这次同步没有抓到任何名单，请确认已登录后重试',
    max_ticks: '已达到同步时长上限，已保存部分数据',
    disconnected: '同步连接中断，已保存部分数据',
    timeout: '同步超时，已保存部分数据',
  };
  showToast(reasons[result.reason] || '同步未完成，已保存已抓取的数据', 'warning', 4500);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'tab': {
      const tab = target.dataset.tab;
      if (!VIEWS[tab]) return;
      if (tab !== ui.tab) {
        ui.tab = tab;
        ui.forceScrollTop = 0;
      }
      render();
      break;
    }
    case 'open-sheet':
    case 'open-sync-sheet': {
      ui.sheet = true;
      ui.confirm = null;
      renderOverlay();
      break;
    }
    case 'close-sheet': {
      ui.sheet = false;
      renderOverlay();
      break;
    }
    case 'sync': {
      startSync(target.dataset.kind);
      break;
    }
    case 'cancel-sync': {
      cancelSync();
      break;
    }
    case 'chart-mode': {
      ui.chartMode = target.dataset.mode === 'net' ? 'net' : 'followers';
      ui.forceAnimate = true;
      render();
      break;
    }
    case 'people-filter': {
      const filter = target.dataset.filter;
      if (!['followers', 'following', 'lost'].includes(filter)) return;
      ui.peopleFilter = filter;
      ui.peopleLimit = 200;
      ui.forceScrollTop = 0;
      render();
      break;
    }
    case 'more-people': {
      ui.peopleLimit += 200;
      render();
      break;
    }
    case 'more-tweets': {
      ui.tweetLimit += 40;
      render();
      break;
    }
    case 'open-x': {
      openX(false);
      break;
    }
    case 'open-profile': {
      openX(true);
      break;
    }
    case 'segmented': {
      handleSegmented(target);
      break;
    }
    case 'export-data': {
      exportData();
      break;
    }
    case 'ask-clear': {
      ui.confirm = 'clear';
      ui.sheet = false;
      renderOverlay();
      break;
    }
    case 'close-confirm': {
      ui.confirm = null;
      renderOverlay();
      break;
    }
    case 'confirm-clear': {
      clearAccount();
      break;
    }
    default:
      break;
  }
}

function onChange(event) {
  const target = event.target;
  if (target.matches('[data-setting]')) {
    const key = target.dataset.setting;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    sendSettings({ [key]: key === 'syncMinutes' ? Number(value) : value });
    return;
  }
  if (target.matches('[data-role="account-select"]')) {
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', handle: target.value }).catch(() => {});
  }
}

function onInput(event) {
  const target = event.target;
  if (target.matches('[data-role="people-search"]')) {
    ui.query = target.value;
    ui.peopleLimit = 200;
    scheduleRender(100);
    return;
  }
  if (target.matches('[data-role="sync-minutes"]')) {
    const output = document.querySelector('[data-role="sync-minutes-value"]');
    if (output) output.textContent = `${target.value} 分钟`;
    const fill = Math.round(((Number(target.value) - 2) / 28) * 100);
    target.style.setProperty('--range-fill', `${fill}%`);
  }
}

function handleSegmented(target) {
  const name = target.dataset.segName;
  const value = target.dataset.segValue;
  if (!name || !value) return;
  if (name === 'theme') {
    ui.state.settings.theme = value;
    applyTheme(resolveTheme());
    render();
    sendSettings({ theme: value });
  }
}

async function sendSettings(patch) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: patch });
    if (!result?.ok) showToast('设置保存失败', 'error');
  } catch {
    showToast('设置保存失败', 'error');
  }
}

async function startSync(kind) {
  if (!kind) return;
  if (ui.sync) {
    showToast('已有同步任务在进行中', 'info');
    return;
  }
  ui.sheet = false;
  renderOverlay();
  const result = await chrome.runtime.sendMessage({ type: 'RUN_SYNC', kind }).catch(() => null);
  if (!result?.ok) {
    const messages = {
      NO_ACCOUNT: '请先登录 x.com 并打开任意页面，让插件识别账号',
      SYNC_RUNNING: '已有同步任务在进行中',
      PAGE_NOT_READY: 'X 页面加载超时，请确认已登录后重试',
      TAB_FAILED: '无法打开同步标签页',
      CANCELLED: '同步已取消',
      BAD_KIND: '同步类型无效',
    };
    showToast(messages[result?.error] || '同步启动失败，请稍后重试', 'error', 4800);
    return;
  }
  showToast(`已打开 X ${SYNC_LABELS[kind] || ''}页面，正在同步…`, 'info', 2600);
  fetchSyncStatus();
}

async function cancelSync() {
  ui.sheet = false;
  renderOverlay();
  try {
    await chrome.runtime.sendMessage({ type: 'CANCEL_SYNC' });
  } catch {
    // ignore
  }
}

function openX(profileOnly) {
  const handle = ui.dash?.self?.handle;
  const url = profileOnly && handle ? `https://x.com/${handle}` : 'https://x.com/home';
  chrome.tabs.create({ url }).catch(() => {});
}

async function exportData() {
  try {
    const payload = {
      app: 'X Monitor',
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      state: ui.state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const handle = ui.dash?.self?.handle || 'data';
    link.href = url;
    link.download = `x-monitor-${handle}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出 JSON 备份', 'success');
  } catch {
    showToast('导出失败，请重试', 'error');
  }
}

async function clearAccount() {
  ui.confirm = null;
  renderOverlay();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CLEAR_ACCOUNT' });
    if (result?.ok) {
      showToast('已清空当前账号数据', 'success');
      await loadState();
      render();
    } else {
      showToast('清空失败，请重试', 'error');
    }
  } catch {
    showToast('清空失败，请重试', 'error');
  }
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !els.view?.contains(active)) return null;
  const key = active.dataset?.focusKey;
  if (!key) return null;
  let start = null;
  let end = null;
  try {
    start = active.selectionStart;
    end = active.selectionEnd;
  } catch {
    // Inputs like number/select do not expose selection.
  }
  return { key, start, end };
}

function restoreFocus(info) {
  if (!info) return;
  const next = els.view.querySelector(`[data-focus-key="${info.key}"]`);
  if (!next) return;
  next.focus();
  if (info.start != null && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(info.start, info.end ?? info.start);
    } catch {
      // ignore
    }
  }
}

function resolveTheme() {
  const setting = ui.state?.settings?.theme || 'system';
  if (setting === 'dark' || setting === 'light') return setting;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}
