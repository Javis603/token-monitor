'use strict';

const charts = window.TokenMonitorUsageCharts;
const dimensions = window.TokenMonitorDashboardDimensions;
const themePresetsApi = window.TokenMonitorThemePresets;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const compactMoneyApi = window.TokenMonitorCompactMoney;
const compactTokenApi = window.TokenMonitorCompactTokens;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const fontSettingsApi = window.TokenMonitorFontSettings;
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
  rangeGroups: Array.from(document.querySelectorAll('.js-range-select')),
  customRanges: Array.from(document.querySelectorAll('.js-custom-range')),
  rangeStarts: Array.from(document.querySelectorAll('.js-range-start')),
  rangeEnds: Array.from(document.querySelectorAll('.js-range-end')),
  chart: document.getElementById('dashChart'),
  legend: document.getElementById('dashLegend'),
  heatmap: document.getElementById('dashHeatmap'),
  weekdays: document.getElementById('dashWeekdays'),
  hours: document.getElementById('dashHours'),
  trend: document.getElementById('dashTrend'),
  share: document.getElementById('dashShare'),
  cards: document.getElementById('dashCards'),
  portrait: document.getElementById('dashPortrait'),
  empty: document.getElementById('dashEmpty'),
  tooltip: document.getElementById('dashTooltip'),
  modal: document.getElementById('dashModal'),
  modalTitle: document.getElementById('dashModalTitle'),
  modalBody: document.getElementById('dashModalBody'),
  modalClose: document.getElementById('dashModalClose'),
  filter: document.getElementById('dashFilter'),
  stackBtns: Array.from(document.querySelectorAll('[data-control="stack"] .seg-btn')),
  modeBtns: Array.from(document.querySelectorAll('[data-control="mode"] .seg-btn')),
  heatmapMetricBtns: Array.from(document.querySelectorAll('[data-control="heatmapMetric"] .seg-btn, [data-control="breakdownMetric"] .seg-btn, [data-control="trendMetric"] .seg-btn')),
  breakdownViewBtns: Array.from(document.querySelectorAll('[data-control="breakdownView"] .seg-btn')),
  shareByBtns: Array.from(document.querySelectorAll('[data-control="shareBy"] .seg-btn')),
  groupByBtns: Array.from(document.querySelectorAll('[data-control="groupBy"] .seg-btn'))
};

const RANGES = ['7', '30', '90', '365', 'all', 'custom'];
const state = {
  tab: 'activity', range: '30', stackBy: 'client', mode: 'bars', flat: false,
  locale: 'en', currency: 'USD', compactTokenUnits: 'western', history: null, chartModel: null,
  chartKind: 'bars', motion: 'none', reduceMotion: 'system',
  heatmapMetric: 'cost',
  breakdownView: 'split',
  groupBy: 'day',
  customStart: '',
  customEnd: '',
  trendSeries: [],
  shareBy: 'client',
  modal: '',
  modalChartModel: null,
  filterClient: '',
  filterModel: '',
  filterWeekday: null
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

function effectiveCompactTokenUnits() {
  return compactTokenApi.effectiveCompactTokenUnits(state.compactTokenUnits, state.locale);
}

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
  applyFontSettings(settings);
  applyThemeColors(settings?.themeColors);
  applyVendorColorOverrides(settings?.vendorColors);
  els.body.classList.toggle('flat', state.flat);
}

function applyFontSettings(settings) {
  const root = document.documentElement.style;
  const { interfaceFont, displayFont } = fontSettingsApi.resolveEffectiveFontSettings(settings, {
    interfaceDefault: fontSettingsApi.DEFAULT_DASHBOARD_INTERFACE_FONT
  });
  root.setProperty('--ui-font', interfaceFont);
  root.setProperty('--display-font', displayFont);
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
  return compactTokenApi.formatCompactTokens(value, effectiveCompactTokenUnits(), state.locale);
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
  return compactMoneyApi.formatCompactCurrencyFromUsd(
    usd,
    state.currency,
    effectiveCompactTokenUnits(),
    state.locale
  );
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
  const m = /^(\d{4})-(\d{2})/.exec(String(ym));
  const mo = m ? Number(m[2]) : Number(String(ym).slice(5));
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
  const html = RANGES.map((r) => `<button type="button" class="range-btn${r === state.range ? ' active' : ''}" data-val="${r}">${t(`dashboard.range.${r}`)}</button>`).join('');
  for (const group of els.rangeGroups) {
    group.innerHTML = html;
    group.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => selectRange(btn.dataset.val));
    });
  }
}

function selectedRange() {
  return dimensions.resolveRange(state.range, {
    todayKey: todayKey(),
    customStart: state.customStart,
    customEnd: state.customEnd,
    daily: state.history?.daily || []
  });
}

function rangedDaily(daily = state.history?.daily || []) {
  return dimensions.sliceDaily(daily, selectedRange());
}

function selectRange(value) {
  const next = RANGES.includes(value) ? value : '30';
  if (next === 'custom' && state.range !== 'custom') {
    const window = dimensions.resolveRange(state.range, {
      todayKey: todayKey(),
      daily: state.history?.daily || []
    });
    state.customStart = window.start;
    state.customEnd = window.end;
  } else if (next === 'custom' && (!state.customStart || !state.customEnd)) {
    const window = dimensions.resolveRange('30', {
      todayKey: todayKey(),
      daily: state.history?.daily || []
    });
    if (!state.customStart) state.customStart = window.start;
    if (!state.customEnd) state.customEnd = window.end;
  }
  if (state.range === next && next !== 'custom') return;
  state.range = next;
  state.motion = 'update';
  render();
}

