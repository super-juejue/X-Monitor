/**
 * Side panel.
 *
 * Your account, current numbers, and changes between follower snapshots. Read from
 * the worker, which gets it from X's own responses — the panel never fetches.
 * All wording comes from the message bundles, so it follows Chrome's language.
 */

import { bundleLocale, t } from '../lib/i18n.js';
import { formatBig, relativeTime, setLocale } from '../lib/time.js';

const language = bundleLocale();
setLocale(language);
document.documentElement.lang = language;

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
  { key: 'followers', labelKey: 'statFollowers' },
  { key: 'following', labelKey: 'statFollowing' },
  { key: 'tweets', labelKey: 'statTweets' },
];

/** Values already shown, so a refresh counts up from them instead of zero. */
const numbers = {};
let account = null;
let followers = null;
let remoteCapture = null;
const expanded = new Set();
let signature = '';
/** Entry animations belong to the first paint only, not to every refresh. */
let mounted = false;
/** True while a manual refresh is in flight. */
let busy = false;
/** True while a follower capture is in flight. */
let scanning = false;
/** Transient line under the card: the result of the last refresh. */
let note = '';
let noteTimer = null;

/** Message keys for the result line, translated when it is shown. */
const REFRESH_ERRORS = {
  NO_ACCOUNT: 'refreshNoAccount',
  TIMEOUT: 'refreshTimeout',
  BUSY: 'refreshBusy',
  TAB_FAILED: 'refreshTabFailed',
  FAILED: 'refreshFailed',
};

