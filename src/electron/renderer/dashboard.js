'use strict';

const charts = window.TokenMonitorUsageCharts;
const themePresetsApi = window.TokenMonitorThemePresets;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// Canonical brand colours, captured before any override (clientColors is shared
// by reference and mutated in place to apply vendor overrides).
const BRAND_VENDOR_COLORS = { ...charts.clientColors };

const els = {
  body: document.body,
  themeToggle: document.getElementById('themeToggle'),
  refreshBtn: document.getElementById('refreshBtn'),
  minBtn: document.getElementById('minBtn'),
  closeBtn: document.getElementById('closeBtn'),
  tabs: Array.from(document.querySelectorAll('.dash-tab')),
  trendsPane: document.getElementById('trendsPane'),
  activityPane: document.getElementById('activityPane'),
  rangeSelect: document.getElementById('rangeSelect'),
  chart: document.getElementById('dashChart'),
  legend: document.getElementById('dashLegend'),
  heatmap: document.getElementById('dashHeatmap'),
  cards: document.getElementById('dashCards'),
  empty: document.getElementById('dashEmpty'),
  tooltip: document.getElementById('dashTooltip'),
  stackBtns: Array.from(document.querySelectorAll('[data-control="stack"] .seg-btn')),
  modeBtns: Array.from(document.querySelectorAll('[data-control="mode"] .seg-btn'))
};

const RANGES = ['7', '30', '90', '365', 'all'];
const state = {
  tab: 'activity', range: '30', stackBy: 'client', mode: 'bars', flat: false,
  locale: 'en', currency: 'USD', history: null, chartModel: null,
  chartKind: 'bars', motion: 'none', reduceMotion: 'system'
};

const DATA_MOTION_MS = 800;
const KLINE_MOTION_MS = 560;
const HEATMAP_MOTION_MS = 720;
const HEAT_CELL_MOTION_MS = 280;
let heatmapMotionGeneration = 0;

function prefersReducedMotion() {
  return motionPreferenceApi.shouldReduceMotion(state.reduceMotion, reducedMotionMedia?.matches);
}

function applyReduceMotionPreference(value) {
  state.reduceMotion = motionPreferenceApi.normalize(value);
  document.documentElement.dataset.reduceMotion = state.reduceMotion;
  if (!prefersReducedMotion()) return;
  heatmapMotionGeneration += 1;
  state.motion = 'none';
  for (const animation of document.getAnimations?.() || []) {
    try { animation.finish(); } catch (_) { animation.cancel(); }
  }
}

function captureGeometry(root, selector = '[data-motion-key]') {
  const geometry = new Map();
  for (const el of root?.querySelectorAll(selector) || []) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) geometry.set(el.dataset.motionKey, rect);
  }
  return geometry;
}

