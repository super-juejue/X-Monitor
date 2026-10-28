/**
 * Dependency-free SVG charts with draw-in animations.
 */

import { formatCompact, monthDay } from '../lib/time.js';

let gradientId = 0;

function cleanPoints(points) {
  return (points || []).map((point) => ({
    ...point,
    value: typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null,
  }));
}

function smoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function splitSegments(points, xFor, yFor) {
  const segments = [];
  let current = null;
  points.forEach((point, index) => {
    if (point.value === null) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      segments.push(current);
    }
    current.push({ x: xFor(index), y: yFor(point.value), day: point.day, value: point.value });
  });
  return segments;
}

function scaleFor(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(1, (max - min) * 0.18);
  return { min: min - padding, max: max + padding, rawMin: min, rawMax: max };
}

export function sparkline(points, {
  width = 320,
  height = 56,
  pad = 4,
  animate = true,
  from = '#8b5cf6',
  to = '#22d3ee',
  fill = true,
  strokeWidth = 2,
} = {}) {
  const clean = cleanPoints(points);
  const values = clean.filter((point) => point.value !== null).map((point) => point.value);
  if (values.length < 2) return '';

  const { min, max } = scaleFor(values);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const xFor = (index) => pad + (clean.length === 1 ? innerW / 2 : (index / (clean.length - 1)) * innerW);
  const yFor = (value) => pad + innerH - ((value - min) / (max - min || 1)) * innerH;
  const segments = splitSegments(clean, xFor, yFor);
  const id = `sp-${(gradientId += 1)}`;
  const lineClass = animate ? 'class="chart-line" pathLength="1"' : '';
  const areaClass = animate ? 'class="chart-area"' : '';

  const lines = segments
    .filter((segment) => segment.length > 1)
    .map((segment) => `<path d="${smoothPath(segment)}" fill="none" stroke="url(#${id})" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${lineClass}/>`)
    .join('');

  const areas = fill
    ? segments
      .filter((segment) => segment.length > 1)
      .map((segment) => {
        const last = segment[segment.length - 1];
        const first = segment[0];
        return `<path d="${smoothPath(segment)} L ${last.x.toFixed(2)} ${height - pad} L ${first.x.toFixed(2)} ${height - pad} Z" fill="url(#${id}-area)" ${areaClass}/>`;
      })
      .join('')
    : '';

  const lastSegment = segments[segments.length - 1];
  const lastPoint = lastSegment?.[lastSegment.length - 1];
  const dot = lastPoint
    ? `<circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="2.6" fill="${to}" ${animate ? 'class="chart-dot"' : ''}/>
       <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="6" fill="${to}" opacity=".14"/>`
    : '';

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${from}"/>
        <stop offset="1" stop-color="${to}"/>
      </linearGradient>
      <linearGradient id="${id}-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${to}" stop-opacity=".24"/>
        <stop offset="1" stop-color="${to}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${areas}
    ${lines}
    ${dot}
  </svg>`;
}

export function areaChart(points, { animate = true } = {}) {
  const clean = cleanPoints(points);
  const values = clean.filter((point) => point.value !== null).map((point) => point.value);
  if (values.length < 2) {
    return `<div class="chart-empty">
      <span class="chart-empty-icon">${'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M3 21h18"/></svg>'}</span>
      <span>再记录几天数据，这里就会出现趋势</span>
    </div>`;
  }

  const width = 340;
  const height = 132;
  const pad = { top: 12, right: 8, bottom: 22, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const { min, max } = scaleFor(values);
  const xFor = (index) => pad.left + (clean.length === 1 ? innerW / 2 : (index / (clean.length - 1)) * innerW);
  const yFor = (value) => pad.top + innerH - ((value - min) / (max - min || 1)) * innerH;
  const segments = splitSegments(clean, xFor, yFor);
  const id = `area-${(gradientId += 1)}`;
  const lineClass = animate ? 'class="chart-line" pathLength="1"' : '';
  const areaClass = animate ? 'class="chart-area"' : '';

  const grid = [0.25, 0.5, 0.75]
    .map((ratio) => `<line class="chart-grid" x1="${pad.left}" y1="${(pad.top + innerH * ratio).toFixed(1)}" x2="${width - pad.right}" y2="${(pad.top + innerH * ratio).toFixed(1)}"/>`)
    .join('');

  const lines = segments
    .filter((segment) => segment.length > 1)
    .map((segment) => `<path d="${smoothPath(segment)}" fill="none" stroke="url(#${id})" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${lineClass}/>`)
    .join('');

  const areas = segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const last = segment[segment.length - 1];
      const first = segment[0];
      return `<path d="${smoothPath(segment)} L ${last.x.toFixed(2)} ${height - pad.bottom} L ${first.x.toFixed(2)} ${height - pad.bottom} Z" fill="url(#${id}-area)" ${areaClass}/>`;
    })
    .join('');

  const lastSegment = segments[segments.length - 1];
  const lastPoint = lastSegment?.[lastSegment.length - 1];
  const dot = lastPoint
    ? `<circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="3" fill="#22d3ee" ${animate ? 'class="chart-dot"' : ''}/>
       <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="7" fill="#22d3ee" opacity=".14"/>`
    : '';

  const firstDay = clean[0]?.day;
  const lastDay = clean[clean.length - 1]?.day;
  const midDay = clean[Math.floor(clean.length / 2)]?.day;

  return `<svg class="area-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="关注者趋势">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#8b5cf6"/>
        <stop offset="1" stop-color="#22d3ee"/>
      </linearGradient>
      <linearGradient id="${id}-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#22d3ee" stop-opacity=".22"/>
        <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${areas}
    ${lines}
    ${dot}
    <text class="chart-axis" x="${pad.left}" y="${height - 6}">${monthDay(firstDay)}</text>
    <text class="chart-axis" x="${width / 2}" y="${height - 6}" text-anchor="middle">${monthDay(midDay)}</text>
    <text class="chart-axis" x="${width - pad.right}" y="${height - 6}" text-anchor="end">${monthDay(lastDay)}</text>
  </svg>
  <div class="chart-range"><span>最低 ${formatCompact(Math.min(...values))}</span><span>最高 ${formatCompact(Math.max(...values))}</span></div>`;
}

export function netBars(points, { animate = true, limit = 30 } = {}) {
  const clean = cleanPoints(points).slice(-limit);
  const values = clean.map((point) => point.value).filter((value) => value !== null);
  if (!values.length) {
    return `<div class="chart-empty"><span>完成一次粉丝同步后，这里会显示每日净增</span></div>`;
  }
  const maxAbs = Math.max(1, ...values.map((value) => Math.abs(value)));

  const bars = clean.map((point, index) => {
    if (point.value === null) {
      return '<div class="netbar" aria-hidden="true"></div>';
    }
    const height = Math.max(3, Math.round((Math.abs(point.value) / maxAbs) * 46));
    const tone = point.value >= 0 ? 'up' : 'down';
    const delay = animate ? `animation-delay:${Math.min(index, 20) * 18}ms;` : '';
    return `<div class="netbar" title="${monthDay(point.day)} · ${point.value > 0 ? '+' : ''}${point.value}">
      <span class="bar ${tone} ${animate ? 'enter' : ''}" style="height:${height}%;${delay}"></span>
    </div>`;
  }).join('');

  const labelDays = [clean[0]?.day, clean[Math.floor(clean.length / 2)]?.day, clean[clean.length - 1]?.day]
    .filter(Boolean);

  return `<div class="netbars">${bars}</div>
    <div class="netlabels">${labelDays.map((day, index) => `<span${index === 1 ? ' class="mid"' : ''}>${monthDay(day)}</span>`).join('')}</div>`;
}

export function donut(segments, { animate = true } = {}) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  if (!total) return '';
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const circles = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const length = (segment.value / total) * circumference;
      const gap = 1.5;
      const visible = Math.max(0.5, length - gap);
      const circle = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="11" stroke-linecap="butt" stroke-dasharray="${visible.toFixed(2)} ${(circumference - visible).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" ${animate ? 'class="donut-seg"' : ''}/>`;
      offset += length;
      return circle;
    })
    .join('');

  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 120 120" role="img" aria-label="互动构成">
      <circle cx="60" cy="60" r="${radius}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="11"/>
      <g transform="rotate(-90 60 60)">${circles}</g>
      <text x="60" y="57" text-anchor="middle" class="donut-value">${formatCompact(total)}</text>
      <text x="60" y="71" text-anchor="middle" class="donut-label">互动</text>
    </svg>
  </div>`;
}