/** The same for a follower capture. */
const CAPTURE_ERRORS = {
  NO_ACCOUNT: 'refreshNoAccount',
  BUSY: 'captureBusy',
  TIMEOUT: 'captureTimeout',
  INCOMPLETE: 'captureIncomplete',
  TAB_FAILED: 'refreshTabFailed',
  NO_ANSWER: 'captureNoAnswer',
  NO_COUNT: 'captureNoCount',
  NO_PAGES: 'captureNoPages',
  UNSUPPORTED: 'captureFormat',
  IDENTITY: 'captureOwner',
  COUNT_CHANGED: 'captureCountChanged',
  LIMIT: 'captureLimit',
  STORAGE: 'captureStorage',
  ACCOUNT_CHANGED: 'captureAccountChanged',
  FAILED: 'captureFailed',
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
  return `<div class="stats">${STATS.map(({ key, labelKey }) => {
    const value = profile?.[key];
    const has = typeof value === 'number' && Number.isFinite(value);
    return `<div class="stat">
      <span class="stat-num"${has ? ` data-count="${value}" data-key="${key}"` : ''}>${has ? formatBig(value) : '—'}</span>
      <span class="stat-label">${esc(t(labelKey))}</span>
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
          ${self.verified ? `<span class="verified" title="${esc(t('verifiedAccount'))}">${ICONS.verified}</span>` : ''}
        </div>
        <div class="handle">@${esc(self.handle)}</div>
      </div>
    </div>
    ${statsHtml(profile)}
    <div class="foot">
      <span class="dot${profile ? ' live' : ''}"></span>
      <span class="foot-time">${ts ? esc(t('panelUpdated', [relativeTime(ts)])) : esc(t('panelNoFollowers'))}</span>
    </div>
    ${profile ? '' : `<p class="hint">${esc(t('panelHint'))}</p>`}
  </section>`;
}

function emptyView() {
  return `<section class="empty">
    <div class="empty-mark">${ICONS.logo}</div>
    <h1>${esc(t('emptyTitle'))}</h1>
    <p>${esc(t('emptyBody'))}</p>
    <button class="btn" type="button" data-action="open-x">
      ${ICONS.external}<span>${esc(t('emptyAction'))}</span>
    </button>
  </section>`;
}

function namesPreview(entries, total) {
  const shown = entries.slice(0, 4).map((entry) => `@${esc(entry.handle || entry.name)}`);
  const rest = total - shown.length;
  return `<span class="names">${shown.join(' ')}${rest > 0 ? ` <span class="more">+${rest}</span>` : ''}</span>`;
}

/** Keep the card small; reveal the actual people when a change is expanded. */
function changeHtml(kind, count, entries) {
  const label = kind === 'gone' ? 'followersUnfollowed' : 'followersFollowed';
  return `<details class="change-list" data-change="${kind}"${expanded.has(kind) ? ' open' : ''}>
    <summary class="change ${kind}">
      <span class="change-num">${kind === 'gone' ? '-' : '+'}${formatBig(count)}</span>
      <span class="change-label">${esc(t(label))}</span>
      ${namesPreview(entries, count)}
    </summary>
    <ul class="people">${entries.map((entry) => `<li>
      ${entry.handle
        ? `<a href="https://x.com/${encodeURIComponent(entry.handle)}" target="_blank" rel="noopener noreferrer">@${esc(entry.handle)}</a>`
        : `<span>${esc(entry.name || entry.id)}</span>`}
      ${entry.name && entry.name !== entry.handle ? `<span class="person-name">${esc(entry.name)}</span>` : ''}
    </li>`).join('')}</ul>
    ${count > entries.length ? `<p class="hint tight">${esc(t('followersShowing', [formatBig(entries.length), formatBig(count)]))}</p>` : ''}
  </details>`;
}

function followersView(snapshot) {
  const capturing = scanning || Boolean(remoteCapture);
  const disabled = capturing || busy;
  const captureText = capturing
    ? remoteCapture?.stage === 'verifying' ? t('followersVerifying')
      : remoteCapture?.captured ? t('followersProgress', [formatBig(remoteCapture.captured)]) : t('followersCapturing')
    : t(snapshot ? 'followersRecapture' : 'followersCapture');
  if (!snapshot) {
    return `<section class="card sub${mounted ? ' instant' : ''}">
      <div class="sub-head">
        <span class="sub-title">${esc(t('followersTitle'))}</span>
      </div>
      <p class="hint tight">${esc(t('followersEmpty'))}</p>
      <button class="btn small" type="button" data-action="capture"${disabled ? ' disabled' : ''}>
        ${capturing ? `<span class="spinner small" aria-hidden="true"></span>` : ''}
        <span role="status">${esc(captureText)}</span>
      </button>
    </section>`;
  }

  const diff = snapshot.diff;
  const rows = [];
  if (diff) {
    if (diff.unfollowedCount > 0) {
      rows.push(changeHtml('gone', diff.unfollowedCount, diff.unfollowed));
    }
    if (diff.followedCount > 0) {
      rows.push(changeHtml('new', diff.followedCount, diff.followed));
    }
    if (!rows.length) {
      rows.push(`<div class="change same"><span class="change-label">${esc(t('followersSame'))}</span></div>`);
    }
  }

  return `<section class="card sub${mounted ? ' instant' : ''}">
    <div class="sub-head">
      <span class="sub-title">${esc(t('followersTitle'))}</span>
      <span class="sub-meta">${esc(t('followersTotal', [formatBig(snapshot.total)]))}</span>
    </div>
    ${rows.join('')}
    ${diff ? '' : `<p class="hint tight">${esc(t('followersFirst'))}</p>`}
    ${diff?.unfollowedCount ? `<p class="hint tight caveat">${esc(t('followersCaveat'))}</p>` : ''}
    <div class="sub-foot">
      <span class="foot-time">${esc(t('followersAt', [relativeTime(snapshot.ts)]))}</span>
      <button class="btn small" type="button" data-action="capture"${disabled ? ' disabled' : ''}>
        ${capturing ? `<span class="spinner small" aria-hidden="true"></span>` : ''}
        <span role="status">${esc(captureText)}</span>
      </button>
    </div>
  </section>`;
}

function loadingView() {
  return `<div class="loading" aria-label="${esc(t('loading'))}"><span class="spinner"></span></div>`;
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
          title="${esc(t(busy ? 'refreshingTitle' : 'refreshTitle'))}" aria-label="${esc(t('refreshTitle'))}"${busy || scanning || remoteCapture ? ' disabled' : ''}>
          ${ICONS.refresh}
        </button>` : ''}
        <button class="icon-btn" type="button" data-action="open-x" title="${esc(t('openX'))}" aria-label="${esc(t('openX'))}">
          ${ICONS.external}
        </button>
      </div>
    </header>
    <main class="content">
      ${account.self ? accountView(account) : emptyView()}
      ${account.self ? followersView(followers) : ''}
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
  // The snapshot is part of what is drawn, so it has to be part of the change
  // check; otherwise a new capture with the same account would not repaint.
  const sig = JSON.stringify([next || null, followers, remoteCapture]);
  if (sig === signature) return;
  signature = sig;
  account = next;
  render();
}