function animateChartGeometry(previous, { fromZero = false } = {}) {
  if (state.motion === 'none' || prefersReducedMotion()) return;
  if (state.chartKind === 'candle') {
    animateCandles();
    return;
  }
  const shapes = Array.from(els.chart.querySelectorAll('.bar-stack[data-motion-key]'));
  shapes.forEach((shape, index) => {
    const target = shape.getBoundingClientRect();
    const old = !fromZero && previous.get(shape.dataset.motionKey);
    let first;
    if (old && target.width > 0 && target.height > 0) {
      const sx = old.width / target.width;
      const sy = old.height / target.height;
      const dx = old.left - target.left;
      const dy = old.top - target.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      first = { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` };
    } else {
      first = { transformOrigin: 'center bottom', transform: 'scaleY(0)' };
    }
    shape.animate([first, { transformOrigin: first.transformOrigin, transform: 'none' }], {
      duration: DATA_MOTION_MS,
      delay: old ? 0 : Math.min(index, 18) * 12,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
  });
}

function animateCandles() {
  const candles = Array.from(els.chart.querySelectorAll('.candle-stack'));
  candles.forEach((candle, index) => {
    const delay = Math.min(index, 18) * 10;
    const body = candle.querySelector('.candle-body');
    body?.animate([
      { transform: 'scaleY(0)', transformOrigin: 'center center' },
      { transform: 'scaleY(1)', transformOrigin: 'center center' }
    ], {
      duration: KLINE_MOTION_MS,
      delay,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'backwards'
    });
    for (const wick of candle.querySelectorAll('.candle-wick')) {
      const length = wick.getTotalLength?.() || 0;
      if (length <= 0) continue;
      wick.animate([
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 }
      ], {
        duration: KLINE_MOTION_MS,
        delay,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'backwards'
      });
    }
  });
}

function animateHeatmapEntry() {
  if (prefersReducedMotion()) {
    els.heatmap.classList.remove('is-motion-pending');
    return;
  }
  // A focus event can trigger a second render while the cold entry animation
  // is pending. Restart against that new SVG instead of exposing it or letting
  // an obsolete schedule animate detached cells.
  const continuingEntry = els.heatmap.classList.contains('is-motion-pending');
  if (state.motion !== 'entry' && !continuingEntry) return;
  els.heatmap.classList.add('is-motion-pending');
  const generation = ++heatmapMotionGeneration;
  const startWhenVisible = () => {
    if (generation !== heatmapMotionGeneration) return;
    if (state.tab !== 'activity') {
      els.heatmap.classList.remove('is-motion-pending');
      return;
    }
    if (!document.hasFocus()) {
      window.addEventListener('focus', startWhenVisible, { once: true });
      return;
    }
    if (refreshRunning) {
      setTimeout(startWhenVisible, 16);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== heatmapMotionGeneration || state.tab !== 'activity') return;
      const cells = Array.from(els.heatmap.querySelectorAll('.heat-base-layer .heat'));
      if (!cells.length) {
        els.heatmap.classList.remove('is-motion-pending');
        return;
      }
      const columns = cells.map((cell) => Number(cell.getAttribute('x') || 0));
      const first = Math.min(...columns);
      const last = Math.max(...columns);
      const delaySpan = HEATMAP_MOTION_MS - HEAT_CELL_MOTION_MS;
      cells.forEach((cell, index) => {
        const position = last > first ? (columns[index] - first) / (last - first) : 0;
        const animation = cell.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: HEAT_CELL_MOTION_MS,
          delay: position * delaySpan,
          easing: 'ease',
          fill: 'both'
        });
        animation.finished.then(() => {
          if (!cell.isConnected) return;
          cell.removeAttribute('data-motion-hidden');
          cell.removeAttribute('opacity');
          animation.cancel();
        }).catch(() => {});
      });
      // On a cold BrowserWindow the animation effect is not composited until
      // the next paint. Keep the pre-paint guard for one more frame so there is
      // never a gap where the fully-rendered heatmap can flash through.
      requestAnimationFrame(() => {
        if (generation === heatmapMotionGeneration && state.tab === 'activity') {
          els.heatmap.classList.remove('is-motion-pending');
        }
      });
    }));
  };
  startWhenVisible();
}

function t(key, params) { return i18n.translate(state.locale, key, params); }

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.getAttribute('data-i18n')); });
  document.documentElement.lang = state.locale;
}

function applyAppearance(settings) {
  const opacity = Math.min(100, Math.max(0, settings?.glassOpacity ?? 68)) / 100;
  const depth = Math.min(100, Math.max(0, settings?.glassBlur ?? 32)) / 100;
  const root = document.documentElement.style;
  root.setProperty('--glass-alpha', opacity.toFixed(2));
  root.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  applyReduceMotionPreference(settings?.reduceMotion);
  applyThemeColors(settings?.themeColors);
  applyVendorColorOverrides(settings?.vendorColors);
  els.body.classList.toggle('flat', state.flat);
}

function applyThemeColors(overrides) {
  const root = document.documentElement.style;
  for (const { name, value } of themePresetsApi.themeCssVarEntries(overrides)) {
    if (value) root.setProperty(name, value);
    else root.removeProperty(name);
  }
}

function applyVendorColorOverrides(overrides) {
  const merged = themePresetsApi.mergeVendorColors(BRAND_VENDOR_COLORS, overrides);
  for (const key of Object.keys(BRAND_VENDOR_COLORS)) charts.clientColors[key] = merged[key];
}

function formatCompact(value) {
  const num = Math.round(Number(value || 0));
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(num / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(num);
}
function formatDurationCompact(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '0m';
}
function formatCost(usd) { return currencyApi.formatCurrencyFromUsd(usd, currencyApi.normalizeCurrency(state.currency)); }
function formatCostCompact(usd) {
  const code = currencyApi.normalizeCurrency(state.currency);
  const sym = (currencyApi.CURRENCY_RATES[code] || {}).symbol || '$';
  return `${sym}${formatCompact(currencyApi.convertUsd(usd, code))}`;
}
function shortDate(key) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key)); return m ? `${Number(m[2])}/${Number(m[3])}` : String(key); }
function axisEvery(list) { return Math.max(1, Math.ceil(list.length / 9)); }
// Local, not UTC: the heatmap's day cells are local-day scoped, so a UTC "today"
// shifted the whole rolling year by a day for non-UTC users (#177).
function todayKey() { return charts.localDayKey(); }
function daysBetween(a, b) {
  return Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 86400000);
}
function monthLabel(ym) {
  const mo = Number(String(ym).slice(5));
  if (state.locale.startsWith('zh')) return `${mo}月`;
  return new Date(Date.UTC(2000, mo - 1, 1)).toLocaleString('en-US', { month: 'short' });
}
function longDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return String(key);
  const mo = Number(m[2]), d = Number(m[3]);
  if (state.locale.startsWith('zh')) return `${mo}月${d}日`;
  return new Date(Date.UTC(2000, mo - 1, d)).toLocaleString('en-US', { month: 'short', day: 'numeric' });
}
function chartSize() {
  return { w: Math.max(320, els.chart.clientWidth || 800), h: Math.max(200, els.chart.clientHeight || 360) };
}

function populateRangeSelect() {
  els.rangeSelect.innerHTML = RANGES.map((r) => `<button class="range-btn${r === state.range ? ' active' : ''}" data-val="${r}">${t(`dashboard.range.${r}`)}</button>`).join('');
  els.rangeSelect.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (state.range === e.target.dataset.val) return;
      state.range = e.target.dataset.val;
      state.motion = 'update';
      els.rangeSelect.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === e.target));
      render();
    });
  });
}

function displayColor(hex) {
  // Brand colors like cursor/opencode are pure black (#000000) and vanish on the dark
  // dashboard — lift very dark colors to a visible grey for swatches, bars and dots.
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return hex || '#6ab4f0';
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 42) return hex;
  const lift = (c) => Math.round(c + (205 - c) * 0.62);
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
}
function colorFor(key) {
  const base = state.stackBy === 'model' ? charts.modelColor(key) : (charts.clientColors[key] || charts.clientColors.default);
  return displayColor(base);
}

// The app's CSP (style-src 'self') blocks inline style="" attributes, so swatch/dot
// colors are carried in data-c and applied via the CSSOM (.style, which CSP allows).
function applySwatchColors(root) {
  root.querySelectorAll('[data-c]').forEach((el) => { el.style.background = el.getAttribute('data-c'); });
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.setProperty('--bar-scale', el.getAttribute('data-w')); });
}

function renderLegend(model) {
  const totals = {};
  for (const bar of model.bars) for (const s of bar.segments) totals[s.key] = (totals[s.key] || 0) + s.value;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const rows = (model.keys || []).map((k) => ({ key: k, value: totals[k] || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  els.legend.innerHTML = rows.map((r) =>
    `<div class="dash-legend-row">`
    + `<span class="dash-legend-name"><span class="dash-legend-swatch" data-c="${colorFor(r.key)}"></span>${r.key}</span>`
    + `<span class="dash-legend-val">${formatCompact(r.value)}</span>`
    + `<span class="dash-legend-pct">${(r.value / grand * 100).toFixed(1)}%</span>`
    + `</div>`
  ).join('');
  applySwatchColors(els.legend);
}

function renderTrends() {
  const previousKind = state.chartKind;
  const previousGeometry = captureGeometry(els.chart, '.bar-stack[data-motion-key]');
  const daily = charts.clampDaily(state.history?.daily || [], state.range === 'all' ? 0 : Number(state.range));
  if (daily.length === 0) { els.chart.innerHTML = ''; els.legend.innerHTML = ''; state.chartModel = null; return; }
  const pad = { padTop: 10, padRight: 14, padBottom: 24, padLeft: 52 };
  
  if (state.mode === 'kline') {
    els.legend.innerHTML = ''; // Clear legend first to let chart expand
    const { w, h } = chartSize(); // Now measure correct expanded size
    const span = daysBetween(daily[0].date, daily[daily.length - 1].date) + 1;
    const target = Math.max(8, Math.round((w - pad.padLeft - pad.padRight) / 24));
    const bucketDays = span <= 10 ? 2 : Math.max(3, Math.round(span / target));
    const model = charts.candleChart(daily, { width: w, height: h, gap: 0.4, metric: 'tokens', bucketDays, ...pad });
    state.chartModel = model; state.chartKind = 'candle';
    const every = axisEvery(model.candles);
    els.chart.innerHTML = charts.candleChartSvg(model, { yTicks: 4, formatTick: formatCompact, axisLabel: (c, i) => (i % every === 0 ? shortDate(c.key) : '') });
    animateChartGeometry(previousGeometry, { fromZero: state.motion === 'entry' || previousKind !== 'candle' });
    return;
  }
  
  // For bars, the legend occupies vertical space which shrinks the chart.
  // Generate a dummy model to render the legend first and force a layout reflow.
  const tempModel = charts.dailyBarsChart(daily, { width: 100, height: 100, gap: 0.3, stackBy: state.stackBy, metric: 'tokens', ...pad });
  renderLegend(tempModel);
  
  // Now that the legend is in the DOM, measuring chartSize() forces a synchronous 
  // reflow and returns the correct squished height for the chart wrapper.
  const { w, h } = chartSize();
  const model = charts.dailyBarsChart(daily, { width: w, height: h, gap: 0.3, stackBy: state.stackBy, metric: 'tokens', ...pad });
  state.chartModel = model; state.chartKind = 'bars';
  const every = axisEvery(model.bars);
  els.chart.innerHTML = charts.barsChartSvg(model, { colorFor, yTicks: 4, formatTick: formatCompact, axisLabel: (bar, i) => (i % every === 0 ? shortDate(bar.label) : '') });
  animateChartGeometry(previousGeometry, { fromZero: state.motion === 'entry' || state.motion === 'series' || previousKind !== 'bars' });
}

function renderBreakdown() {
  const elsBreakdown = document.getElementById('dashBreakdown');
  if (!elsBreakdown) return;
  const previousBars = captureGeometry(elsBreakdown, '.dash-bd-bar-fill[data-motion-key]');
  const daily = state.history?.daily || [];
  if (daily.length === 0) { elsBreakdown.innerHTML = ''; return; }
  
  const clientTotals = {};
  const modelTotals = {};
  let grandTotal = 0;
  
  for (const d of daily) {
    if (d.perClient) Object.entries(d.perClient).forEach(([k, v]) => clientTotals[k] = (clientTotals[k] || 0) + Number(v.tokens || 0));
    if (d.perModel) Object.entries(d.perModel).forEach(([k, v]) => modelTotals[k] = (modelTotals[k] || 0) + Number(v.tokens || 0));
    grandTotal += Number(d.tokens || 0);
  }
  
  const buildCol = (titleKey, map, colorFn) => {
    const rows = Object.entries(map).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (rows.length === 0) return '';
    const maxVal = Math.max(...rows.map(x => x[1]));
    const html = rows.map(([key, val]) => {
      const pctGrand = grandTotal > 0 ? (val / grandTotal * 100).toFixed(1) : '0.0';
      const pctMax = maxVal > 0 ? (val / maxVal * 100).toFixed(1) : '0.0';
      const color = displayColor(colorFn(key));
      const motionKey = `${titleKey}:${encodeURIComponent(key)}`;
      return `<div class="dash-bd-row">
        <span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${color}"></span>${String(key).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</span>
        <div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-motion-key="${motionKey}" data-w="${Number(pctMax) / 100}" data-c="${color}"></div></div>
        <span class="dash-bd-val">${formatCompact(val)}</span>
        <span class="dash-bd-pct">${pctGrand}%</span>
      </div>`;
    }).join('');
    return `<div class="dash-breakdown-col"><div class="dash-breakdown-title" data-i18n="${titleKey}">${t(titleKey)}</div>${html}</div>`;
  };
  
  const colModel = buildCol('dashboard.stack.model', modelTotals, charts.modelColor);
  const colClient = buildCol('dashboard.stack.client', clientTotals, (k) => charts.clientColors[k] || charts.clientColors.default);
  
  elsBreakdown.innerHTML = colModel + colClient;
  applySwatchColors(elsBreakdown);
  if (state.motion !== 'none' && !prefersReducedMotion()) {
    for (const fill of elsBreakdown.querySelectorAll('.dash-bd-bar-fill[data-motion-key]')) {
      const trackWidth = fill.parentElement?.getBoundingClientRect().width || 0;
      const old = state.motion === 'entry' ? null : previousBars.get(fill.dataset.motionKey);
      const fromScale = old && trackWidth > 0 ? old.width / trackWidth : 0;
      fill.animate([{ transform: `scaleX(${fromScale})` }, { transform: `scaleX(${fill.dataset.w})` }], {
        duration: DATA_MOTION_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'backwards'
      });
    }
  }
}

let statCardMeasureCanvas = null;

function canvasFontFor(node) {
  const style = window.getComputedStyle(node);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function transformedText(node) {
  const text = node?.textContent || '';
  return window.getComputedStyle(node).textTransform === 'uppercase' ? text.toUpperCase() : text;
}

function measureTextWidth(node) {
  if (!node) return 0;
  statCardMeasureCanvas ||= document.createElement('canvas');
  const ctx = statCardMeasureCanvas.getContext('2d');
  ctx.font = canvasFontFor(node);
  return ctx.measureText(transformedText(node)).width;
}

function statCardContentWidth(card) {
  const style = window.getComputedStyle(card);
  const padding = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
  return Math.max(
    measureTextWidth(card.querySelector('.dash-card-v')),
    measureTextWidth(card.querySelector('.dash-card-k'))
  ) + padding;
}

function balanceStatCards() {
  const cards = Array.from(els.cards.querySelectorAll('.dash-card'));
  if (!cards.length) return;
  els.cards.style.setProperty('--stat-count', String(cards.length));
  const columns = charts.statCardColumnWidths(cards.map(statCardContentWidth), {
    totalWidth: els.cards.clientWidth || 0,
    minWidth: 92,
    safety: 10
  });
  if (columns.length) els.cards.style.gridTemplateColumns = columns.map((width) => `${width}px`).join(' ');
}

function renderActivity() {
  const daily = state.history?.daily || [];
  const end = todayKey();
  // Start at the 1st of the month 11 months back → exactly 12 distinct months (Jul→Jun),
  // like GitHub/codex, so there's no duplicate leading month label.
  const now = new Date(`${end}T00:00:00Z`);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const gap = 4;
  let heat = charts.contribHeatmap(daily, { cell: 14, gap, startDate: start, endDate: end });
  const avail = els.heatmap.clientWidth || 0;
  if (heat.weeks > 0 && avail > 0) {
    // Size cells to the available width, capped so a wide window doesn't stretch them edge-to-edge.
    const cell = Math.max(9, Math.min(22, (avail - heat.weeks * gap) / heat.weeks)); // fractional → fills exactly
    heat = charts.contribHeatmap(daily, { cell, gap, startDate: start, endDate: end });
  }
  const hideHeatmapForEntry = !prefersReducedMotion()
    && (state.motion === 'entry' || els.heatmap.classList.contains('is-motion-pending'));
  els.heatmap.innerHTML = heat.cells.length
    ? charts.heatmapSvg(heat, { monthLabel: (m) => monthLabel(m.label), initialHidden: hideHeatmapForEntry })
    : '';
  animateHeatmapEntry();
  state.dayMap = new Map((state.history?.daily || []).map((d) => [String(d.date).slice(0, 10), { tokens: Number(d.tokens || 0), cost: Number(d.cost || 0) }]));
  const cards = charts.statsCards(state.history?.summary || {});
  const LABELS = {
    totalTokens: 'dashboard.stat.totalTokens', totalCost: 'dashboard.stat.totalCost',
    activeDays: 'trends.activeDays', currentStreak: 'trends.currentStreak',
    activeTimeMs: 'trends.activeTime', peakDayTokens: 'trends.peakDay',
    favoriteModel: 'dashboard.stat.favoriteModel', messages: 'dashboard.stat.messages'
  };
  els.cards.innerHTML = charts.statsCardsHtml(cards, {
    label: (k) => t(LABELS[k] || k),
    format: (c) => (c.kind === 'cost' ? formatCostCompact(c.value)
      : c.kind === 'duration' ? formatDurationCompact(c.value)
        : c.kind === 'model' ? (c.value || '—') : formatCompact(c.value))
  });
  balanceStatCards();
  renderBreakdown();
}

function render() {
  hideTooltip();
  const hasData = (state.history?.daily || []).length > 0 || (state.history?.monthly || []).length > 0;
  els.empty.classList.toggle('hidden', hasData);
  els.trendsPane.classList.toggle('hidden', state.tab !== 'trends');
  els.activityPane.classList.toggle('hidden', state.tab !== 'activity');
  els.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  els.stackBtns.forEach((b) => b.classList.toggle('active', b.dataset.stack === state.stackBy));
  document.querySelector('[data-control="stack"]').style.display = state.mode === 'kline' ? 'none' : '';
  if (state.tab === 'trends') {
    heatmapMotionGeneration += 1;
    els.heatmap.classList.remove('is-motion-pending');
    renderTrends();
  } else {
    renderActivity();
  }
  state.motion = 'none';
}

function hideTooltip() { els.tooltip.classList.add('hidden'); }

function positionTooltip(ev) {
  els.tooltip.classList.remove('hidden');
  const rect = els.tooltip.getBoundingClientRect();
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - pad;
  els.tooltip.style.left = `${Math.max(8, x)}px`;
  els.tooltip.style.top = `${Math.max(8, y)}px`;
}

function showBarTooltip(bar, ev) {
  const segs = (bar.segments || []).filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const rows = segs.map((s) =>
    `<div class="tt-row"><span class="tt-dot" data-c="${colorFor(s.key)}"></span><span class="tt-name">${s.key}</span><span class="tt-val">${formatCompact(s.value)}</span></div>`
  ).join('');
  els.tooltip.innerHTML = `<div class="tt-head">${shortDate(bar.label)} · ${formatCompact(bar.total)}</div>${rows}`;
  applySwatchColors(els.tooltip);
  positionTooltip(ev);
}

function showCandleTooltip(c, ev) {
  // Each candle spans a bucket of days: O = first day, C = last day, H/L = busiest/quietest.
  const head = c.endKey && c.endKey !== c.key ? `${longDate(c.key)} – ${longDate(c.endKey)}` : longDate(c.key);
  const ohlc = [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]];
  els.tooltip.innerHTML = `<div class="tt-head">${head}</div>`
    + ohlc.map(([k, v]) => `<div class="tt-row"><span class="tt-name">${k}</span><span class="tt-val">${formatCompact(v)}</span></div>`).join('');
  positionTooltip(ev);
}

function showHeatTooltip(date, day, ev) {
  const tokens = day ? day.tokens : 0;
  const cost = day ? day.cost : 0;
  const tokLabel = state.locale.startsWith('zh') ? 'Token' : 'Tokens';
  const costLabel = state.locale.startsWith('zh') ? '花費' : 'Cost';
  let html = `<div class="tt-head">${longDate(date)}</div>`;
  html += `<div class="tt-row"><span class="tt-name">${tokLabel}</span><span class="tt-val">${formatCompact(tokens)}</span></div>`;
  if (cost > 0) html += `<div class="tt-row"><span class="tt-name">${costLabel}</span><span class="tt-val">${formatCost(cost)}</span></div>`;
  els.tooltip.innerHTML = html;
  positionTooltip(ev);
}

let refreshRunning = false;
let refreshQueued = false;

async function refresh() {
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  try {
    state.motion = state.history ? 'update' : 'entry';
    state.history = await window.tokenMonitor.getDashboardHistory();
    render();
  } catch (error) {
    state.motion = 'none';
    console.log(`[dashboard] history failed: ${error.message}`);
  } finally {
    refreshRunning = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh();
    }
  }
}

async function boot() {
  let settings = {};
  try { settings = await window.tokenMonitor.getSettings(); } catch (_) {}
  state.locale = i18n.resolveLocale(settings.language, navigator.languages);
  state.currency = settings.currency || 'USD';
  if (settings.currencyRatesEffective && window.TokenMonitorCurrency?.configureRates) {
    window.TokenMonitorCurrency.configureRates(settings.currencyRatesEffective);
  }
  state.flat = settings.dashboardFlat === true;
  applyAppearance(settings);
  applyTranslations();
  populateRangeSelect();
  render();
  await refresh();
  window.tokenMonitor.dashboard.ready();
}

// Effective rates can change after boot (auto refresh / manual override). The
// dashboard shares the main window's preload, so it receives the same push.
window.tokenMonitor.onSettingsPush?.((next) => {
  if (!next) return;
  let needsRender = false;
  if (next.currencyRatesEffective && window.TokenMonitorCurrency?.configureRates) {
    window.TokenMonitorCurrency.configureRates(next.currencyRatesEffective);
    // A rate-only change (auto refresh / same-currency manual override) keeps
    // the currency code identical, so the code-change branch below won't fire —
    // repaint explicitly or the already-rendered costs stay stale.
    needsRender = true;
  }
  if (next.currency && state.currency !== next.currency) {
    state.currency = next.currency;
    needsRender = true;
  }
  const reduceMotion = motionPreferenceApi.normalize(next.reduceMotion);
  if (state.reduceMotion !== reduceMotion) {
    applyReduceMotionPreference(reduceMotion);
    needsRender = true;
  }
  if (needsRender) render();
});

reducedMotionMedia?.addEventListener?.('change', () => {
  if (state.reduceMotion !== 'system') return;
  applyReduceMotionPreference('system');
  render();
});

window.tokenMonitor.onDashboardHistoryChanged?.(() => { void refresh(); });

els.tabs.forEach((tab) => tab.addEventListener('click', () => {
  if (state.tab === tab.dataset.tab) return;
  state.tab = tab.dataset.tab;
  state.motion = 'entry';
  els.tabs.forEach((x) => x.classList.toggle('active', x === tab));
  render();
}));
els.stackBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.stackBy === b.dataset.stack) return;
  state.stackBy = b.dataset.stack;
  state.motion = 'series';
  render();
}));
els.modeBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  state.motion = 'update';
  render();
}));
els.themeToggle.addEventListener('click', () => { state.flat = !state.flat; els.body.classList.toggle('flat', state.flat); window.tokenMonitor.updateSettings({ dashboardFlat: state.flat }); });
els.refreshBtn.addEventListener('click', refresh);
els.minBtn.addEventListener('click', () => window.tokenMonitor.dashboard.minimize());
els.closeBtn.addEventListener('click', () => window.tokenMonitor.dashboard.close());

els.chart.addEventListener('mousemove', (ev) => {
  const hit = ev.target.closest('.bar-hover');
  if (!hit || !state.chartModel) { hideTooltip(); return; }
  const i = Number(hit.getAttribute('data-i'));
  if (state.chartKind === 'candle') {
    const c = state.chartModel.candles[i];
    if (c) showCandleTooltip(c, ev); else hideTooltip();
  } else {
    const bar = state.chartModel.bars[i];
    if (bar) showBarTooltip(bar, ev); else hideTooltip();
  }
});
els.chart.addEventListener('mouseleave', hideTooltip);

els.heatmap.addEventListener('mousemove', (ev) => {
  const hit = ev.target.closest('.heat');
  if (!hit) { hideTooltip(); return; }
  const date = hit.getAttribute('data-d');
  showHeatTooltip(date, state.dayMap && state.dayMap.get(date), ev);
});
els.heatmap.addEventListener('mouseleave', hideTooltip);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { state.motion = 'none'; render(); }, 120); // both the chart and the heatmap are sized to the window
});
window.addEventListener('focus', refresh);

boot();
