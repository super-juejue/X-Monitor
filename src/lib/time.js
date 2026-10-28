/**
 * Date / number formatting helpers.
 * All day boundaries are local-time based, because "today" should match the
 * user's wall clock rather than UTC.
 */

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function dayKey(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayKeyFromTs(ts) {
  return ts ? dayKey(new Date(ts)) : '';
}

export function daysBack(count, from = new Date()) {
  const out = [];
  const anchor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

export function startOfDay(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = now - ts;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return '昨天';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return formatDate(ts, now);
}

export function formatDate(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = new Date(ts);
  const n = new Date(now);
  const sameYear = d.getFullYear() === n.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDateTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(ts, now)} ${hh}:${mm}`;
}

export function monthDay(dayKeyString) {
  if (!dayKeyString) return '';
  const [, m, d] = dayKeyString.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function formatInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('zh-CN').format(Math.round(n));
}

function trimDecimal(n) {
  return n.toFixed(1).replace(/\.0$/, '');
}

export function formatCompact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e8) return `${sign}${trimDecimal(abs / 1e8)}亿`;
  if (abs >= 1e4) return `${sign}${trimDecimal(abs / 1e4)}万`;
  return formatInt(n);
}

/** Big numbers stay precise until they would break the layout. */
export function formatBig(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1e7 ? formatCompact(n) : formatInt(n);
}

export function formatSigned(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const body = abs >= 1e4 ? formatCompact(abs) : formatInt(abs);
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return '0';
}