/** Read the stored account from the worker. Changing nothing on X. */
async function loadAccount() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT' });
    if (!result?.ok) {
      apply(null);
      return;
    }
    followers = result.followers ?? null;
    remoteCapture = result.capture ?? null;
    apply({ self: result.self, profile: result.profile, updatedAt: result.updatedAt });
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
  if (busy || scanning || remoteCapture) return;
  busy = true;
  note = '';
  clearTimeout(noteTimer);
  render();

  let message = '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'REFRESH' });
    message = result?.ok
      ? t('refreshDone')
      : t(REFRESH_ERRORS[result?.error] || 'refreshFailed');
  } catch {
    message = t('refreshFailed');
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

/**
 * Walk the whole follower list once. Counts and names only: nothing is stored
 * unless the capture reached the end of the list, so a partial read can never
 * look like people leaving.
 */
async function captureNow() {
  if (scanning || remoteCapture || busy) return;
  scanning = true;
  note = '';
  clearTimeout(noteTimer);
  render();

  let message = '';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'COLLECT_FOLLOWERS' });
    if (result?.ok) {
      message = result.first
        ? t('followersFirstSaved', [formatBig(result.total)])
        : t('followersSaved', [formatBig(result.total)]);
    } else if (result?.error === 'INCOMPLETE') {
      const captured = formatBig(result.captured || 0);
      message = result.reason === 'COUNT_MISMATCH' && result.expected != null
        ? t('captureIncompleteOf', [captured, formatBig(result.expected)])
        : result.reason === 'INVALID_ENTRIES' ? t('captureFormat', [captured])
          : t('captureStopped', [captured, formatBig(result.pages || 0)]);
    } else {
      message = t(CAPTURE_ERRORS[result?.error] || 'captureFailed', [formatBig(result?.captured || 0)]);
    }
  } catch {
    message = t('captureFailed');
  }

  await loadAccount();
  scanning = false;
  note = message;
  render();

  noteTimer = setTimeout(() => {
    note = '';
    render();
  }, 8000);
}

app.addEventListener('click', (event) => {
  const refreshBtn = event.target.closest('[data-action="refresh"]');
  if (refreshBtn) {
    refreshNow();
    return;
  }

  const captureBtn = event.target.closest('[data-action="capture"]');
  if (captureBtn) {
    captureNow();
    return;
  }

  const openX = event.target.closest('[data-action="open-x"]');
  if (openX) {
    openTab('https://x.com');
  }
});

app.addEventListener('toggle', (event) => {
  const kind = event.target.dataset?.change;
  if (!kind) return;
  if (event.target.open) expanded.add(kind);
  else expanded.delete(kind);
}, true);

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

// Keep the "updated …" line honest without re-rendering (and re-animating) the card.
setInterval(() => {
  const el = app.querySelector('.foot .foot-time');
  const ts = account?.profile?.ts;
  if (el && ts) el.textContent = t('panelUpdated', [relativeTime(ts)]);
  const snapshotTime = app.querySelector('.sub-foot .foot-time');
  if (snapshotTime && followers?.ts) snapshotTime.textContent = t('followersAt', [relativeTime(followers.ts)]);
}, 30_000);

// The markup is static, so its accessible label is set here instead.
const initialLoading = app.querySelector('.loading');
if (initialLoading) initialLoading.setAttribute('aria-label', t('loading'));

loadAccount();