function syncTimeControls() {
  const bounds = dimensions.dataBounds(state.history?.daily || []);
  const window = selectedRange();
  for (const group of els.rangeGroups) {
    group.querySelectorAll('.range-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.val === state.range));
  }
  for (const el of els.customRanges) el.classList.toggle('hidden', state.range !== 'custom');
  for (const input of els.rangeStarts) {
    if (bounds.start) input.min = bounds.start;
    if (bounds.end) input.max = bounds.end;
    if (input !== document.activeElement) input.value = window.start || '';
  }
  for (const input of els.rangeEnds) {
    if (bounds.start) input.min = bounds.start;
    if (bounds.end) input.max = bounds.end;
    if (input !== document.activeElement) input.value = window.end || '';
  }
}

function onCustomDateInput(kind, value) {
  const next = dimensions.normalizeDateKey(value);
  if (kind === 'start') state.customStart = next;
  else state.customEnd = next;
  state.range = 'custom';
  if (state.customStart && state.customEnd && state.customStart > state.customEnd) {
    const swap = state.customStart;
    state.customStart = state.customEnd;
    state.customEnd = swap;
  }
  state.motion = 'update';
  render();
}

function periodLabel(key, endKey) {
  if (state.groupBy === 'month') {
    const year = String(key).slice(0, 4);
    const years = new Set((state.trendSeries || []).map((row) => String(row.date).slice(0, 4)));
    const name = monthLabel(key);
    if (/^\d{4}$/.test(year) && years.size > 1) {
      return state.locale.startsWith('zh') ? `${year}年${name}` : `${name} ${year}`;
    }
    return name;
  }
  if (endKey && endKey !== key && state.groupBy === 'week') return `${shortDate(key)} – ${shortDate(endKey)}`;
  return shortDate(key);
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

function colorForDimension(dimension, key) {
  const base = dimension === 'model' ? charts.modelColor(key) : (charts.clientColors[key] || charts.clientColors.default);
  return displayColor(base);
}

// The app's CSP (style-src 'self') blocks inline style="" attributes, so swatch/dot
// colors are carried in data-c and applied via the CSSOM (.style, which CSP allows).
function applySwatchColors(root) {
  root.querySelectorAll('[data-c]').forEach((el) => { el.style.background = el.getAttribute('data-c'); });
  root.querySelectorAll('[data-w]').forEach((el) => {
    const scale = el.getAttribute('data-w');
    el.style.setProperty('--bar-scale', scale);
    el.style.setProperty('--cell-scale', scale);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dashboardMetric() {
  return dimensions.normalizeMetric(state.heatmapMetric);
}

function formatMetric(value) {
  return dashboardMetric() === 'cost' ? formatCostCompact(value) : formatCompact(value);
}

function filteredDaily(daily) {
  return dimensions.filterDaily(rangedDaily(daily), { client: state.filterClient, model: state.filterModel });
}

function overviewDaily(daily = state.history?.daily || []) {
  return dimensions.filterWeekday(filteredDaily(daily), state.filterWeekday);
}

function comparisonDaily(daily = state.history?.daily || []) {
  if (state.range === 'all') return [];
  const previous = dimensions.previousRange(selectedRange());
  if (!previous.start || !previous.end) return [];
  return dimensions.filterWeekday(
    dimensions.filterDaily(dimensions.sliceDaily(daily, previous), {
      client: state.filterClient,
      model: state.filterModel
    }),
    state.filterWeekday
  );
}

function weekdayLabel(weekday) {
  const day = Number(weekday);
  if (!Number.isInteger(day) || day < 0 || day > 6) return '';
  return new Intl.DateTimeFormat(state.locale, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2026, 7, 16 + day)));
}

function formatChange(ratio, current) {
  if (ratio == null) return n(current) > 0 ? { text: t('dashboard.compare.new'), tone: 'new' } : null;
  if (!Number.isFinite(ratio) || Math.abs(ratio) < 0.005) return null;
  const pct = Math.round(ratio * 100);
  if (pct === 0) return null;
  return { text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`, tone: pct > 0 ? 'up' : 'down' };
}

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
}

function metricValue(entry, metric) {
  return metric === 'cost' ? n(entry?.cost) : n(entry?.tokens);
}

function setFilter({ client = state.filterClient, model = state.filterModel } = {}) {
  const nextClient = String(client || '');
  const nextModel = String(model || '');
  if (state.filterClient === nextClient && state.filterModel === nextModel) return;
  state.filterClient = nextClient;
  state.filterModel = nextModel;
  state.motion = 'update';
  render();
}

function renderLegend(model) {
  const totals = {};
  for (const bar of model.bars) for (const s of bar.segments) totals[s.key] = (totals[s.key] || 0) + s.value;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const activeKey = state.stackBy === 'model' ? state.filterModel : state.filterClient;
  const rows = (model.keys || []).map((k) => ({ key: k, value: totals[k] || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  els.legend.innerHTML = rows.map((r) =>
    `<button type="button" class="dash-legend-row${r.key === activeKey ? ' is-active' : ''}" data-filter-key="${escapeHtml(r.key)}">`
    + `<span class="dash-legend-name"><span class="dash-legend-swatch" data-c="${colorFor(r.key)}"></span>${escapeHtml(r.key)}</span>`
    + `<span class="dash-legend-val">${formatMetric(r.value)}</span>`
    + `<span class="dash-legend-pct">${(r.value / grand * 100).toFixed(1)}%</span>`
    + `</button>`
  ).join('');
  applySwatchColors(els.legend);
}

function renderTrends() {
  const previousKind = state.chartKind;
  const previousGeometry = captureGeometry(els.chart, '.bar-stack[data-motion-key]');
  const metric = dashboardMetric();
  const daily = filteredDaily(state.history?.daily || []);
  if (daily.length === 0) {
    els.chart.innerHTML = '';
    els.legend.innerHTML = '';
    state.chartModel = null;
    state.trendSeries = [];
    return;
  }
  const pad = { padTop: 10, padRight: 14, padBottom: 24, padLeft: 52 };
  const formatTick = formatMetric;

  if (state.mode === 'kline') {
    els.legend.innerHTML = '';
    const { w, h } = chartSize();
    const span = daysBetween(daily[0].date, daily[daily.length - 1].date) + 1;
    const target = Math.max(8, Math.round((w - pad.padLeft - pad.padRight) / 24));
    const bucketDays = span <= 10 ? 2 : Math.max(3, Math.round(span / target));
    const model = charts.candleChart(daily, { width: w, height: h, gap: 0.4, metric, bucketDays, ...pad });
    state.chartModel = model; state.chartKind = 'candle'; state.trendSeries = daily;
    const every = axisEvery(model.candles);
    els.chart.innerHTML = charts.candleChartSvg(model, { yTicks: 4, formatTick, axisLabel: (c, i) => (i % every === 0 ? shortDate(c.key) : '') });
    animateChartGeometry(previousGeometry, { fromZero: state.motion === 'entry' || previousKind !== 'candle' });
    return;
  }

  const series = dimensions.groupDaily(daily, {
    period: state.groupBy,
    weekStartsOn: dimensions.weekStartsOn(state.locale)
  });
  state.trendSeries = series;
  const tempModel = charts.dailyBarsChart(series, { width: 100, height: 100, gap: 0.3, stackBy: state.stackBy, metric, ...pad });
  renderLegend(tempModel);

  const { w, h } = chartSize();
  const model = charts.dailyBarsChart(series, { width: w, height: h, gap: 0.3, stackBy: state.stackBy, metric, ...pad });
  state.chartModel = model; state.chartKind = 'bars';
  const every = axisEvery(model.bars);
  els.chart.innerHTML = charts.barsChartSvg(model, {
    colorFor,
    yTicks: 4,
    formatTick,
    axisLabel: (bar, i) => (i % every === 0 ? periodLabel(bar.label, series[i]?.endDate) : '')
  });
  animateChartGeometry(previousGeometry, { fromZero: state.motion === 'entry' || state.motion === 'series' || previousKind !== 'bars' });
}

function renderFilterChip() {
  if (!els.filter) return;
  if (!state.filterClient && !state.filterModel && state.filterWeekday == null) {
    els.filter.classList.add('hidden');
    els.filter.innerHTML = '';
    return;
  }
  const clientChip = state.filterClient
    ? `<span class="dash-filter-chip">${t('dashboard.filter.client', { name: escapeHtml(state.filterClient) })}</span>`
    : '';
  const modelChip = state.filterModel
    ? `<span class="dash-filter-chip">${t('dashboard.filter.model', { name: escapeHtml(state.filterModel) })}</span>`
    : '';
  const weekdayChip = state.filterWeekday != null
    ? `<span class="dash-filter-chip">${t('dashboard.filter.weekday', { name: escapeHtml(weekdayLabel(state.filterWeekday)) })}</span>`
    : '';
  els.filter.classList.remove('hidden');
  els.filter.innerHTML = `${clientChip}${modelChip}${weekdayChip}<button type="button" class="dash-filter-clear" data-filter-clear="1">${t('dashboard.filter.clear')}</button>`;
}

function changeHtml(ratio, current, className) {
  const change = formatChange(ratio, current);
  if (!change) return `<span class="${className}"></span>`;
  return `<span class="${className} is-${escapeHtml(change.tone)}">${escapeHtml(change.text)}</span>`;
}

function breakdownRowHtml({ key, value, grand, maxVal, dimension, active, ratio }) {
  const pctGrand = grand > 0 ? (value / grand * 100).toFixed(1) : '0.0';
  const pctMax = maxVal > 0 ? (value / maxVal * 100).toFixed(1) : '0.0';
  const color = colorForDimension(dimension, key);
  const motionKey = `${dimension}:${encodeURIComponent(key)}`;
  const attr = dimension === 'model' ? 'data-filter-model' : 'data-filter-client';
  return `<button type="button" class="dash-bd-row${active ? ' is-active' : ''}" ${attr}="${escapeHtml(key)}">
    <span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${color}"></span>${escapeHtml(key)}</span>
    <span class="dash-bd-bar-bg"><span class="dash-bd-bar-fill" data-motion-key="${motionKey}" data-w="${Number(pctMax) / 100}" data-c="${color}"></span></span>
    <span class="dash-bd-val">${formatMetric(value)}</span>
    <span class="dash-bd-pct">${pctGrand}%</span>
    ${ratio === undefined ? '' : changeHtml(ratio, value, 'dash-bd-delta')}
  </button>`;
}

function buildBreakdownCol(title, rows, dimension, grand, activeKey) {
  if (!rows.length) return '';
  const maxVal = Math.max(0, ...rows.map((row) => row.value));
  const html = rows.map((row) => breakdownRowHtml({
    key: row.key, value: row.value, grand, maxVal, dimension, active: row.key === activeKey, ratio: row.ratio
  })).join('');
  return `<div class="dash-breakdown-col"><div class="dash-breakdown-title">${escapeHtml(title)}</div>${html}</div>`;
}

function renderCross(daily, metric) {
  if (!dimensions.hasClientModel(daily)) {
    return `<div class="dash-cross-hint">${t('dashboard.cross.empty')}</div>`;
  }
  const matrix = dimensions.crossMatrix(daily, { metric, maxRows: 8, maxCols: 6 });
  if (!matrix.rowKeys.length || !matrix.colKeys.length) {
    return `<div class="dash-cross-hint">${t('dashboard.cross.empty')}</div>`;
  }
  const maxCell = Math.max(1, ...matrix.grid.flat());
  const headRow = `<tr><th class="dash-cross-corner">${t('dashboard.stack.cross')}</th>`
    + matrix.colKeys.map((key) => `<th data-filter-model="${escapeHtml(key)}">${escapeHtml(key)}</th>`).join('')
    + '<th></th></tr>';
  const body = matrix.rowKeys.map((client, rowIndex) => {
    const cells = matrix.grid[rowIndex].map((value, colIndex) => {
      const model = matrix.colKeys[colIndex];
      if (value <= 0) return '<td class="dash-cross-cell is-empty">—</td>';
      return `<td class="dash-cross-cell" data-w="${value / maxCell}" data-filter-client="${escapeHtml(client)}" data-filter-model="${escapeHtml(model)}">${formatMetric(value)}</td>`;
    }).join('');
    return `<tr><th class="dash-cross-row" data-filter-client="${escapeHtml(client)}">${escapeHtml(client)}</th>${cells}<td>${formatMetric(matrix.rowTotals[rowIndex])}</td></tr>`;
  }).join('');
  return `<table class="dash-cross"><thead>${headRow}</thead><tbody>${body}</tbody></table>`;
}

function withChange(rows, previousMap, metric) {
  if (!previousMap) return rows;
  return rows.map((row) => ({
    ...row,
    ratio: dimensions.changeRatio(row.value, metricValue(previousMap[row.key], metric))
  }));
}

function renderBreakdown(target = document.getElementById('dashBreakdown'), options = {}) {
  const root = target;
  if (!root) return;
  const limit = Math.max(1, Math.floor(Number(options.limit) || 8));
  const previousBars = options.motion === false
    ? new Map()
    : captureGeometry(root, '.dash-bd-bar-fill[data-motion-key]');
  const source = overviewDaily();
  if (!options.skipFilter) renderFilterChip();
  if (source.length === 0) {
    root.innerHTML = `<div class="dash-cross-hint">${t('dashboard.breakdown.empty')}</div>`;
    return;
  }
  const metric = dashboardMetric();
  const grand = source.reduce((sum, day) => sum + (metric === 'cost' ? Number(day.cost || 0) : Number(day.tokens || 0)), 0);
  const previous = comparisonDaily();
  const canCompare = state.range !== 'all';

  if (state.breakdownView === 'cross') {
    root.innerHTML = renderCross(source, metric);
    applySwatchColors(root);
    return;
  }

  let clientRows = dimensions.rankedEntries(dimensions.sumField(source, 'perClient', metric), metric, limit);
  let modelRows = dimensions.rankedEntries(dimensions.sumField(source, 'perModel', metric), metric, limit);
  if (canCompare) {
    clientRows = withChange(clientRows, dimensions.sumField(previous, 'perClient', metric), metric);
    modelRows = withChange(modelRows, dimensions.sumField(previous, 'perModel', metric), metric);
  }
  const canDrill = dimensions.hasClientModel(source);
  let rightTitle = t('dashboard.stack.model');
  let rightRows = modelRows;
  let rightDimension = 'model';
  let leftTitle = t('dashboard.stack.client');
  let leftRows = clientRows;
  let leftDimension = 'client';

  if (canDrill && state.filterClient && !state.filterModel) {
    rightTitle = t('dashboard.drill.models', { name: state.filterClient });
    rightRows = dimensions.drillRows(source, { dimension: 'client', key: state.filterClient, metric, limit });
    if (canCompare) {
      rightRows = withChange(
        rightRows,
        Object.fromEntries(
          dimensions.drillRows(previous, { dimension: 'client', key: state.filterClient, metric }).map((row) => [row.key, row])
        ),
        metric
      );
    }
  } else if (canDrill && state.filterModel && !state.filterClient) {
    leftTitle = t('dashboard.drill.tools', { name: state.filterModel });
    leftRows = dimensions.drillRows(source, { dimension: 'model', key: state.filterModel, metric, limit });
    if (canCompare) {
      leftRows = withChange(
        leftRows,
        Object.fromEntries(
          dimensions.drillRows(previous, { dimension: 'model', key: state.filterModel, metric }).map((row) => [row.key, row])
        ),
        metric
      );
    }
  }

  if (!leftRows.length && !rightRows.length) {
    root.innerHTML = `<div class="dash-cross-hint">${t('dashboard.breakdown.empty')}</div>`;
    return;
  }

  root.innerHTML = buildBreakdownCol(leftTitle, leftRows, leftDimension, grand, state.filterClient)
    + buildBreakdownCol(rightTitle, rightRows, rightDimension, grand, state.filterModel);
  applySwatchColors(root);
  if (options.motion !== false && state.motion !== 'none' && !prefersReducedMotion()) {
    for (const fill of root.querySelectorAll('.dash-bd-bar-fill[data-motion-key]')) {
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

function heatmapSpan() {
  const end = todayKey();
  const now = new Date(`${end}T00:00:00Z`);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  return { start, end };
}

function markHeatmapRange(root) {
  if (!root) return;
  const range = selectedRange();
  const ranged = state.range !== 'all' && range.start && range.end;
  root.classList.toggle('is-ranged', ranged);
  if (!ranged) return;
  for (const cell of root.querySelectorAll('.heat')) {
    const date = cell.getAttribute('data-d');
    if (!dimensions.inDateRange(date, range)) continue;
    if (state.filterWeekday != null && dimensions.utcWeekday(date) !== state.filterWeekday) continue;
    cell.classList.add('is-in-range');
  }
  if (state.range === 'custom' && state.customStart && state.customStart === state.customEnd) {
    root.querySelector(`.heat[data-d="${CSS.escape(state.customStart)}"]`)?.classList.add('is-selected');
  }
}

function paintHeatmap(root, { maxCell = 22, motion = false } = {}) {
  if (!root) return;
  const daily = charts.computeHeatmapIntensities(state.history?.daily || []);
  const { start, end } = heatmapSpan();
  const intensityKey = state.heatmapMetric === 'cost' ? 'costIntensity' : 'tokenIntensity';
  const gap = 4;
  let heat = charts.contribHeatmap(daily, { cell: 14, gap, startDate: start, endDate: end, intensityKey });
  const avail = root.clientWidth || 0;
  if (heat.weeks > 0 && avail > 0) {
    const cell = Math.max(9, Math.min(maxCell, (avail - heat.weeks * gap) / heat.weeks));
    heat = charts.contribHeatmap(daily, { cell, gap, startDate: start, endDate: end, intensityKey });
  }
  root.innerHTML = heat.cells.length
    ? charts.heatmapSvg(heat, { monthLabel: (m) => monthLabel(m.label), initialHidden: motion })
    : '';
  markHeatmapRange(root);
}

function groupedOverviewSeries() {
  return dimensions.groupDaily(overviewDaily(), {
    period: state.groupBy,
    weekStartsOn: dimensions.weekStartsOn(state.locale)
  });
}

function shareColor(key) {
  if (key === '__other') return 'rgba(138, 160, 184, 0.55)';
  return colorForDimension(state.shareBy === 'model' ? 'model' : 'client', key);
}

function shareLabel(key) {
  return key === '__other' ? t('dashboard.share.other') : key;
}

function shareRows() {
  const field = state.shareBy === 'model' ? 'perModel' : 'perClient';
  return dimensions.rankedEntries(dimensions.sumField(overviewDaily(), field, dashboardMetric()), dashboardMetric());
}

function shareLegendHtml(slices, total) {
  return slices.map((slice) => {
    const pct = total > 0 ? (slice.value / total * 100).toFixed(1) : '0.0';
    const filterAttr = slice.key === '__other'
      ? ''
      : (state.shareBy === 'model' ? ` data-filter-model="${escapeHtml(slice.key)}"` : ` data-filter-client="${escapeHtml(slice.key)}"`);
    const tag = filterAttr ? 'button' : 'div';
    const type = filterAttr ? ' type="button"' : '';
    return `<${tag}${type} class="dash-legend-row"${filterAttr}>`
      + `<span class="dash-legend-name"><span class="dash-legend-swatch" data-c="${shareColor(slice.key)}"></span>${escapeHtml(shareLabel(slice.key))}</span>`
      + `<span class="dash-legend-val">${formatMetric(slice.value)}</span>`
      + `<span class="dash-legend-pct">${pct}%</span>`
      + `</${tag}>`;
  }).join('');
}

function renderTrendWidget() {
  if (!els.trend) return;
  const series = groupedOverviewSeries();
  if (!series.length) {
    els.trend.innerHTML = `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`;
    return;
  }
  const w = Math.max(160, els.trend.clientWidth || 320);
  const model = charts.areaLineChart(series, {
    width: w, height: 148, metric: dashboardMetric(), curve: true,
    padTop: 10, padRight: 8, padBottom: 8, padLeft: 8
  });
  els.trend.innerHTML = `<div class="dash-area">${charts.areaLineSvg(model, { gradientId: 'dash-area-grad' })}</div>`;
}

function renderShareWidget() {
  if (!els.share) return;
  const rows = shareRows();
  if (!rows.length) {
    els.share.innerHTML = `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`;
    return;
  }
  const size = 132;
  const model = charts.donutChart(rows, { width: size, height: size, thickness: 20, maxSlices: 5, otherKey: '__other' });
  els.share.innerHTML = `${charts.donutChartSvg(model, {
    colorFor: shareColor,
    center: formatMetric(model.total),
    sub: t(dashboardMetric() === 'cost' ? 'dashboard.heatmap.cost' : 'dashboard.heatmap.tokens')
  })}<div class="dash-share-legend">${shareLegendHtml(model.slices, model.total)}</div>`;
  applySwatchColors(els.share);
}

const MODALS = new Set(['trend', 'share', 'weekday', 'hours', 'heatmap', 'breakdown', 'portrait']);

function openModal(kind) {
  if (!MODALS.has(kind)) return;
  state.modal = kind;
  state.motion = 'none';
  render();
}

function closeModal() {
  if (!state.modal) return;
  state.modal = '';
  state.modalChartModel = null;
  state.motion = 'none';
  render();
}

function renderModal() {
  if (!els.modal) return;
  const kind = state.modal;
  const open = MODALS.has(kind);
  els.modal.classList.toggle('hidden', !open);
  els.modal.setAttribute('aria-hidden', String(!open));
  document.querySelectorAll('.dash-expand[data-modal]').forEach((btn) => {
    btn.title = t('dashboard.modal.expand');
    btn.setAttribute('aria-label', t('dashboard.modal.expand'));
  });
  if (els.modalClose) {
    els.modalClose.title = t('dashboard.modal.close');
    els.modalClose.setAttribute('aria-label', t('dashboard.modal.close'));
  }
  if (!open) {
    els.modalBody.innerHTML = '';
    state.modalChartModel = null;
    return;
  }
  els.modalTitle.textContent = t(`dashboard.modal.${kind}`);
  const paint = () => {
    if (state.modal !== kind) return;
    if (kind === 'trend') renderModalTrend();
    else if (kind === 'share') renderModalShare();
    else if (kind === 'weekday') renderModalWeekday();
    else if (kind === 'hours') renderModalHours();
    else if (kind === 'heatmap') renderModalHeatmap();
    else if (kind === 'portrait') renderModalPortrait();
    else renderModalBreakdown();
  };
  paint();
  requestAnimationFrame(paint);
}

function renderModalTrend() {
  els.modalBody.innerHTML = '<div id="dashModalChart" class="dash-modal-chart"></div><div id="dashModalSide" class="dash-modal-side"></div>';
  const chartEl = document.getElementById('dashModalChart');
  const sideEl = document.getElementById('dashModalSide');
  const series = groupedOverviewSeries();
  if (!series.length) {
    chartEl.innerHTML = `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`;
    state.modalChartModel = null;
    return;
  }
  const w = Math.max(280, chartEl.clientWidth || 640);
  const h = Math.max(200, chartEl.clientHeight || 360);
  const pad = { padTop: 10, padRight: 14, padBottom: 24, padLeft: 52 };
  const stackBy = state.shareBy === 'model' ? 'model' : 'client';
  const model = charts.dailyBarsChart(series, {
    width: w, height: h, gap: 0.3, stackBy, metric: dashboardMetric(), ...pad
  });
  state.modalChartModel = model;
  state.modalSeries = series;
  const every = axisEvery(model.bars);
  chartEl.innerHTML = charts.barsChartSvg(model, {
    colorFor: (key) => colorForDimension(stackBy, key),
    yTicks: 4,
    formatTick: formatMetric,
    axisLabel: (bar, i) => (i % every === 0 ? periodLabel(bar.label, series[i]?.endDate) : '')
  });
  const totals = {};
  for (const bar of model.bars) for (const seg of bar.segments) totals[seg.key] = (totals[seg.key] || 0) + seg.value;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  sideEl.innerHTML = (model.keys || []).map((key) => ({ key, value: totals[key] || 0 }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((row) => {
      const attr = stackBy === 'model'
        ? `data-filter-model="${escapeHtml(row.key)}"`
        : `data-filter-client="${escapeHtml(row.key)}"`;
      return `<button type="button" class="dash-legend-row" ${attr}>`
        + `<span class="dash-legend-name"><span class="dash-legend-swatch" data-c="${colorForDimension(stackBy, row.key)}"></span>${escapeHtml(row.key)}</span>`
        + `<span class="dash-legend-val">${formatMetric(row.value)}</span>`
        + `<span class="dash-legend-pct">${(row.value / grand * 100).toFixed(1)}%</span>`
        + `</button>`;
    }).join('');
  applySwatchColors(sideEl);
}

function renderModalShare() {
  els.modalBody.innerHTML = '<div class="dash-modal-share">'
    + '<div id="dashModalChart" class="dash-modal-share-chart"></div>'
    + '<div id="dashModalSide" class="dash-modal-share-legend"></div>'
    + '</div>';
  const chartEl = document.getElementById('dashModalChart');
  const sideEl = document.getElementById('dashModalSide');
  const rows = shareRows();
  if (!rows.length) {
    chartEl.innerHTML = `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`;
    return;
  }
  const body = els.modalBody;
  const cap = Math.min(body.clientWidth || 520, body.clientHeight || 400);
  const size = Math.round(Math.min(280, Math.max(220, cap * 0.52)));
  const model = charts.donutChart(rows, {
    width: size,
    height: size,
    thickness: Math.max(22, Math.round(size * 0.12)),
    maxSlices: 8,
    otherKey: '__other'
  });
  chartEl.innerHTML = charts.donutChartSvg(model, {
    colorFor: shareColor,
    center: formatMetric(model.total),
    sub: t(dashboardMetric() === 'cost' ? 'dashboard.heatmap.cost' : 'dashboard.heatmap.tokens')
  });
  sideEl.innerHTML = shareLegendHtml(model.slices, model.total);
  applySwatchColors(sideEl);
}

function renderModalWeekday() {
  els.modalBody.innerHTML = '<div id="dashModalChart" class="dash-modal-chart dash-modal-weekdays dash-weekdays"></div>';
  renderWeekdays(filteredDaily(), { root: document.getElementById('dashModalChart'), showValue: true });
}

function scopedSessions() {
  return dimensions.filterSessions(state.history?.sessions || [], {
    client: state.filterClient,
    model: state.filterModel
  });
}

function scopedHourTotals() {
  return dimensions.hourTotals(scopedSessions(), {
    range: selectedRange(),
    weekday: state.filterWeekday
  });
}

function heatLevel(value, maxVal) {
  if (!(value > 0) || !(maxVal > 0)) return 0;
  const ratio = value / maxVal;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function renderHours(hours, { root = els.hours, showValue = false, slots = true } = {}) {
  if (!root) return;
  const metric = dashboardMetric();
  const rows = slots ? dimensions.slotTotals(hours) : hours;
  const maxVal = Math.max(1, ...rows.map((row) => metric === 'cost' ? row.cost : row.tokens));
  const hasValues = rows.some((row) => (metric === 'cost' ? row.cost : row.tokens) > 0);
  if (!hasValues) {
    root.innerHTML = `<div class="dash-widget-empty">${t((state.history?.sessions || []).length ? 'dashboard.breakdown.empty' : 'dashboard.hours.empty')}</div>`;
    return;
  }
  root.innerHTML = rows.map((row) => {
    const value = metric === 'cost' ? row.cost : row.tokens;
    const height = value > 0 ? Math.max(2, Math.round(value / maxVal * 100)) : 0;
    const key = slots ? row.id : String(row.hour);
    const label = slots ? t(`dashboard.slot.${row.id}`) : String(row.hour);
    const valueHtml = showValue ? `<span class="dash-weekday-val">${escapeHtml(formatMetric(value))}</span>` : '';
    return `<button type="button" class="dash-hour" data-hour="${escapeHtml(key)}" data-value="${value}" title="${escapeHtml(formatMetric(value))}">`
      + `<span class="dash-weekday-track"><span class="dash-weekday-bar" data-h="${height}"></span></span>`
      + `<span class="dash-weekday-k">${escapeHtml(label)}</span>`
      + valueHtml
      + `</button>`;
  }).join('');
  root.querySelectorAll('.dash-weekday-bar').forEach((bar) => {
    bar.style.height = `${bar.getAttribute('data-h') || 0}%`;
  });
}

function renderHourGrid(root, sessions) {
  if (!root) return;
  const metric = dashboardMetric();
  const grid = dimensions.weekdayHourGrid(sessions, {
    range: selectedRange(),
    firstDay: dimensions.weekStartsOn(state.locale),
    weekday: state.filterWeekday
  });
  const maxVal = Math.max(1, ...grid.flatMap((row) => row.hours.map((cell) => metric === 'cost' ? cell.cost : cell.tokens)));
  const axis = ['', ...Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? String(hour) : ''))];
  const cells = axis.map((label, index) => `<span class="dash-hour-axis">${index === 0 ? '' : escapeHtml(label)}</span>`).join('')
    + grid.map((row) => {
      const name = weekdayLabel(row.weekday);
      return `<span class="dash-hour-label">${escapeHtml(name)}</span>`
        + row.hours.map((cell) => {
          const value = metric === 'cost' ? cell.cost : cell.tokens;
          return `<span class="dash-hour-cell lvl-${heatLevel(value, maxVal)}" data-weekday="${row.weekday}" data-hour="${cell.hour}" data-value="${value}"><span class="dash-hour-sq"></span></span>`;
        }).join('');
    }).join('');
  root.innerHTML = cells;
}

function renderModalHours() {
  els.modalBody.innerHTML = '<div class="dash-modal-hours">'
    + '<div class="dash-hour-chart">'
    + '<div class="dash-modal-hours-bars-row"><span class="dash-hour-gutter" aria-hidden="true"></span>'
    + '<div id="dashModalHours" class="dash-hours dash-modal-hours-bars"></div></div>'
    + '<div id="dashModalHourGrid" class="dash-hour-grid"></div>'
    + '</div>'
    + `<p class="dash-hours-hint">${t('dashboard.hours.hint')}</p>`
    + '</div>';
  const hours = scopedHourTotals();
  // 24 columns cannot fit compact totals; values stay on the hover tooltip.
  renderHours(hours, { root: document.getElementById('dashModalHours'), slots: false });
  renderHourGrid(document.getElementById('dashModalHourGrid'), scopedSessions());
}

function currentPortrait() {
  return dimensions.usagePortrait(overviewDaily(), scopedSessions(), {
    range: selectedRange(),
    weekday: state.filterWeekday,
    firstDay: dimensions.weekStartsOn(state.locale),
    metric: dashboardMetric()
  });
}

function portraitMark(time) {
  if (time === 'night') {
    return '<svg class="dash-portrait-mark" viewBox="0 0 48 48" aria-hidden="true">'
      + '<circle class="dash-portrait-orbit" cx="24" cy="24" r="16"></circle>'
      + '<path class="dash-portrait-core" d="M30 14a13 13 0 1 0 4 20 16 16 0 0 1-4-20z"></path>'
      + '</svg>';
  }
  if (time === 'morning') {
    return '<svg class="dash-portrait-mark" viewBox="0 0 48 48" aria-hidden="true">'
      + '<path class="dash-portrait-ray" d="M8 32h32"></path>'
      + '<path class="dash-portrait-core" d="M12 32a12 12 0 0 1 24 0"></path>'
      + '<circle class="dash-portrait-core" cx="24" cy="22" r="5"></circle>'
      + '</svg>';
  }
  if (time === 'evening') {
    return '<svg class="dash-portrait-mark" viewBox="0 0 48 48" aria-hidden="true">'
      + '<circle class="dash-portrait-orbit" cx="24" cy="24" r="16"></circle>'
      + '<path class="dash-portrait-core" d="M8 24a16 16 0 0 1 32 0H8z"></path>'
      + '</svg>';
  }
  if (time === 'allDay') {
    return '<svg class="dash-portrait-mark" viewBox="0 0 48 48" aria-hidden="true">'
      + '<circle class="dash-portrait-orbit" cx="24" cy="24" r="16"></circle>'
      + '<circle class="dash-portrait-core" cx="24" cy="10" r="2.5"></circle>'
      + '<circle class="dash-portrait-core" cx="38" cy="24" r="2.5"></circle>'
      + '<circle class="dash-portrait-core" cx="24" cy="38" r="2.5"></circle>'
      + '<circle class="dash-portrait-core" cx="10" cy="24" r="2.5"></circle>'
      + '</svg>';
  }
  return '<svg class="dash-portrait-mark" viewBox="0 0 48 48" aria-hidden="true">'
    + '<circle class="dash-portrait-orbit" cx="24" cy="24" r="16"></circle>'
    + '<circle class="dash-portrait-core" cx="24" cy="24" r="7"></circle>'
    + '<path class="dash-portrait-ray" d="M24 8v4M40 24h-4M24 40v-4M8 24h4M35.3 12.7l-2.8 2.8M35.3 35.3l-2.8-2.8M12.7 35.3l2.8-2.8M12.7 12.7l2.8 2.8"></path>'
    + '</svg>';
}

function portraitHeadline(portrait) {
  const focus = t(`dashboard.portrait.focus.${portrait.focus}`, { name: portrait.topTool || '—' });
  if (portrait.time === 'unknown') return focus;
  return `${t(`dashboard.portrait.time.${portrait.time}`)} · ${focus}`;
}

function portraitMeta(portrait) {
  const parts = [];
  if (portrait.time !== 'unknown' && portrait.time !== 'allDay') {
    const peak = portrait.slots.find((slot) => slot.id === portrait.time);
    const pct = peak ? `${Math.round(peak.share * 100)}%` : '';
    parts.push(`${t(`dashboard.slot.${portrait.time}`)} ${pct}`.trim());
  }
  if (portrait.topModel) parts.push(portrait.topModel);
  parts.push(t('dashboard.portrait.counts', { tools: portrait.toolCount, models: portrait.modelCount }));
  return parts.join(' · ');
}

function portraitTagName(key, portrait) {
  if (key.includes('catalog')) return portrait.topModel || '—';
  if (key.includes('focus')) return portrait.topTool || '—';
  return '';
}

function portraitTags(portrait) {
  const keys = Array.isArray(portrait.tagKeys) ? portrait.tagKeys : [];
  return keys.map((key) => {
    const label = t(`dashboard.portrait.${key}`, { name: portraitTagName(key, portrait) });
    return `<span class="dash-portrait-tag">${escapeHtml(label)}</span>`;
  }).join('');
}

function portraitSlotBars(portrait) {
  const maxShare = Math.max(0.01, ...portrait.slots.map((slot) => slot.share));
  return portrait.slots.map((slot) => {
    const height = Math.max(slot.share > 0 ? 8 : 0, Math.round(slot.share / maxShare * 100));
    return `<div class="dash-portrait-slot" data-hour="${escapeHtml(slot.id)}" data-value="${slot.value}">`
      + `<span class="dash-weekday-track"><span class="dash-weekday-bar" data-h="${height}"></span></span>`
      + `<span class="dash-weekday-k">${escapeHtml(t(`dashboard.slot.${slot.id}`))}</span>`
      + `<span class="dash-portrait-slot-pct">${Math.round(slot.share * 100)}%</span>`
      + '</div>';
  }).join('');
}

function applyPortraitBars(root) {
  root?.querySelectorAll('.dash-weekday-bar').forEach((bar) => {
    bar.style.height = `${bar.getAttribute('data-h') || 0}%`;
  });
}

function renderPortrait() {
  if (!els.portrait) return;
  const portrait = currentPortrait();
  if (portrait.empty) {
    els.portrait.innerHTML = `<div class="dash-widget-empty">${t('dashboard.portrait.empty')}</div>`;
    return;
  }
  els.portrait.innerHTML = `${portraitMark(portrait.time)}`
    + '<div class="dash-portrait-copy">'
    + `<div class="dash-portrait-kicker">${escapeHtml(portraitHeadline(portrait))}</div>`
    + `<div class="dash-portrait-meta">${escapeHtml(portraitMeta(portrait))}</div>`
    + `<div class="dash-portrait-tags">${portraitTags(portrait)}</div>`
    + '</div>'
    + `<div class="dash-portrait-slots">${portraitSlotBars(portrait)}</div>`;
  applyPortraitBars(els.portrait);
}

function renderModalPortrait() {
  const portrait = currentPortrait();
  if (portrait.empty) {
    els.modalBody.innerHTML = `<div class="dash-widget-empty">${t('dashboard.portrait.empty')}</div>`;
    return;
  }
  const toolRows = portrait.tools.slice(0, 8).map((row) => {
    const share = portrait.tools[0] ? row.value / Math.max(portrait.tools[0].value, 1) : 0;
    return `<button type="button" class="dash-bd-row" data-filter-client="${escapeHtml(row.key)}">`
      + `<span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${colorForDimension('client', row.key)}"></span>${escapeHtml(row.key)}</span>`
      + `<span class="dash-bd-bar-bg"><span class="dash-bd-bar-fill" data-c="${colorForDimension('client', row.key)}" data-w="${share}"></span></span>`
      + `<span class="dash-bd-val">${formatMetric(row.value)}</span>`
      + '</button>';
  }).join('');
  const modelRows = portrait.models.slice(0, 8).map((row) => {
    const share = portrait.models[0] ? row.value / Math.max(portrait.models[0].value, 1) : 0;
    return `<button type="button" class="dash-bd-row" data-filter-model="${escapeHtml(row.key)}">`
      + `<span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${colorForDimension('model', row.key)}"></span>${escapeHtml(row.key)}</span>`
      + `<span class="dash-bd-bar-bg"><span class="dash-bd-bar-fill" data-w="${share}" data-c="${colorForDimension('model', row.key)}"></span></span>`
      + `<span class="dash-bd-val">${formatMetric(row.value)}</span>`
      + '</button>';
  }).join('');
  els.modalBody.innerHTML = '<div class="dash-modal-portrait">'
    + '<div class="dash-portrait">'
    + portraitMark(portrait.time)
    + '<div class="dash-portrait-copy">'
    + `<div class="dash-portrait-kicker">${escapeHtml(portraitHeadline(portrait))}</div>`
    + `<div class="dash-portrait-meta">${escapeHtml(portraitMeta(portrait))}</div>`
    + `<div class="dash-portrait-tags">${portraitTags(portrait)}</div>`
    + '</div></div>'
    + `<div class="dash-portrait-slots dash-portrait-slots--modal">${portraitSlotBars(portrait)}</div>`
    + '<div class="dash-breakdown">'
    + `<div class="dash-breakdown-col"><div class="dash-breakdown-title">${t('dashboard.portrait.tools')}</div>${toolRows || `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`}</div>`
    + `<div class="dash-breakdown-col"><div class="dash-breakdown-title">${t('dashboard.portrait.models')}</div>${modelRows || `<div class="dash-widget-empty">${t('dashboard.breakdown.empty')}</div>`}</div>`
    + '</div>'
    + `<p class="dash-hours-hint">${t('dashboard.portrait.hint')}</p>`
    + '</div>';
  applyPortraitBars(els.modalBody);
  applySwatchColors(els.modalBody);
}

function renderModalHeatmap() {
  els.modalBody.innerHTML = '<div id="dashModalChart" class="dash-modal-chart dash-heatmap-wrap"></div>';
  paintHeatmap(document.getElementById('dashModalChart'), { maxCell: 28, motion: false });
}

function renderModalBreakdown() {
  els.modalBody.innerHTML = '<div id="dashModalChart" class="dash-modal-chart dash-breakdown"></div>';
  renderBreakdown(document.getElementById('dashModalChart'), { limit: 16, skipFilter: true, motion: false });
}

function renderActivity() {
  const hideHeatmapForEntry = !prefersReducedMotion()
    && (state.motion === 'entry' || els.heatmap.classList.contains('is-motion-pending'));
  paintHeatmap(els.heatmap, { motion: hideHeatmapForEntry });
  animateHeatmapEntry();
  state.dayMap = new Map((state.history?.daily || []).map((d) => [String(d.date).slice(0, 10), {
    tokens: Number(d.tokens || 0),
    cost: Number(d.cost || 0),
    timedOutputTokens: Number(d.timedOutputTokens || 0),
    timedDurationMs: Number(d.timedDurationMs || 0)
  }]));
  const range = selectedRange();
  const scoped = overviewDaily();
  const summary = dimensions.windowSummary(scoped, {
    endKey: range.end || todayKey(),
    streakDaily: dimensions.filterDaily(state.history?.daily || [], {
      client: state.filterClient,
      model: state.filterModel
    })
  });
  const compared = state.range === 'all'
    ? null
    : dimensions.compareSummary(summary, dimensions.windowSummary(comparisonDaily(), {
      endKey: dimensions.previousRange(range).end,
      streakDaily: dimensions.filterDaily(state.history?.daily || [], {
        client: state.filterClient,
        model: state.filterModel
      })
    }));
  const cards = charts.statsCards(summary);
  const LABELS = {
    totalTokens: 'dashboard.stat.totalTokens', totalCost: 'dashboard.stat.totalCost',
    activeDays: 'trends.activeDays', currentStreak: 'trends.currentStreak',
    activeTimeMs: 'trends.activeTime', peakDayTokens: 'trends.peakDay',
    favoriteModel: 'dashboard.stat.favoriteModel', messages: 'dashboard.stat.messages',
    outputTokens: 'dashboard.stat.outputTokens'
  };
  els.cards.innerHTML = charts.statsCardsHtml(cards, {
    label: (k) => t(LABELS[k] || k),
    format: (c) => (c.kind === 'cost' ? formatCostCompact(c.value)
      : c.kind === 'duration' ? formatDurationCompact(c.value)
        : c.kind === 'model' ? (c.value || '—')
          : formatCompact(c.value)),
    delta: (c) => compared?.[c.key] ? formatChange(compared[c.key].ratio, compared[c.key].current) : null
  });
  renderPortrait();
  renderTrendWidget();
  renderShareWidget();
  renderWeekdays(filteredDaily());
  renderHours(scopedHourTotals());
  renderBreakdown();
}

function renderWeekdays(daily, { root = els.weekdays, showValue = false } = {}) {
  if (!root) return;
  const metric = dashboardMetric();
  const buckets = dimensions.weekdayTotals(daily, { firstDay: dimensions.weekStartsOn(state.locale) });
  const maxVal = Math.max(1, ...buckets.map((bucket) => metric === 'cost' ? bucket.cost : bucket.tokens));
  root.innerHTML = buckets.map((bucket) => {
    const value = metric === 'cost' ? bucket.cost : bucket.tokens;
    const height = value > 0 ? Math.max(2, Math.round(value / maxVal * 100)) : 0;
    const active = state.filterWeekday === bucket.weekday;
    const valueHtml = showValue ? `<span class="dash-weekday-val">${escapeHtml(formatMetric(value))}</span>` : '';
    return `<button type="button" class="dash-weekday${active ? ' is-active' : ''}" data-weekday="${bucket.weekday}" title="${escapeHtml(formatMetric(value))}">`
      + `<span class="dash-weekday-track"><span class="dash-weekday-bar" data-h="${height}"></span></span>`
      + `<span class="dash-weekday-k">${escapeHtml(weekdayLabel(bucket.weekday))}</span>`
      + valueHtml
      + `</button>`;
  }).join('');
  root.querySelectorAll('.dash-weekday-bar').forEach((bar) => {
    bar.style.height = `${bar.getAttribute('data-h') || 0}%`;
  });
}

function render() {
  hideTooltip();
  const hasData = (state.history?.daily || []).length > 0 || (state.history?.monthly || []).length > 0;
  els.empty.classList.toggle('hidden', hasData);
  els.trendsPane.classList.toggle('hidden', state.tab !== 'trends');
  els.activityPane.classList.toggle('hidden', state.tab !== 'activity');
  els.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  els.stackBtns.forEach((b) => b.classList.toggle('active', b.dataset.stack === state.stackBy));
  els.heatmapMetricBtns.forEach((b) => { const active = b.dataset.val === state.heatmapMetric; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  els.breakdownViewBtns.forEach((b) => b.classList.toggle('active', b.dataset.val === state.breakdownView));
  els.shareByBtns.forEach((b) => b.classList.toggle('active', b.dataset.val === state.shareBy));
  els.groupByBtns.forEach((b) => b.classList.toggle('active', b.dataset.val === state.groupBy));
  document.querySelector('[data-control="stack"]').style.display = state.mode === 'kline' ? 'none' : '';
  document.querySelector('[data-control="groupBy"]').style.display = state.mode === 'kline' ? 'none' : '';
  syncTimeControls();
  if (state.tab === 'trends') {
    heatmapMotionGeneration += 1;
    els.heatmap.classList.remove('is-motion-pending');
    renderTrends();
  } else {
    renderActivity();
  }
  renderModal();
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
  const dim = state.modal === 'trend' ? (state.shareBy === 'model' ? 'model' : 'client') : state.stackBy;
  const rows = segs.map((s) =>
    `<div class="tt-row"><span class="tt-dot" data-c="${colorForDimension(dim, s.key)}"></span><span class="tt-name">${escapeHtml(s.key)}</span><span class="tt-val">${formatMetric(s.value)}</span></div>`
  ).join('');
  const series = state.modal === 'trend' ? (state.modalSeries || []) : (state.trendSeries || []);
  const row = series.find((day) => day.date === bar.label);
  els.tooltip.innerHTML = `<div class="tt-head">${periodLabel(bar.label, row?.endDate)} · ${formatMetric(bar.total)}</div>${rows}`;
  applySwatchColors(els.tooltip);
  positionTooltip(ev);
}

function showCandleTooltip(c, ev) {
  // Each candle spans a bucket of days: O = first day, C = last day, H/L = busiest/quietest.
  const head = c.endKey && c.endKey !== c.key ? `${longDate(c.key)} – ${longDate(c.endKey)}` : longDate(c.key);
  const ohlc = [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]];
  els.tooltip.innerHTML = `<div class="tt-head">${head}</div>`
    + ohlc.map(([k, v]) => `<div class="tt-row"><span class="tt-name">${k}</span><span class="tt-val">${formatMetric(v)}</span></div>`).join('');
  positionTooltip(ev);
}

function outputTokPerSec(value) {
  const output = Number(value?.timedOutputTokens || 0);
  const duration = Number(value?.timedDurationMs || 0);
  return duration > 0 && output > 0 ? output * 1000 / duration : 0;
}

function tooltipEl(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function tooltipRow(name, value) {
  const row = tooltipEl('div', 'tt-row');
  row.append(tooltipEl('span', 'tt-name', name), tooltipEl('span', 'tt-val', value));
  return row;
}

function showHeatTooltip(date, day, ev) {
  const tokens = day ? day.tokens : 0;
  const cost = day ? day.cost : 0;
  const rate = outputTokPerSec(day);
  const tokLabel = state.locale.startsWith('zh') ? 'Token' : 'Tokens';
  const costLabel = state.locale.startsWith('zh') ? '花費' : 'Cost';
  // Dates come from heatmap data-d attributes — write them as text, not HTML.
  const nodes = [
    tooltipEl('div', 'tt-head', longDate(date)),
    tooltipRow(tokLabel, formatCompact(tokens))
  ];
  if (cost > 0) nodes.push(tooltipRow(costLabel, formatCost(cost)));
  if (rate > 0) nodes.push(tooltipRow(t('trends.outputRate'), `${formatCompact(rate)}/s`));
  els.tooltip.replaceChildren(...nodes);
  positionTooltip(ev);
}

function showShareTooltip(slice, ev) {
  const key = slice.getAttribute('data-key');
  const value = Number(slice.getAttribute('data-v') || 0);
  els.tooltip.innerHTML = `<div class="tt-head">${escapeHtml(shareLabel(key))}</div>`
    + `<div class="tt-row"><span class="tt-name">${escapeHtml(formatMetric(value))}</span></div>`;
  positionTooltip(ev);
}

function showHourTooltip(target, ev) {
  const value = Number(target.getAttribute('data-value') || 0);
  const hourRaw = target.getAttribute('data-hour');
  const weekdayRaw = target.getAttribute('data-weekday');
  const weekday = weekdayRaw == null || weekdayRaw === '' ? null : Number(weekdayRaw);
  const slotKey = dimensions.HOUR_SLOTS.some((slot) => slot.id === hourRaw) ? hourRaw : '';
  const hour = slotKey ? null : Number(hourRaw);
  const label = slotKey
    ? t(`dashboard.slot.${slotKey}`)
    : [
      Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekdayLabel(weekday) : '',
      Number.isInteger(hour) && hour >= 0 && hour <= 23 ? `${hour}:00` : ''
    ].filter(Boolean).join(' ');
  els.tooltip.innerHTML = `<div class="tt-head">${escapeHtml(label || t('dashboard.hours.title'))}</div>`
    + `<div class="tt-row"><span class="tt-name">${escapeHtml(formatMetric(value))}</span></div>`;
  positionTooltip(ev);
}

function handleHeatmapClick(ev) {
  const hit = ev.target.closest('.heat');
  const date = hit?.getAttribute('data-d');
  if (!date) return;
  state.filterWeekday = null;
  state.range = 'custom';
  state.customStart = date;
  state.customEnd = date;
  state.motion = 'update';
  render();
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
  state.locale = i18n.resolveLocale(settings.locale || settings.language, navigator.languages);
  state.currency = settings.currency || 'USD';
  state.compactTokenUnits = compactTokenApi.normalizeCompactTokenUnits(settings.compactTokenUnits);
  if (settings.currencyRatesEffective && window.TokenMonitorCurrency?.configureRates) {
    window.TokenMonitorCurrency.configureRates(settings.currencyRatesEffective);
  }
  state.flat = settings.dashboardFlat === true;
  state.heatmapMetric = settings.heatmapMetric || 'cost';
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
  applyFontSettings(next);
  let needsRender = false;
  const nextLocale = i18n.resolveLocale(next.locale || next.language, navigator.languages);
  if (state.locale !== nextLocale) {
    state.locale = nextLocale;
    applyTranslations();
    populateRangeSelect();
    needsRender = true;
  }
  const nextCompactTokenUnits = compactTokenApi.normalizeCompactTokenUnits(next.compactTokenUnits);
  if (state.compactTokenUnits !== nextCompactTokenUnits) {
    state.compactTokenUnits = nextCompactTokenUnits;
    needsRender = true;
  }
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
  const nextMetric = next.heatmapMetric || 'cost';
  if (state.heatmapMetric !== nextMetric) {
    state.heatmapMetric = nextMetric;
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
  state.modal = '';
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
els.heatmapMetricBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.heatmapMetric === b.dataset.val) return;
  state.heatmapMetric = b.dataset.val;
  state.motion = 'none';
  render();
  window.tokenMonitor.updateSettings({ heatmapMetric: state.heatmapMetric });
}));
els.breakdownViewBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.breakdownView === b.dataset.val) return;
  state.breakdownView = b.dataset.val;
  state.motion = 'update';
  render();
}));
els.shareByBtns.forEach((b) => b.addEventListener('click', () => {
  const next = b.dataset.val === 'model' ? 'model' : 'client';
  if (state.shareBy === next) return;
  state.shareBy = next;
  state.motion = 'update';
  render();
}));
els.groupByBtns.forEach((b) => b.addEventListener('click', () => {
  const next = dimensions.normalizeGroupBy(b.dataset.val);
  if (state.groupBy === next) return;
  state.groupBy = next;
  state.motion = 'series';
  render();
}));
for (const input of els.rangeStarts) {
  input.addEventListener('change', () => onCustomDateInput('start', input.value));
}
for (const input of els.rangeEnds) {
  input.addEventListener('change', () => onCustomDateInput('end', input.value));
}

