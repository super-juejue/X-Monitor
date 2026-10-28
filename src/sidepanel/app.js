/**
 * Side panel.
 *
 * One card: who you are on X, and your current numbers. Everything is read from
 * the worker, which gets it from X's own responses — the panel never fetches.
 */

import { formatBig, relativeTime } from '../lib/time.js';

const app = document.getElementById('app');

const ICONS = {
  logo: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3.5 15.5 8 9.5l3.4 3.9L16 5.5l4.5 5" stroke="white" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="20.5" cy="16.5" r="2" fill="white" fill-opacity=".9"/>
  </svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M20 11.5A8 8 0 1 0 18 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M20.2 3.8v5.4h-5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  verified: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#1d9bf0" d="M12 1.6l2.6 2.1 3.3-.5 1.2 3.1 2.9 1.7-1 3.2 1 3.2-2.9 1.7-1.2 3.1-3.3-.5L12 22.4l-2.6-2.1-3.3.5-1.2-3.1-2.9-1.7 1-3.2-1-3.2 2.9-1.7 1.2-3.1 3.3.5z"/>
    <path fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" d="M8.2 12.2l2.5 2.5 5-5.2"/>
  </svg>`,
};

const STATS = [
  { key: 'followers', label: '粉丝' },
  { key: 'following', label: '关注' },
  { key: 'tweets', label: '帖子' },
];

/** Values already shown, so a refresh counts up from them instead of zero. */
const numbers = {};
let account = null;
let signature = '';
/** Entry animations belong to the first paint only, not to every refresh. */
let mounted = false;
/** True while a manual refresh is in flight. */
let busy = false;
/** Transient line under the card: the result of the last refresh. */
let note = '';
let noteTimer = null;

const REFRESH_ERRORS = {
  NO_ACCOUNT: '还没识别到账号，先打开 x.com',
  TIMEOUT: '没能拿到新数据，确认已登录后再试一次',
  BUSY: '正在刷新，稍等一下',
  TAB_FAILED: '打不开 X 页面，请手动打开一次',
  FAILED: '刷新失败，请重试',
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[ch]));

/** X serves 48px avatars by default; ask for the big one. */
function largeAvatar(url) {
  return typeof url === 'string' ? url.replace(/_normal(\.[a-z]+)$/i, '_400x400$1') : '';
}

function avatarHtml(self) {
  const name = String(self?.name || self?.handle || '?').trim();
  const initial = name.charAt(0).toUpperCase() || '?';
  const src = /^https?:\/\//.test(self?.avatar || '') ? largeAvatar(self.avatar) : '';
  return `<div class="avatar">
    <span class="avatar-initial">${esc(initial)}</span>
    ${src ? `<img src="${esc(src)}" alt="">` : ''}
  </div>`;
}

function statsHtml(profile) {
  return `<div class="stats">${STATS.map(({ key, label }) => {
    const value = profile?.[key];
    const has = typeof value === 'number' && Number.isFinite(value);
    return `<div class="stat">
      <span class="stat-num"${has ? ` data-count="${value}" data-key="${key}"` : ''}>${has ? formatBig(value) : '—'}</span>
      <span class="stat-label">${label}</span>
    </div>`;
  }).join('')}</div>`;
}

function accountView(data) {
  const self = data.self;
  const profile = data.profile;
  const ts = profile?.ts || 0;
  return `<section class="card">
    <div class="identity">
      ${avatarHtml(self)}
      <div class="who">
        <div class="name-row">
          <span class="name">${esc(self.name || self.handle)}</span>
          ${self.verified ? `<span class="verified" title="已验证账号">${ICONS.verified}</span>` : ''}
        </div>
        <div class="handle">@${esc(self.handle)}</div>
      </div>
    </div>
    ${statsHtml(profile)}
    <div class="foot">
      <span class="dot${profile ? ' live' : ''}"></span>
      <span class="foot-time">${ts ? `更新于 ${relativeTime(ts)}` : '还没读到粉丝数'}</span>
    </div>
    ${profile ? '' : `<p class="hint">
      点右上角的刷新按钮，会打开一次你的主页，把数字读回来。
    </p>`}
  </section>`;
}

function emptyView() {
  return `<section class="empty">
    <div class="empty-mark">${ICONS.logo}</div>
    <h1>还没有读到你的账号</h1>
    <p>在浏览器里打开并登录 x.com，这里会自动显示你的头像和粉丝数。</p>
    <button class="btn" type="button" data-action="open-x">
      ${ICONS.external}<span>打开 x.com</span>
    </button>
  </section>`;
}

function loadingView() {
  return `<div class="loading" aria-label="正在读取本地数据"><span class="spinner"></span></div>`;
}

function render() {
  if (!account) {
    app.innerHTML = loadingView();
    return;
  }

  app.innerHTML = `
    <header class="topbar${mounted ? ' instant' : ''}">
      <div class="brand">
        <span class="brand-mark">${ICONS.logo}</span>
        <span class="brand-name">X Monitor</span>
      </div>
      <div class="top-actions">
        ${account.self ? `<button class="icon-btn${busy ? ' spinning' : ''}" type="button" data-action="refresh"
          title="${busy ? '正在刷新' : '刷新数据'}" aria-label="刷新数据"${busy ? ' disabled' : ''}>
          ${ICONS.refresh}
        </button>` : ''}
        <button class="icon-btn" type="button" data-action="open-x" title="打开 x.com" aria-label="打开 x.com">
          ${ICONS.external}
        </button>
      </div>
    </header>
    <main class="content">
      ${account.self ? accountView(account) : emptyView()}
      ${note ? `<p class="note" role="status">${esc(note)}</p>` : ''}
    </main>`;

  if (mounted) {
    for (const el of app.querySelectorAll('.card, .empty, .avatar')) el.classList.add('instant');
  }
  mounted = true;

  const img = app.querySelector('.avatar img');
  if (img) {
    if (img.complete && img.naturalWidth > 0) img.classList.add('ready');
    img.addEventListener('load', () => img.classList.add('ready'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
  }

  animateNumbers();
}

function animateNumbers() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  for (const el of app.querySelectorAll('[data-count]')) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) continue;
    const key = el.dataset.key || 'count';
    const from = Number.isFinite(numbers[key])
      ? numbers[key]
      : Math.round(target * 0.84);
    numbers[key] = target;

    if (reduced || from === target) {
      el.textContent = formatBig(target);
      continue;
    }

    const started = performance.now();
    const duration = 720;
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      el.textContent = formatBig(Math.round(from + (target - from) * eased));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function apply(next) {
  const sig = JSON.stringify(next || null);
  if (sig === signature) return;
  signature = sig;
  account = next;
  render();
}

/** Read the stored account from the worker. Changing nothing on X. */
async function loadAccount() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT' });
    apply(result?.ok ? { self: result.self, profile: result.profile, updatedAt: result.updatedAt } : null);
  } catch {
    // Extension context is gone (e.g. reloaded); keep whatever is on screen.
  }
}

/**
 * Ask the worker to make X hand over fresh numbers. The panel cannot fetch
 * them itself, so this always costs one page load — see refreshAccount in the
 * worker for how the tab is chosen.
 */
async function refreshNow() {
  if (busy) return;
  busy = true;
  note = '';
  clearTimeout(noteTimer);
  render();

  let message = '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'REFRESH' });
    message = result?.ok ? '已拿到最新数据' : REFRESH_ERRORS[result?.error] || REFRESH_ERRORS.FAILED;
  } catch {
    message = REFRESH_ERRORS.FAILED;
  }

  await loadAccount();
  busy = false;
  note = message;
  render();

  noteTimer = setTimeout(() => {
    note = '';
    render();
  }, 6000);
}

app.addEventListener('click', (event) => {
  const refreshBtn = event.target.closest('[data-action="refresh"]');
  if (refreshBtn) {
    refreshNow();
    return;
  }

  const openX = event.target.closest('[data-action="open-x"]');
  if (openX) {
    openTab('https://x.com');
  }
});

/**
 * Prefer the tab the user already has open instead of adding another one.
 * Host permissions cover x.com, so its url is readable without the tabs
 * permission.
 */
async function openTab(url) {
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => /^https:\/\/(x|twitter)\.com\//.test(tab.url || ''));
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { url, active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ACCOUNT_UPDATED') loadAccount();
});

// Keep "更新于 …" honest without re-rendering (and re-animating) the card.
setInterval(() => {
  const el = app.querySelector('.foot-time');
  const ts = account?.profile?.ts;
  if (el && ts) el.textContent = `更新于 ${relativeTime(ts)}`;
}, 30_000);

loadAccount();
