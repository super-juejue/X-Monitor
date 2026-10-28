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
  const ts = profile?.ts || data.updatedAt || 0;
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
      <span class="foot-time">${ts ? `更新于 ${relativeTime(ts)}` : '等待你的主页数据'}</span>
    </div>
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
      <button class="icon-btn" type="button" data-action="open-x" title="打开 x.com" aria-label="打开 x.com">
        ${ICONS.external}
      </button>
    </header>
    <main class="content">
      ${account.self ? accountView(account) : emptyView()}
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

async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT' });
    apply(result?.ok ? { self: result.self, profile: result.profile, updatedAt: result.updatedAt } : null);
  } catch {
    // Extension context is gone (e.g. reloaded); keep whatever is on screen.
  }
}

app.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-action="open-x"]');
  if (!trigger) return;
  try {
    chrome.tabs.create({ url: 'https://x.com' });
  } catch {
    window.open('https://x.com', '_blank', 'noopener');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ACCOUNT_UPDATED') refresh();
});

// Keep "更新于 …" honest without re-rendering (and re-animating) the card.
setInterval(() => {
  const el = app.querySelector('.foot-time');
  const ts = account?.profile?.ts || account?.updatedAt;
  if (el && ts) el.textContent = `更新于 ${relativeTime(ts)}`;
}, 30_000);

refresh();
