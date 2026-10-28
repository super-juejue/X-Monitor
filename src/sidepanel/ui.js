/**
 * Small view helpers: icons, avatars, toasts, number animation.
 * Everything returns escaped HTML strings so views stay declarative.
 */

import { formatBig, formatInt, formatSigned } from '../lib/time.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

const ICONS = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/>',
  quote: '<path d="M7 7h4v4c0 3-1.5 5-4.5 6l-.8-1.6C7.6 14.7 8.4 13.6 8.5 12H7z"/><path d="M15 7h4v4c0 3-1.5 5-4.5 6l-.8-1.6c1.9-.7 2.7-1.8 2.8-3.4h-1.5z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  'arrow-up': '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  'arrow-down': '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  'arrow-up-right': '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
  'trend-up': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  'trend-down': '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
};

export function icon(name, size = 18, className = '') {
  const body = ICONS[name] || ICONS.sparkles;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function logoMark(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3.5 15.5 8 9.5l3.4 3.9L16 5.5l4.5 5" stroke="white" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="20.5" cy="16.5" r="2" fill="white" fill-opacity=".9"/>
  </svg>`;
}

export function verifiedMark() {
  return `<span class="verified" title="已验证">${icon('check', 9)}</span>`;
}

function imageUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function hueFor(text) {
  let hash = 0;
  const value = String(text || '?');
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

export function avatar(person, size = 36, className = '') {
  const name = person?.name || person?.handle || '?';
  const initial = String(name).trim().charAt(0).toUpperCase() || '?';
  const src = imageUrl(person?.avatar);
  const hue = hueFor(person?.handle || name);
  return `<span class="avatar ${className}" style="--avatar-size:${size}px;--avatar-hue:${hue}">
    <span class="avatar-fallback" aria-hidden="true">${esc(initial)}</span>
    ${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}
  </span>`;
}

export function deltaPill(value, { label = '', suffix = '', empty = '' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return empty ? `<span class="delta flat">${esc(empty)}</span>` : '';
  }
  const tone = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const body = `${sign}${formatBig(Math.abs(value))}${suffix}`;
  const arrow = value > 0 ? icon('arrow-up', 9) : value < 0 ? icon('arrow-down', 9) : '';
  return `<span class="delta ${tone}" title="${esc(label)}">${arrow}${esc(body)}${label ? `<span class="delta-label">${esc(label)}</span>` : ''}</span>`;
}

export function livePill(live) {
  return `<span class="live-pill ${live ? 'is-live' : ''}"><i></i>${live ? 'LIVE' : '待机'}</span>`;
}

export function emptyState({ iconName = 'sparkles', title, body = '', action = '' }) {
  return `<div class="empty">
    <span class="empty-icon">${icon(iconName, 22)}</span>
    <strong>${esc(title)}</strong>
    ${body ? `<p>${esc(body)}</p>` : ''}
    ${action ? `<div class="empty-action">${action}</div>` : ''}
  </div>`;
}

export function enter(index, animate, base = '') {
  const cls = `${base} ${animate ? 'enter' : ''}`.trim();
  const delay = animate ? ` style="animation-delay:${Math.min(index, 14) * 28}ms"` : '';
  return `class="${cls}"${delay}`;
}

export function switchControl({ setting, checked, label, description = '', disabled = false }) {
  return `<label class="switch-row">
    <span class="switch-copy"><strong>${esc(label)}</strong>${description ? `<span>${esc(description)}</span>` : ''}</span>
    <span class="switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}">
      <input type="checkbox" data-setting="${esc(setting)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </span>
  </label>`;
}

export function segmented(name, options, value, { className = '', action = 'segmented' } = {}) {
  return `<div class="seg ${className}" data-seg="${esc(name)}">
    ${options.map(([key, label]) => `<button type="button" data-action="${esc(action)}" data-seg-name="${esc(name)}" data-seg-value="${esc(key)}" class="${value === key ? 'active' : ''}">${esc(label)}</button>`).join('')}
  </div>`;
}

export function animateNumbers(root, ui) {
  const nodes = root.querySelectorAll('[data-count]');
  nodes.forEach((el) => {
    const key = el.dataset.countKey || 'count';
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) {
      el.textContent = el.dataset.empty || '—';
      return;
    }
    const from = Number.isFinite(ui.numbers[key]) ? ui.numbers[key] : 0;
    ui.numbers[key] = target;
    const format = el.dataset.countFormat === 'big'
      ? formatBig
      : el.dataset.countFormat === 'signed'
        ? formatSigned
        : formatInt;
    if (ui.reduced || from === target || Math.abs(target - from) < 1) {
      el.textContent = format(target);
      return;
    }
    const duration = 680;
    const started = performance.now();
    const frame = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      el.textContent = format(Math.round(from + (target - from) * eased));
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

let toastCounter = 0;

export function showToast(message, tone = 'info', duration = 3200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const toneIcon = tone === 'success' ? 'check' : tone === 'error' || tone === 'warning' ? 'alert' : 'sparkles';
  const id = `toast-${(toastCounter += 1)}`;
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.id = id;
  node.innerHTML = `<span class="tone-icon">${icon(toneIcon, 15)}</span><span>${esc(message)}</span>`;
  host.appendChild(node);
  while (host.children.length > 3) host.firstElementChild?.remove();
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, duration);
}