function toggleFilter(next) {
  const client = String(next.client || '');
  const model = String(next.model || '');
  if (state.filterClient === client && state.filterModel === model) setFilter({ client: '', model: '' });
  else setFilter({ client, model });
}

function handleDimensionClick(ev) {
  if (ev.target.closest('[data-filter-clear]')) {
    if (!state.filterClient && !state.filterModel && state.filterWeekday == null) return;
    state.filterClient = '';
    state.filterModel = '';
    state.filterWeekday = null;
    state.motion = 'update';
    render();
    return;
  }
  const hit = ev.target.closest('[data-filter-client], [data-filter-model], [data-filter-key]');
  if (!hit) return;
  if (hit.classList.contains('is-empty')) return;
  const key = hit.getAttribute('data-filter-key');
  if (key) {
    if (state.stackBy === 'model') toggleFilter({ model: key });
    else toggleFilter({ client: key });
    return;
  }
  const hasClient = hit.hasAttribute('data-filter-client');
  const hasModel = hit.hasAttribute('data-filter-model');
  if (hasClient && hasModel) {
    toggleFilter({
      client: hit.getAttribute('data-filter-client') || '',
      model: hit.getAttribute('data-filter-model') || ''
    });
    return;
  }
  if (hasClient) {
    toggleFilter({ client: hit.getAttribute('data-filter-client') || '', model: '' });
    return;
  }
  toggleFilter({
    client: state.filterClient,
    model: hit.getAttribute('data-filter-model') || ''
  });
}

