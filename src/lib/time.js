/**
 * Date and number formatting.
 *
 * Wording and number styles follow the browser's language rather than a fixed
 * locale: "3 min ago" and "3 分钟前" both come out of Intl, and the relative
 * strings themselves live in the message bundles.
 */

import { t, uiLocale } from './i18n.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

let locale = null;
const formatters = new Map();

/** Override the locale; by default it is the browser's UI language. */
export function setLocale(next) {
  if (typeof next === 'string' && next) {
    locale = next;
    formatters.clear();
  }
  return currentLocale();
}

function currentLocale() {
  if (!locale) locale = uiLocale();
  return locale;
}

function formatter(kind, options) {
  const key = `${kind}:${currentLocale()}:${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;

  let made;
  try {
    made = kind === 'date'
      ? new Intl.DateTimeFormat(currentLocale(), options)
      : new Intl.NumberFormat(currentLocale(), options);
  } catch {
    // An unknown locale string must not break the panel.
    made = kind === 'date'
      ? new Intl.DateTimeFormat('en', options)
      : new Intl.NumberFormat('en', options);
  }
  formatters.set(key, made);
  return made;
}

/**
 * Parse the classic Twitter date format, e.g.
 * "Wed Oct 10 20:19:24 +0000 2018".
 * Falls back to Date.parse for ISO strings.
 */
export function parseTwitterDate(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const str = String(value);
  const m = str.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/);
  if (m) {
    const month = MONTHS[m[1]];
    if (month === undefined) return null;
    const ms = Date.UTC(Number(m[9]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    const offsetMin = (Number(m[7]) * 60 + Number(m[8])) * (m[6] === '+' ? 1 : -1);
    return ms - offsetMin * MINUTE;
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "just now", "5 min ago", "yesterday", then a plain date. */
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = now - ts;
  if (diff < MINUTE) return t('timeNow');
  if (diff < HOUR) return t('timeMinutes', [String(Math.floor(diff / MINUTE))]);
  if (diff < DAY) return t('timeHours', [String(Math.floor(diff / HOUR))]);
  if (diff < 2 * DAY) return t('timeYesterday');
  if (diff < 7 * DAY) return t('timeDays', [String(Math.floor(diff / DAY))]);

  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return formatter('date', sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function formatInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return formatter('number', {}).format(Math.round(n));
}

/** Big numbers stay precise until they would break the layout. */
export function formatBig(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1e7) return formatInt(n);
  return formatter('number', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