els.filter?.addEventListener('click', handleDimensionClick);
document.getElementById('dashBreakdown')?.addEventListener('click', handleDimensionClick);
els.legend.addEventListener('click', handleDimensionClick);
els.share?.addEventListener('click', (ev) => {
  const slice = ev.target.closest('.dash-donut-slice[data-key]');
  if (slice) {
    const key = slice.getAttribute('data-key');
    if (key && key !== '__other') {
      if (state.shareBy === 'model') toggleFilter({ model: key });
      else toggleFilter({ client: key });
    }
    return;
  }
  handleDimensionClick(ev);
});
els.activityPane?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.dash-expand[data-modal]');
  if (!btn) return;
  ev.preventDefault();
  openModal(btn.getAttribute('data-modal'));
});
els.modal?.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-modal-close]')) {
    closeModal();
    return;
  }
  const slice = ev.target.closest('.dash-donut-slice[data-key]');
  if (slice) {
    const key = slice.getAttribute('data-key');
    if (key && key !== '__other') {
      if (state.shareBy === 'model') toggleFilter({ model: key });
      else toggleFilter({ client: key });
    }
    return;
  }
  handleDimensionClick(ev);
  const weekday = ev.target.closest('[data-weekday]');
  if (weekday) {
    const value = Number(weekday.getAttribute('data-weekday'));
    if (Number.isInteger(value) && value >= 0 && value <= 6) {
      state.filterWeekday = state.filterWeekday === value ? null : value;
      state.motion = 'update';
      render();
    }
    return;
  }
  const heat = ev.target.closest('.heat');
  if (heat && state.modal === 'heatmap') handleHeatmapClick(ev);
});
els.modal?.addEventListener('mousemove', (ev) => {
  const slice = ev.target.closest('.dash-donut-slice');
  if (slice) {
    showShareTooltip(slice, ev);
    return;
  }
  const hit = ev.target.closest('.bar-hover');
  if (hit && state.modalChartModel) {
    const bar = state.modalChartModel.bars[Number(hit.getAttribute('data-i'))];
    if (bar) showBarTooltip(bar, ev);
    else hideTooltip();
    return;
  }
  const heat = ev.target.closest('.heat');
  if (heat) {
    const date = heat.getAttribute('data-d');
    showHeatTooltip(date, state.dayMap && state.dayMap.get(date), ev);
    return;
  }
  const hourHit = ev.target.closest('.dash-hour[data-hour], .dash-hour-cell[data-hour], .dash-portrait-slot[data-hour]');
  if (hourHit) {
    showHourTooltip(hourHit, ev);
    return;
  }
  hideTooltip();
});
els.modal?.addEventListener('mouseleave', hideTooltip);
els.share?.addEventListener('mousemove', (ev) => {
  const slice = ev.target.closest('.dash-donut-slice');
  if (slice) showShareTooltip(slice, ev);
  else hideTooltip();
});
els.share?.addEventListener('mouseleave', hideTooltip);
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !state.modal) return;
  ev.preventDefault();
  closeModal();
});
els.hours?.addEventListener('mousemove', (ev) => {
  const hit = ev.target.closest('.dash-hour[data-hour]');
  if (hit) showHourTooltip(hit, ev);
  else hideTooltip();
});
els.hours?.addEventListener('mouseleave', hideTooltip);
els.portrait?.addEventListener('mousemove', (ev) => {
  const hit = ev.target.closest('.dash-portrait-slot[data-hour]');
  if (hit) showHourTooltip(hit, ev);
  else hideTooltip();
});
els.portrait?.addEventListener('mouseleave', hideTooltip);
els.weekdays?.addEventListener('click', (ev) => {
  const hit = ev.target.closest('[data-weekday]');
  if (!hit) return;
  const weekday = Number(hit.getAttribute('data-weekday'));
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return;
  state.filterWeekday = state.filterWeekday === weekday ? null : weekday;
  state.motion = 'update';
  render();
});
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
els.heatmap.addEventListener('click', handleHeatmapClick);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { state.motion = 'none'; render(); }, 120); // both the chart and the heatmap are sized to the window
});
window.addEventListener('focus', refresh);

boot();
