'use strict';

const charts = window.TokenMonitorUsageCharts;
const themePresetsApi = window.TokenMonitorThemePresets;
const i18n = window.TokenMonitorI18n;
const currencyApi = window.TokenMonitorCurrency;
const compactMoneyApi = window.TokenMonitorCompactMoney;
const compactTokenApi = window.TokenMonitorCompactTokens;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const fontSettingsApi = window.TokenMonitorFontSettings;
const statsRenderSchedulerApi = window.TokenMonitorStatsRenderScheduler;
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const glassRenderingApi = window.TokenMonitorGlassRendering;
const contentBlurApi = window.TokenMonitorContentBlur;
const modelApi = window.TokenMonitorDashboardModel;
const numberAnimationApi = window.TokenMonitorTokenNumberAnimation;
const tokenRateApi = window.TokenMonitorTokenRate;
const homeLimitMotionApi = window.TokenMonitorHomeLimitMotion;
const limitResetMotionApi = window.TokenMonitorLimitResetMotion;
const limitResetAnimatorApi = window.TokenMonitorLimitResetAnimator;
const sessionLiveApi = window.TokenMonitorSessionLive;
const sessionActivityProjectionApi = window.TokenMonitorSessionActivityProjection;
const sessionTitleDisplayApi = window.TokenMonitorSessionTitleDisplay;
const allTimeSessionsApi = window.TokenMonitorAllTimeSessions;
const fixedPeriodRangesApi = window.TokenMonitorFixedPeriodRanges;
const skylineApi = window.TokenMonitorActivitySkyline3D;
const rendererDom = window.TokenMonitorDomReconcile.create();

// Canonical brand colours captured before overrides (clientColors is shared by reference).
const BRAND_VENDOR_COLORS = { ...charts.modelColors };

const els = {
  body: document.body,
  shell: document.getElementById('dashShell'),
  workspace: document.getElementById('dashWorkspace'),
  stage: document.querySelector('.dash-stage'),
  deviceScope: document.getElementById('dashDeviceScope'),
  deviceTrigger: document.getElementById('dashDeviceTrigger'),
  deviceMenu: document.getElementById('dashDeviceMenu'),
  periodSelect: document.getElementById('periodSelect'),
  themeToggle: document.getElementById('themeToggle'),
  refreshBtn: document.getElementById('refreshBtn'),
  minBtn: document.getElementById('minBtn'),
  closeBtn: document.getElementById('closeBtn'),
  tabsContainer: document.querySelector('.dash-tabs'),
  tabs: Array.from(document.querySelectorAll('.dash-tab')),
  trendsPane: document.getElementById('trendsPane'),
  activityPane: document.getElementById('activityPane'),
  heroScope: document.getElementById('dashHeroScope'),
  heroActive: document.getElementById('dashHeroActive'),
  heroTokens: document.getElementById('dashHeroTokens'),
  heroApprox: document.getElementById('dashHeroApprox'),
  heroCost: document.getElementById('dashHeroCost'),
  heroCacheSep: document.getElementById('dashHeroCacheSep'),
  heroCacheItem: document.getElementById('dashHeroCacheItem'),
  heroCache: document.getElementById('dashHeroCache'),
  heroRibbon: document.getElementById('dashHeroRibbon'),
  heroAnatomy: document.getElementById('dashHeroAnatomy'),
  velocity: document.getElementById('dashVelocity'),
  velocityStatus: document.getElementById('dashVelocityStatus'),
  velocityStatusText: document.getElementById('dashVelocityStatusText'),
  velocityOverview: document.querySelector('#dashVelocity .dash-velocity-overview'),
  velocityFigure: document.getElementById('dashVelocityFigure'),
  velocityValue: document.getElementById('dashVelocityValue'),
  velocityUnit: document.getElementById('dashVelocityUnit'),
  velocitySecondary: document.getElementById('dashVelocitySecondary'),
  velocitySpark: document.getElementById('dashVelocitySpark'),
  velocityModels: document.getElementById('dashVelocityModels'),
  stageTitle: document.getElementById('dashStageTitle'),
  activityCol: document.getElementById('dashActivityCol'),
  heatmapMeta: document.getElementById('dashHeatmapMeta'),
  heatmapMetricControl: document.getElementById('dashHeatmapMetricControl'),
  visualBand: document.querySelector('.dash-visual-band'),
  topology: document.getElementById('dashTopology'),
  skylineStage: document.getElementById('dashSkylineStage'),
  skylineCanvasHost: document.getElementById('dashSkylineCanvasHost'),
  skylineToolLegend: document.getElementById('dashSkylineToolLegend'),
  skylineHint: document.getElementById('dashSkylineHint'),
  skylineReset: document.getElementById('skylineReset'),
  quotasCard: document.getElementById('dashQuotasCard'),
  quotasCount: document.getElementById('dashQuotasCount'),
  quotas: document.getElementById('dashQuotas'),
  workTitle: document.getElementById('dashWorkTitle'),
  workSummary: document.getElementById('dashWorkSummary'),
  workPanel: document.getElementById('dashWorkPanel'),
  breakdown: document.getElementById('dashBreakdown'),
  dailyLedger: document.getElementById('dashDailyLedger'),
  ledgerMeta: document.getElementById('dashLedgerMeta'),
  rangeSelect: document.getElementById('rangeSelect'),
  chart: document.getElementById('dashChart'),
  legend: document.getElementById('dashLegend'),
  heatmap: document.getElementById('dashHeatmap'),
  heatFooter: document.getElementById('dashHeatFooter'),
  heatSummary: document.getElementById('dashHeatSummary'),
  heatLegend: document.getElementById('dashHeatLegend'),
  cards: document.getElementById('dashCards'),
  empty: document.getElementById('dashEmpty'),
  tooltip: document.getElementById('dashTooltip'),
  drawerScrim: document.getElementById('dashDrawerScrim'),
  drawer: document.getElementById('dashDrawer'),
  drawerIcon: document.getElementById('dashDrawerIcon'),
  drawerTitle: document.getElementById('dashDrawerTitle'),
  drawerSubtitle: document.getElementById('dashDrawerSubtitle'),
  drawerBody: document.getElementById('dashDrawerBody'),
  drawerClose: document.getElementById('dashDrawerClose'),
  stackBtns: Array.from(document.querySelectorAll('[data-control="stack"] .seg-btn')),
  modeBtns: Array.from(document.querySelectorAll('[data-control="mode"] .seg-btn')),
  trendMetricBtns: Array.from(document.querySelectorAll('[data-control="trendMetric"] .seg-btn')),
  stageViewBtns: Array.from(document.querySelectorAll('[data-control="stageView"] .seg-btn')),
  heatmapMetricBtns: Array.from(document.querySelectorAll('[data-control="heatmapMetric"] .seg-btn')),
  skylineColorBtns: Array.from(document.querySelectorAll('[data-control="skylineColor"] .seg-btn')),
  breakdownModeBtns: Array.from(document.querySelectorAll('[data-control="breakdownMode"] .seg-btn')),
  workModeBtns: Array.from(document.querySelectorAll('[data-control="workMode"] .seg-btn'))
};

contentBlurApi?.create?.({
  document,
  window,
  root: els.shell || els.body
});

const PERIODS = ['today', 'yesterday', 'week', 'last7', 'last30', 'month', 'allTime'];
const dashboardSettings = {
  popover: document.getElementById('dashSettings'),
  trigger: document.getElementById('dashSettingsTrigger'),
  choices: document.getElementById('dashPeriodChoices'),
  follow: document.getElementById('dashFollowPeriods'),
  velocity: document.getElementById('dashShowVelocity'),
  quotas: document.getElementById('dashShowQuotas'),
  stage: document.getElementById('dashDefaultStage'),
  metric: document.getElementById('dashDefaultMetric'),
  error: document.getElementById('dashSettingsError')
};
let dashboardSettingsSave = Promise.resolve();
let periodTabsSignature = '';
const RANGES = ['7', '30', '90', '365', 'all'];
const state = {
  tab: 'activity',
  periodKey: 'today',
  selectedDeviceId: 'all',
  deviceMenuOpen: false,
  range: '30',
  stackBy: 'client',
  mode: 'bars',
  trendMetric: 'tokens',
  stageView: 'flow',
  heatmapView: '3d',
  heatmapMetric: 'cost',
  skylineColorMode: 'heat',
  rateMode: 'speed',
  breakdownMode: 'both',
  workMode: 'sessions',
  soloKey: null,
  flat: false,
  locale: 'en',
  currency: 'USD',
  compactTokenUnits: 'western',
  settings: {},
  stats: null,
  history: null,
  chartModel: null,
  chartKind: 'bars',
  motion: 'none',
  reduceMotion: 'system',
  streamConnected: false,
  statsMode: '',
  overview: null,
  drawer: null
};

let nativeMaterialState = glassRenderingApi?.normalizeNativeMaterialState?.()
  || { type: 'transparent', reducedTransparency: false, highContrast: false };
let nativeMaterialRevision = 0;

const DATA_MOTION_MS = 800;
const KLINE_MOTION_MS = 560;
const HEATMAP_MOTION_MS = 720;
const HEAT_CELL_MOTION_MS = 280;
let heatmapMotionGeneration = 0;
let dashboardReady = false;
let dashboardRefreshFrame = 0;
let lastHeroRender = { text: '', value: 0, scopeKey: '' };
let settleHeroNumber = null;
let heroSettleTimer = 0;
let drawerRequestToken = 0;
let lastHeatmapGridSig = '';
let lastHeatmapValuesSig = '';
let lastQuotasStructureSig = '';
let lastWorkStructureSig = '';
let lastBreakdownStructureSig = '';
const metricTextAnimations = new WeakMap();
let topologyLayoutFrame = 0;
let topologyScrollFrame = 0;
let topologyResizeObserver = null;
let skylineController = null;
let skylineResizeObserver = null;
let skylineHintDismissed = false;
let lastRenderedTab = state.tab;
let activeHover = null;
let spotlightFrame = 0;
let spotlightVisible = false;
const spotlightCurrent = { x: -200, y: -200 };
const spotlightTarget = { x: -200, y: -200 };

// Match rateHistory's epoch clock (`Date.now`) so sample timestamps share one time base.
const deviceRateTracker = tokenRateApi?.createLiveTokenRateGroupTracker
  ? tokenRateApi.createLiveTokenRateGroupTracker({ now: Date.now, activeMs: 12_000 })
  : null;
const rateHistory = tokenRateApi?.createLiveTokenRateHistory
  ? tokenRateApi.createLiveTokenRateHistory()
  : null;
const deviceRateTrackers = new Map();
let rateExpiryTimer = null;

const homeLimitMotion = homeLimitMotionApi && limitResetMotionApi && limitResetAnimatorApi && numberAnimationApi
  ? homeLimitMotionApi.createHomeLimitMotion({
      motion: limitResetMotionApi,
      resetEasing: limitResetAnimatorApi.EASING,
      numbers: numberAnimationApi,
      numberMode: () => numberAnimationApi.normalize(state.settings?.tokenNumberAnimation),
      prefersReducedMotion: () => prefersReducedMotion(),
      formatPercent: (value) => `${Math.round(Number(value || 0))}%`
    })
  : null;

function prefersReducedMotion() {
  return motionPreferenceApi.shouldReduceMotion(state.reduceMotion, reducedMotionMedia?.matches);
}

function applyReduceMotionPreference(value) {
  state.reduceMotion = motionPreferenceApi.normalize(value);
  document.documentElement.dataset.reduceMotion = state.reduceMotion;
  if (!prefersReducedMotion()) return;
  heatmapMotionGeneration += 1;
  state.motion = 'none';
  settleHeroNumber?.();
  homeLimitMotion?.settle?.();
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
    if (fromZero) animateCandles();
    return;
  }
  const shapes = Array.from(els.chart.querySelectorAll('.bar-stack[data-motion-key]'));
  shapes.forEach((shape, index) => {
    for (const animation of shape.getAnimations()) animation.cancel();
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
  const continuingEntry = els.heatmap.classList.contains('is-motion-pending');
  if (state.motion !== 'entry' && !continuingEntry) return;
  els.heatmap.classList.add('is-motion-pending');
  const generation = ++heatmapMotionGeneration;
  const startWhenVisible = () => {
    if (generation !== heatmapMotionGeneration) return;
    if (state.tab !== 'activity' || state.stageView === 'flow') {
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
      if (generation !== heatmapMotionGeneration || state.tab !== 'activity' || state.stageView === 'flow') return;
      const isoCols = Array.from(els.heatmap.querySelectorAll('.iso-col'));
      if (isoCols.length) {
        const cols = isoCols.map((node) => Number(node.getAttribute('data-col') || 0));
        const first = Math.min(...cols);
        const last = Math.max(...cols);
        const span = Math.max(1, last - first);
        isoCols.forEach((node, idx) => {
          const lvl = Number(node.getAttribute('data-lvl') || 0);
          const delay = ((cols[idx] - first) / span) * (HEATMAP_MOTION_MS - 300);
          const liftY = lvl > 0 ? 12 : 4;
          const anim = node.animate(
            [{ opacity: 0, transform: `translateY(${liftY}px)` }, { opacity: 1, transform: 'none' }],
            { duration: 320, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
          );
          anim.finished.then(() => {
            if (!node.isConnected) return;
            node.removeAttribute('data-motion-hidden');
            anim.cancel();
          }).catch(() => {});
        });
        requestAnimationFrame(() => {
          if (generation === heatmapMotionGeneration && state.tab === 'activity') {
            els.heatmap.classList.remove('is-motion-pending');
          }
        });
        return;
      }

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
      requestAnimationFrame(() => {
        if (generation === heatmapMotionGeneration && state.tab === 'activity') {
          els.heatmap.classList.remove('is-motion-pending');
        }
      });
    }));
  };
  startWhenVisible();
}

function animateSectionReveal(targets) {
  if (prefersReducedMotion() || document.hidden) return;
  const list = Array.from(targets || []).filter((el) => el && el.isConnected && !el.classList?.contains('hidden'));
  list.forEach((node) => {
    node.animate?.(
      [{ opacity: 0.72 }, { opacity: 1 }],
      { duration: 160, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
    );
  });
}

function syncSegIndicator(container, { animate = true } = {}) {
  if (!container) return;
  if (container.classList?.contains('hidden')) {
    container.querySelector(':scope > .seg-indicator')?.classList.remove('is-ready');
    return;
  }
  const active = container.querySelector('.seg-btn.active, .dash-tab.active, .range-btn.active');
  let indicator = container.querySelector(':scope > .seg-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'seg-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    container.prepend(indicator);
  }
  container.classList.add('has-indicator');
  if (!active || active.offsetWidth <= 0) {
    indicator.classList.remove('is-ready');
    return;
  }
  const instant = !animate || prefersReducedMotion() || !indicator.classList.contains('is-ready');
  if (instant) indicator.classList.add('is-instant');
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;
  indicator.classList.add('is-ready');
  if (instant) {
    void indicator.offsetWidth;
    indicator.classList.remove('is-instant');
  }
}

function syncAllSegIndicators({ animate = true } = {}) {
  syncSegIndicator(els.periodSelect, { animate });
  syncSegIndicator(els.tabsContainer, { animate });
  syncSegIndicator(els.rangeSelect, { animate });
  document.querySelectorAll('.seg[data-control]').forEach((seg) => syncSegIndicator(seg, { animate }));
}

function activateSegButton(buttons, activeBtn) {
  buttons.forEach((btn) => {
    const active = btn === activeBtn;
    btn.classList.toggle('active', active);
    if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(active));
  });
  syncSegIndicator(activeBtn?.parentElement || null);
}

function t(key, params) { return i18n.translate(state.locale, key, params); }

function effectiveCompactTokenUnits() {
  return compactTokenApi.effectiveCompactTokenUnits(state.compactTokenUnits, state.locale);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.getAttribute('data-i18n')); });
  const brandMark = document.querySelector('.dash-brand-mark');
  if (brandMark) brandMark.setAttribute('aria-label', t('dashboard.title'));
  if (els.refreshBtn && !manualRefreshBusy && !refreshFeedbackTimer) {
    els.refreshBtn.setAttribute('aria-label', t('refreshButton.label'));
  }
  if (els.skylineReset) els.skylineReset.setAttribute('aria-label', t('dashboard.skyline.reset'));
  els.periodSelect?.setAttribute('aria-label', t('periodRange.tabsTitle'));
  document.documentElement.lang = state.locale;
}

function applyAppearance(settings) {
  glassRenderingApi?.applyNativeMaterialClasses?.(nativeMaterialState);
  const opacity = Math.min(100, Math.max(0, settings?.glassOpacity ?? 68)) / 100;
  const depth = (glassRenderingApi?.usesNativeMaterial?.(nativeMaterialState) ? 32 : Math.min(100, Math.max(0, settings?.glassBlur ?? 32))) / 100;
  const root = document.documentElement.style;
  root.setProperty('--glass-alpha', opacity.toFixed(2));
  root.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  applyReduceMotionPreference(settings?.reduceMotion);
  applyFontSettings(settings);
  applyThemeColors(settings?.themeColors);
  applyVendorColorOverrides(settings?.vendorColors);
  els.body.classList.toggle('flat', state.flat);
  skylineController?.refreshTheme?.();
}

function applyFontSettings(settings) {
  const root = document.documentElement.style;
  const { interfaceFont, displayFont } = fontSettingsApi.resolveEffectiveFontSettings(settings, {
    ...settings?.fontContext,
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
  charts.applyVendorColors(merged);
}

function formatCompact(value) {
  return compactTokenApi.formatCompactTokens(value, effectiveCompactTokenUnits(), state.locale);
}

function formatExactTokens(value) {
  return Math.max(0, Math.round(Number(value || 0))).toLocaleString('en-US');
}

function formatRate(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1000) return formatCompact(num);
  return String(Math.round(num));
}

function formatDurationCompact(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '0m';
}

function formatCost(usd, unpricedTokens) {
  if (unpricedTokens > 0 && !(usd > 0)) return '—';
  return currencyApi.formatCurrencyFromUsd(usd, currencyApi.normalizeCurrency(state.currency));
}

function formatCostCompact(usd, unpricedTokens) {
  if (unpricedTokens > 0 && !(usd > 0)) return '—';
  return compactMoneyApi.formatCompactCurrencyFromUsd(
    usd,
    state.currency,
    effectiveCompactTokenUnits(),
    state.locale
  );
}

function formatResetShort(resetsAt) {
  const ms = Date.parse(String(resetsAt || ''));
  if (!Number.isFinite(ms)) return '';
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return diffMs >= -60_000 ? '<1m' : '';
  const totalMinutes = Math.max(0, Math.round(diffMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function shortDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(key);
}

function axisEvery(list) { return Math.max(1, Math.ceil(list.length / 9)); }
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
  return { w: Math.max(320, els.chart.clientWidth || 860), h: Math.max(220, els.chart.clientHeight || 290) };
}

function dashboardPeriodChoices(settings) {
  return settings.dashboardVisiblePeriods?.length
    ? PERIODS.filter(period => settings.dashboardVisiblePeriods.includes(period))
    : PERIODS;
}

function dashboardPeriodTabs(settings) {
  if (!settings.dashboardFollowPeriodTabs) return dashboardPeriodChoices(settings);
  const order = fixedPeriodRangesApi.normalizePeriodTabOrder(settings.periodTabOrder);
  if (order.length) return order;
  return ['today', fixedPeriodRangesApi.normalizeMonthMode(settings.periodMonthMode), 'allTime'];
}

function syncDashboardSettings(settings) {
  if (!dashboardSettings.popover) return;
  const visible = dashboardPeriodChoices(settings);
  dashboardSettings.follow.checked = settings.dashboardFollowPeriodTabs === true;
  dashboardSettings.velocity.checked = settings.dashboardShowVelocity !== false;
  dashboardSettings.quotas.checked = settings.dashboardShowQuotas !== false;
  dashboardSettings.stage.value = state.stageView;
  dashboardSettings.metric.value = state.heatmapMetric;
  const displayed = dashboardSettings.follow.checked ? dashboardPeriodTabs(settings) : visible;
  for (const input of dashboardSettings.choices.querySelectorAll('input')) {
    input.checked = displayed.includes(input.value);
    input.disabled = dashboardSettings.follow.checked || (input.checked && visible.length === 1);
  }
  els.velocity?.classList.toggle('hidden', !dashboardSettings.velocity.checked);
  els.quotasCard?.classList.toggle('hidden', !dashboardSettings.quotas.checked);
  els.velocity?.parentElement?.classList.toggle('dash-band-single', !dashboardSettings.velocity.checked);
  els.visualBand?.classList.toggle('dash-band-single', !dashboardSettings.quotas.checked);
}

function populateDashboardSettings() {
  if (!dashboardSettings.choices) return;
  dashboardSettings.trigger.setAttribute('aria-label', t('dashboard.settings.title'));
  dashboardSettings.choices.innerHTML = PERIODS.map(period =>
    `<label><input type="checkbox" value="${period}"> ${escapeHtml(t(`dashboard.period.${period}`))}</label>`
  ).join('');
}

function saveDashboardSettings(patch) {
  dashboardSettingsSave = dashboardSettingsSave.then(async () => {
    dashboardSettings.error.classList.add('hidden');
    try {
      await window.tokenMonitor.updateSettings(patch);
    } catch (_) {
      dashboardSettings.error.classList.remove('hidden');
      syncDashboardSettings(state.settings);
    }
  });
}

function populatePeriodSelect() {
  if (!els.periodSelect) return;
  const periods = dashboardPeriodTabs(state.settings);
  const selectionChanged = !periods.includes(state.periodKey);
  if (selectionChanged) state.periodKey = periods.includes(state.settings.defaultUsageRange)
    ? state.settings.defaultUsageRange
    : periods[0];
  const signature = JSON.stringify([state.locale, periods]);
  if (periodTabsSignature === signature) return false;
  periodTabsSignature = signature;
  els.periodSelect.innerHTML = periods.map((p) =>
    `<button type="button" class="seg-btn${p === state.periodKey ? ' active' : ''}" data-period="${p}" aria-pressed="${p === state.periodKey}">${escapeHtml(t(`dashboard.period.${p}`))}</button>`
  ).join('');
  els.periodSelect.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextPeriod = btn.dataset.period;
      if (!nextPeriod || state.periodKey === nextPeriod) return;
      hideTooltip();
      closeDrawer();
      state.periodKey = nextPeriod;
      state.motion = 'update';
      els.periodSelect.querySelectorAll('.seg-btn').forEach((b) => {
        const active = b.dataset.period === nextPeriod;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      syncSegIndicator(els.periodSelect);
      if (nextPeriod === 'allTime') allTimeSessions?.ensure?.();
      ensureSyncedSessionPages?.();
      render();
    });
  });
  syncSegIndicator(els.periodSelect, { animate: false });
  return selectionChanged;
}

function populateRangeSelect() {
  els.rangeSelect.innerHTML = RANGES.map((r) =>
    `<button type="button" class="range-btn${r === state.range ? ' active' : ''}" data-val="${r}">${escapeHtml(t(`dashboard.range.${r}`))}</button>`
  ).join('');
  els.rangeSelect.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (state.range === e.target.dataset.val) return;
      hideTooltip();
      state.range = e.target.dataset.val;
      state.motion = 'update';
      els.rangeSelect.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === e.target));
      syncSegIndicator(els.rangeSelect);
      render();
    });
  });
  syncSegIndicator(els.rangeSelect, { animate: false });
}

function displayColor(hex) {
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

// CSP (style-src 'self') forbids inline style attributes. Dynamic colours,
// bar scales, node accents, and quota track percentages travel via data-* through CSSOM.
function applySwatchColors(root) {
  if (!root) return;
  root.querySelectorAll('[data-c]').forEach((el) => {
    const color = el.getAttribute('data-c');
    if (el.classList.contains('row-icon') || el.classList.contains('limit-icon')) {
      el.style.color = color;
    } else {
      el.style.background = color;
    }
  });
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.setProperty('--bar-scale', el.getAttribute('data-w')); });
  root.querySelectorAll('[data-h]').forEach((el) => { el.style.setProperty('--bar-h', el.getAttribute('data-h')); });
  root.querySelectorAll('[data-weight]').forEach((el) => { el.style.setProperty('--seg-weight', el.getAttribute('data-weight')); });
  root.querySelectorAll('[data-bg]').forEach((el) => { el.style.background = el.getAttribute('data-bg'); });
  root.querySelectorAll('[data-node-accent]').forEach((el) => { el.style.setProperty('--node-accent', el.getAttribute('data-node-accent')); });
  root.querySelectorAll('[data-limit-fill]').forEach((el) => { el.style.setProperty('--home-limit-fill', `${el.getAttribute('data-limit-fill')}%`); });
  root.querySelectorAll('[data-limit-pace]').forEach((el) => { el.style.setProperty('--home-limit-pace', `${el.getAttribute('data-limit-pace')}%`); });
  root.querySelectorAll('[data-vendor-color]').forEach((el) => {
    const vc = el.getAttribute('data-vendor-color');
    if (vc) el.style.setProperty('--home-vendor-color', vc);
  });
  root.querySelectorAll('[data-limit-color]').forEach((el) => {
    const color = el.getAttribute('data-limit-color');
    if (color) {
      el.style.setProperty('--home-limit-bar', color);
      el.style.setProperty('--home-limit-tail', color);
    }
  });
  root.querySelectorAll('[data-limit-accent]').forEach((el) => {
    const accent = el.getAttribute('data-limit-accent');
    if (accent) el.style.setProperty('--home-limit-accent', accent);
  });
}

function findByDataset(root, selector, predicate) {
  if (!root) return null;
  for (const el of root.querySelectorAll(selector)) {
    if (predicate(el)) return el;
  }
  return null;
}

function withPreservedFocus(container, rowSelector, keyOf, renderFn) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const inside = Boolean(container && active && container.contains?.(active));
  const matchedRow = inside ? active.closest?.(rowSelector) : null;
  const focusKey = matchedRow ? keyOf(matchedRow) : '';
  renderFn();
  if (!focusKey || !container) return;
  const nextRow = findByDataset(container, rowSelector, (el) => keyOf(el) === focusKey);
  if (nextRow && nextRow !== active) nextRow.focus?.({ preventScroll: true });
}

function handleKeyboardClick(ev) {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const target = ev.target?.closest?.('[role="button"][tabindex="0"]');
  if (!target) return;
  if (ev.key === ' ') ev.preventDefault();
  target.click();
}

function renderLegend(model) {
  const totals = {};
  for (const bar of model.bars) for (const s of bar.segments) totals[s.key] = (totals[s.key] || 0) + s.value;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const rows = (model.keys || []).map((k) => ({ key: k, value: totals[k] || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  withPreservedFocus(els.legend, '.dash-legend-row[data-legend-key]', (r) => r.dataset.legendKey || '', () => {
    els.legend.innerHTML = rows.map((r) => {
      const soloCls = state.soloKey === r.key ? ' is-solo' : (state.soloKey && state.soloKey !== r.key ? ' is-dimmed' : '');
      return `<div class="dash-legend-row${soloCls}" data-legend-key="${escapeHtml(r.key)}" tabindex="0" role="button">`
        + `<span class="dash-legend-name"><span class="dash-legend-swatch" data-c="${colorFor(r.key)}"></span>${escapeHtml(r.key)}</span>`
        + `<span class="dash-legend-val">${state.trendMetric === 'cost' ? formatCost(r.value) : formatCompact(r.value)}</span>`
        + `<span class="dash-legend-pct">${(r.value / grand * 100).toFixed(1)}%</span>`
        + `</div>`;
    }).join('');
    applySwatchColors(els.legend);
    els.legend.querySelectorAll('.dash-legend-row').forEach((row) => {
      row.addEventListener('click', () => {
        const key = row.dataset.legendKey;
        state.soloKey = state.soloKey === key ? null : key;
        renderTrends();
      });
    });
  });
}

function renderDailyLedger(overview) {
  if (!els.dailyLedger) return;
  const allRows = overview?.dailyLedger || [];
  let rows = allRows;
  if (state.range !== 'all') {
    const rangeDays = Math.max(1, Number(state.range) || 0);
    const calendarWindow = charts.dailyWindow
      ? charts.dailyWindow(allRows, { days: rangeDays, todayKey: todayKey() })
      : [];
    if (calendarWindow.length > 0) {
      const startDate = calendarWindow[0].date;
      const endDate = calendarWindow[calendarWindow.length - 1].date;
      rows = allRows.filter((r) => r.date >= startDate && r.date <= endDate);
    } else {
      rows = [];
    }
  }
  if (els.ledgerMeta) els.ledgerMeta.textContent = rows.length ? `${rows.length}d` : '';
  if (rows.length === 0) {
    els.dailyLedger.innerHTML = `<div class="dash-quotas-empty">${escapeHtml(t('dashboard.empty'))}</div>`;
    return;
  }
  const head = `<div class="dash-ledger-row is-head">`
    + `<span>${escapeHtml(t('dashboard.ledger.date'))}</span>`
    + `<span>${escapeHtml(t('dashboard.ledger.topTool'))}</span>`
    + `<span class="dash-ledger-num">${escapeHtml(t('dashboard.heatmap.tokens'))}</span>`
    + `<span class="dash-ledger-num">${escapeHtml(t('dashboard.heatmap.cost'))}</span>`
    + `<span class="dash-ledger-num">${escapeHtml(t('dashboard.ledger.delta'))}</span>`
    + `</div>`;
  const body = rows.slice(0, 60).map((row) => {
    const delta = row.deltaPercent;
    const deltaCls = delta == null ? '' : delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : '';
    const deltaText = delta == null ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta)}%`;
    const toolHtml = row.topClient
      ? `<span class="dash-bd-swatch" data-c="${displayColor(row.topClient.color)}"></span><span>${escapeHtml(row.topClient.label)}</span>`
      : '—';
    return `<div class="dash-ledger-row" data-day="${escapeHtml(row.date)}" tabindex="0" role="button">`
      + `<span>${escapeHtml(shortDate(row.date))}</span>`
      + `<span class="dash-ledger-tool">${toolHtml}</span>`
      + `<span class="dash-ledger-num">${escapeHtml(formatCompact(row.tokens))}</span>`
      + `<span class="dash-ledger-num">${escapeHtml(formatCost(row.cost, row.unpricedTokens))}</span>`
      + `<span class="dash-ledger-delta${deltaCls}">${escapeHtml(deltaText)}</span>`
      + `</div>`;
  }).join('');
  withPreservedFocus(els.dailyLedger, '.dash-ledger-row[data-day]', (r) => r.dataset.day || '', () => {
    els.dailyLedger.innerHTML = head + body;
    applySwatchColors(els.dailyLedger);
    els.dailyLedger.querySelectorAll('.dash-ledger-row[data-day]').forEach((row) => {
      row.addEventListener('click', () => {
        const target = rows.find((d) => d.date === row.dataset.day);
        if (target) openDrawer({ kind: 'day', day: target });
      });
    });
  });
}

const renderedMarkup = new WeakMap();

function patchDashboardMarkup(container, html, beforePatch) {
  if (renderedMarkup.get(container) === html) return false;
  beforePatch?.();
  const staged = container.cloneNode(false);
  staged.innerHTML = html;
  rendererDom.reconcileChildren(container, Array.from(staged.childNodes));
  renderedMarkup.set(container, html);
  return true;
}

function renderTrends() {
  const previousKind = state.chartKind;
  let previousGeometry;
  const captureBars = () => { previousGeometry = captureGeometry(els.chart, '.bar-stack[data-motion-key]'); };
  const effectiveDeviceId = state.overview?.fleet
    ? (state.overview.fleet.isFleetMode && state.overview.activeMachine ? state.overview.activeMachine.deviceId : 'all')
    : state.selectedDeviceId;
  const scopedHistory = effectiveDeviceId === 'all'
    ? null
    : (state.overview?.scopedHistory || modelApi.selectScopedHistory(state.history, effectiveDeviceId));
  // Give each calendar day a slot even when history has no record for it.
  const daily = effectiveDeviceId === 'all'
    ? charts.dailyWindow(state.history?.daily || [], {
      days: state.range === 'all' ? 0 : Number(state.range)
    })
    : charts.dailyWindow(scopedHistory?.daily || [], {
      days: state.range === 'all' ? 0 : Number(state.range)
    });
  if (daily.length === 0) { patchDashboardMarkup(els.chart, ''); els.legend.innerHTML = ''; state.chartModel = null; return; }
  const pad = { padTop: 10, padRight: 14, padBottom: 24, padLeft: 56 };
  const metric = state.trendMetric === 'cost' ? 'cost' : 'tokens';
  const formatAxisTick = metric === 'cost' ? formatCostCompact : formatCompact;

  if (state.mode === 'kline') {
    els.legend.innerHTML = '';
    const { w, h } = chartSize();
    const span = daysBetween(daily[0].date, daily[daily.length - 1].date) + 1;
    const target = Math.max(8, Math.round((w - pad.padLeft - pad.padRight) / 24));
    const bucketDays = span <= 10 ? 2 : Math.max(3, Math.round(span / target));
    const model = charts.candleChart(daily, { width: w, height: h, gap: 0.4, metric, bucketDays, ...pad });
    state.chartModel = model; state.chartKind = 'candle';
    const every = axisEvery(model.candles);
    const html = charts.candleChartSvg(model, { yTicks: 4, formatTick: formatAxisTick, axisLabel: (c, i) => (i % every === 0 ? shortDate(c.key) : '') });
    if (patchDashboardMarkup(els.chart, html)) {
      animateChartGeometry(null, { fromZero: state.motion === 'entry' || previousKind !== 'candle' });
    }
    return;
  }

  const tempModel = charts.dailyBarsChart(daily, { width: 100, height: 100, gap: 0.3, stackBy: state.stackBy, metric, ...pad });
  renderLegend(tempModel);

  const { w, h } = chartSize();
  const model = charts.dailyBarsChart(daily, { width: w, height: h, gap: 0.3, stackBy: state.stackBy, metric, ...pad });
  state.chartModel = model; state.chartKind = 'bars';
  const every = axisEvery(model.bars);
  const html = charts.barsChartSvg(model, { colorFor, yTicks: 4, formatTick: formatAxisTick, axisLabel: (bar, i) => (i % every === 0 ? shortDate(bar.label) : '') });
  const changed = patchDashboardMarkup(els.chart, html, captureBars);
  const soloColor = state.soloKey ? colorFor(state.soloKey) : '';
  els.chart.querySelectorAll('.bar-seg').forEach((seg) => {
    seg.classList.toggle('is-dimmed', Boolean(soloColor && seg.getAttribute('fill') !== soloColor));
  });
  if (changed) animateChartGeometry(previousGeometry, { fromZero: state.motion === 'entry' || state.motion === 'series' || previousKind !== 'bars' });
}

function renderBreakdown(overview) {
  const elsBreakdown = els.breakdown || document.getElementById('dashBreakdown');
  if (!elsBreakdown) return;
  const tools = overview?.tools || [];
  const models = overview?.models || [];
  if (tools.length === 0 && models.length === 0) {
    lastBreakdownStructureSig = '';
    elsBreakdown.innerHTML = '';
    return;
  }

  const groups = [];
  if (state.breakdownMode !== 'model' && tools.length > 0) {
    groups.push({ kind: 'client', titleKey: 'dashboard.stack.client', rows: tools.slice(0, 6) });
  }
  if (state.breakdownMode !== 'client' && models.length > 0) {
    groups.push({ kind: 'model', titleKey: 'dashboard.stack.model', rows: models.slice(0, 6) });
  }

  const nextSig = JSON.stringify([
    state.breakdownMode,
    state.locale,
    groups.map((g) => [g.kind, g.rows.map((r) => r.id)])
  ]);

  if (nextSig === lastBreakdownStructureSig) {
    const rowMap = new Map();
    elsBreakdown.querySelectorAll('.dash-bd-row').forEach((rowEl) => {
      rowMap.set(`${rowEl.dataset.bdKind}:${rowEl.dataset.bdId}`, rowEl);
    });
    for (const g of groups) {
      for (const row of g.rows) {
        const rowEl = rowMap.get(`${g.kind}:${row.id}`);
        if (!rowEl) continue;
        const fill = rowEl.querySelector('.dash-bd-bar-fill');
        const valEl = rowEl.querySelector('.dash-bd-val');
        const pctEl = rowEl.querySelector('.dash-bd-pct');
        const w = row.relWidth.toFixed(4);
        if (fill) {
          fill.setAttribute('data-w', w);
          fill.style.setProperty('--bar-scale', w);
        }
        if (valEl) valEl.textContent = formatCompact(row.tokens);
        if (pctEl) pctEl.textContent = `${(row.share * 100).toFixed(1)}%`;
      }
    }
    return;
  }

  const keyOf = (rowEl) => `${rowEl.dataset.bdKind}:${rowEl.dataset.bdId}`;
  const snapshot = captureListSnapshot(elsBreakdown, '.dash-bd-row', keyOf, '.dash-bd-bar-fill');
  lastBreakdownStructureSig = nextSig;

  withPreservedFocus(elsBreakdown, '.dash-bd-row[data-bd-kind]', keyOf, () => {
    elsBreakdown.innerHTML = groups.map((g) => {
      const html = g.rows.map((row) => {
        const pctGrand = (row.share * 100).toFixed(1);
        const color = displayColor(row.color);
        const motionKey = `${g.titleKey}:${encodeURIComponent(row.id)}`;
        const iconHtml = row.iconClass
          ? `<span class="dash-bd-icon row-icon ${escapeHtml(row.iconClass)}" aria-hidden="true"></span>`
          : `<span class="dash-bd-swatch" data-c="${color}"></span>`;
        return `<div class="dash-bd-row" data-bd-kind="${g.kind}" data-bd-id="${escapeHtml(row.id)}" tabindex="0" role="button">`
          + `<span class="dash-bd-name">${iconHtml}<span class="dash-bd-name-text">${escapeHtml(row.label)}</span></span>`
          + `<div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-motion-key="${motionKey}" data-w="${row.relWidth.toFixed(4)}" data-c="${color}"></div></div>`
          + `<span class="dash-bd-val">${escapeHtml(formatCompact(row.tokens))}</span>`
          + `<span class="dash-bd-pct">${pctGrand}%</span>`
          + `</div>`;
      }).join('');
      return `<div class="dash-breakdown-group"><div class="dash-breakdown-title" data-i18n="${g.titleKey}">${escapeHtml(t(g.titleKey))}</div>${html}</div>`;
    }).join('');
    applySwatchColors(elsBreakdown);
  });
  animateListSnapshot(elsBreakdown, '.dash-bd-row', keyOf, '.dash-bd-bar-fill', snapshot);
}

function captureListSnapshot(container, rowSelector, keyFn, barSelector) {
  const rowTops = new Map();
  const barScales = new Map();
  if (!container) return { scrollTop: 0, rowTops, barScales };
  container.querySelectorAll(rowSelector).forEach((row) => {
    const key = keyFn(row);
    if (!key) return;
    const rect = row.getBoundingClientRect();
    if (rect.height > 0) rowTops.set(key, rect.top);
    if (barSelector) {
      const fill = row.querySelector(barSelector);
      const trackWidth = fill?.parentElement?.getBoundingClientRect().width || 0;
      const fillWidth = fill?.getBoundingClientRect().width || 0;
      const fallback = Number(fill?.dataset?.w || 0);
      barScales.set(key, trackWidth > 0 ? Math.max(0, Math.min(1, fillWidth / trackWidth)) : fallback);
    }
  });
  return { scrollTop: container.scrollTop || 0, rowTops, barScales };
}

function animateListSnapshot(container, rowSelector, keyFn, barSelector, snapshot, { staggerMs = 8 } = {}) {
  if (!container || prefersReducedMotion() || document.hidden || state.motion === 'none') return;
  let enterIndex = 0;
  container.querySelectorAll(rowSelector).forEach((row) => {
    const key = keyFn(row);
    const oldTop = key ? snapshot?.rowTops?.get(key) : undefined;
    if (oldTop !== undefined) {
      const dy = oldTop - row.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) {
        row.animate?.(
          [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
          { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
        );
      }
    } else {
      row.animate?.(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 160, delay: Math.min(enterIndex++, 6) * staggerMs, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
      );
    }
    if (barSelector) {
      const fill = row.querySelector(barSelector);
      const targetScale = Number(fill?.dataset?.w || 0);
      const fromScale = state.motion === 'entry' ? 0 : (snapshot?.barScales?.get(key) ?? 0);
      if (fill && Math.abs(targetScale - fromScale) >= 0.002) {
        for (const anim of fill.getAnimations?.() || []) anim.cancel();
        fill.animate?.(
          [{ transform: `scaleX(${fromScale})` }, { transform: `scaleX(${targetScale})` }],
          { duration: DATA_MOTION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
        );
      }
    }
  });
}

let statCardMeasureCanvas = null;

function canvasFontFor(node) {
  const style = window.getComputedStyle(node);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function transformedText(node) {
  const metricNode = node?.matches?.('[data-metric-text]') ? node : node?.querySelector?.('[data-metric-text]');
  const readingEl = node?.querySelector?.('.token-number-reading');
  const text = metricNode?.dataset?.metricText ?? readingEl?.textContent ?? node?.textContent ?? '';
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

function setDeviceMenuOpen(nextOpen) {
  state.deviceMenuOpen = Boolean(nextOpen);
  if (!els.deviceScope || !els.deviceMenu || !els.deviceTrigger) return;
  els.deviceScope.classList.toggle('is-open', state.deviceMenuOpen);
  els.deviceTrigger.setAttribute('aria-expanded', String(state.deviceMenuOpen));
  els.deviceMenu.setAttribute('aria-hidden', String(!state.deviceMenuOpen));

  if (state.deviceMenuOpen) {
    const triggerRect = els.deviceTrigger.getBoundingClientRect?.();
    if (triggerRect) {
      els.deviceMenu.style.left = `${Math.round(triggerRect.left)}px`;
      els.deviceMenu.style.top = `${Math.round(triggerRect.bottom + 6)}px`;
    }
    if (typeof els.deviceMenu.showPopover === 'function' && !els.deviceMenu.matches?.(':popover-open')) {
      try { els.deviceMenu.showPopover(); } catch (_) {}
    }
  } else if (typeof els.deviceMenu.hidePopover === 'function' && els.deviceMenu.matches?.(':popover-open')) {
    try { els.deviceMenu.hidePopover(); } catch (_) {}
  }
}

function renderDeviceSelector(fleet) {
  if (!els.deviceScope || !els.deviceTrigger || !els.deviceMenu || !fleet) return;
  const machines = fleet.machines || [];
  if (machines.length === 0) {
    state.selectedDeviceId = 'all';
    els.deviceScope.classList.add('hidden');
    setDeviceMenuOpen(false);
    return;
  }
  els.deviceScope.classList.remove('hidden');

  if (!fleet.isFleetMode) {
    state.selectedDeviceId = 'all';
    setDeviceMenuOpen(false);
    const m = machines[0];
    els.deviceTrigger.innerHTML = `<span class="device-kind-icon device-kind-${escapeHtml(m.deviceKind)}" aria-hidden="true"></span>`
      + `<span class="dash-device-trigger-label">${escapeHtml(m.name)}</span>`;
    els.deviceTrigger.onclick = () => openDrawer({ kind: 'machine', machine: m });
    return;
  }

  const active = machines.find((m) => m.deviceId === state.selectedDeviceId) || null;
  if (!active && state.selectedDeviceId !== 'all') {
    state.selectedDeviceId = 'all';
  }
  const triggerLabel = active
    ? `${active.name}${active.share > 0 ? ` · ${Math.round(active.share * 100)}%` : ''}`
    : `${t('dashboard.fleet.all')} · ${fleet.fleetTotals.onlineCount}/${machines.length}`;
  const triggerIconHtml = active
    ? `<span class="device-kind-icon device-kind-${escapeHtml(active.deviceKind)}" aria-hidden="true"></span>`
    : '';

  els.deviceTrigger.innerHTML = `${triggerIconHtml}`
    + `<span class="dash-device-trigger-label">${escapeHtml(triggerLabel)}</span>`
    + `<span class="dash-device-trigger-chevron" aria-hidden="true"></span>`;

  els.deviceTrigger.onclick = (ev) => {
    ev.stopPropagation();
    if (!state.deviceMenuOpen) renderDeviceMenu(fleet);
    setDeviceMenuOpen(!state.deviceMenuOpen);
    if (state.deviceMenuOpen && ev.detail === 0) els.deviceMenu.querySelector('[aria-checked="true"]')?.focus();
  };

  if (state.deviceMenuOpen) renderDeviceMenu(fleet);
}

function renderDeviceMenu(fleet) {
  const machines = fleet.machines;
  const allSelected = state.selectedDeviceId === 'all';
  const allItem = `<button type="button" class="dash-device-menu-item is-all${allSelected ? ' is-selected' : ''}" data-device="all" data-key="all" role="menuitemradio" aria-checked="${allSelected}">`
    + `<span class="dash-device-menu-meta"><span class="dash-device-menu-name">${escapeHtml(t('dashboard.fleet.all'))}</span><span class="dash-device-menu-sub">${escapeHtml(t('dashboard.fleet.machineCount', { count: machines.length }))}</span></span>`
    + `<span class="dash-device-menu-val">${escapeHtml(formatCompact(fleet.fleetTotals.tokens))}</span>`
    + `<span class="dash-device-menu-share">100%</span>`
    + `</button>`;

  const machineItems = machines.map((m) => {
    const selected = state.selectedDeviceId === m.deviceId;
    const subParts = [];
    if (m.isLocal) subParts.push(t('dashboard.devices.you'));
    if (m.liveTokPerSec > 0) subParts.push(`${Math.round(m.liveTokPerSec)} tok/s`);
    else if (m.activeWorkspace) subParts.push(m.activeWorkspace);
    else if (m.platformLabel) subParts.push(m.platformLabel);
    const pct = fleet.fleetTotals.tokens > 0 ? `${Math.round(m.share * 100)}%` : '—';
    return `<button type="button" class="dash-device-menu-item${selected ? ' is-selected' : ''}" data-device="${escapeHtml(m.deviceId)}" data-key="${escapeHtml(m.deviceId)}" role="menuitemradio" aria-checked="${selected}">`
      + `<span class="device-kind-icon device-kind-${escapeHtml(m.deviceKind)}" aria-hidden="true"></span>`
      + `<span class="dash-device-menu-meta"><span class="dash-device-menu-name">${escapeHtml(m.name)}</span><span class="dash-device-menu-sub">${escapeHtml(subParts.join(' · ') || '—')}</span></span>`
      + `<span class="dash-device-menu-val">${escapeHtml(formatCompact(m.tokens))}</span>`
      + `<span class="dash-device-menu-share">${escapeHtml(pct)}</span>`
      + `</button>`;
  }).join('');

  patchDashboardMarkup(els.deviceMenu, `${allItem}<div class="dash-device-menu-sep" role="separator"></div>${machineItems}`);
}

function animateMetricText(el, nextText, { value = null, format = null, period = false, whole = false, immediate = false } = {}) {
  if (!el) return;
  const text = String(nextText ?? '');
  const prev = metricTextAnimations.get(el) || { text: '', value: null, settle: null, timer: 0 };
  if (el.dataset) el.dataset.metricText = text;
  if (prev.text === text && !immediate && !prefersReducedMotion() && !document.hidden) {
    prev.value = value;
    return;
  }

  const canAnimate = !immediate
    && numberAnimationApi
    && prev.text
    && prev.text !== text
    && !prefersReducedMotion()
    && !document.hidden;

  if (!canAnimate) {
    clearTimeout(prev.timer);
    prev.settle?.();
    metricTextAnimations.set(el, { text, value, settle: null, timer: 0 });
    el.textContent = text;
    return;
  }

  const mode = numberAnimationApi.normalize(state.settings?.tokenNumberAnimation);
  if (mode === 'none') {
    clearTimeout(prev.timer);
    prev.settle?.();
    metricTextAnimations.set(el, { text, value, settle: null, timer: 0 });
    el.textContent = text;
    return;
  }

  clearTimeout(prev.timer);
  let settle;
  if (mode === 'count' && typeof format === 'function' && Number.isFinite(value) && Number.isFinite(prev.value)) {
    const activeVal = numberAnimationApi.currentCountValue?.(el);
    const fromVal = Number.isFinite(activeVal) ? activeVal : prev.value;
    settle = numberAnimationApi.beginCount(el, fromVal, value, format, { toText: text });
  } else {
    const snapshot = numberAnimationApi.capture?.(el) || null;
    const increasing = Number.isFinite(value) && Number.isFinite(prev.value) ? value >= prev.value : text >= prev.text;
    settle = numberAnimationApi.beginRoll(el, prev.text, text, increasing, null, snapshot, { period, whole });
  }

  const entry = { text, value, settle, timer: 0 };
  entry.timer = setTimeout(() => {
    if (metricTextAnimations.get(el) !== entry) return;
    entry.settle?.();
    entry.settle = null;
    entry.timer = 0;
  }, numberAnimationApi.duration + 40);
  metricTextAnimations.set(el, entry);
}

function updateHeroTokens(text, value, scopeKey) {
  if (!els.heroTokens) return;
  const previous = lastHeroRender;
  const canAnimate = numberAnimationApi
    && previous.text
    && previous.text !== text
    && !prefersReducedMotion()
    && !document.hidden;
  lastHeroRender = { text, value, scopeKey };
  if (previous.text === text && previous.scopeKey === scopeKey && !prefersReducedMotion() && !document.hidden) return;

  if (!canAnimate) {
    settleHeroNumber?.();
    settleHeroNumber = null;
    els.heroTokens.textContent = text;
    return;
  }

  const mode = numberAnimationApi.normalize(state.settings?.tokenNumberAnimation);
  if (mode === 'none') {
    settleHeroNumber?.();
    settleHeroNumber = null;
    els.heroTokens.textContent = text;
    return;
  }

  clearTimeout(heroSettleTimer);
  let settle;
  if (mode === 'count') {
    const activeVal = numberAnimationApi.currentCountValue?.(els.heroTokens);
    const fromVal = Number.isFinite(activeVal) ? activeVal : previous.value;
    settle = numberAnimationApi.beginCount(els.heroTokens, fromVal, value, formatExactTokens, { toText: text });
  } else {
    const snapshot = numberAnimationApi.capture?.(els.heroTokens) || null;
    settle = numberAnimationApi.beginRoll(
      els.heroTokens,
      previous.text,
      text,
      value >= previous.value,
      null,
      snapshot,
      { period: previous.scopeKey !== scopeKey }
    );
  }
  settleHeroNumber = settle;
  heroSettleTimer = setTimeout(() => {
    if (settleHeroNumber !== settle) return;
    settleHeroNumber?.();
    settleHeroNumber = null;
  }, numberAnimationApi.duration + 40);
}

function renderHero(overview) {
  if (!overview) return;
  const { hero, activeMachine, tools, fleet } = overview;
  const scopeTitle = activeMachine
    ? `${activeMachine.name} · ${t(`dashboard.period.${state.periodKey}`)}`
    : `${fleet?.isFleetMode ? t('dashboard.fleet.all') : (fleet?.machines?.[0]?.name || t('dashboard.fleet.all'))} · ${t(`dashboard.period.${state.periodKey}`)}`;
  if (els.heroScope) els.heroScope.textContent = scopeTitle;

  const activeCount = activeMachine ? activeMachine.activeSessionCount : (fleet?.fleetTotals?.activeSessions || 0);
  if (els.heroActive) {
    if (activeCount > 0) {
      els.heroActive.classList.remove('hidden');
      els.heroActive.textContent = t('dashboard.fleet.activeAgents', { count: activeCount });
    } else {
      els.heroActive.classList.add('hidden');
      els.heroActive.textContent = '';
    }
  }

  const prevScopeKey = lastHeroRender.scopeKey;
  const scopeKey = `${state.selectedDeviceId}:${state.periodKey}`;
  const scopeChanged = Boolean(prevScopeKey && prevScopeKey !== scopeKey);
  const exactTokens = formatExactTokens(hero.tokens);
  updateHeroTokens(exactTokens, hero.tokens, scopeKey);

  if (els.heroApprox) {
    if (hero.tokens >= 1000) {
      els.heroApprox.classList.remove('hidden');
      els.heroApprox.textContent = `≈ ${formatCompact(hero.tokens)} ${t('dashboard.hero.tokens')}`;
    } else {
      els.heroApprox.classList.add('hidden');
      els.heroApprox.textContent = '';
    }
  }

  if (els.heroCost) {
    animateMetricText(els.heroCost, formatCost(hero.cost, hero.unpricedTokens), {
      value: hero.cost,
      period: scopeChanged,
      whole: hero.unpricedTokens > 0 && !(hero.cost > 0)
    });
  }
  const hasCacheHit = hero.cacheHitRate != null;
  if (els.heroCache) {
    els.heroCache.textContent = hasCacheHit ? `${Math.round(hero.cacheHitRate * 100)}%` : '—';
  }
  els.heroCacheSep?.classList.toggle('hidden', !hasCacheHit);
  els.heroCacheItem?.classList.toggle('hidden', !hasCacheHit);

  if (els.heroRibbon) {
    const visibleTools = (tools || []).filter((tRow) => tRow.tokens > 0).slice(0, 8);
    const existingSegs = Array.from(els.heroRibbon.children);
    const sameOrder = existingSegs.length === visibleTools.length
      && visibleTools.every((tRow, idx) => existingSegs[idx]?.dataset?.tipId === tRow.id);
    if (sameOrder && visibleTools.length > 0) {
      visibleTools.forEach((tRow, idx) => {
        const seg = existingSegs[idx];
        const w = String(Math.max(1, Math.round(tRow.share * 1000)));
        const c = displayColor(tRow.color);
        const val = formatCompact(tRow.tokens);
        seg.setAttribute('data-weight', w);
        seg.setAttribute('data-c', c);
        seg.setAttribute('data-tip-name', tRow.label);
        seg.setAttribute('data-tip-val', val);
        seg.setAttribute('aria-label', `${tRow.label}: ${val}`);
        seg.style.setProperty('--seg-weight', w);
        seg.style.background = c;
      });
    } else {
      els.heroRibbon.innerHTML = visibleTools.map((tRow) =>
        `<span class="dash-ribbon-seg" data-weight="${Math.max(1, Math.round(tRow.share * 1000))}" data-c="${displayColor(tRow.color)}" data-tip-id="${escapeHtml(tRow.id)}" data-tip-name="${escapeHtml(tRow.label)}" data-tip-val="${escapeHtml(formatCompact(tRow.tokens))}" aria-label="${escapeHtml(tRow.label)}: ${escapeHtml(formatCompact(tRow.tokens))}"></span>`
      ).join('');
      applySwatchColors(els.heroRibbon);
    }
  }

  if (els.heroAnatomy) {
    const segments = hero.anatomy?.segments || [];
    const existingItems = Array.from(els.heroAnatomy.children);
    const sameKinds = existingItems.length === segments.length
      && segments.every((seg, idx) => existingItems[idx]?.dataset?.kind === seg.key);
    if (sameKinds && segments.length > 0) {
      segments.forEach((seg, idx) => {
        const item = existingItems[idx];
        const labelEl = item.querySelector('.dash-anatomy-label');
        const strongEl = item.querySelector('strong');
        const pctEl = item.querySelector('.dash-anatomy-pct');
        if (labelEl) labelEl.textContent = t(seg.labelKey);
        if (strongEl) strongEl.textContent = formatCompact(seg.tokens);
        if (pctEl) pctEl.textContent = `(${(seg.share * 100).toFixed(0)}%)`;
      });
    } else {
      els.heroAnatomy.innerHTML = segments.map((seg) =>
        `<span class="dash-anatomy-item" data-kind="${escapeHtml(seg.key)}">`
        + `<span class="dash-anatomy-dot kind-${escapeHtml(seg.key)}" aria-hidden="true"></span>`
        + `<span class="dash-anatomy-label">${escapeHtml(t(seg.labelKey))}</span>`
        + `<strong>${escapeHtml(formatCompact(seg.tokens))}</strong>`
        + `<span class="dash-anatomy-pct">(${(seg.share * 100).toFixed(0)}%)</span>`
        + `</span>`
      ).join('');
    }
  }
}

function renderVelocity(overview) {
  const vel = overview?.velocity;
  if (!els.velocity || !vel) return;
  const burn = vel.rateMode === 'burn';
  const live = vel.hasSample && !vel.idle;
  const primaryUnit = t(burn ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit') || (burn ? 'TPM' : 'tok/s');
  const otherUnit = t(burn ? 'edgeDock.rate.speedUnit' : 'edgeDock.rate.burnUnit') || (burn ? 'tok/s' : 'TPM');

  if (els.velocityStatus) {
    els.velocityStatus.classList.toggle('is-live', live);
    els.velocityStatus.classList.toggle('is-idle', !live);
  }
  if (els.velocityStatusText) {
    els.velocityStatusText.textContent = !vel.hasSample
      ? t('dashboard.velocity.noSample')
      : live ? t('dashboard.velocity.live') : t('dashboard.velocity.idle');
  }
  if (els.velocityOverview) {
    els.velocityOverview.classList.toggle('is-idle', !live);
  }
  if (els.velocityValue) {
    animateMetricText(els.velocityValue, vel.hasSample ? formatRate(vel.primaryValue) : '—', {
      value: vel.hasSample ? vel.primaryValue : null,
      format: vel.hasSample ? formatRate : null,
      whole: !vel.hasSample
    });
  }
  if (els.velocityUnit) els.velocityUnit.textContent = primaryUnit;
  if (els.velocitySecondary) {
    els.velocitySecondary.textContent = vel.hasSample && vel.secondaryValue != null
      ? `≈ ${formatRate(vel.secondaryValue)} ${otherUnit}`
      : '—';
  }

  if (els.velocitySpark) {
    let svg = els.velocitySpark.querySelector('svg.dash-vel-svg');
    if (!svg) {
      els.velocitySpark.innerHTML = `<svg class="dash-vel-svg" viewBox="-3 0 150 64" preserveAspectRatio="none" aria-hidden="true">`
        + `<defs><linearGradient id="dashVelGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="dash-velocity-stop-a"></stop><stop offset="100%" class="dash-velocity-stop-b"></stop></linearGradient></defs>`
        + `<path class="dash-velocity-baseline" d="M0 59H144"></path>`
        + `<path class="dash-velocity-area" fill="url(#dashVelGrad)" d=""></path>`
        + `<path class="dash-velocity-line" d=""></path>`
        + `<circle class="dash-velocity-endpoint-halo" cx="-99" cy="-99" r="5" opacity="0"></circle>`
        + `<circle class="dash-velocity-endpoint" cx="-99" cy="-99" r="2.3" opacity="0"></circle>`
        + `</svg>`;
      svg = els.velocitySpark.querySelector('svg.dash-vel-svg');
    }
    const pts = vel.points || [];
    const lineD = pts.length > 1
      ? pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
      : '';
    const lastPt = pts.at(-1);
    const areaD = lineD && lastPt
      ? `${lineD} L${lastPt.x.toFixed(2)},59 L${pts[0].x.toFixed(2)},59 Z`
      : '';
    const areaEl = svg?.querySelector('.dash-velocity-area');
    const lineEl = svg?.querySelector('.dash-velocity-line');
    const haloEl = svg?.querySelector('.dash-velocity-endpoint-halo');
    const dotEl = svg?.querySelector('.dash-velocity-endpoint');
    areaEl?.setAttribute('d', areaD);
    lineEl?.setAttribute('d', lineD);
    if (lastPt) {
      const cx = lastPt.x.toFixed(2);
      const cy = lastPt.y.toFixed(2);
      dotEl?.setAttribute('cx', cx);
      dotEl?.setAttribute('cy', cy);
      dotEl?.setAttribute('opacity', '1');
      if (live) {
        haloEl?.setAttribute('cx', cx);
        haloEl?.setAttribute('cy', cy);
        haloEl?.setAttribute('opacity', '0.25');
      } else {
        haloEl?.setAttribute('opacity', '0');
      }
    } else {
      dotEl?.setAttribute('opacity', '0');
      haloEl?.setAttribute('opacity', '0');
    }
  }

  if (els.velocityModels) {
    const models = (vel.models || []).slice(0, 3);
    els.velocityModels.innerHTML = models.map((m) => {
      const color = displayColor(m.color);
      const iconHtml = m.iconClass
        ? `<span class="row-icon ${escapeHtml(m.iconClass)}" aria-hidden="true"></span>`
        : `<span class="dash-bd-swatch" data-c="${color}"></span>`;
      return `<div class="dash-velocity-model">`
        + iconHtml
        + `<span class="dash-velocity-model-name">${escapeHtml(m.id)}</span>`
        + `<span class="dash-velocity-model-val">${escapeHtml(`${formatRate(m.value)} ${primaryUnit}`)}</span>`
        + `</div>`;
    }).join('');
    applySwatchColors(els.velocityModels);
  }
}

function formatQuotaWindowLabel(win, providerId = '', visibleWindows = []) {
  const label = String(win?.label || '').trim();
  if (providerId === 'antigravity') {
    return label.replace(/\bweekly$/i, 'Weekly');
  }
  if (providerId === 'zai' && win?.kind === 'daily' && label) return label;
  if (win?.kind === 'billing') {
    if (providerId === 'cursor' && label === 'Included usage') return t('home.limit.monthly');
    if (label) return label;
  }
  const periodKey = {
    session: 'home.limit.session',
    daily: 'home.limit.daily',
    weekly: 'home.limit.weekly',
    billing: 'home.limit.billing',
    monthly: 'home.limit.monthly'
  }[win?.kind];
  if (!periodKey) return label;
  const period = t(periodKey);
  const generic = ['', 'session', '5-hour', '5h', 'daily', 'weekly', 'monthly', 'billing', period.toLowerCase()];
  const named = !generic.includes(label.toLowerCase());
  const sharesPeriod = visibleWindows.some((candidate) => candidate !== win && candidate?.kind === win.kind);
  return named && sharesPeriod ? `${label} ${period}` : period;
}

function quotaWindowFlags(win, { vendorColors, highlightLow }) {
  const remaining = win.remainingPercent;
  const clamped = remaining == null ? null : Math.max(0, Math.min(100, remaining));
  const isExhausted = highlightLow && clamped === 0;
  const isCritical = highlightLow && vendorColors && clamped != null && clamped > 0 && clamped < 20;
  const isLow = highlightLow && !vendorColors && clamped != null && clamped > 0 && clamped < 20;
  const isValueLow = highlightLow && vendorColors && clamped != null && clamped >= 20 && clamped < 50;
  const isUntouched = Boolean(win.untouched && !win.isCredits);
  return { isExhausted, isCritical, isLow, isValueLow, isUntouched };
}

function quotaMotionKey(acc, labelText) {
  return JSON.stringify([acc?.key ?? '', acc?.name ?? '', labelText ?? '']);
}

function formatQuotaWindowReading(win, shownPct) {
  if (win?.planStatus === 'expired') return t('limits.mimo.planExpired');
  if (String(win?.detail || '').toLowerCase() === 'unlimited') return t('settings.thirdparty.unlimited');
  if (win?.value) return win.value;
  if (win?.isCredits) return win.creditsText || win.detail || '—';
  if (win?.remainingPercent == null) return win?.detail || '—';
  return `${shownPct}%`;
}

function renderQuotas(overview) {
  if (!els.quotas) return;
  const accounts = overview?.quotas || [];
  const prevScrollTop = els.quotas.scrollTop || 0;
  const motionSnapshot = homeLimitMotion ? homeLimitMotion.capture(els.quotas) : null;
  const showUsed = Boolean(state.settings?.showLimitUsed);
  // Dashboard Quotas always reflect provider brand identity alongside status highlights,
  // matching Hero, Live Neural Flow, and Attribution regardless of Home's monochrome setting.
  const vendorColors = true;
  const highlightLow = true;

  if (els.quotasCount) {
    els.quotasCount.textContent = accounts.length
      ? t(showUsed ? 'settings.limits.barsUsed' : 'settings.limits.barsRemaining')
      : '';
  }

  if (accounts.length === 0) {
    lastQuotasStructureSig = '';
    els.quotas.innerHTML = `<div class="dash-quotas-empty">${escapeHtml(t('dashboard.quotas.empty'))}</div>`;
    return;
  }

  const nextSig = JSON.stringify([
    state.locale,
    vendorColors,
    highlightLow,
    accounts.map((acc) => [
      acc.key,
      acc.name,
      acc.plan,
      acc.iconClass,
      displayColor(acc.color || charts.clientColors[acc.providerId] || '#6ab4f0'),
      Math.max(0, Number(acc.resetCount || 0)),
      (acc.windows || []).map((w) => [
        formatQuotaWindowLabel(w, acc.providerId, acc.windows),
        Boolean(w.pacePercent != null),
        Boolean(w.isCredits),
        Boolean(w.showMeter !== false && w.remainingPercent != null),
        Boolean(!w.isCredits && !w.value && w.planStatus !== 'expired' && w.remainingPercent != null),
        String(w.planStatus || '')
      ])
    ])
  ]);

  if (nextSig === lastQuotasStructureSig) {
    const rowByKey = new Map();
    els.quotas.querySelectorAll('.home-limit-window[data-limit-motion-key]').forEach((row) => {
      rowByKey.set(row.dataset.limitMotionKey, row);
    });
    for (const acc of accounts) {
      const accColor = displayColor(acc.color || charts.clientColors[acc.providerId] || '#6ab4f0');
      for (const win of acc.windows || []) {
        const labelText = formatQuotaWindowLabel(win, acc.providerId, acc.windows);
        const motionKey = quotaMotionKey(acc, labelText);
        const row = rowByKey.get(motionKey);
        if (!row) continue;
        const resetShort = formatResetShort(win.resetsAt);
        const hasMeter = win.showMeter !== false && win.remainingPercent != null;
        const isPercent = !win.isCredits && !win.value && win.planStatus !== 'expired' && win.remainingPercent != null;
        const shownPct = win.remainingPercent != null
          ? (win.showUsed ? Math.round(100 - win.remainingPercent) : Math.round(win.remainingPercent))
          : 0;
        const readingText = formatQuotaWindowReading(win, shownPct);
        const flags = quotaWindowFlags(win, { vendorColors, highlightLow });

        row.classList.toggle('is-low', flags.isLow);
        row.classList.toggle('is-critical', flags.isCritical);
        row.classList.toggle('is-exhausted', flags.isExhausted);
        row.classList.toggle('is-untouched', flags.isUntouched);
        if (win.remainingPercent != null) row.setAttribute('data-limit-remaining-percent', String(win.remainingPercent));
        else row.removeAttribute('data-limit-remaining-percent');
        if (win.resetsAt) row.setAttribute('data-limit-reset-at', String(win.resetsAt));
        else row.removeAttribute('data-limit-reset-at');

        const resetEl = row.querySelector('.home-limit-reset');
        if (resetEl) resetEl.textContent = resetShort;

        const track = row.querySelector('.home-limit-track');
        if (track && hasMeter) {
          track.setAttribute('data-limit-fill', win.fillPercent.toFixed(1));
          if (win.pacePercent != null) track.setAttribute('data-limit-pace', win.pacePercent.toFixed(1));
          else {
            track.removeAttribute('data-limit-pace');
            track.style.removeProperty('--home-limit-pace');
          }
          if (!flags.isExhausted) {
            track.setAttribute('data-limit-color', accColor);
          } else {
            track.removeAttribute('data-limit-color');
            track.style.removeProperty('--home-limit-bar');
            track.style.removeProperty('--home-limit-tail');
          }
        }

        const valEl = row.querySelector('.home-list-value');
        if (valEl) {
          valEl.classList.toggle('home-limit-value-critical', flags.isExhausted || flags.isCritical);
          valEl.classList.toggle('home-limit-value-low', flags.isLow || flags.isValueLow);
          if (flags.isValueLow) valEl.setAttribute('data-limit-accent', accColor);
          else {
            valEl.removeAttribute('data-limit-accent');
            valEl.style.removeProperty('--home-limit-accent');
          }
          if (isPercent) {
            valEl.setAttribute('data-limit-motion-value', String(shownPct));
            valEl.setAttribute('data-limit-motion-text', readingText);
          } else {
            valEl.removeAttribute('data-limit-motion-value');
            valEl.removeAttribute('data-limit-motion-text');
          }
          valEl.textContent = readingText;
        }
      }
    }
    applySwatchColors(els.quotas);
    if (homeLimitMotion) {
      homeLimitMotion.animate(els.quotas, motionSnapshot, { entry: state.motion === 'entry' });
    }
    return;
  }

  const isFirstMount = !lastQuotasStructureSig;
  lastQuotasStructureSig = nextSig;

  els.quotas.innerHTML = accounts.map((acc) => {
    const accColor = displayColor(acc.color || charts.clientColors[acc.providerId] || '#6ab4f0');
    const iconHtml = acc.iconClass
      ? `<span class="${escapeHtml(acc.iconClass)}" aria-hidden="true"></span>`
      : `<span class="home-list-mark" data-c="${accColor}" aria-hidden="true"></span>`;
    const resetsCount = Math.max(0, Number(acc.resetCount || 0));
    const accountDisplayName = escapeHtml(acc.name || acc.providerId);
    const titleHtml = resetsCount > 0
      ? `<span class="home-limit-account-title"><span class="home-list-name">${accountDisplayName}</span><span class="home-limit-resets" role="img" aria-label="${escapeHtml(t('home.limitResets', { count: resetsCount }))}"><span class="home-limit-resets-icon" aria-hidden="true"></span><span class="home-limit-resets-count">${resetsCount}</span></span></span>`
      : `<span class="home-list-name">${accountDisplayName}</span>`;
    const planHtml = acc.plan
      ? `<span class="home-limit-plan" aria-label="${escapeHtml(acc.plan)}">${escapeHtml(acc.plan)}</span>`
      : '';

    const windowsHtml = (acc.windows || []).map((win) => {
      const labelText = formatQuotaWindowLabel(win, acc.providerId, acc.windows);
      const resetShort = formatResetShort(win.resetsAt);
      const hasMeter = win.showMeter !== false && win.remainingPercent != null;
      const isPercent = !win.isCredits && !win.value && win.planStatus !== 'expired' && win.remainingPercent != null;
      const shownPct = win.remainingPercent != null
        ? (win.showUsed ? Math.round(100 - win.remainingPercent) : Math.round(win.remainingPercent))
        : 0;
      const readingText = formatQuotaWindowReading(win, shownPct);
      const flags = quotaWindowFlags(win, { vendorColors, highlightLow });
      const rowClasses = [
        'home-limit-window',
        flags.isLow ? 'is-low' : '',
        flags.isCritical ? 'is-critical' : '',
        flags.isExhausted ? 'is-exhausted' : '',
        flags.isUntouched ? 'is-untouched' : ''
      ].filter(Boolean).join(' ');
      const motionKey = quotaMotionKey(acc, labelText);
      const paceHtml = win.pacePercent != null
        ? `<span class="home-limit-pace" aria-hidden="true"></span>`
        : '';
      const trackAttrs = [
        'class="home-limit-track' + (win.pacePercent != null ? ' has-pace' : '') + '"',
        `data-limit-fill="${win.fillPercent.toFixed(1)}"`,
        win.pacePercent != null ? `data-limit-pace="${win.pacePercent.toFixed(1)}"` : '',
        !flags.isExhausted ? `data-limit-color="${accColor}"` : ''
      ].filter(Boolean).join(' ');
      const trackHtml = hasMeter
        ? `<div ${trackAttrs}><div class="home-limit-meter" aria-hidden="true"><span class="home-limit-ghost"></span><span class="home-limit-fill"></span></div><span class="home-limit-tip" aria-hidden="true"></span>${paceHtml}</div>`
        : '';
      const valClasses = [
        'home-list-value',
        (flags.isExhausted || flags.isCritical) ? 'home-limit-value-critical' : '',
        (flags.isLow || flags.isValueLow) ? 'home-limit-value-low' : ''
      ].filter(Boolean).join(' ');
      const readingAttrs = [
        `class="${valClasses}"`,
        flags.isValueLow ? `data-limit-accent="${accColor}"` : '',
        isPercent ? `data-limit-motion-value="${shownPct}" data-limit-motion-text="${escapeHtml(readingText)}"` : ''
      ].filter(Boolean).join(' ');

      return `<div class="${rowClasses}" data-limit-motion-key="${escapeHtml(motionKey)}"${win.remainingPercent != null ? ` data-limit-remaining-percent="${win.remainingPercent}"` : ''}${win.resetsAt ? ` data-limit-reset-at="${escapeHtml(win.resetsAt)}"` : ''}>`
        + `<span class="home-limit-window-label">${escapeHtml(labelText)}</span>`
        + `<span class="home-limit-reset">${escapeHtml(resetShort)}</span>`
        + trackHtml
        + `<span ${readingAttrs}>${escapeHtml(readingText)}</span>`
        + `</div>`;
    }).join('');

    return `<div class="home-limit-account" data-vendor-color="${escapeHtml(accColor)}">`
      + `<div class="home-limit-account-head">${iconHtml}${titleHtml}${planHtml}</div>`
      + `<div class="home-limit-windows">${windowsHtml}</div>`
      + `</div>`;
  }).join('');

  applySwatchColors(els.quotas);
  if (prevScrollTop > 0) els.quotas.scrollTop = prevScrollTop;
  if (homeLimitMotion) {
    homeLimitMotion.animate(els.quotas, motionSnapshot, { entry: state.motion === 'entry' || isFirstMount });
  }
}

function sessionGroupBadgeLabel(s) {
  if (!s) return '';
  if (s.subagentCount > 0) return t('sessions.subagentCount', { count: s.subagentCount });
  if (s.groupKind === 'background-review' && s.groupCount > 0) {
    return t('sessions.backgroundReviewCount', { count: s.groupCount });
  }
  if (s.groupKind === 'grok-bot' && s.groupCount > 0) {
    return t('sessions.grokBotCount', { count: s.groupCount });
  }
  return '';
}

function topologyEndpointSubText(ep, isSessionMode) {
  if (!isSessionMode) return ep.latestModel && ep.latestModel !== ep.title ? ep.latestModel : (ep.clientLabel || '');
  const countLabel = sessionGroupBadgeLabel(ep);
  const rawModel = ep.modelLabel || ep.latestModel;
  const modelOrClient = (ep.groupKind === 'background-review' || ep.groupKind === 'grok-bot')
    ? (rawModel && rawModel !== ep.title ? rawModel : '')
    : (rawModel && rawModel !== ep.title ? rawModel : (ep.clientLabel || ''));
  return [modelOrClient, countLabel].filter(Boolean).join(' · ');
}

function sessionStateIconHtml(activityState) {
  if (!sessionLiveApi?.sessionStateMarkup) return '';
  return `<span class="home-session-state" data-state="${escapeHtml(activityState)}">`
    + sessionLiveApi.sessionStateMarkup({
      spin: 'home-session-spin',
      check: 'home-session-check',
      idle: 'home-session-idle',
      waiting: 'home-session-waiting'
    })
    + `</span>`;
}

function sessionRowParts(s, overview) {
  const showDevice = overview?.fleet?.isFleetMode && state.selectedDeviceId === 'all';
  const metaParts = [];
  if (showDevice && (s.deviceName || s.sourceDevice?.name)) {
    const devIcon = s.deviceKind
      ? `<span class="dash-session-dev-icon device-kind-icon device-kind-${escapeHtml(s.deviceKind)}" aria-hidden="true"></span>`
      : '';
    metaParts.push(`${devIcon}<span>${escapeHtml(s.deviceName || s.sourceDevice?.name)}</span>`);
  }
  if (s.projectLabel) metaParts.push(`<span>${escapeHtml(s.projectLabel)}</span>`);
  const modelText = s.modelLabel || s.latestModel;
  if (modelText) metaParts.push(`<span>${escapeHtml(modelText)}</span>`);

  const subExtras = [];
  const groupBadge = sessionGroupBadgeLabel(s);
  if (groupBadge) {
    subExtras.push(`<span class="dash-session-badge">${escapeHtml(groupBadge)}</span>`);
  }
  if (s.context) {
    const toneAttr = s.context.tone ? ` data-tone="${escapeHtml(s.context.tone)}"` : '';
    const scale = Math.max(0, Math.min(1, Number(s.context.displayPercent || 0) / 100)).toFixed(3);
    subExtras.push(
      `<span class="home-session-context"${toneAttr}>`
      + `<span class="home-session-context-meter"><span class="home-session-context-fill" data-w="${scale}"></span></span>`
      + `<span class="home-session-context-value">${s.context.displayPercent}%</span>`
      + `</span>`
    );
  } else if (s.promptCache) {
    subExtras.push(`<span class="dash-session-badge is-warm">${escapeHtml(t('session.cacheEstimate', { minutes: s.promptCache.minutes }))}</span>`);
  }

  return {
    joinedMeta: metaParts.join('<span class="dash-meta-dot" aria-hidden="true">·</span>'),
    subExtrasHtml: subExtras.join('')
  };
}

function renderSessionRowsHtml(list, overview) {
  return list.slice(0, 12).map((s) => {
    const iconHtml = s.iconClass
      ? `<span class="dash-session-brand row-icon ${escapeHtml(s.iconClass)}" aria-hidden="true"></span>`
      : `<span class="dash-bd-swatch" data-c="${displayColor(s.color)}"></span>`;
    const stateHtml = sessionStateIconHtml(s.activityState);
    const { joinedMeta, subExtrasHtml } = sessionRowParts(s, overview);
    return `<div class="dash-session-row state-${escapeHtml(s.activityState)}" data-session-key="${escapeHtml(s.key)}" tabindex="0" role="button">`
      + `<span class="dash-session-lead">${iconHtml}${stateHtml}</span>`
      + `<div class="dash-session-body">`
      + `<div class="dash-session-title"><span class="dash-session-title-text">${escapeHtml(s.title)}</span></div>`
      + `<div class="dash-session-sub"><span class="dash-session-meta-text">${joinedMeta}</span>${subExtrasHtml}</div>`
      + `</div>`
      + `<div class="dash-session-metrics">`
      + `<span class="dash-row-tokens">${escapeHtml(formatCompact(s.totalTokens))}</span>`
      + `<span class="dash-row-cost">${escapeHtml(formatCost(s.costUsd, s.unpricedTokens))}</span>`
      + `</div>`
      + `</div>`;
  }).join('');
}

function renderWorkPanel(overview) {
  if (!els.workPanel) return;
  const allSessions = overview?.sessions || [];
  const runningSessions = allSessions.filter((s) => s.activityState === 'running' || s.activityState === 'waiting');

  const titleKey = state.workMode === 'devices'
    ? 'dashboard.work.devices'
    : (state.workMode === 'workspaces' ? 'dashboard.work.workspaces' : 'dashboard.work.sessions');
  if (els.workTitle) els.workTitle.textContent = t(titleKey);

  if (els.workSummary) {
    if (runningSessions.length > 0) {
      els.workSummary.textContent = t('dashboard.fleet.activeAgents', { count: runningSessions.length });
    } else if (overview?.fleet?.isFleetMode) {
      const online = overview.fleet.fleetTotals?.onlineCount || 0;
      const total = overview.fleet.machines?.length || 0;
      els.workSummary.textContent = `${online}/${total}`;
    } else {
      els.workSummary.textContent = allSessions.length ? `${allSessions.length}` : '';
    }
  }

  if (state.workMode === 'devices') {
    const fleet = overview?.fleet;
    const machines = fleet?.machines || [];
    if (machines.length === 0) {
      lastWorkStructureSig = '';
      els.workPanel.innerHTML = `<div class="dash-quotas-empty">${escapeHtml(t('dashboard.empty'))}</div>`;
      return;
    }
    const nextSig = JSON.stringify(['devices', state.locale, state.selectedDeviceId, machines.map((m) => m.deviceId)]);
    if (nextSig === lastWorkStructureSig) {
      machines.forEach((m) => {
        const row = findByDataset(els.workPanel, '.dash-device-row[data-device-id]', (r) => r.dataset.deviceId === m.deviceId);
        if (!row) return;
        row.classList.toggle('is-selected', state.selectedDeviceId === m.deviceId);
        row.classList.toggle('is-stale', Boolean(m.stale));
        row.classList.toggle('is-running', m.activeSessionCount > 0);
        const subParts = [];
        if (m.activeSessionCount > 0) subParts.push(t('dashboard.fleet.activeAgents', { count: m.activeSessionCount }));
        if (m.liveTokPerSec > 0) subParts.push(`${Math.round(m.liveTokPerSec)} tok/s`);
        if (m.activeWorkspace) subParts.push(m.activeWorkspace);
        else if (m.platformLabel) subParts.push(m.platformLabel);
        const pct = fleet.fleetTotals.tokens > 0 ? `${Math.round(m.share * 100)}%` : '—';
        const relW = Math.max(0.02, Math.min(1, m.share || 0)).toFixed(4);
        const metaEl = row.querySelector('.dash-session-meta-text');
        const fillEl = row.querySelector('.dash-project-bar-fill');
        const tokEl = row.querySelector('.dash-row-tokens');
        const costEl = row.querySelector('.dash-row-cost');
        if (metaEl) metaEl.textContent = subParts.join(' · ') || '—';
        if (fillEl) {
          fillEl.setAttribute('data-w', relW);
          fillEl.style.setProperty('--bar-scale', relW);
        }
        if (tokEl) tokEl.textContent = formatCompact(m.tokens);
        if (costEl) costEl.textContent = pct;
      });
      return;
    }

    const rowKey = (r) => r.dataset.deviceId || r.dataset.wsKey || r.dataset.sessionKey || '';
    const snapshot = captureListSnapshot(els.workPanel, '.dash-device-row, .dash-project-row, .dash-session-row', rowKey, '.dash-project-bar-fill');
    lastWorkStructureSig = nextSig;

    withPreservedFocus(els.workPanel, '.dash-device-row[data-device-id]', (r) => r.dataset.deviceId || '', () => {
      els.workPanel.innerHTML = machines.map((m) => {
        const selected = state.selectedDeviceId === m.deviceId;
        const cls = [
          'dash-device-row',
          selected ? 'is-selected' : '',
          m.stale ? 'is-stale' : '',
          m.activeSessionCount > 0 ? 'is-running' : ''
        ].filter(Boolean).join(' ');
        const subParts = [];
        if (m.activeSessionCount > 0) subParts.push(t('dashboard.fleet.activeAgents', { count: m.activeSessionCount }));
        if (m.liveTokPerSec > 0) subParts.push(`${Math.round(m.liveTokPerSec)} tok/s`);
        if (m.activeWorkspace) subParts.push(m.activeWorkspace);
        else if (m.platformLabel) subParts.push(m.platformLabel);
        const badge = m.isLocal ? `<span class="dash-session-badge">${escapeHtml(t('dashboard.devices.you'))}</span>` : '';
        const pct = fleet.fleetTotals.tokens > 0 ? `${Math.round(m.share * 100)}%` : '—';
        const relW = Math.max(0.02, Math.min(1, m.share || 0)).toFixed(4);
        return `<div class="${cls}" data-device-id="${escapeHtml(m.deviceId)}" tabindex="0" role="button">`
          + `<span class="dash-session-lead"><span class="device-kind-icon device-kind-${escapeHtml(m.deviceKind)}" aria-hidden="true"></span><span class="dash-session-live-ring" aria-hidden="true"></span></span>`
          + `<div class="dash-session-body">`
          + `<div class="dash-session-title"><span class="dash-session-title-text">${escapeHtml(m.name)}</span>${badge}</div>`
          + `<div class="dash-session-sub"><span class="dash-session-meta-text">${escapeHtml(subParts.join(' · ') || '—')}</span></div>`
          + `<div class="dash-project-bar"><div class="dash-project-bar-fill" data-w="${relW}" data-c="var(--accent, #b7ead4)"></div></div>`
          + `</div>`
          + `<div class="dash-session-metrics">`
          + `<span class="dash-row-tokens">${escapeHtml(formatCompact(m.tokens))}</span>`
          + `<span class="dash-row-cost">${escapeHtml(pct)}</span>`
          + `</div>`
          + `</div>`;
      }).join('');
      applySwatchColors(els.workPanel);
    });
    animateListSnapshot(els.workPanel, '.dash-device-row', (r) => r.dataset.deviceId, '.dash-project-bar-fill', snapshot);
    return;
  }

  if (state.workMode === 'workspaces') {
    const workspaces = overview?.workspaces || [];
    if (workspaces.length === 0) {
      lastWorkStructureSig = '';
      els.workPanel.innerHTML = `<div class="dash-quotas-empty">${escapeHtml(t(overview?.sessionsIncomplete ? 'sessions.incomplete' : 'dashboard.work.emptyWorkspaces'))}</div>`;
      return;
    }
    const visibleWs = workspaces.slice(0, 12);
    const nextSig = JSON.stringify(['workspaces', state.locale, visibleWs.map((w) => [w.key, w.activeSessionCount > 0])]);
    if (nextSig === lastWorkStructureSig) {
      const rowMap = new Map();
      els.workPanel.querySelectorAll('.dash-project-row').forEach((r) => rowMap.set(r.dataset.wsKey, r));
      visibleWs.forEach((ws) => {
        const row = rowMap.get(ws.key);
        if (!row) return;
        const clientsLabel = (ws.clients || []).slice(0, 3).join(' · ');
        const devsLabel = (ws.devices || []).slice(0, 2).join(', ');
        const subParts = [devsLabel, clientsLabel].filter(Boolean).join(' · ');
        const metaEl = row.querySelector('.dash-session-meta-text');
        const chipEl = row.querySelector('.dash-live-chip');
        const fillEl = row.querySelector('.dash-project-bar-fill');
        const tokEl = row.querySelector('.dash-row-tokens');
        const costEl = row.querySelector('.dash-row-cost');
        if (metaEl) metaEl.textContent = subParts;
        if (chipEl && ws.activeSessionCount > 0) chipEl.textContent = t('dashboard.fleet.activeAgents', { count: ws.activeSessionCount });
        if (fillEl) {
          const w = ws.relWidth.toFixed(4);
          fillEl.setAttribute('data-w', w);
          fillEl.style.setProperty('--bar-scale', w);
        }
        if (tokEl) tokEl.textContent = formatCompact(ws.tokens);
        if (costEl) costEl.textContent = formatCost(ws.cost, ws.unpricedTokens);
      });
      return;
    }

    const rowKey = (r) => r.dataset.deviceId || r.dataset.wsKey || r.dataset.sessionKey || '';
    const snapshot = captureListSnapshot(els.workPanel, '.dash-device-row, .dash-project-row, .dash-session-row', rowKey, '.dash-project-bar-fill');
    lastWorkStructureSig = nextSig;

    withPreservedFocus(els.workPanel, '.dash-project-row[data-ws-key]', (r) => r.dataset.wsKey || '', () => {
      els.workPanel.innerHTML = visibleWs.map((ws) => {
        const clientsLabel = (ws.clients || []).slice(0, 3).join(' · ');
        const devsLabel = (ws.devices || []).slice(0, 2).join(', ');
        const subParts = [devsLabel, clientsLabel].filter(Boolean).join(' · ');
        const liveChip = ws.activeSessionCount > 0
          ? `<span class="dash-live-chip">${escapeHtml(t('dashboard.fleet.activeAgents', { count: ws.activeSessionCount }))}</span>`
          : '';
        return `<div class="dash-project-row" data-ws-key="${escapeHtml(ws.key)}" tabindex="0" role="button">`
          + `<span class="dash-session-lead"><span class="row-icon row-icon-project" aria-hidden="true"></span></span>`
          + `<div class="dash-project-body">`
          + `<div class="dash-project-title"><span class="dash-session-title-text">${escapeHtml(ws.name)}</span>${liveChip}</div>`
          + `<div class="dash-project-sub"><span class="dash-session-meta-text">${escapeHtml(subParts || '')}</span></div>`
          + `<div class="dash-project-bar"><div class="dash-project-bar-fill" data-w="${ws.relWidth.toFixed(4)}" data-bg="${escapeHtml(ws.barBackground)}"></div></div>`
          + `</div>`
          + `<div class="dash-project-metrics">`
          + `<span class="dash-row-tokens">${escapeHtml(formatCompact(ws.tokens))}</span>`
          + `<span class="dash-row-cost">${escapeHtml(formatCost(ws.cost, ws.unpricedTokens))}</span>`
          + `</div>`
          + `</div>`;
      }).join('');
      applySwatchColors(els.workPanel);
    });
    animateListSnapshot(els.workPanel, '.dash-project-row', (r) => r.dataset.wsKey, '.dash-project-bar-fill', snapshot);
    return;
  }

  const list = state.workMode === 'running' ? runningSessions : allSessions;
  const incompleteFooter = state.workMode === 'sessions' && overview?.sessionsIncomplete
    ? `<div class="dash-quotas-empty">${escapeHtml(t('sessions.incomplete'))}</div>`
    : '';
  if (list.length === 0) {
    lastWorkStructureSig = '';
    const emptyKey = overview?.sessionsIncomplete ? 'sessions.incomplete'
      : state.workMode === 'running' ? 'dashboard.work.emptyRunning' : 'dashboard.work.emptySessions';
    els.workPanel.innerHTML = `<div class="dash-quotas-empty">${escapeHtml(t(emptyKey))}</div>`;
    return;
  }

  const visibleSessions = list.slice(0, 12);
  const nextSig = JSON.stringify([state.workMode, state.locale, Boolean(overview?.sessionsIncomplete), visibleSessions.map((s) => s.key)]);
  if (nextSig === lastWorkStructureSig) {
    const rowMap = new Map();
    els.workPanel.querySelectorAll('.dash-session-row').forEach((r) => rowMap.set(r.dataset.sessionKey, r));
    visibleSessions.forEach((s) => {
      const row = rowMap.get(s.key);
      if (!row) return;
      row.className = `dash-session-row state-${s.activityState}`;
      const lead = row.querySelector('.dash-session-lead');
      const stateNode = lead?.querySelector('.home-session-state');
      if (stateNode && stateNode.dataset.state !== s.activityState) {
        const tmp = document.createElement('div');
        tmp.innerHTML = sessionStateIconHtml(s.activityState);
        if (tmp.firstElementChild) stateNode.replaceWith(tmp.firstElementChild);
      }
      const titleEl = row.querySelector('.dash-session-title-text');
      if (titleEl) titleEl.textContent = s.title;
      const subEl = row.querySelector('.dash-session-sub');
      const prevContextFill = subEl?.querySelector('.home-session-context-fill');
      const groupBadge = sessionGroupBadgeLabel(s);
      const badgeEl = subEl?.querySelector?.('.dash-session-badge:not(.is-warm)') || null;
      const { joinedMeta, subExtrasHtml } = sessionRowParts(s, overview);
      if (subEl && s.context && prevContextFill && Boolean(groupBadge) === Boolean(badgeEl)) {
        const metaSpan = subEl.querySelector('.dash-session-meta-text');
        if (metaSpan) metaSpan.innerHTML = joinedMeta;
        if (badgeEl) badgeEl.textContent = groupBadge;
        const scale = Math.max(0, Math.min(1, Number(s.context.displayPercent || 0) / 100)).toFixed(3);
        const ctxWrap = subEl.querySelector('.home-session-context');
        if (ctxWrap) {
          if (s.context.tone) ctxWrap.setAttribute('data-tone', s.context.tone);
          else ctxWrap.removeAttribute('data-tone');
        }
        prevContextFill.setAttribute('data-w', scale);
        prevContextFill.style.setProperty('--bar-scale', scale);
        const ctxVal = subEl.querySelector('.home-session-context-value');
        if (ctxVal) ctxVal.textContent = `${s.context.displayPercent}%`;
      } else if (subEl) {
        subEl.innerHTML = `<span class="dash-session-meta-text">${joinedMeta}</span>${subExtrasHtml}`;
        applySwatchColors(subEl);
      }
      const tokEl = row.querySelector('.dash-row-tokens');
      const costEl = row.querySelector('.dash-row-cost');
      if (tokEl) tokEl.textContent = formatCompact(s.totalTokens);
      if (costEl) costEl.textContent = formatCost(s.costUsd, s.unpricedTokens);
    });
    return;
  }

  const rowKey = (r) => r.dataset.deviceId || r.dataset.wsKey || r.dataset.sessionKey || '';
  const snapshot = captureListSnapshot(els.workPanel, '.dash-device-row, .dash-project-row, .dash-session-row', rowKey, '.home-session-context-fill');
  lastWorkStructureSig = nextSig;

  withPreservedFocus(els.workPanel, '.dash-session-row[data-session-key]', (r) => r.dataset.sessionKey || '', () => {
    els.workPanel.innerHTML = renderSessionRowsHtml(list, overview) + incompleteFooter;
    applySwatchColors(els.workPanel);
  });
  animateListSnapshot(els.workPanel, '.dash-session-row', (r) => r.dataset.sessionKey, '.home-session-context-fill', snapshot);
}

function topologyLineage(graph, kind, id) {
  const relatedNodes = new Set([`${kind}:${id}`]);
  const relatedEdges = new Set();
  if (!graph) return { relatedNodes, relatedEdges };

  if (kind === 'device') {
    for (const edge of graph.devToHub || []) {
      if (edge.from !== id) continue;
      relatedEdges.add(edge.id);
      relatedNodes.add(`hub:${edge.to}`);
    }
    for (const edge of graph.hubToEnd || []) {
      const ep = graph.endpoints?.find((item) => item.id === edge.to);
      const matchesDev = graph.mode === 'sessions'
        ? (ep?.deviceId === id || (Array.isArray(ep?.memberDeviceIds) && ep.memberDeviceIds.includes(id)))
        : relatedNodes.has(`hub:${edge.from}`);
      if (matchesDev && relatedNodes.has(`hub:${edge.from}`)) {
        relatedEdges.add(edge.id);
        relatedNodes.add(`endpoint:${edge.to}`);
      }
    }
  } else if (kind === 'hub') {
    for (const edge of graph.devToHub || []) {
      if (edge.to !== id) continue;
      relatedEdges.add(edge.id);
      relatedNodes.add(`device:${edge.from}`);
    }
    for (const edge of graph.hubToEnd || []) {
      if (edge.from !== id) continue;
      relatedEdges.add(edge.id);
      relatedNodes.add(`endpoint:${edge.to}`);
    }
  } else if (kind === 'endpoint') {
    const ep = graph.endpoints?.find((item) => item.id === id);
    const epHasMemberDevs = Array.isArray(ep?.memberDeviceIds) && ep.memberDeviceIds.length > 0;
    const matchedHubs = new Set();
    for (const edge of graph.hubToEnd || []) {
      if (edge.to !== id) continue;
      relatedEdges.add(edge.id);
      relatedNodes.add(`hub:${edge.from}`);
      matchedHubs.add(edge.from);
    }
    for (const edge of graph.devToHub || []) {
      if (!matchedHubs.has(edge.to)) continue;
      if (graph.mode !== 'sessions'
        || (!ep?.deviceId && !epHasMemberDevs)
        || ep?.deviceId === edge.from
        || (epHasMemberDevs && ep.memberDeviceIds.includes(edge.from))) {
        relatedEdges.add(edge.id);
        relatedNodes.add(`device:${edge.from}`);
      }
    }
  }
  return { relatedNodes, relatedEdges };
}

function applyTopologyFocus(kind, id) {
  const canvas = els.topology?.querySelector('.dash-topo-canvas');
  const graph = state.overview?.topology;
  if (!canvas || !graph) return;
  const { relatedNodes, relatedEdges } = topologyLineage(graph, kind, id);
  canvas.setAttribute('data-focus', 'true');
  canvas.querySelectorAll('.topo-node').forEach((node) => {
    const key = `${node.dataset.topoKind}:${node.dataset.topoId}`;
    if (relatedNodes.has(key)) node.setAttribute('data-related', 'true');
    else node.removeAttribute('data-related');
  });
  canvas.querySelectorAll('.topo-edge').forEach((edge) => {
    if (relatedEdges.has(edge.dataset.edgeId)) edge.setAttribute('data-related', 'true');
    else edge.removeAttribute('data-related');
  });
}

function clearTopologyFocus() {
  const canvas = els.topology?.querySelector('.dash-topo-canvas');
  if (!canvas) return;
  canvas.removeAttribute('data-focus');
  canvas.querySelectorAll('[data-related]').forEach((el) => el.removeAttribute('data-related'));
}

function showTopologyTooltip(kind, id, anchorEl) {
  const graph = state.overview?.topology;
  if (!graph || !anchorEl) return;
  let head = '';
  const rows = [];

  if (kind === 'device') {
    const d = graph.devices?.find((item) => item.id === id);
    if (!d) return;
    head = d.name;
    rows.push([t('dashboard.hero.tokens'), formatCompact(d.tokens)]);
    rows.push([t('dashboard.hero.cost'), formatCost(d.cost, d.unpricedTokens)]);
    if (d.liveTokPerSec > 0) rows.push([t('dashboard.hero.liveRate'), `${Math.round(d.liveTokPerSec)} tok/s`]);
    if (d.activeWorkspace) rows.push([t('dashboard.work.workspaces'), d.activeWorkspace]);
  } else if (kind === 'hub') {
    const h = graph.hubs?.find((item) => item.id === id);
    if (!h) return;
    head = h.isGeneral ? t('dashboard.topology.generalWorkspace') : h.name;
    rows.push([t('dashboard.hero.tokens'), formatCompact(h.tokens)]);
    rows.push([t('dashboard.hero.cost'), formatCost(h.cost, h.unpricedTokens)]);
    if (h.activeSessionCount > 0) rows.push([t('dashboard.work.running'), String(h.activeSessionCount)]);
  } else if (kind === 'endpoint') {
    const ep = graph.endpoints?.find((item) => item.id === id);
    if (!ep) return;
    head = ep.title;
    rows.push([t('dashboard.hero.tokens'), formatCompact(ep.totalTokens)]);
    rows.push([t('dashboard.hero.cost'), formatCost(ep.costUsd, ep.unpricedTokens)]);
    if (ep.modelLabel || ep.latestModel) rows.push([t('dashboard.stack.model'), ep.modelLabel || ep.latestModel]);
    const groupBadge = sessionGroupBadgeLabel(ep);
    if (groupBadge) rows.push([t('dashboard.work.sessions'), groupBadge]);
    if (ep.context) rows.push([t('dashboard.sessions.context'), `${ep.context.displayPercent}%`]);
  }
  if (!head) return;

  activeHover = { kind: 'topo', nodeKind: kind, nodeId: id };
  els.tooltip.innerHTML = `<div class="tt-head">${escapeHtml(head)}</div>`
    + rows.map(([k, v]) => `<div class="tt-row"><span class="tt-name">${escapeHtml(k)}</span><span class="tt-val">${escapeHtml(v)}</span></div>`).join('');
  positionTooltip(anchorEl);
}

function topologyEdgeSpeedTier(liveRate) {
  const rate = Number(liveRate || 0);
  if (rate >= 100) return 3;
  if (rate >= 15) return 2;
  return 1;
}

function syncTopologyScrollFades(canvas) {
  if (!canvas) return;
  canvas.querySelectorAll('.dash-topo-col-scroll').forEach((scroller) => {
    const overflow = scroller.scrollHeight > scroller.clientHeight + 2;
    scroller.classList.toggle('has-top-fade', overflow && scroller.scrollTop > 3);
    scroller.classList.toggle('has-bottom-fade', overflow && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 3);
  });
}

function layoutTopologyLinks(graph) {
  if (!els.topology || !graph) return;
  const canvas = els.topology.querySelector('.dash-topo-canvas');
  const svg = els.topology.querySelector('.dash-topo-links');
  if (!canvas || !svg) return;
  const rect = canvas.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;

  svg.setAttribute('viewBox', `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`);

  const colBounds = new Map();
  canvas.querySelectorAll('.dash-topo-col-scroll[data-topo-col]').forEach((scroller) => {
    const sr = scroller.getBoundingClientRect();
    colBounds.set(scroller.getAttribute('data-topo-col'), {
      top: sr.top - rect.top,
      bottom: sr.bottom - rect.top
    });
  });

  const ports = new Map();
  canvas.querySelectorAll('[data-port]').forEach((el) => {
    const pr = el.getBoundingClientRect();
    if (pr.width <= 0 && pr.height <= 0) return;
    const x = pr.left + pr.width / 2 - rect.left;
    const y = pr.top + pr.height / 2 - rect.top;
    const scroller = el.closest?.('.dash-topo-col-scroll[data-topo-col]');
    const colKey = scroller?.getAttribute?.('data-topo-col') || '';
    const bounds = colKey ? colBounds.get(colKey) : null;
    let vis = 1;
    if (bounds && bounds.bottom > bounds.top) {
      if (y < bounds.top - 16 || y > bounds.bottom + 16) vis = 0;
      else if (y < bounds.top + 14) vis = Math.max(0, Math.min(1, (y - (bounds.top - 16)) / 30));
      else if (y > bounds.bottom - 14) vis = Math.max(0, Math.min(1, ((bounds.bottom + 16) - y) / 30));
    }
    ports.set(el.getAttribute('data-port'), { x, y, vis });
  });

  const edgeSpecs = [
    ...(graph.devToHub || []).map((e) => ({ edge: e, hop: 1, fromKey: `dev:${e.from}`, toKey: `hub-in:${e.to}` })),
    ...(graph.hubToEnd || []).map((e) => ({ edge: e, hop: 2, fromKey: `hub-out:${e.from}`, toKey: `end:${e.to}` }))
  ].map((spec) => {
    const p1 = ports.get(spec.fromKey);
    const p2 = ports.get(spec.toKey);
    if (!p1 || !p2) return null;
    const dx = Math.max(24, (p2.x - p1.x) * 0.48);
    const d = `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${(p1.x + dx).toFixed(1)},${p1.y.toFixed(1)} ${(p2.x - dx).toFixed(1)},${p2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    const color = displayColor(spec.edge.color || '#6ab4f0');
    const swNum = 1.15 + Math.max(0, Math.min(1, Number(spec.edge.share || 0))) * 0.85;
    const sw = swNum.toFixed(2);
    const vis = Math.min(p1.vis, p2.vis);
    return { ...spec, d, color, swNum, sw, vis };
  }).filter(Boolean);

  const applyEdgeVisibility = (g, vis) => {
    if (!g) return;
    g.classList.toggle('is-offscreen', vis <= 0.01);
    g.style?.setProperty?.('--edge-vis', vis >= 0.99 ? '1' : vis.toFixed(3));
  };

  const reduced = prefersReducedMotion();
  const edgesHtml = edgeSpecs.map(({ edge, hop, d, color, swNum, sw }) => {
    const active = Boolean(edge.active);
    const classes = ['topo-edge', `topo-edge--hop${hop}`];
    let activeLayers = '';
    if (active) {
      classes.push('is-active');
      if (!reduced) {
        const tier = topologyEdgeSpeedTier(edge.liveRate);
        const branchIdx = Array.from(edge.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
        classes.push(`topo-speed-${tier}`, `topo-branch-${branchIdx}`);
        activeLayers = `<path class="topo-edge-aura" stroke="${escapeHtml(color)}" stroke-width="${(swNum + 3.2).toFixed(2)}" d="${d}"></path>`
          + `<path class="topo-beam-tail" pathLength="100" stroke="${escapeHtml(color)}" stroke-width="${(swNum + 1.8).toFixed(2)}" d="${d}"></path>`
          + `<path class="topo-beam-body" pathLength="100" stroke="${escapeHtml(color)}" stroke-width="${Math.max(1.5, swNum + 0.35).toFixed(2)}" d="${d}"></path>`
          + `<path class="topo-beam-head" pathLength="100" stroke-width="1.25" d="${d}"></path>`;
      }
    }
    return `<g class="${classes.join(' ')}" data-edge-id="${escapeHtml(edge.id)}" data-key="${escapeHtml(edge.id)}">`
      + `<path class="topo-edge-base" stroke="${escapeHtml(color)}" stroke-width="${sw}" d="${d}"></path>`
      + activeLayers
      + `</g>`;
  }).join('');

  patchDashboardMarkup(svg, `<defs>`
    + `<filter id="dashTopoBeamGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"></feGaussianBlur><feMerge><feMergeNode in="b"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge></filter>`
    + `<filter id="dashTopoAmbientGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"></feGaussianBlur></filter>`
    + `</defs>${edgesHtml}`);

  const edgeSpecById = new Map(edgeSpecs.map((spec) => [spec.edge.id, spec]));
  svg.querySelectorAll('g.topo-edge[data-edge-id]').forEach((g) => {
    const spec = edgeSpecById.get(g.getAttribute('data-edge-id'));
    if (spec) applyEdgeVisibility(g, spec.vis);
  });

  if (activeHover?.kind === 'topo') {
    applyTopologyFocus(activeHover.nodeKind, activeHover.nodeId);
  }
}

function renderTopology(overview) {
  if (!els.topology) return;
  const graph = overview?.topology;
  if (!graph || !graph.devices?.length) {
    topologyResizeObserver?.disconnect();
    topologyResizeObserver = null;
    patchDashboardMarkup(els.topology, `<div class="dash-quotas-empty">${escapeHtml(t('dashboard.topology.empty'))}</div>`);
    return;
  }

  const reduced = prefersReducedMotion();
  const isSessionMode = graph.mode === 'sessions';
  const maxHubTokens = graph.hubs.reduce((mx, h) => Math.max(mx, h.tokens), 0) || 1;
  const existingCanvas = els.topology.querySelector('.dash-topo-canvas');

  const activeDevEdgeMap = new Map();
  for (const e of graph.devToHub || []) {
    if (!e.active) continue;
    const prev = activeDevEdgeMap.get(e.from);
    if (!prev || Number(e.tokens || 0) > Number(prev.tokens || 0)) {
      activeDevEdgeMap.set(e.from, e);
    }
  }
  const activeHubColorMap = new Map();
  for (const e of graph.hubToEnd || []) {
    if (e.active && e.color && !activeHubColorMap.has(e.from)) {
      activeHubColorMap.set(e.from, e.color);
    }
  }
  for (const e of graph.devToHub || []) {
    if (e.active && e.color && !activeHubColorMap.has(e.to)) {
      activeHubColorMap.set(e.to, e.color);
    }
  }
  const hubRateMap = new Map();
  for (const e of graph.devToHub || []) {
    if (e.active) hubRateMap.set(e.to, Math.max(hubRateMap.get(e.to) || 0, Number(e.liveRate || 0)));
  }
  for (const e of graph.hubToEnd || []) {
    if (e.active) hubRateMap.set(e.from, Math.max(hubRateMap.get(e.from) || 0, Number(e.liveRate || 0)));
  }
  const endRateMap = new Map();
  for (const e of graph.hubToEnd || []) {
    if (e.active) endRateMap.set(e.to, Math.max(endRateMap.get(e.to) || 0, Number(e.liveRate || 0)));
  }
  const nodeSpeedClass = (active, rate) => (active && !reduced ? `topo-speed-${topologyEdgeSpeedTier(rate)}` : '');

  const devicesHtml = graph.devices.map((d) => {
    const devEdge = activeDevEdgeMap.get(d.id) || null;
    const hasLiveFlow = Boolean(devEdge);
    const selected = state.selectedDeviceId === d.id;
    const accent = hasLiveFlow ? displayColor(devEdge.color || '#6ab4f0') : 'rgba(var(--overlay-rgb), 0.45)';
    const barColor = hasLiveFlow || d.liveTokPerSec > 0 ? 'rgba(var(--overlay-rgb), 0.56)' : 'rgba(var(--overlay-rgb), 0.34)';
    const cls = ['topo-node', 'topo-node--device', hasLiveFlow ? 'is-active' : '', nodeSpeedClass(hasLiveFlow, d.liveTokPerSec), selected ? 'is-selected' : '', d.stale ? 'is-stale' : ''].filter(Boolean).join(' ');
    const subLeft = d.liveTokPerSec > 0
      ? `<span class="topo-live-rate is-rate">${Math.round(d.liveTokPerSec)} tok/s</span>`
      : escapeHtml(d.activeWorkspace || (d.isLocal ? t('dashboard.devices.you') : ''));
    const subRight = d.activeSessionCount > 0 ? t('dashboard.fleet.activeAgents', { count: d.activeSessionCount }) : '';
    const shareScale = Math.max(0.03, Math.min(1, d.share || 0)).toFixed(3);
    return `<div class="${cls}" data-topo-kind="device" data-topo-id="${escapeHtml(d.id)}" data-key="device:${escapeHtml(d.id)}" data-node-accent="${accent}" tabindex="0" role="button">`
      + `<div class="topo-node-top">`
      + `<span class="topo-node-ident"><span class="device-kind-icon device-kind-${escapeHtml(d.deviceKind)}" aria-hidden="true"></span><span class="topo-node-title">${escapeHtml(d.name)}</span></span>`
      + `<span class="topo-node-val">${escapeHtml(formatCompact(d.tokens))}</span>`
      + `</div>`
      + `<div class="topo-node-sub"><span class="topo-node-sub-text">${subLeft}</span><span>${escapeHtml(subRight)}</span></div>`
      + `<div class="topo-mini-bar"><div class="topo-mini-bar-fill" data-w="${shareScale}" data-c="${barColor}"></div></div>`
      + `<span class="topo-port topo-port--out${hasLiveFlow ? ' is-live' : ''}" data-port="dev:${escapeHtml(d.id)}"></span>`
      + `</div>`;
  }).join('');

  const hubsHtml = graph.hubs.map((h) => {
    const active = h.activeSessionCount > 0;
    const titleText = h.isGeneral ? t('dashboard.topology.generalWorkspace') : h.name;
    const accent = displayColor(activeHubColorMap.get(h.id) || h.color || '#73bdf5');
    const hubCls = ['topo-node', 'topo-node--hub', active ? 'is-active' : '', nodeSpeedClass(active, hubRateMap.get(h.id) || 0)].filter(Boolean).join(' ');
    const iconHtml = isSessionMode
      ? `<span class="row-icon row-icon-project" aria-hidden="true"></span>`
      : (h.iconClass ? `<span class="dash-bd-icon row-icon ${escapeHtml(h.iconClass)}" aria-hidden="true"></span>` : `<span class="dash-bd-swatch" data-c="${accent}"></span>`);
    const subLeft = isSessionMode ? (h.clients || []).slice(0, 2).join(' · ') : '';
    const subRight = active ? `<span class="topo-live-rate">${escapeHtml(t('dashboard.fleet.activeAgents', { count: h.activeSessionCount }))}</span>` : escapeHtml(formatCost(h.cost, h.unpricedTokens));
    const fillScale = Math.max(0.04, Math.min(1, h.tokens / maxHubTokens)).toFixed(3);
    const barAttr = h.barBackground ? `data-bg="${escapeHtml(h.barBackground)}"` : `data-c="${accent}"`;
    return `<div class="${hubCls}" data-topo-kind="hub" data-topo-id="${escapeHtml(h.id)}" data-key="hub:${escapeHtml(h.id)}" data-node-accent="${accent}" tabindex="0" role="button">`
      + `<span class="topo-port topo-port--in${active ? ' is-live' : ''}" data-port="hub-in:${escapeHtml(h.id)}"></span>`
      + `<div class="topo-node-top">`
      + `<span class="topo-node-ident">${iconHtml}<span class="topo-node-title">${escapeHtml(titleText)}</span></span>`
      + `<span class="topo-node-val">${escapeHtml(formatCompact(h.tokens))}</span>`
      + `</div>`
      + `<div class="topo-node-sub"><span class="topo-node-sub-text">${escapeHtml(subLeft)}</span><span>${subRight}</span></div>`
      + `<div class="topo-mini-bar"><div class="topo-mini-bar-fill" data-w="${fillScale}" ${barAttr}></div></div>`
      + `<span class="topo-port topo-port--out${active ? ' is-live' : ''}" data-port="hub-out:${escapeHtml(h.id)}"></span>`
      + `</div>`;
  }).join('');

  const endsHtml = graph.endpoints.map((ep) => {
    const accent = displayColor(ep.color || '#6ab4f0');
    const epCls = ['topo-node', 'topo-node--endpoint', ep.isActive ? 'is-active' : '', nodeSpeedClass(Boolean(ep.isActive), endRateMap.get(ep.id) || 0)].filter(Boolean).join(' ');
    const iconHtml = ep.iconClass
      ? `<span class="dash-session-brand row-icon ${escapeHtml(ep.iconClass)}" aria-hidden="true"></span>`
      : `<span class="dash-bd-swatch" data-c="${accent}"></span>`;
    const stateHtml = isSessionMode ? sessionStateIconHtml(ep.activityState) : '';
    const subLeft = topologyEndpointSubText(ep, isSessionMode);
    const rightMeta = ep.context
      ? `<span class="home-session-context"${ep.context.tone ? ` data-tone="${escapeHtml(ep.context.tone)}"` : ''}><span class="home-session-context-meter"><span class="home-session-context-fill" data-w="${Math.max(0, Math.min(1, Number(ep.context.displayPercent || 0) / 100)).toFixed(3)}"></span></span><span class="home-session-context-value">${ep.context.displayPercent}%</span></span>`
      : `<span>${escapeHtml(formatCost(ep.costUsd, ep.unpricedTokens))}</span>`;
    return `<div class="${epCls}" data-topo-kind="endpoint" data-topo-id="${escapeHtml(ep.id)}" data-key="endpoint:${escapeHtml(ep.id)}" data-node-accent="${accent}" tabindex="0" role="button">`
      + `<span class="topo-port topo-port--in${ep.isActive ? ' is-live' : ''}" data-port="end:${escapeHtml(ep.id)}"></span>`
      + `<div class="topo-node-top">`
      + `<span class="topo-node-ident">${iconHtml}${stateHtml}<span class="topo-node-title">${escapeHtml(ep.title)}</span></span>`
      + `<span class="topo-node-val">${escapeHtml(formatCompact(ep.totalTokens))}</span>`
      + `</div>`
      + `<div class="topo-node-sub"><span class="topo-node-sub-text">${escapeHtml(subLeft)}</span>${rightMeta}</div>`
      + `</div>`;
  }).join('');

  const hubColTitle = t(isSessionMode ? 'dashboard.topology.colWorkspaces' : 'dashboard.topology.colTools');
  const endColTitle = t(isSessionMode ? 'dashboard.topology.colSessions' : 'dashboard.topology.colModels');

  // Keep the scroll containers and focused nodes on membership/rank changes.
  // The link layer owns its SVG children and stays mounted through node updates.
  const changed = patchDashboardMarkup(els.topology, `<div class="dash-topo-canvas">`
    + `<svg class="dash-topo-links" data-dom-island aria-hidden="true"></svg>`
    + `<div class="dash-topo-col"><div class="dash-topo-col-head"><span>${escapeHtml(t('dashboard.topology.colDevices'))}</span><span>${graph.counts.devices}</span></div><div class="dash-topo-col-scroll" data-topo-col="devices">${devicesHtml}</div></div>`
    + `<div class="dash-topo-col"><div class="dash-topo-col-head"><span>${escapeHtml(hubColTitle)}</span><span>${graph.counts.hubs}</span></div><div class="dash-topo-col-scroll" data-topo-col="hubs">${hubsHtml}</div></div>`
    + `<div class="dash-topo-col"><div class="dash-topo-col-head"><span>${escapeHtml(endColTitle)}</span><span>${graph.counts.endpoints}</span></div><div class="dash-topo-col-scroll" data-topo-col="endpoints">${endsHtml}</div></div>`
    + `</div>`);

  if (changed) applySwatchColors(els.topology);
  const canvas = els.topology.querySelector('.dash-topo-canvas');
  if (canvas && canvas !== existingCanvas && typeof ResizeObserver === 'function') {
    topologyResizeObserver?.disconnect();
    topologyResizeObserver = new ResizeObserver(() => {
      if (state.stageView === 'flow' && state.overview?.topology) {
        syncTopologyScrollFades(canvas);
        layoutTopologyLinks(state.overview.topology);
      }
    });
    topologyResizeObserver.observe(canvas);
  }

  if (topologyLayoutFrame) cancelAnimationFrame(topologyLayoutFrame);
  topologyLayoutFrame = requestAnimationFrame(() => {
    topologyLayoutFrame = 0;
    syncTopologyScrollFades(canvas);
    layoutTopologyLinks(graph);
  });
}

function dismissSkylineHint() {
  if (skylineHintDismissed) return;
  skylineHintDismissed = true;
  els.skylineHint?.classList.add('is-dismissed');
}

function ensureSkylineController() {
  if (skylineController || !els.skylineCanvasHost || typeof skylineApi?.createSkylineController !== 'function') {
    return skylineController;
  }
  skylineController = skylineApi.createSkylineController(els.skylineCanvasHost, {
    onHover(hit) {
      if (!hit || state.stageView !== '3d' || state.tab !== 'activity') {
        if (activeHover?.kind === 'skyline') hideTooltip();
        return;
      }
      const date = hit.cell?.date;
      if (!date) return;
      activeHover = { kind: 'skyline', date };
      showHeatTooltip(date, state.dayMap?.get(date) || hit.cell, hit.anchorRect);
    },
    onSelect(cell) {
      if (!cell?.date) return;
      const day = (state.overview?.dailyLedger || []).find((d) => d.date === cell.date);
      if (day) openDrawer({ kind: 'day', day });
    },
    onInteract() {
      dismissSkylineHint();
    }
  });
  if (skylineController && typeof ResizeObserver === 'function' && !skylineResizeObserver) {
    skylineResizeObserver = new ResizeObserver(() => {
      if (state.stageView === '3d' && state.tab === 'activity') skylineController?.resize?.();
    });
    skylineResizeObserver.observe(els.skylineCanvasHost);
  }
  return skylineController;
}

function renderSkylineToolLegend(cells) {
  if (!els.skylineToolLegend) return;
  const visible = state.skylineColorMode === 'tool' && Array.isArray(cells) && cells.length > 0;
  if (!visible) {
    els.skylineToolLegend.classList.add('hidden');
    els.skylineToolLegend.innerHTML = '';
    return;
  }
  const counts = new Map();
  for (const c of cells) {
    if (!c?.topClient?.id || !(c.tokens > 0 || c.cost > 0)) continue;
    const prev = counts.get(c.topClient.id);
    if (prev) prev.count += 1;
    else counts.set(c.topClient.id, { ...c.topClient, count: 1 });
  }
  const topTools = Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5);
  if (!topTools.length) {
    els.skylineToolLegend.classList.add('hidden');
    els.skylineToolLegend.innerHTML = '';
    return;
  }
  els.skylineToolLegend.classList.remove('hidden');
  els.skylineToolLegend.innerHTML = topTools.map((tool) =>
    `<span class="dash-skyline-tool-item"><span class="dash-bd-swatch" data-c="${escapeHtml(displayColor(tool.color))}"></span><span>${escapeHtml(tool.label)}</span></span>`
  ).join('');
  applySwatchColors(els.skylineToolLegend);
}

function renderHeatLegend(visible) {
  if (!els.heatLegend) return;
  els.heatLegend.classList.toggle('hidden', !visible);
  if (!visible) return;
  const lessLabel = t('home.less') || 'Less';
  const moreLabel = t('home.more') || 'More';
  const existing = els.heatLegend.querySelectorAll('.dash-heat-legend-label');
  if (existing.length === 2) {
    existing[0].textContent = lessLabel;
    existing[1].textContent = moreLabel;
    return;
  }
  els.heatLegend.innerHTML = `<span class="dash-heat-legend-label">${escapeHtml(lessLabel)}</span>`
    + [0, 1, 2, 3, 4].map((lvl) => `<span class="dash-heat-legend-swatch lvl-${lvl}"></span>`).join('')
    + `<span class="dash-heat-legend-label">${escapeHtml(moreLabel)}</span>`;
}

function renderActivity(overview) {
  const isFlow = state.stageView === 'flow';
  els.activityCol?.setAttribute('data-stage', state.stageView);
  els.topology?.classList.toggle('hidden', !isFlow);
  els.heatmapMetricControl?.classList.toggle('hidden', isFlow);

  if (els.stageTitle) {
    els.stageTitle.textContent = t(isFlow ? 'dashboard.topology.title' : 'dashboard.heatmap.title');
  }

  if (isFlow) {
    const graph = overview?.topology;
    if (els.heatmapMeta) {
      const liveEdges = graph?.counts?.activeEdges || 0;
      const peak = overview?.scopedHistory?.summary?.peakDayTokens || 0;
      els.heatmapMeta.textContent = liveEdges > 0
        ? t('dashboard.topology.liveLinks', { count: liveEdges })
        : (peak > 0 ? `${t('trends.peakDay')}: ${formatCompact(peak)}` : '');
    }
    heatmapMotionGeneration += 1;
    els.heatmap?.classList.remove('is-motion-pending');
    els.heatmap?.classList.add('hidden');
    els.skylineStage?.classList.add('hidden');
    els.heatFooter?.classList.add('hidden');
    renderHeatLegend(false);
    renderTopology(overview);
  } else {
    state.heatmapView = state.stageView === '2d' ? '2d' : '3d';
    const scopedDailySource = state.selectedDeviceId === 'all'
      ? (state.history?.daily || [])
      : (overview?.scopedHistory?.daily || []);
    const daily = state.selectedDeviceId === 'all'
      ? charts.computeHeatmapIntensities(state.history?.daily || [])
      : charts.computeHeatmapIntensities(scopedDailySource);

    const end = todayKey();
    const now = new Date(`${end}T00:00:00Z`);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
    const intensityKey = state.heatmapMetric === 'cost' ? 'costIntensity' : 'tokenIntensity';
    const gap = 3;
    let heat = charts.contribHeatmap(daily, { cell: 12, gap, startDate: start, endDate: end, intensityKey });

    if (els.heatmapMeta) {
      const peak = overview?.scopedHistory?.summary?.peakDayTokens || 0;
      els.heatmapMeta.textContent = peak > 0 ? `${t('trends.peakDay')}: ${formatCompact(peak)}` : '';
    }

    const insights = modelApi?.buildActivityInsights
      ? modelApi.buildActivityInsights(scopedDailySource, {
          metric: state.heatmapMetric,
          startDate: start,
          endDate: end,
          topLimit: 3
        })
      : null;

    const ledgerByDate = new Map();
    for (const row of overview?.dailyLedger || []) {
      if (row?.date) ledgerByDate.set(row.date, row);
    }

    state.dayMap = new Map(scopedDailySource.map((d) => {
      const date = String(d.date).slice(0, 10);
      const ledgerRow = ledgerByDate.get(date);
      return [date, {
        tokens: Number(d.tokens || 0),
        cost: Number(d.cost || 0),
        unpricedTokens: Number(d.unpricedTokens || 0),
        topClient: ledgerRow?.topClient || null
      }];
    }));

    if (state.heatmapView === '3d') {
      const controller = ensureSkylineController();
      if (controller) {
        heatmapMotionGeneration += 1;
        els.heatmap?.classList.remove('is-motion-pending');
        els.heatmap?.classList.add('hidden');
        els.heatFooter?.classList.add('hidden');
        renderHeatLegend(false);
        els.skylineStage?.classList.remove('hidden');

        const enrichedCells = heat.cells.map((c) => {
          const dayRec = state.dayMap.get(c.date);
          return {
            ...c,
            tokens: dayRec ? dayRec.tokens : c.tokens,
            cost: dayRec ? dayRec.cost : c.cost,
            unpricedTokens: dayRec ? dayRec.unpricedTokens : 0,
            topClient: dayRec?.topClient || null
          };
        });
        renderSkylineToolLegend(enrichedCells);
        controller.setData({
          cells: enrichedCells,
          monthLabels: heat.monthLabels,
          weeks: heat.weeks,
          metric: state.heatmapMetric,
          colorMode: state.skylineColorMode,
          reducedMotion: prefersReducedMotion(),
          animateEntry: state.motion === 'entry',
          monthLabel: (m) => monthLabel(m.label)
        });
      } else {
        // Fallback when Canvas 2D is unavailable
        els.skylineStage?.classList.add('hidden');
        els.heatFooter?.classList.add('hidden');
        renderHeatLegend(false);
        els.heatmap?.classList.remove('hidden');
        if (heat.cells.length && modelApi?.isometricHeatmapSvg) {
          els.heatmap.innerHTML = modelApi.isometricHeatmapSvg(heat, {
            monthLabel: (m) => monthLabel(m.label),
            dayMap: state.dayMap,
            metric: state.heatmapMetric,
            uid: 'dashIso',
            initialHidden: false
          });
        } else {
          els.heatmap.innerHTML = '';
        }
      }
    } else {
      els.skylineStage?.classList.add('hidden');
      els.heatmap?.classList.remove('hidden');

      const avail = Math.max(0, (els.heatmap.clientWidth || 0) - 4);
      if (heat.weeks > 0 && avail > 0) {
        const cell = Math.max(8, Math.min(20, (avail - heat.weeks * gap) / heat.weeks));
        heat = charts.contribHeatmap(daily, { cell, gap, startDate: start, endDate: end, intensityKey });
      }

      const hideHeatmapForEntry = !prefersReducedMotion()
        && (state.motion === 'entry' || els.heatmap.classList.contains('is-motion-pending'));

      const heatGridSig = JSON.stringify([
        state.selectedDeviceId,
        state.heatmapView,
        state.locale,
        Math.round(avail),
        start,
        end
      ]);
      const heatValuesSig = JSON.stringify([
        state.heatmapMetric,
        daily.map((d) => [d.date, d.tokens, d.cost])
      ]);

      if (!heat.cells.length) {
        lastHeatmapGridSig = '';
        lastHeatmapValuesSig = '';
        els.heatmap.innerHTML = '';
      } else if (
        heatGridSig === lastHeatmapGridSig
        && !hideHeatmapForEntry
        && els.heatmap.querySelector('svg.dash-heatmap:not(.dash-heatmap--iso)')
      ) {
        if (heatValuesSig !== lastHeatmapValuesSig) {
          lastHeatmapValuesSig = heatValuesSig;
          const baseCells = els.heatmap.querySelectorAll('.heat-base-layer .heat[data-d]');
          const brightCells = els.heatmap.querySelectorAll('.heat-bright-layer .heat-bright');
          const setLevel = (el, lvl) => {
            for (let i = 0; i <= 4; i++) el.classList.remove(`lvl-${i}`);
            el.classList.add(`lvl-${lvl}`);
          };
          heat.cells.forEach((c, idx) => {
            const baseEl = baseCells[idx];
            if (baseEl && baseEl.getAttribute('data-d') === c.date) {
              setLevel(baseEl, c.intensity);
              baseEl.setAttribute('data-t', String(Math.round((c.tokens || 0) * 100) / 100));
              baseEl.setAttribute('data-cost', String(Math.round((c.cost || 0) * 100) / 100));
            }
            const brightEl = brightCells[idx];
            if (brightEl) setLevel(brightEl, c.intensity);
          });
        }
      } else if (heatGridSig !== lastHeatmapGridSig || heatValuesSig !== lastHeatmapValuesSig || hideHeatmapForEntry) {
        lastHeatmapGridSig = heatGridSig;
        lastHeatmapValuesSig = heatValuesSig;
        els.heatmap.innerHTML = charts.heatmapSvg(heat, {
          monthLabel: (m) => monthLabel(m.label),
          radius: 2.5,
          glowFilterId: 'dashActivityHeatGlow',
          spotlightId: 'dashActivitySpotlight',
          spotlightRadius: 82,
          initialHidden: hideHeatmapForEntry
        });
      }

      const show2dExtras = heat.cells.length > 0;
      if (els.heatSummary) {
        if (show2dExtras && insights && insights.activeDays > 0) {
          const avgVal = state.heatmapMetric === 'cost'
            ? formatCostCompact(insights.dailyAvgCost)
            : formatCompact(insights.dailyAvgTokens);
          els.heatSummary.textContent = `${t('dashboard.heatmap.activeSummary', { days: insights.activeDays })} · ${t('dashboard.heatmap.dailyAvg', { value: avgVal })}`;
        } else {
          els.heatSummary.textContent = '';
        }
      }
      els.heatFooter?.classList.toggle('hidden', !show2dExtras);
      renderHeatLegend(show2dExtras);
      animateHeatmapEntry();
    }
  }

  const summary = overview?.scopedHistory?.summary || {};
  const cards = charts.statsCards(summary);
  const LABELS = {
    totalTokens: 'dashboard.stat.totalTokens', totalCost: 'dashboard.stat.totalCost',
    activeDays: 'trends.activeDays', currentStreak: 'trends.currentStreak',
    activeTimeMs: 'trends.activeTime', peakDayTokens: 'trends.peakDay',
    favoriteModel: 'dashboard.stat.favoriteModel', messages: 'dashboard.stat.messages'
  };
  const formatStatCard = (c) => (c.kind === 'cost' ? formatCostCompact(c.value, summary.unpricedTokens)
    : c.kind === 'duration' ? formatDurationCompact(c.value)
      : c.kind === 'model' ? (c.value || '—') : formatCompact(c.value));
  const missing = Number(summary.unpricedTokens || 0);
  const costInfoLabel = t('usage.excludedFromCost', { tokens: Math.round(missing).toLocaleString('en-US') });

  const existingCards = Array.from(els.cards.querySelectorAll('.dash-card[data-stat]'));
  const sameCards = existingCards.length === cards.length
    && cards.every((c, idx) => existingCards[idx]?.dataset?.stat === c.key);

  if (sameCards && cards.length > 0) {
    cards.forEach((c, idx) => {
      const cardEl = existingCards[idx];
      const keyEl = cardEl.querySelector('.dash-card-k');
      if (keyEl) keyEl.textContent = t(LABELS[c.key] || c.key);
      const valWrap = cardEl.querySelector('.dash-card-v');
      let valText = valWrap?.querySelector('.dash-card-v-text');
      if (valWrap && !valText) {
        valText = document.createElement('span');
        valText.className = 'dash-card-v-text';
        valText.textContent = valWrap.textContent || '';
        valWrap.prepend(valText);
      }
      if (valText) {
        animateMetricText(valText, formatStatCard(c), {
          value: typeof c.value === 'number' ? c.value : null,
          whole: c.kind === 'model' || c.kind === 'duration' || c.kind === 'cost'
        });
      }
      if (c.key === 'totalCost' && valWrap) {
        let info = valWrap.querySelector('.usage-cost-info');
        if (missing > 0) {
          if (!info) {
            info = document.createElement('span');
            info.className = 'usage-cost-info';
            info.tabIndex = 0;
            valWrap.append(info);
          }
          info.setAttribute('aria-label', costInfoLabel);
        } else if (info) {
          info.remove();
        }
      }
    });
  } else {
    els.cards.innerHTML = charts.statsCardsHtml(cards, {
      label: (k) => t(LABELS[k] || k),
      format: formatStatCard
    });
    els.cards.querySelectorAll('.dash-card-v').forEach((valWrap, idx) => {
      const text = valWrap.textContent || '';
      valWrap.textContent = '';
      const span = document.createElement('span');
      span.className = 'dash-card-v-text';
      valWrap.append(span);
      const c = cards[idx];
      animateMetricText(span, text, {
        value: typeof c?.value === 'number' ? c.value : null,
        immediate: true
      });
    });
    const costValue = els.cards.querySelector('[data-stat="totalCost"] .dash-card-v');
    if (costValue && missing > 0) {
      const info = document.createElement('span');
      info.className = 'usage-cost-info';
      info.setAttribute('aria-label', costInfoLabel);
      info.tabIndex = 0;
      costValue.append(info);
    }
  }

  balanceStatCards();
  renderHero(overview);
  if (state.settings?.dashboardShowVelocity !== false) renderVelocity(overview);
  if (state.settings?.dashboardShowQuotas !== false) renderQuotas(overview);
  renderWorkPanel(overview);
  renderBreakdown(overview);
}

function drawerStatGrid(pairs) {
  return `<div class="dash-drawer-grid">${pairs.map(([k, v]) =>
    `<div class="dash-drawer-stat"><span class="dash-drawer-stat-k">${escapeHtml(k)}</span><span class="dash-drawer-stat-v">${escapeHtml(v)}</span></div>`
  ).join('')}</div>`;
}

function closeDrawer() {
  drawerRequestToken += 1;
  state.drawer = null;
  if (typeof els.drawer?.hidePopover === 'function' && els.drawer.matches?.(':popover-open')) {
    try { els.drawer.hidePopover(); } catch (_) {}
  }
  els.drawerScrim?.classList.add('hidden');
}

function isRemoteSession(session) {
  if (!session) return true;
  if (session.sourceDevice?.ambiguous === true) return true;
  const srcId = String(session.sourceDevice?.deviceId || '').trim();
  const localId = String(state.stats?.localDeviceId || state.settings?.deviceId || '').trim();
  if (srcId) {
    return !localId || srcId !== localId;
  }
  if (session.sourceDevice) return true;
  if (session.isNativeLocal === true) return false;
  return isSyncedStatsContext(state.stats, state.settings, state.statsMode);
}

function isSyncedStatsContext(stats = state.stats, settings = state.settings, statsMode = state.statsMode) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const localId = String(stats?.localDeviceId || settings?.deviceId || '').trim();
  if (devices.length > 1) return true;
  if (devices.length === 1) {
    const onlyId = String(devices[0]?.deviceId || devices[0]?.id || '').trim();
    if (onlyId && (!localId || onlyId !== localId)) return true;
  }
  const activeMode = String(stats?.mode || statsMode || '').trim();
  if (activeMode === 'local') return false;
  if (activeMode === 'sync') return true;
  const hubMode = String(settings?.hubMode || '').trim();
  if (hubMode === 'local') return false;
  if (hubMode === 'client' || hubMode === 'host' || hubMode === 'icloud') return true;
  return Boolean(String(settings?.hubUrl || '').trim());
}

function hasPendingSyncedOwnership(stats = state.stats, periodKey = state.periodKey) {
  const derived = Boolean(typeof fixedPeriodRangesApi !== 'undefined' && fixedPeriodRangesApi?.isDerived?.(periodKey));
  if (periodKey === 'allTime') return !allTimeSessions?.current();
  if (periodKey !== 'today' && periodKey !== 'month' && !derived) return false;
  if (!isSyncedStatsContext(stats, state.settings, state.statsMode)) return false;
  if (derived) {
    return Boolean(typeof syncedSessionPagesKeyFor === 'function' && syncedSessionPagesKeyFor(stats, periodKey))
      && !isSyncedSessionPagesLoaded(stats, periodKey);
  }
  if (!(stats?.sessionDetailsOmitted?.[periodKey] > 0)) return false;
  return !isSyncedSessionPagesLoaded(stats, periodKey);
}

function hasUnresolvedSyncedOmissions(stats = state.stats, periodKey = state.periodKey) {
  return hasPendingSyncedOwnership(stats, periodKey);
}

function reconcileSyncedSessionOwnership(displayedSession, authoritativeSession, { allowAdoptUnowned = false } = {}) {
  const localId = String(state.stats?.localDeviceId || state.settings?.deviceId || '').trim();
  const displayedOwnerId = displayedSession?.sourceDevice?.ambiguous === true
    ? ''
    : String(displayedSession?.sourceDevice?.deviceId || '').trim();
  const confirmedNextOwner = Boolean(authoritativeSession?.sourceDevice?.deviceId)
    && authoritativeSession?.sourceDevice?.ambiguous !== true;
  const nextOwnerId = confirmedNextOwner ? String(authoritativeSession.sourceDevice.deviceId).trim() : '';
  const ownerMatches = Boolean(nextOwnerId) && (
    displayedOwnerId ? nextOwnerId === displayedOwnerId : allowAdoptUnowned
  );
  if (ownerMatches) {
    return {
      session: {
        ...displayedSession,
        sourceDevice: authoritativeSession.sourceDevice,
        deviceName: authoritativeSession.sourceDevice.name || displayedSession.deviceName || ''
      },
      confirmedOwner: true
    };
  }
  if (displayedOwnerId && (!localId || displayedOwnerId !== localId)) {
    return {
      session: {
        ...displayedSession,
        sourceDevice: displayedSession.sourceDevice,
        deviceName: displayedSession.deviceName || displayedSession.sourceDevice?.name || ''
      },
      confirmedOwner: false
    };
  }
  return {
    session: {
      ...displayedSession,
      sourceDevice: null,
      deviceName: ''
    },
    confirmedOwner: false
  };
}

function loadSessionDrawerDetail(s, token, baseGrid) {
  if (typeof window.tokenMonitor?.getSessionDetail !== 'function') return;
  const periodKey = s.sourcePeriodKey || state.periodKey;
  const owner = String(s.sourceDevice?.deviceId || state.stats?.localDeviceId || state.settings?.deviceId || '');
  const deviceWindows = state.stats?.syncedFixedPeriodDeviceWindows?.[periodKey];
  const nativeWindow = deviceWindows ? (Object.hasOwn(deviceWindows, owner) ? deviceWindows[owner] : null)
    : state.stats?.nativeRangeWindows?.[periodKey];
  const fixedRange = fixedPeriodRangesApi?.isDerived?.(periodKey)
    ? (nativeWindow?.start && nativeWindow?.end
      ? nativeWindow
      : fixedPeriodRangesApi.rangeForSelection?.(periodKey, { locale: state.settings?.locale || state.locale }))
    : null;
  const detailPeriod = fixedRange?.start && fixedRange?.end
    ? `range:${fixedRange.start}:${fixedRange.end}`
    : (periodKey === 'allTime' ? 'total' : periodKey);
  void window.tokenMonitor.getSessionDetail({
    client: s.client,
    sessionId: s.sessionId,
    period: detailPeriod,
    sessionCost: s.costUsd,
    snapshotSource: state.stats?.snapshot?.source
  }).then((detail) => {
    if (token !== drawerRequestToken || !detail || detail.found !== true) return;
    const anatomy = modelApi?.computeSessionDetailAnatomy?.(detail) || modelApi?.computeTokenAnatomy?.(detail);
    const segsHtml = (anatomy?.segments || []).map((seg) =>
      `<div class="dash-bd-row"><span class="dash-bd-name"><span class="dash-bd-name-text">${escapeHtml(t(seg.labelKey))}</span></span><div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-w="${seg.share.toFixed(4)}" data-c="#73bdf5"></div></div><span class="dash-bd-val">${escapeHtml(formatCompact(seg.tokens))}</span><span class="dash-bd-pct">${(seg.share * 100).toFixed(0)}%</span></div>`
    ).join('');
    const currentBaseGrid = typeof state.drawer?.detailBaseGrid === 'string'
      ? state.drawer.detailBaseGrid
      : baseGrid;
    els.drawerBody.innerHTML = currentBaseGrid
      + (segsHtml ? `<div><div class="dash-drawer-section-title">${escapeHtml(t('dashboard.anatomy.title'))}</div>${segsHtml}</div>` : '');
    applySwatchColors(els.drawerBody);
  }).catch(() => {});
}

function openDrawer(payload) {
  state.drawer = payload;
  const token = ++drawerRequestToken;
  if (!els.drawer) return;

  els.drawerScrim?.classList.remove('hidden');
  if (typeof els.drawer.showPopover === 'function' && !els.drawer.matches?.(':popover-open')) {
    try { els.drawer.showPopover(); } catch (_) {}
  }
  if (els.drawerIcon) {
    els.drawerIcon.className = 'dash-drawer-icon hidden';
    els.drawerIcon.style.color = '';
  }

  if (payload.kind === 'machine') {
    const m = payload.machine;
    els.drawerTitle.textContent = m.name;
    els.drawerSubtitle.textContent = m.platformLabel || m.deviceId;
    const toolsHtml = (m.topClients || []).map((c) =>
      `<div class="dash-bd-row"><span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${displayColor(c.color)}"></span><span class="dash-bd-name-text">${escapeHtml(c.label)}</span></span><div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-w="${(m.tokens > 0 ? c.tokens / m.tokens : 0).toFixed(4)}" data-c="${displayColor(c.color)}"></div></div><span class="dash-bd-val">${escapeHtml(formatCompact(c.tokens))}</span><span class="dash-bd-pct"></span></div>`
    ).join('');
    els.drawerBody.innerHTML = drawerStatGrid([
      [t('dashboard.hero.tokens'), formatCompact(m.tokens)],
      [t('dashboard.hero.cost'), formatCost(m.cost, m.unpricedTokens)],
      [t('dashboard.hero.liveRate'), m.liveTokPerSec > 0 ? `${Math.round(m.liveTokPerSec)} tok/s` : '—'],
      [t('dashboard.work.sessions'), String(m.sessionCount || 0)]
    ]) + (toolsHtml ? `<div><div class="dash-drawer-section-title">${escapeHtml(t('dashboard.stack.client'))}</div>${toolsHtml}</div>` : '');
    applySwatchColors(els.drawerBody);
    return;
  }

  if (payload.kind === 'client' || payload.kind === 'model') {
    const item = payload.item;
    els.drawerTitle.textContent = item.label;
    els.drawerSubtitle.textContent = t(payload.kind === 'model' ? 'dashboard.stack.model' : 'dashboard.stack.client');
    if (els.drawerIcon && item.iconClass) {
      els.drawerIcon.className = `dash-drawer-icon row-icon ${item.iconClass}`;
    }
    const subRows = (item.models || []).slice(0, 8).map((m) =>
      `<div class="dash-bd-row"><span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${displayColor(m.color)}"></span><span class="dash-bd-name-text">${escapeHtml(m.id)}</span></span><div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-w="${(item.tokens > 0 ? m.tokens / item.tokens : 0).toFixed(4)}" data-c="${displayColor(m.color)}"></div></div><span class="dash-bd-val">${escapeHtml(formatCompact(m.tokens))}</span><span class="dash-bd-pct"></span></div>`
    ).join('');
    els.drawerBody.innerHTML = drawerStatGrid([
      [t('dashboard.hero.tokens'), formatCompact(item.tokens)],
      [t('dashboard.hero.cost'), formatCost(item.cost, item.unpricedTokens)],
      [t('dashboard.breakdown.share'), `${(item.share * 100).toFixed(1)}%`],
      [t('dashboard.period.label'), t(`dashboard.period.${state.periodKey}`)]
    ]) + (subRows ? `<div><div class="dash-drawer-section-title">${escapeHtml(t('dashboard.stack.model'))}</div>${subRows}</div>` : '');
    applySwatchColors(els.drawerBody);
    return;
  }

  if (payload.kind === 'workspace') {
    const ws = payload.workspace;
    els.drawerTitle.textContent = ws.name;
    els.drawerSubtitle.textContent = t('dashboard.work.workspaces');
    const breakdownHtml = (ws.accordionRows || []).map((r) =>
      `<div class="dash-bd-row"><span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${displayColor(r.color)}"></span><span class="dash-bd-name-text">${escapeHtml(r.name)}</span></span><div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-w="${(r.percent / 100).toFixed(4)}" data-c="${displayColor(r.color)}"></div></div><span class="dash-bd-val">${escapeHtml(formatCompact(r.value))}</span><span class="dash-bd-pct">${r.percent.toFixed(0)}%</span></div>`
    ).join('');
    els.drawerBody.innerHTML = drawerStatGrid([
      [t('dashboard.hero.tokens'), formatCompact(ws.tokens)],
      [t('dashboard.hero.cost'), formatCost(ws.cost, ws.unpricedTokens)],
      [t('dashboard.stack.client'), String((ws.clients || []).length)],
      [t('dashboard.breakdown.share'), `${((ws.share || 0) * 100).toFixed(1)}%`]
    ]) + (breakdownHtml ? `<div><div class="dash-drawer-section-title">${escapeHtml(t('dashboard.breakdown.title'))}</div>${breakdownHtml}</div>` : '');
    applySwatchColors(els.drawerBody);
    return;
  }

  if (payload.kind === 'day') {
    const day = payload.day;
    els.drawerTitle.textContent = longDate(day.date);
    els.drawerSubtitle.textContent = day.date;
    const rawClients = Object.entries(day.raw?.perClient || {})
      .map(([id, v]) => ({ id, tokens: Number(v?.tokens || 0), color: charts.clientColors[id] || '#6ab4f0' }))
      .filter((c) => c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
    const breakdownHtml = rawClients.map((c) =>
      `<div class="dash-bd-row"><span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${displayColor(c.color)}"></span><span class="dash-bd-name-text">${escapeHtml(c.id)}</span></span><div class="dash-bd-bar-bg"><div class="dash-bd-bar-fill" data-w="${(day.tokens > 0 ? c.tokens / day.tokens : 0).toFixed(4)}" data-c="${displayColor(c.color)}"></div></div><span class="dash-bd-val">${escapeHtml(formatCompact(c.tokens))}</span><span class="dash-bd-pct"></span></div>`
    ).join('');
    els.drawerBody.innerHTML = drawerStatGrid([
      [t('dashboard.hero.tokens'), formatCompact(day.tokens)],
      [t('dashboard.hero.cost'), formatCost(day.cost, day.unpricedTokens)]
    ]) + (breakdownHtml ? `<div><div class="dash-drawer-section-title">${escapeHtml(t('dashboard.stack.client'))}</div>${breakdownHtml}</div>` : '');
    applySwatchColors(els.drawerBody);
    return;
  }

  if (payload.kind === 'session') {
    const s = payload.session;
    const renderMemberRow = (member, idx) => {
      const swatch = typeof displayColor === 'function' ? displayColor(member.color || '#6ab4f0') : (member.color || '#6ab4f0');
      const title = member.title || member.modelLabel || member.clientLabel || member.sessionId || '';
      const meta = [member.modelLabel || member.latestModel, member.projectLabel, formatCost(member.costUsd, member.unpricedTokens)].filter(Boolean).join(' · ');
      return `<div class="dash-bd-row dash-drawer-member-row" data-drawer-member-idx="${idx}" tabindex="0" role="button">`
        + `<span class="dash-bd-name"><span class="dash-bd-swatch" data-c="${swatch}"></span><span class="dash-bd-name-text">${escapeHtml(title)}</span></span>`
        + `<span class="dash-bd-val">${escapeHtml(formatCompact(member.totalTokens))}</span>`
        + `<span class="dash-bd-pct">${escapeHtml(meta)}</span>`
        + `</div>`;
    };
    const renderGroupMembersSection = (sess) => {
      const rows = Array.isArray(sess?.groupRows) ? sess.groupRows : [];
      if (!rows.length) return '';
      const indexed = rows.map((member, index) => ({ member, index }));
      if (sess.subagentGroup) {
        const mainEntries = indexed.filter((item) => item.member.groupRole === 'main');
        const childEntries = indexed.filter((item) => item.member.groupRole !== 'main');
        const sections = [];
        if (mainEntries.length > 0) {
          sections.push(mainEntries.map((item) => renderMemberRow(item.member, item.index)).join(''));
        }
        if (childEntries.length > 0) {
          const heading = sess.subagentCount > 0
            ? `${t('sessions.subagent')} · ${sess.subagentCount}`
            : t('sessions.subagent');
          sections.push(
            `<div class="dash-drawer-section-title">${escapeHtml(heading)}</div>`
            + childEntries.slice(0, 50).map((item) => renderMemberRow(item.member, item.index)).join('')
          );
        }
        return sections.join('');
      }
      const badgeText = typeof sessionGroupBadgeLabel === 'function' ? sessionGroupBadgeLabel(sess) : '';
      return (badgeText ? `<div class="dash-drawer-section-title">${escapeHtml(badgeText)}</div>` : '')
        + indexed.slice(0, 50).map((item) => renderMemberRow(item.member, item.index)).join('');
    };

    const isGroupSession = Boolean(s.sessionGroup && Array.isArray(s.groupRows) && s.groupRows.length > 0);
    const ownershipPeriodKey = s.resumedFromPriorPeriod === true
      ? (s.sourcePeriodKey === 'today' || s.sourcePeriodKey === 'month' ? s.sourcePeriodKey : 'month')
      : (s.sourcePeriodKey || state.periodKey);
    const isSyncedPeriodSession = !isGroupSession
      && s.isNativeLocal !== true
      && (typeof isSyncedSessionPeriodKey === 'function' ? isSyncedSessionPeriodKey(ownershipPeriodKey) : (ownershipPeriodKey === 'today' || ownershipPeriodKey === 'month'))
      && isSyncedStatsContext(state.stats, state.settings, state.statsMode);
    const syncedPeriodNeedsPaging = isSyncedPeriodSession
      && (ownershipPeriodKey === 'today' || ownershipPeriodKey === 'month')
      && state.stats?.sessionDetailsOmitted?.[ownershipPeriodKey] > 0;
    const syncedDerivedNeedsLoad = isSyncedPeriodSession
      && typeof isSyncedDerivedPeriod === 'function'
      && isSyncedDerivedPeriod(ownershipPeriodKey)
      && Boolean(typeof syncedSessionPagesKeyFor === 'function' && syncedSessionPagesKeyFor(state.stats, ownershipPeriodKey));
    const allTimeOwnership = isSyncedPeriodSession && ownershipPeriodKey === 'allTime';
    const ownershipPending = allTimeOwnership
      ? !allTimeSessions?.current()
      : (syncedPeriodNeedsPaging || syncedDerivedNeedsLoad) && !isSyncedSessionPagesLoaded(state.stats, ownershipPeriodKey);
    const snapshotMismatch = s.snapshotId != null && state.stats?.snapshot && (
      s.snapshotId !== state.stats.snapshot.id
      || s.snapshotSource !== state.stats.snapshot.source
    );
    let effectiveSession = s;
    if (syncedPeriodNeedsPaging && !ownershipPending) {
      const sessionKey = s.key || `${s.client}:${s.sessionId}`;
      const pagedSession = resolvedSyncedPageSession(state.stats, ownershipPeriodKey, sessionKey);
      effectiveSession = reconcileSyncedSessionOwnership(s, pagedSession, { allowAdoptUnowned: true }).session;
    } else if (isSyncedPeriodSession && !syncedPeriodNeedsPaging && !ownershipPending && (allTimeOwnership || Boolean(payload.returnToGroup) || snapshotMismatch)) {
      const sessionKey = s.key || `${s.client}:${s.sessionId}`;
      const currentSessions = state.stats?.periods?.[ownershipPeriodKey]?.sessions;
      const currentSession = currentSessions && Object.hasOwn(currentSessions, sessionKey)
        ? currentSessions[sessionKey]
        : null;
      effectiveSession = reconcileSyncedSessionOwnership(s, currentSession, { allowAdoptUnowned: syncedDerivedNeedsLoad || allTimeOwnership }).session;
    } else if (!ownershipPending && (s.sourceDevice?.ambiguous === true || (s.sourceDevice && !s.sourceDevice.deviceId))) {
      effectiveSession = { ...s, deviceName: '' };
    }

    const subtitleDevice = effectiveSession.sourceDevice?.ambiguous === true
      || (effectiveSession.sourceDevice && !effectiveSession.sourceDevice.deviceId)
      ? ''
      : (effectiveSession.deviceName || effectiveSession.sourceDevice?.name);
    const groupBadge = isGroupSession && typeof sessionGroupBadgeLabel === 'function'
      ? sessionGroupBadgeLabel(effectiveSession)
      : '';
    els.drawerTitle.textContent = effectiveSession.title;
    els.drawerSubtitle.textContent = [effectiveSession.clientLabel, effectiveSession.projectLabel, groupBadge, subtitleDevice].filter(Boolean).join(' · ');
    if (els.drawerIcon && effectiveSession.iconClass) {
      els.drawerIcon.className = `dash-drawer-icon row-icon ${effectiveSession.iconClass}`;
    }
    const backHtml = payload.returnToGroup
      ? `<button type="button" class="dash-drawer-back" data-drawer-back="true">← ${escapeHtml(payload.returnToGroup.title || payload.returnToGroup.projectLabel || payload.returnToGroup.clientLabel || '')}</button>`
      : '';
    const baseGrid = backHtml + drawerStatGrid([
      [t('dashboard.hero.tokens'), formatCompact(effectiveSession.totalTokens)],
      [t('dashboard.hero.cost'), formatCost(effectiveSession.costUsd, effectiveSession.unpricedTokens)],
      [t('dashboard.sessions.context'), effectiveSession.context ? `${effectiveSession.context.percentUsed}%` : '—'],
      [t('dashboard.sessions.cacheWarm'), effectiveSession.promptCache ? t('session.cacheEstimate', { minutes: effectiveSession.promptCache.minutes }) : '—']
    ]);

    if (isGroupSession) {
      state.drawer = {
        ...payload,
        session: effectiveSession,
        groupMembers: effectiveSession.groupRows,
        rawGroupSession: effectiveSession,
        pendingOwnershipDetail: false,
        detailRequested: false
      };
      els.drawerBody.innerHTML = baseGrid + renderGroupMembersSection(effectiveSession);
      if (typeof applySwatchColors === 'function') applySwatchColors(els.drawerBody);
      return;
    }

    els.drawerBody.innerHTML = baseGrid;
    const baseDrawer = {
      ...payload,
      session: effectiveSession,
      pendingOwnershipDetail: false,
      detailRequested: false,
      detailPeriodKey: ownershipPeriodKey,
      detailSource: state.stats?.snapshot?.source ?? null,
      detailSourceGen: statsSourceGeneration,
      detailToken: token,
      detailBaseGrid: baseGrid
    };
    state.drawer = baseDrawer;

    if (!isRemoteSession(effectiveSession)) {
      if (ownershipPending) {
        state.drawer = {
          ...baseDrawer,
          pendingOwnershipDetail: true
        };
        if (allTimeOwnership) allTimeSessions?.ensure();
        else ensureSyncedSessionPages(ownershipPeriodKey);
      } else {
        state.drawer = {
          ...baseDrawer,
          detailRequested: true
        };
        loadSessionDrawerDetail(effectiveSession, token, baseGrid);
      }
    }
  }
}

function refreshActiveHover() {
  const isOpen = els.tooltip.matches?.(':popover-open') || !els.tooltip.classList?.contains('hidden');
  if (!activeHover || !isOpen) return;
  if (activeHover.kind === 'heat' && activeHover.date) {
    const day = state.dayMap?.get(activeHover.date);
    const hit = findByDataset(els.heatmap, '.heat[data-d], .iso-col[data-d]', (el) => el.getAttribute('data-d') === activeHover.date);
    if (hit) {
      hit.setAttribute('data-active', 'true');
      const anchor = hit.querySelector('.iso-face-top') || hit;
      showHeatTooltip(activeHover.date, day, anchor);
    } else hideTooltip();
  } else if (activeHover.kind === 'ribbon' && activeHover.id) {
    const seg = findByDataset(els.heroRibbon, '.dash-ribbon-seg[data-tip-id]', (el) => el.getAttribute('data-tip-id') === activeHover.id);
    if (seg) showRibbonTooltip(seg);
    else hideTooltip();
  } else if (activeHover.kind === 'topo' && state.stageView === 'flow') {
    const node = findByDataset(
      els.topology,
      '.topo-node[data-topo-kind]',
      (el) => el.dataset.topoKind === activeHover.nodeKind && el.dataset.topoId === activeHover.nodeId
    );
    if (node) {
      applyTopologyFocus(activeHover.nodeKind, activeHover.nodeId);
      showTopologyTooltip(activeHover.nodeKind, activeHover.nodeId, node);
    } else {
      clearTopologyFocus();
      hideTooltip();
    }
  } else if (activeHover.kind === 'trend' && state.chartKind === activeHover.chartKind) {
    const candles = state.chartKind === 'candle';
    const entries = candles ? state.chartModel?.candles : state.chartModel?.bars;
    const index = entries?.findIndex(entry => (candles ? entry.key : entry.label) === activeHover.key) ?? -1;
    const anchor = index >= 0 ? els.chart.querySelector(`.bar-hover[data-i="${index}"]`) : null;
    if (anchor) (candles ? showCandleTooltip : showBarTooltip)(entries[index], anchor);
    else hideTooltip();
  }
}

let localSessionActivity = null;
let latestBaseStats = null;
let latestAcceptedSnapshot = null;
let statsPushSeq = 0;
let statsSourceGeneration = 0;
const syncedSessionPagesByPeriod = new Map();
const syncedSessionPagesRequests = new Map();

function applyLocalSessionActivity(stats) {
  const incoming = localSessionActivity;
  if (!stats || !incoming || !sessionActivityProjectionApi?.applyActivityPatch) return stats;
  if (incoming.snapshot?.id !== stats.snapshot?.id
    || incoming.snapshot?.source !== stats.snapshot?.source) {
    return stats;
  }
  let patch = incoming.patch;
  if (state.settings?.sessionTitlesEnabled === false && patch?.nativeSessions && sessionTitleDisplayApi?.withoutSessionTitles) {
    const redactedNative = Object.fromEntries(
      Object.entries(patch.nativeSessions).map(([periodName, sessions]) => [
        periodName,
        sessionTitleDisplayApi.withoutSessionTitles(sessions)
      ])
    );
    patch = { ...patch, nativeSessions: redactedNative };
  }
  const patched = sessionActivityProjectionApi.applyActivityPatch(stats, patch);
  if (state.settings?.sessionTitlesEnabled === false && sessionTitleDisplayApi?.withoutSessionTitleStats) {
    return sessionTitleDisplayApi.withoutSessionTitleStats(patched);
  }
  return patched;
}

function isSyncedDerivedPeriod(periodKey) {
  return Boolean(typeof fixedPeriodRangesApi !== 'undefined' && fixedPeriodRangesApi?.isDerived?.(periodKey));
}

function isSyncedSessionPeriodKey(periodKey) {
  return periodKey === 'today' || periodKey === 'month' || periodKey === 'allTime' || isSyncedDerivedPeriod(periodKey);
}

function syncedPeriodCalendarKey(stats, periodKey) {
  const devices = (stats.devices || []).map(device => [
    String(device.deviceId || device.id || ''),
    fixedPeriodRangesApi.deviceDayState(device)?.currentKey || device.periodWindows?.today?.key || ''
  ]);
  return JSON.stringify([stats.snapshot?.source, periodKey, fixedPeriodRangesApi.localDayKey(), devices.sort()]);
}

function syncedSessionPagesRevisionsKey(stats, periodKey) {
  if (!stats?.snapshot) return '';
  const revisions = stats.fixedRangeRevisions || {};
  if (!Object.keys(revisions).length && !stats.localFixedRangeRevision) return '';
  if (isSyncedDerivedPeriod(periodKey)) {
    const dayKeys = (stats.devices || []).map((d) => {
      const id = String(d?.deviceId || d?.id || '');
      const hasRev = Object.hasOwn(revisions, id) && Boolean(revisions[id]);
      return [id, hasRev ? '' : (d?.updatedAt || '')];
    });
    return JSON.stringify([
      stats.snapshot.source,
      periodKey,
      Object.entries(revisions).sort(),
      stats.localFixedRangeRevision || '',
      stats.deviceHistoryRevision || '',
      dayKeys.sort(),
      syncedPeriodCalendarKey(stats, periodKey),
      state.settings?.sessionTitlesEnabled !== false,
      state.settings?.syncWeekStartsOn || ''
    ]);
  }
  return JSON.stringify([
    stats.snapshot.source,
    periodKey,
    Object.entries(revisions).sort(),
    stats.localFixedRangeRevision || ''
  ]);
}

function syncedSessionPagesKeyFor(stats, periodKey) {
  const derived = isSyncedDerivedPeriod(periodKey);
  if (!derived && periodKey !== 'today' && periodKey !== 'month') return '';
  if (!stats?.snapshot) return '';
  if (!derived && !(stats?.sessionDetailsOmitted?.[periodKey] > 0)) return '';
  const activeMode = String(stats?.mode || state.statsMode || '').trim();
  const hasDevices = Array.isArray(stats?.devices) && stats.devices.length > 0;
  if (activeMode === 'local' || (!activeMode && !hasDevices && state.settings?.hubMode === 'local')) return '';
  const revisionsKey = syncedSessionPagesRevisionsKey(stats, periodKey);
  if (!revisionsKey) return '';
  return derived ? revisionsKey : `${stats.snapshot.id}:${revisionsKey}`;
}

function isSyncedSessionPagesLoaded(stats = state.stats, periodKey = state.periodKey) {
  const key = syncedSessionPagesKeyFor(stats, periodKey);
  const entry = syncedSessionPagesByPeriod.get(periodKey);
  return Boolean(key && entry?.key === key && (!entry.derived || entry.detailsAvailable));
}

function resolvedSyncedPageSession(stats, periodKey, sessionKey) {
  if (!sessionKey || !isSyncedSessionPagesLoaded(stats, periodKey)) return null;
  const entry = syncedSessionPagesByPeriod.get(periodKey);
  if (!entry?.sessions || !Object.hasOwn(entry.sessions, sessionKey)) return null;
  return entry.sessions[sessionKey] || null;
}

function attachSyncedSessionPages(stats) {
  if (!stats?.snapshot || !syncedSessionPagesByPeriod.size) return stats;
  let nextStats = stats;
  for (const [periodKey, entry] of [...syncedSessionPagesByPeriod.entries()]) {
    const revisionsKey = syncedSessionPagesRevisionsKey(stats, periodKey);
    if (entry?.derived === true) {
      // Keep the last available projection during a refresh of the same calendar range.
      // The exact revision check still blocks transcript reads while ownership is pending.
      if (!revisionsKey || entry.calendarKey !== syncedPeriodCalendarKey(stats, periodKey)) {
        syncedSessionPagesByPeriod.delete(periodKey);
        continue;
      }
      const rawPeriod = entry.period;
      if (!rawPeriod || typeof rawPeriod !== 'object') continue;
      const attachedSessions = state.settings?.sessionTitlesEnabled === false && sessionTitleDisplayApi?.withoutSessionTitles && rawPeriod.sessions
        ? sessionTitleDisplayApi.withoutSessionTitles(rawPeriod.sessions)
        : rawPeriod.sessions;
      const attachedPeriod = attachedSessions === rawPeriod.sessions
        ? rawPeriod
        : { ...rawPeriod, sessions: attachedSessions };
      const devPeriodsById = new Map(
        (entry.devices || []).map((d) => [String(d?.deviceId || d?.id || '').trim(), d?.period || null])
      );
      const nextDevices = devPeriodsById.size > 0 && Array.isArray(nextStats.devices)
        ? nextStats.devices.map((dev) => {
            const devId = String(dev?.deviceId || dev?.id || '').trim();
            const devPeriod = devPeriodsById.get(devId);
            return devPeriod
              ? { ...dev, periods: { ...(dev.periods || {}), [periodKey]: devPeriod } }
              : dev;
          })
        : nextStats.devices;
      nextStats = {
        ...nextStats,
        ...(nextDevices !== nextStats.devices ? { devices: nextDevices } : {}),
        periods: {
          ...(nextStats.periods || {}),
          [periodKey]: attachedPeriod
        },
        syncedFixedPeriodDeviceWindows: {
          ...(nextStats.syncedFixedPeriodDeviceWindows || {}),
          [periodKey]: Object.fromEntries(entry.devices.filter(device => device.range)
            .map(device => [device.deviceId, device.range]))
        },
        syncedFixedPeriodDetailsAvailable: {
          ...(nextStats.syncedFixedPeriodDetailsAvailable || {}),
          [periodKey]: entry.detailsAvailable === true
        },
        ...(entry.range ? {
          nativeRangeWindows: {
            ...(nextStats.nativeRangeWindows || {}),
            [periodKey]: entry.range
          }
        } : {})
      };
      continue;
    }
    if (!(stats.sessionDetailsOmitted?.[periodKey] > 0) || !revisionsKey || entry.revisionsKey !== revisionsKey) {
      syncedSessionPagesByPeriod.delete(periodKey);
      continue;
    }
    const period = nextStats.periods?.[periodKey];
    if (!period || typeof period !== 'object') continue;
    const paged = state.settings?.sessionTitlesEnabled === false && sessionTitleDisplayApi?.withoutSessionTitles
      ? sessionTitleDisplayApi.withoutSessionTitles(entry.sessions)
      : entry.sessions;
    if (!paged || typeof paged !== 'object') continue;
    const inlineSessions = period.sessions || {};
    const mergedSessions = {};
    for (const [sessionKey, pagedSession] of Object.entries(paged)) {
      const inlineSession = inlineSessions[sessionKey];
      const sourceDevice = pagedSession?.sourceDevice?.ambiguous === true
        ? pagedSession.sourceDevice
        : (inlineSession?.sourceDevice?.ambiguous === true
          ? inlineSession.sourceDevice
          : (pagedSession?.sourceDevice || null));
      mergedSessions[sessionKey] = {
        ...(inlineSession || {}),
        ...pagedSession,
        sourceDevice
      };
    }
    nextStats = {
      ...nextStats,
      periods: {
        ...nextStats.periods,
        [periodKey]: {
          ...period,
          sessions: mergedSessions
        }
      }
    };
  }
  return nextStats;
}

function syncOpenSessionDrawer(periodKey, periodSessions, snapshot) {
  if (state.drawer?.kind !== 'session'
    || state.drawer.session?.sessionGroup
    || state.drawer.session?.isNativeLocal === true
    || !isSyncedSessionPeriodKey(periodKey)
    || state.drawer.detailPeriodKey !== periodKey
    || state.drawer.detailSourceGen !== statsSourceGeneration
    || (state.drawer.detailSource != null && state.drawer.detailSource !== snapshot?.source)
    || (typeof drawerRequestToken === 'number' && state.drawer.detailToken !== drawerRequestToken)) {
    return;
  }
  const syncedContext = typeof isSyncedStatsContext === 'function'
    ? isSyncedStatsContext(state.stats, state.settings, state.statsMode)
    : false;
  if (state.drawer.pendingOwnershipDetail !== true && !syncedContext) {
    return;
  }
  const prevSession = state.drawer.session;
  const sessionKey = prevSession.key || `${prevSession.client}:${prevSession.sessionId}`;
  const rawEntry = periodSessions && Object.hasOwn(periodSessions, sessionKey)
    ? periodSessions[sessionKey]
    : null;
  const wasPending = state.drawer.pendingOwnershipDetail === true;
  const { session: resolvedSession } = reconcileSyncedSessionOwnership(prevSession, rawEntry, {
    allowAdoptUnowned: wasPending
  });
  const displayDevice = resolvedSession.sourceDevice?.ambiguous === true
    || (resolvedSession.sourceDevice && !resolvedSession.sourceDevice.deviceId)
    ? ''
    : (resolvedSession.deviceName || resolvedSession.sourceDevice?.name || '');
  if (typeof els !== 'undefined' && els?.drawerSubtitle) {
    els.drawerSubtitle.textContent = [
      resolvedSession.clientLabel,
      resolvedSession.projectLabel,
      displayDevice
    ].filter(Boolean).join(' · ');
  }
  const omissionsUnresolved = typeof hasUnresolvedSyncedOmissions === 'function'
    ? hasUnresolvedSyncedOmissions(state.stats, periodKey)
    : false;
  const stillConfirmedLocal = typeof isRemoteSession === 'function'
    && !isRemoteSession(resolvedSession)
    && !omissionsUnresolved;
  if (!stillConfirmedLocal) {
    if (state.drawer.detailRequested === true) {
      if (typeof drawerRequestToken === 'number') drawerRequestToken += 1;
      if (typeof els !== 'undefined' && els?.drawerBody && typeof state.drawer.detailBaseGrid === 'string') {
        els.drawerBody.innerHTML = state.drawer.detailBaseGrid;
      }
    }
    state.drawer = {
      ...state.drawer,
      session: resolvedSession,
      pendingOwnershipDetail: false,
      detailRequested: false,
      detailToken: typeof drawerRequestToken === 'number' ? drawerRequestToken : state.drawer.detailToken
    };
  } else if (wasPending && typeof loadSessionDrawerDetail === 'function') {
    state.drawer = {
      ...state.drawer,
      session: resolvedSession,
      pendingOwnershipDetail: false,
      detailRequested: true,
      detailToken: typeof drawerRequestToken === 'number' ? drawerRequestToken : state.drawer.detailToken
    };
    loadSessionDrawerDetail(resolvedSession, drawerRequestToken, state.drawer.detailBaseGrid);
  } else {
    state.drawer = {
      ...state.drawer,
      session: resolvedSession,
      pendingOwnershipDetail: false
    };
  }
}

function ensureSyncedSessionPages(targetPeriodKey = state.periodKey) {
  if (typeof window.tokenMonitor?.getSyncedFixedPeriod !== 'function') return;
  const snapshot = state.stats?.snapshot;
  const periodKey = targetPeriodKey;
  const derived = isSyncedDerivedPeriod(periodKey);
  const key = syncedSessionPagesKeyFor(state.stats, periodKey);
  const revisionsKey = syncedSessionPagesRevisionsKey(state.stats, periodKey);
  if (!key || !revisionsKey || !snapshot) return;
  const existing = syncedSessionPagesByPeriod.get(periodKey);
  if (existing?.key === key && (!derived || existing.detailsAvailable)) return;
  const pending = syncedSessionPagesRequests.get(periodKey);
  if (pending && (derived || pending.key === key)) return;
  const request = { key };
  const calendarKey = derived ? syncedPeriodCalendarKey(state.stats, periodKey) : '';
  syncedSessionPagesRequests.set(periodKey, request);
  void Promise.resolve()
    .then(() => window.tokenMonitor.getSyncedFixedPeriod(snapshot.id, snapshot.source, periodKey))
    .then((result) => {
      if (syncedSessionPagesRequests.get(periodKey) !== request) return;
      syncedSessionPagesRequests.delete(periodKey);
      if (syncedSessionPagesKeyFor(state.stats, periodKey) !== key) {
        if (state.periodKey === periodKey) ensureSyncedSessionPages();
        return;
      }
      if (derived && result?.period && result.status === 'ready') {
        // Preserve a complete projection through a temporary failure. Partial totals
        // are still useful on a cold load, and the next refresh can retry this revision.
        if (result.detailsAvailable !== true && existing?.detailsAvailable && existing.calendarKey === calendarKey) return;
        syncedSessionPagesByPeriod.set(periodKey, {
          key,
          revisionsKey,
          derived: true,
          calendarKey,
          snapshot: { id: snapshot.id, source: snapshot.source },
          period: result.period,
          devices: Array.isArray(result.devices) ? result.devices : [],
          range: result.range || null,
          detailsAvailable: result.detailsAvailable === true,
          sessions: result.period.sessions || {}
        });
        const attached = attachSyncedSessionPages(allTimeSessions ? allTimeSessions.attach(state.stats) : state.stats);
        state.stats = applyLocalSessionActivity(attached);
        state.motion = 'update';
        render();
        if (result.detailsAvailable) syncOpenSessionDrawer(periodKey, result.period.sessions || null, snapshot);
      } else if (!derived && result?.detailsAvailable && result?.period?.sessions) {
        syncedSessionPagesByPeriod.set(periodKey, {
          key,
          revisionsKey,
          snapshot: { id: snapshot.id, source: snapshot.source },
          sessions: result.period.sessions
        });
        const attached = attachSyncedSessionPages(allTimeSessions ? allTimeSessions.attach(state.stats) : state.stats);
        state.stats = applyLocalSessionActivity(attached);
        state.motion = 'update';
        render();
        syncOpenSessionDrawer(periodKey, result.period.sessions, snapshot);
      }
    }, () => {
      if (syncedSessionPagesRequests.get(periodKey) === request) syncedSessionPagesRequests.delete(periodKey);
    });
}

const allTimeSessions = allTimeSessionsApi?.createAllTimeSessionsLoader
  ? allTimeSessionsApi.createAllTimeSessionsLoader({
      fetchSessions: (snapshotId) => window.tokenMonitor.getAllTimeSessions(snapshotId),
      currentSnapshot: () => state.stats?.snapshot,
      needed: () => (state.periodKey === 'allTime' || state.drawer?.detailPeriodKey === 'allTime')
        && typeof window.tokenMonitor?.getAllTimeSessions === 'function',
      projectSessions: (sessions) => (
        state.settings?.sessionTitlesEnabled === false && sessionTitleDisplayApi?.withoutSessionTitles
          ? sessionTitleDisplayApi.withoutSessionTitles(sessions)
          : sessions
      ),
      projectionKey: () => state.settings?.sessionTitlesEnabled !== false,
      onLoaded: () => {
        if (!state.stats) return;
        const attached = allTimeSessions.attach(state.stats);
        state.stats = applyLocalSessionActivity(attachSyncedSessionPages(attached));
        if (allTimeSessions.current()) syncOpenSessionDrawer('allTime', state.stats.periods?.allTime?.sessions, state.stats.snapshot);
        state.motion = 'update';
        render();
      },
      onError: (error) => console.log(`[dashboard] all-time sessions failed: ${error?.message || error}`)
    })
  : null;

function isStaleStatsSnapshot(nextStats, expectedPushSeq = null, { fromPush = false } = {}) {
  const prev = latestAcceptedSnapshot || state.stats?.snapshot || null;
  const next = nextStats?.snapshot || null;
  if (prev && next) {
    if (typeof prev.source === 'number' && typeof next.source === 'number' && next.source < prev.source) {
      return true;
    }
    if (prev.source === next.source && typeof prev.id === 'number' && typeof next.id === 'number') {
      if (next.id < prev.id) return true;
      if (!fromPush && expectedPushSeq != null && statsPushSeq !== expectedPushSeq && next.id === prev.id) {
        return true;
      }
    }
    return false;
  }
  if (!fromPush && expectedPushSeq != null && statsPushSeq !== expectedPushSeq) {
    return true;
  }
  return false;
}

function shouldAcceptPulledHistory(pulledStats, statsAccepted, { pullSource = null, pullSourceGen = statsSourceGeneration } = {}) {
  if (statsSourceGeneration !== pullSourceGen) return false;
  const currentSource = latestAcceptedSnapshot?.source ?? state.stats?.snapshot?.source ?? null;
  if (pulledStats?.snapshot?.source != null && currentSource != null && pulledStats.snapshot.source !== currentSource) {
    return false;
  }
  if (pullSource != null && currentSource != null && currentSource !== pullSource && !statsAccepted) {
    return false;
  }
  return true;
}

function applyIncomingStats(nextStats, { expectedPushSeq = null, fromPush = false, mode = '' } = {}) {
  if (!nextStats || isStaleStatsSnapshot(nextStats, expectedPushSeq, { fromPush })) {
    return false;
  }
  const prevSnap = latestAcceptedSnapshot || state.stats?.snapshot || null;
  const nextSnap = nextStats?.snapshot || null;
  const sourceChanged = Boolean(prevSnap && nextSnap && prevSnap.source !== nextSnap.source);
  if (sourceChanged) {
    statsSourceGeneration += 1;
    state.statsMode = mode || nextStats?.mode || '';
    state.history = null;
    localSessionActivity = null;
    syncedSessionPagesByPeriod.clear();
    syncedSessionPagesRequests.clear();
    if (state.drawer) closeDrawer();
    deviceRateTracker?.reset?.();
    rateHistory?.reset?.();
    deviceRateTrackers.clear();
    if (rateExpiryTimer) {
      clearTimeout(rateExpiryTimer);
      rateExpiryTimer = null;
    }
    if (typeof refreshQueued !== 'undefined') refreshQueued = true;
    if (typeof dashboardReady !== 'undefined' && dashboardReady && !document.hidden
      && (typeof refreshRunning === 'undefined' || !refreshRunning)) {
      scheduleDashboardRefresh();
    }
  } else if (mode || nextStats?.mode) {
    state.statsMode = mode || nextStats.mode;
  }
  if (nextSnap) {
    latestAcceptedSnapshot = { id: nextSnap.id, source: nextSnap.source };
  }
  if (fromPush) {
    statsPushSeq += 1;
  }
  allTimeSessions?.invalidate?.();
  latestBaseStats = nextStats;
  const withAllTime = allTimeSessions ? allTimeSessions.attach(nextStats) : nextStats;
  const withPages = attachSyncedSessionPages(withAllTime);
  state.stats = applyLocalSessionActivity(withPages);
  observeStatsRates(state.stats);
  allTimeSessions?.ensure?.();
  ensureSyncedSessionPages();
  const syncedCtx = typeof isSyncedStatsContext === 'function'
    ? isSyncedStatsContext(state.stats, state.settings, state.statsMode)
    : false;
  if (state.drawer?.kind === 'session'
    && !state.drawer.session?.sessionGroup
    && state.drawer.session?.isNativeLocal !== true
    && (typeof isSyncedSessionPeriodKey === 'function' ? isSyncedSessionPeriodKey(state.drawer.detailPeriodKey) : (state.drawer.detailPeriodKey === 'today' || state.drawer.detailPeriodKey === 'month'))
    && state.drawer.detailSourceGen === statsSourceGeneration
    && (state.drawer.detailSource == null || state.drawer.detailSource === state.stats?.snapshot?.source)
    && (state.drawer.pendingOwnershipDetail === true || syncedCtx)) {
    const drawerPeriodKey = state.drawer.detailPeriodKey;
    const stillPending = typeof hasPendingSyncedOwnership === 'function'
      ? hasPendingSyncedOwnership(state.stats, drawerPeriodKey)
      : (state.stats?.sessionDetailsOmitted?.[drawerPeriodKey] > 0 && !isSyncedSessionPagesLoaded(state.stats, drawerPeriodKey));
    if (stillPending) {
      if (state.drawer.detailRequested === true) {
        if (typeof drawerRequestToken === 'number') drawerRequestToken += 1;
        if (typeof els !== 'undefined' && els?.drawerBody && typeof state.drawer.detailBaseGrid === 'string') {
          els.drawerBody.innerHTML = state.drawer.detailBaseGrid;
        }
        state.drawer = {
          ...state.drawer,
          pendingOwnershipDetail: true,
          detailRequested: false,
          detailToken: drawerRequestToken
        };
      }
      if (state.drawer.pendingOwnershipDetail === true && drawerPeriodKey !== state.periodKey) {
        ensureSyncedSessionPages(drawerPeriodKey);
      }
    } else {
      const stillOmitted = state.stats?.sessionDetailsOmitted?.[drawerPeriodKey] > 0;
      const authoritativeSessions = stillOmitted
        ? (syncedSessionPagesByPeriod.get(drawerPeriodKey)?.sessions || null)
        : (state.stats?.periods?.[drawerPeriodKey]?.sessions || null);
      syncOpenSessionDrawer(drawerPeriodKey, authoritativeSessions, state.stats?.snapshot || null);
    }
  }
  return true;
}

function renderNow() {
  const sample = deviceRateTracker?.getSample?.() || null;
  const deviceRateSamples = {};
  const rateSamplesByDevice = {};
  for (const [devId, devState] of deviceRateTrackers.entries()) {
    const devSample = devState.tracker.getSample?.();
    if (devSample) deviceRateSamples[devId] = devSample;
    rateSamplesByDevice[devId] = devState.history.getSamples?.() || [];
  }
  const overview = modelApi?.buildScopedOverview?.({
    stats: state.stats,
    history: state.history,
    periodKey: state.periodKey,
    selectedDeviceId: state.selectedDeviceId,
    settings: state.settings,
    statsMode: state.statsMode,
    liveRatesByDevice: currentLiveRatesByDevice(),
    rateSample: sample,
    deviceRateSamples,
    rateSamples: rateHistory?.getSamples?.() || [],
    rateSamplesByDevice,
    syncedPagesLoaded: isSyncedSessionPagesLoaded(),
    rateMode: state.rateMode,
    sessionLabels: {
      subagent: t('sessions.subagent'),
      subagentCount: (count) => t('sessions.subagentCount', { count }),
      backgroundReviews: t('sessions.backgroundReviews'),
      backgroundReviewCount: (count) => t('sessions.backgroundReviewCount', { count }),
      grokBot: t('sessions.grokBot'),
      grokBotCount: (count) => t('sessions.grokBotCount', { count })
    }
  }) || null;
  state.overview = overview;
  if (overview?.fleet && state.selectedDeviceId !== 'all') {
    const hasSelected = overview.fleet.isFleetMode && Boolean(overview.activeMachine);
    if (!hasSelected) {
      state.selectedDeviceId = 'all';
    }
  }

  renderDeviceSelector(overview?.fleet);

  const hasHistory = (state.history?.daily || []).length > 0 || (state.history?.monthly || []).length > 0;
  const hasStats = Boolean(overview && overview.hero.tokens > 0);
  els.empty.classList.toggle('hidden', hasHistory || hasStats);
  els.trendsPane.classList.toggle('hidden', state.tab !== 'trends');
  els.activityPane.classList.toggle('hidden', state.tab !== 'activity');

  els.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  els.stackBtns.forEach((b) => b.classList.toggle('active', b.dataset.stack === state.stackBy));
  els.trendMetricBtns.forEach((b) => b.classList.toggle('active', b.dataset.tmetric === state.trendMetric));
  els.stageViewBtns.forEach((b) => {
    const active = b.dataset.view === state.stageView;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  els.heatmapMetricBtns.forEach((b) => {
    const active = b.dataset.val === state.heatmapMetric;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  els.skylineColorBtns?.forEach((b) => {
    const active = b.dataset.color === state.skylineColorMode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  els.breakdownModeBtns.forEach((b) => {
    const active = b.dataset.bd === state.breakdownMode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  els.workModeBtns.forEach((b) => {
    const active = b.dataset.work === state.workMode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  document.querySelector('[data-control="stack"]')?.classList.toggle('hidden', state.mode === 'kline');

  if (state.tab === 'trends') {
    heatmapMotionGeneration += 1;
    els.heatmap.classList.remove('is-motion-pending');
    renderTrends();
    renderDailyLedger(overview);
  } else {
    renderActivity(overview);
  }

  syncAllSegIndicators({ animate: !prefersReducedMotion() });
  if (lastRenderedTab !== state.tab) {
    lastRenderedTab = state.tab;
    const targets = state.tab === 'trends'
      ? els.trendsPane.querySelectorAll('.dash-trends-open, .dash-ledger-open')
      : els.activityPane.querySelectorAll('.dash-hero-band, .dash-visual-band, .dash-cards, .dash-lower-band');
    animateSectionReveal(targets);
  }

  refreshActiveHover();
  scheduleRateExpiry?.();
  state.motion = 'none';
}

const dashboardRenderScheduler = statsRenderSchedulerApi.createStatsRenderScheduler({
  isHidden: () => dashboardReady && document.hidden,
  render: renderNow
});

function render() {
  dashboardRenderScheduler.request();
}

function scheduleDashboardRefresh() {
  if (dashboardRefreshFrame) cancelAnimationFrame(dashboardRefreshFrame);
  dashboardRefreshFrame = requestAnimationFrame(() => {
    dashboardRefreshFrame = 0;
    if (document.hidden || refreshRunning) return;
    refreshQueued = false;
    void refresh();
  });
}

function handleDashboardVisibilityChange() {
  if (!dashboardRenderScheduler.visibilityChanged()) return;
  if (!document.hidden) {
    dashboardRenderScheduler.flush();
    scheduleDashboardRefresh();
    if (typeof scheduleRateExpiry === 'function') scheduleRateExpiry();
    return;
  }
  if (dashboardRefreshFrame) cancelAnimationFrame(dashboardRefreshFrame);
  dashboardRefreshFrame = 0;
  if (typeof rateExpiryTimer !== 'undefined' && rateExpiryTimer) {
    clearTimeout(rateExpiryTimer);
    rateExpiryTimer = null;
  }
}

document.addEventListener('visibilitychange', handleDashboardVisibilityChange);

function hideTooltip() {
  activeHover = null;
  if (els.tooltip.dataset) els.tooltip.dataset.visible = 'false';
  els.tooltip.setAttribute?.('aria-hidden', 'true');
  if (typeof els.tooltip.hidePopover === 'function' && els.tooltip.matches?.(':popover-open')) {
    try { els.tooltip.hidePopover(); } catch (_) {}
  }
  els.tooltip.classList?.add('hidden');
  if (els.tooltip.style) els.tooltip.style.transform = 'translate3d(-9999px, -9999px, 0)';
}

function positionTooltip(evOrAnchor) {
  els.tooltip.classList?.remove('hidden');
  if (typeof els.tooltip.showPopover === 'function' && !els.tooltip.matches?.(':popover-open')) {
    try { els.tooltip.showPopover(); } catch (_) {}
  }
  if (els.tooltip.dataset) els.tooltip.dataset.visible = 'true';
  els.tooltip.setAttribute?.('aria-hidden', 'false');
  const tipRect = typeof els.tooltip.getBoundingClientRect === 'function'
    ? els.tooltip.getBoundingClientRect()
    : { width: 140, height: 48 };
  const rectWidth = tipRect.width || 0;
  const rectHeight = tipRect.height || 0;

  let anchorX;
  let anchorY;
  let bottomY;
  if (evOrAnchor && typeof evOrAnchor.getBoundingClientRect === 'function') {
    const r = evOrAnchor.getBoundingClientRect();
    anchorX = r.left + r.width / 2;
    anchorY = r.top;
    bottomY = r.bottom;
  } else if (evOrAnchor && evOrAnchor.left !== undefined && evOrAnchor.top !== undefined) {
    anchorX = evOrAnchor.left + (evOrAnchor.width || 0) / 2;
    anchorY = evOrAnchor.top;
    bottomY = evOrAnchor.bottom ?? evOrAnchor.top;
  } else if (evOrAnchor && evOrAnchor.x !== undefined && evOrAnchor.y !== undefined) {
    anchorX = evOrAnchor.x;
    anchorY = evOrAnchor.y;
    bottomY = evOrAnchor.y;
  } else {
    anchorX = Number(evOrAnchor?.clientX || 0);
    anchorY = Number(evOrAnchor?.clientY || 0);
    bottomY = anchorY;
  }

  const gap = 11;
  const winW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;
  const x = Math.max(8, Math.min(winW - 8 - rectWidth, anchorX - rectWidth / 2));
  const aboveY = anchorY - gap - rectHeight;
  const y = Math.max(8, Math.min(winH - 8 - rectHeight, aboveY >= 8 ? aboveY : (bottomY + gap)));

  if (els.tooltip.style) {
    els.tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }
}

function showBarTooltip(bar, ev) {
  const formatVal = typeof state !== 'undefined' && state?.trendMetric === 'cost' ? formatCost : formatCompact;
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  if (bar.hasRecord === false) {
    els.tooltip.innerHTML = `<div class="tt-head">${esc(shortDate(bar.label))} · ${esc(t('dashboard.noRecord'))}</div>`;
    positionTooltip(ev);
    return;
  }
  const segs = bar.segments.slice().reverse();
  const rows = segs.map((s) =>
    `<div class="tt-row"><span class="tt-dot" data-c="${esc(colorFor(s.key))}"></span><span class="tt-name">${esc(s.key)}</span><span class="tt-val">${esc(formatVal(s.value))}</span></div>`
  ).join('');
  els.tooltip.innerHTML = `<div class="tt-head">${esc(shortDate(bar.label))} · ${esc(formatVal(bar.total))}</div>${rows}`;
  applySwatchColors(els.tooltip);
  positionTooltip(ev);
}

function showCandleTooltip(c, ev) {
  const formatVal = typeof state !== 'undefined' && state?.trendMetric === 'cost' ? formatCost : formatCompact;
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const head = c.endKey && c.endKey !== c.key ? `${longDate(c.key)} – ${longDate(c.endKey)}` : longDate(c.key);
  if (c.hasRecord === false) {
    els.tooltip.innerHTML = `<div class="tt-head">${esc(head)}</div><div class="tt-row"><span class="tt-name">${esc(t('dashboard.noRecord'))}</span></div>`;
    positionTooltip(ev);
    return;
  }
  const ohlc = [['O', c.open], ['H', c.high], ['L', c.low], ['C', c.close]];
  els.tooltip.innerHTML = `<div class="tt-head">${esc(head)}</div>`
    + ohlc.map(([k, v]) => `<div class="tt-row"><span class="tt-name">${esc(k)}</span><span class="tt-val">${esc(formatVal(v))}</span></div>`).join('');
  positionTooltip(ev);
}

function showHeatTooltip(date, day, evOrCell) {
  const make = (className, text = '') => {
    const node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    return node;
  };
  const row = (label, value, color) => {
    const node = make('tt-row');
    if (color) {
      const swatch = make('tt-dot');
      swatch.style.backgroundColor = displayColor(color);
      node.append(swatch);
    }
    node.append(make('tt-name', label), make('tt-val', value));
    return node;
  };
  const tokens = day?.tokens || 0;
  const cost = day?.cost || 0;
  const missing = Number(day?.unpricedTokens || 0);
  const content = [
    make('tt-head', longDate(date)),
    row(t('dashboard.heatmap.tokens'), formatCompact(tokens))
  ];
  if (cost > 0 || missing > 0) content.push(row(t('dashboard.heatmap.cost'), formatCost(cost, missing)));
  if (day?.topClient?.label) {
    content.push(row(t('dashboard.ledger.topTool'), day.topClient.label, day.topClient.color));
  }
  if (missing > 0) {
    content.push(make('tt-sub', t('usage.excludedFromCost', { tokens: Math.round(missing).toLocaleString('en-US') })));
  }
  els.tooltip.replaceChildren(...content);
  positionTooltip(evOrCell);
}

function showRibbonTooltip(seg) {
  const name = seg.getAttribute('data-tip-name') || '';
  const val = seg.getAttribute('data-tip-val') || '';
  const color = seg.getAttribute('data-c') || '#6ab4f0';
  activeHover = { kind: 'ribbon', id: seg.getAttribute('data-tip-id') || '' };
  els.tooltip.innerHTML = `<div class="tt-row"><span class="tt-dot" data-c="${escapeHtml(color)}"></span><span class="tt-name">${escapeHtml(name)}</span><span class="tt-val">${escapeHtml(val)}</span></div>`;
  applySwatchColors(els.tooltip);
  positionTooltip(seg);
}

function moveHeatmapSpotlight(x, y) {
  spotlightTarget.x = x;
  spotlightTarget.y = y;
  const gradient = els.heatmap.querySelector('#dashActivitySpotlightGradient');
  if (!gradient) return;
  if (!spotlightVisible) {
    spotlightVisible = true;
    spotlightCurrent.x = x;
    spotlightCurrent.y = y;
    gradient.setAttribute('cx', String(Math.round(x * 10) / 10));
    gradient.setAttribute('cy', String(Math.round(y * 10) / 10));
    return;
  }
  if (spotlightFrame) return;
  const step = () => {
    spotlightFrame = 0;
    const g = els.heatmap.querySelector('#dashActivitySpotlightGradient');
    if (!g) return;
    const dx = spotlightTarget.x - spotlightCurrent.x;
    const dy = spotlightTarget.y - spotlightCurrent.y;
    if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) {
      spotlightCurrent.x = spotlightTarget.x;
      spotlightCurrent.y = spotlightTarget.y;
    } else {
      spotlightCurrent.x += dx * 0.32;
      spotlightCurrent.y += dy * 0.32;
      spotlightFrame = requestAnimationFrame(step);
    }
    g.setAttribute('cx', String(Math.round(spotlightCurrent.x * 10) / 10));
    g.setAttribute('cy', String(Math.round(spotlightCurrent.y * 10) / 10));
  };
  spotlightFrame = requestAnimationFrame(step);
}

function hideHeatmapHover() {
  if (spotlightFrame) cancelAnimationFrame(spotlightFrame);
  spotlightFrame = 0;
  spotlightVisible = false;
  spotlightTarget.x = -200;
  spotlightTarget.y = -200;
  spotlightCurrent.x = -200;
  spotlightCurrent.y = -200;
  const g = els.heatmap.querySelector('#dashActivitySpotlightGradient');
  if (g) {
    g.setAttribute('cx', '-200');
    g.setAttribute('cy', '-200');
  }
  els.heatmap.querySelectorAll('[data-active="true"]').forEach((c) => c.removeAttribute('data-active'));
  if (activeHover?.kind === 'heat') hideTooltip();
}

function scheduleRateExpiry() {
  if (rateExpiryTimer) {
    clearTimeout(rateExpiryTimer);
    rateExpiryTimer = null;
  }
  if (typeof document !== 'undefined' && document.hidden) return;
  const expiries = [];
  const collect = (ts) => {
    if (Number.isFinite(ts) && ts > 0) expiries.push(ts);
  };
  collect(deviceRateTracker?.nextExpiryAt?.());
  collect(rateHistory?.nextExpiryAt?.());
  if (typeof sessionLiveApi !== 'undefined' && sessionLiveApi?.nextSessionStatusChangeAt) {
    const rows = state.overview?.sessions || [];
    collect(sessionLiveApi.nextSessionStatusChangeAt(rows.flatMap(row => (row.groupRows || [row]).map(member => member.raw))));
  }
  for (const devState of deviceRateTrackers.values()) {
    collect(devState.tracker?.nextExpiryAt?.());
    collect(devState.history?.nextExpiryAt?.());
  }
  if (!expiries.length) return;
  const earliest = Math.min(...expiries);
  const delayMs = Math.max(50, earliest - Date.now() + 20);
  rateExpiryTimer = setTimeout(() => {
    rateExpiryTimer = null;
    if (typeof document !== 'undefined' && document.hidden) return;
    state.motion = 'none';
    render();
  }, delayMs);
  rateExpiryTimer?.unref?.();
}

function observeStatsRates(stats) {
  if (!deviceRateTracker || !stats) return;
  const settings = state?.settings;
  const localId = String(stats?.localDeviceId || settings?.deviceId || '').trim();
  const devicesList = Array.isArray(stats?.devices) ? stats.devices : [];
  const activeMode = String(stats?.mode || state?.statsMode || '').trim();
  const hubMode = String(settings?.hubMode || '').trim();
  const synced = typeof isSyncedStatsContext === 'function'
    ? isSyncedStatsContext(stats, settings, state?.statsMode)
    : (devicesList.length > 1
      || (devicesList.length === 1 && (() => {
        const onlyId = String(devicesList[0]?.deviceId || devicesList[0]?.id || '').trim();
        return Boolean(onlyId && (!localId || onlyId !== localId));
      })())
      || (activeMode !== 'local' && (
        activeMode === 'sync'
        || (hubMode !== 'local' && (Boolean(hubMode) || Boolean(String(settings?.hubUrl || '').trim())))
      )));
  const entries = (stats.devices || []).map((device) => ({
    id: String(device?.deviceId || '').trim(),
    name: String(device?.displayName || device?.deviceId || '').trim(),
    period: device?.periods?.today || device?.today || null
  })).filter((entry) => entry.id && entry.period);
  if (!synced && entries.length === 0 && stats.periods?.today) {
    entries.push({ id: String(stats.localDeviceId || 'local'), name: 'Local', period: stats.periods.today });
  }
  const activeIds = new Set(entries.map((entry) => entry.id));
  for (const existingId of Array.from(deviceRateTrackers.keys())) {
    if (!activeIds.has(existingId)) deviceRateTrackers.delete(existingId);
  }
  const result = deviceRateTracker.observe(entries);
  if (result?.sample && !result.sample.idle) {
    rateHistory?.observe(result.sample);
  }
  if (entries.length > 0 && tokenRateApi?.createLiveTokenRateGroupTracker && tokenRateApi?.createLiveTokenRateHistory) {
    for (const entry of entries) {
      let devState = deviceRateTrackers.get(entry.id);
      if (!devState) {
        devState = {
          tracker: tokenRateApi.createLiveTokenRateGroupTracker({ now: Date.now, activeMs: 12_000 }),
          history: tokenRateApi.createLiveTokenRateHistory()
        };
        deviceRateTrackers.set(entry.id, devState);
      }
      const devRes = devState.tracker.observe([entry]);
      if (devRes?.sample && !devRes.sample.idle) {
        devState.history.observe(devRes.sample);
      }
    }
  }
  if (typeof scheduleRateExpiry === 'function') scheduleRateExpiry();
}

function currentLiveRatesByDevice() {
  const out = {};
  if (deviceRateTrackers.size > 0) {
    for (const [id, devState] of deviceRateTrackers.entries()) {
      const s = devState.tracker?.getSample?.();
      if (s && !s.idle && Number(s.speed) > 0) {
        out[id] = Number(s.speed);
      }
    }
    return out;
  }
  if (!deviceRateTracker) return out;
  const settings = state?.settings;
  const localId = String(state?.stats?.localDeviceId || settings?.deviceId || '').trim();
  const devicesList = Array.isArray(state?.stats?.devices) ? state.stats.devices : [];
  const activeMode = String(state?.stats?.mode || state?.statsMode || '').trim();
  const hubMode = String(settings?.hubMode || '').trim();
  const synced = typeof isSyncedStatsContext === 'function'
    ? isSyncedStatsContext(state?.stats, settings, state?.statsMode)
    : (devicesList.length > 1
      || (devicesList.length === 1 && (() => {
        const onlyId = String(devicesList[0]?.deviceId || devicesList[0]?.id || '').trim();
        return Boolean(onlyId && (!localId || onlyId !== localId));
      })())
      || (activeMode !== 'local' && (
        activeMode === 'sync'
        || (hubMode !== 'local' && (Boolean(hubMode) || Boolean(String(settings?.hubUrl || '').trim())))
      )));
  const sample = deviceRateTracker.getSample();
  if (!sample || sample.idle) return out;
  for (const dev of sample.devices || []) {
    if (!dev?.id) continue;
    const devSpeed = dev?.speed != null
      ? Number(dev.speed)
      : (sample.speed && sample.devices.length === 1
          ? sample.speed
          : Number(dev.models?.reduce((s, m) => s + Number(m.speed || 0), 0) || 0));
    if (devSpeed > 0) out[dev.id] = devSpeed;
  }
  if (Object.keys(out).length === 0 && !synced && state.stats?.localDeviceId && sample.speed > 0) {
    out[state.stats.localDeviceId] = sample.speed;
  }
  return out;
}

const REFRESH_BUTTON_FEEDBACK_MS = 1400;
let refreshFeedbackTimer = null;
let manualRefreshBusy = false;

function clearRefreshBtnFeedbackTimer() {
  if (!refreshFeedbackTimer) return;
  clearTimeout(refreshFeedbackTimer);
  refreshFeedbackTimer = null;
}

function setRefreshBtnState(status = 'idle') {
  if (!els?.refreshBtn) return;
  els.refreshBtn.classList.toggle('is-refreshing', status === 'refreshing');
  els.refreshBtn.classList.toggle('is-refreshed', status === 'refreshed');
  els.refreshBtn.classList.toggle('is-refresh-error', status === 'error');
  els.refreshBtn.disabled = status === 'refreshing';
  if (status === 'refreshing') {
    els.refreshBtn.setAttribute('aria-label', t('refreshButton.refreshing'));
    els.refreshBtn.setAttribute('aria-busy', 'true');
  } else if (status === 'refreshed') {
    els.refreshBtn.setAttribute('aria-label', t('refreshButton.refreshed'));
    els.refreshBtn.setAttribute('aria-busy', 'false');
  } else if (status === 'error') {
    els.refreshBtn.setAttribute('aria-label', t('refreshButton.failed'));
    els.refreshBtn.setAttribute('aria-busy', 'false');
  } else {
    els.refreshBtn.setAttribute('aria-label', t('refreshButton.label'));
    els.refreshBtn.removeAttribute('aria-busy');
  }
}

function settleRefreshBtnState(status) {
  clearRefreshBtnFeedbackTimer();
  setRefreshBtnState(status);
  refreshFeedbackTimer = setTimeout(() => {
    refreshFeedbackTimer = null;
    setRefreshBtnState('idle');
  }, REFRESH_BUTTON_FEEDBACK_MS);
}

let historyRequestSeq = 0;
let appliedHistoryRequestSeq = 0;

async function pullDashboardData({ manual = false } = {}) {
  const seq = ++historyRequestSeq;
  const pullPushSeq = typeof statsPushSeq === 'number' ? statsPushSeq : null;
  const pullSource = state.stats?.snapshot?.source ?? null;
  const pullSourceGen = typeof statsSourceGeneration === 'number' ? statsSourceGeneration : 0;
  let stats = null;
  let statsAccepted = false;
  let statsError;
  const readStats = async () => {
    try {
      if (typeof window.tokenMonitor.getStats !== 'function') return;
      stats = await window.tokenMonitor.getStats(manual
        ? { force: true, forceHistory: true, forceSelfSync: true, feedback: true }
        : undefined);
      if (!stats) return;
      if (typeof applyIncomingStats === 'function') {
        if (statsSourceGeneration === pullSourceGen) {
          statsAccepted = applyIncomingStats(stats, { expectedPushSeq: pullPushSeq });
        }
      } else {
        state.stats = stats;
        observeStatsRates(stats);
        statsAccepted = true;
      }
      if (statsAccepted) {
        state.motion = state.overview ? 'update' : 'entry';
        render();
      }
    } catch (error) {
      statsError = error;
    }
  };

  // A manual scan updates History in main. Read it after that scan settles.
  const statsTask = readStats();
  if (manual) await statsTask;
  const [historyResult] = await Promise.allSettled([
    Promise.resolve().then(() => window.tokenMonitor.getDashboardHistory({ includeDevices: true })),
    statsTask
  ]);
  if (historyResult.status === 'rejected') throw historyResult.reason;
  const acceptHistory = typeof shouldAcceptPulledHistory !== 'function'
    || shouldAcceptPulledHistory(stats, statsAccepted, { pullSource, pullSourceGen });
  if (seq > appliedHistoryRequestSeq && acceptHistory) {
    appliedHistoryRequestSeq = seq;
    state.history = historyResult.value;
    state.motion = state.overview ? 'update' : 'entry';
    render();
  }
  if (manual && statsError) throw statsError;
}

async function manualRefresh() {
  if (manualRefreshBusy) return;
  manualRefreshBusy = true;
  clearRefreshBtnFeedbackTimer();
  setRefreshBtnState('refreshing');
  try {
    await pullDashboardData({ manual: true });
    settleRefreshBtnState('refreshed');
  } catch (error) {
    console.log(`[dashboard] manual refresh failed: ${error.message}`);
    settleRefreshBtnState('error');
  } finally {
    manualRefreshBusy = false;
  }
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
    await pullDashboardData();
  } catch (error) {
    console.log(`[dashboard] history failed: ${error.message}`);
  } finally {
    refreshRunning = false;
    if (refreshQueued && !document.hidden) {
      refreshQueued = false;
      void refresh();
    }
  }
}

async function boot() {
  const materialPush = window.tokenMonitor.onNativeMaterialState;
  if (typeof materialPush === 'function') {
    materialPush((next) => {
      nativeMaterialRevision += 1;
      nativeMaterialState = glassRenderingApi.normalizeNativeMaterialState(next);
      glassRenderingApi.applyNativeMaterialClasses(nativeMaterialState);
      applyAppearance(state.settings || {});
    });
  }
  const materialQueryRevision = nativeMaterialRevision;
  try {
    const initialMaterial = await window.tokenMonitor.getNativeMaterialState?.();
    if (materialQueryRevision === nativeMaterialRevision && initialMaterial) {
      nativeMaterialState = glassRenderingApi.normalizeNativeMaterialState(initialMaterial);
      glassRenderingApi.applyNativeMaterialClasses(nativeMaterialState);
    }
  } catch (_) {}
  let settings = {};
  try { settings = await window.tokenMonitor.getSettings(); } catch (_) {}
  try {
    const streamStatus = await window.tokenMonitor.getStreamStatus?.();
    if (streamStatus?.mode) state.statsMode = streamStatus.mode;
  } catch (_) {}
  state.locale = i18n.resolveLocale(settings.locale || settings.language, navigator.languages);
  state.settings = settings;
  state.currency = settings.currency || 'USD';
  state.compactTokenUnits = compactTokenApi.normalizeCompactTokenUnits(settings.compactTokenUnits);
  if (settings.currencyRatesEffective && window.TokenMonitorCurrency?.configureRates) {
    window.TokenMonitorCurrency.configureRates(settings.currencyRatesEffective);
  }
  state.flat = settings.dashboardFlat === true;
  state.heatmapMetric = settings.dashboardHeatmapMetric || settings.heatmapMetric || 'cost';
  state.stageView = settings.dashboardStageView === '2d' || settings.dashboardStageView === '3d' || settings.dashboardStageView === 'flow'
    ? settings.dashboardStageView
    : 'flow';
  state.heatmapView = state.stageView === '2d' ? '2d' : '3d';
  state.rateMode = settings.tokenRateMode === 'burn' ? 'burn' : 'speed';
  if (settings.defaultUsageRange && PERIODS.includes(settings.defaultUsageRange)) {
    state.periodKey = settings.defaultUsageRange;
  }
  applyAppearance(settings);
  applyTranslations();
  populateDashboardSettings();
  syncDashboardSettings(settings);
  populatePeriodSelect();
  populateRangeSelect();
  render();
  document.fonts?.ready?.then?.(() => syncAllSegIndicators({ animate: false })).catch(() => {});
  await refresh();
  dashboardReady = true;
  window.tokenMonitor.dashboard.ready();
}

window.tokenMonitor.onSettingsPush?.((next) => {
  if (!next) return;
  const previousSettings = state.settings;
  const prevHubMode = previousSettings?.hubMode;
  const prevHubUrl = previousSettings?.hubUrl;
  state.settings = { ...(state.settings || {}), ...next };
  const destinationChanged = ('hubMode' in next && next.hubMode !== prevHubMode)
    || ('hubUrl' in next && next.hubUrl !== prevHubUrl);
  if (destinationChanged) {
    statsSourceGeneration += 1;
    syncedSessionPagesByPeriod.clear();
    syncedSessionPagesRequests.clear();
    if (state.drawer) closeDrawer();
  }
  if ('dashboardFlat' in next) {
    state.flat = next.dashboardFlat === true;
    els.body.classList.toggle('flat', state.flat);
  }
  // applyAppearance applies the motion preference itself; remember the old one
  // so a changed preference still repaints below.
  const previousReduceMotion = state.reduceMotion;
  applyAppearance(state.settings);
  let needsRender = false;
  const nextLocale = i18n.resolveLocale(state.settings.locale || state.settings.language, navigator.languages);
  if (state.locale !== nextLocale) {
    state.locale = nextLocale;
    applyTranslations();
    populateDashboardSettings();
    populateRangeSelect();
    needsRender = true;
  }
  if (typeof populatePeriodSelect === 'function' && populatePeriodSelect()) {
    closeDrawer();
    if (!destinationChanged) {
      allTimeSessions?.ensure?.();
      ensureSyncedSessionPages();
    }
    needsRender = true;
  }
  const nextCompactTokenUnits = compactTokenApi.normalizeCompactTokenUnits(state.settings.compactTokenUnits);
  if (state.compactTokenUnits !== nextCompactTokenUnits) {
    state.compactTokenUnits = nextCompactTokenUnits;
    needsRender = true;
  }
  if (next.currencyRatesEffective && window.TokenMonitorCurrency?.configureRates) {
    window.TokenMonitorCurrency.configureRates(next.currencyRatesEffective);
    needsRender = true;
  }
  if (next.currency && state.currency !== next.currency) {
    state.currency = next.currency;
    needsRender = true;
  }
  if (state.reduceMotion !== previousReduceMotion) needsRender = true;
  const nextMetric = state.settings.dashboardHeatmapMetric || state.settings.heatmapMetric || 'cost';
  if (state.heatmapMetric !== nextMetric) {
    state.heatmapMetric = nextMetric;
    needsRender = true;
  }
  if ('dashboardStageView' in next) {
    const nextStage = next.dashboardStageView === '2d' || next.dashboardStageView === '3d' || next.dashboardStageView === 'flow'
      ? next.dashboardStageView
      : 'flow';
    if (state.stageView !== nextStage) {
      state.stageView = nextStage;
      if (nextStage === '2d' || nextStage === '3d') state.heatmapView = nextStage;
      needsRender = true;
    }
  }
  if ('tokenRateMode' in next) {
    const nextRateMode = next.tokenRateMode === 'burn' ? 'burn' : 'speed';
    if (state.rateMode !== nextRateMode) {
      state.rateMode = nextRateMode;
      needsRender = true;
    }
  }
  if (['syncWeekStartsOn', 'modelAliases', 'modelAliasGrouping', 'projectsEnabled'].some(key =>
    key in next && JSON.stringify(next[key]) !== JSON.stringify(previousSettings?.[key]))) {
    syncedSessionPagesByPeriod.clear();
    syncedSessionPagesRequests.clear();
    if (latestBaseStats) state.stats = applyLocalSessionActivity(allTimeSessions ? allTimeSessions.attach(latestBaseStats) : latestBaseStats);
    if (!destinationChanged) ensureSyncedSessionPages();
    needsRender = true;
  }
  if ('showLimitUsed' in next || 'homeVendorColors' in next || 'showToolIcons' in next
    || 'sessionContextMetric' in next || 'homeLimitAccountCount' in next
    || 'showHomeLimitProviderNames' in next || 'limitProviders' in next || 'limitProviderOrder' in next || 'limitsEnabled' in next
    || 'maskLimitAccountEmails' in next || 'showHomeLimitBars' in next
    || 'limitProviderHiddenItems' in next || 'sessionTitlesEnabled' in next) {
    if ('sessionTitlesEnabled' in next && next.sessionTitlesEnabled !== previousSettings?.sessionTitlesEnabled) {
      syncedSessionPagesByPeriod.clear();
      syncedSessionPagesRequests.clear();
      let base = latestBaseStats || state.stats;
      if (next.sessionTitlesEnabled === false && base && sessionTitleDisplayApi?.withoutSessionTitleStats) {
        base = sessionTitleDisplayApi.withoutSessionTitleStats(base);
        latestBaseStats = base;
      }
      if (base) state.stats = applyLocalSessionActivity(allTimeSessions ? allTimeSessions.attach(base) : base);
      if (!destinationChanged) ensureSyncedSessionPages();
      if (state.drawer?.kind === 'session') {
        const s = state.drawer.session;
        const redactMember = (m) => ({
          ...m,
          title: m.projectLabel || m.modelLabel || m.clientLabel || m.sessionId || m.key || ''
        });
        const redactGroup = (grp) => (grp ? {
          ...grp,
          title: grp.subagentGroup
            ? (grp.projectLabel || grp.clientLabel || grp.sessionId || grp.key || '')
            : grp.title,
          ...(Array.isArray(grp.groupRows) ? { groupRows: grp.groupRows.map(redactMember) } : {})
        } : grp);
        const updateBackButtonLabel = (grp) => {
          if (!grp || !els.drawerBody) return;
          const nextBackText = `← ${escapeHtml(grp.title || grp.projectLabel || grp.clientLabel || '')}`;
          const backPattern = /(<button[^>]*class="dash-drawer-back"[^>]*>)[\s\S]*?(<\/button>)/;
          if (typeof els.drawerBody.innerHTML === 'string' && backPattern.test(els.drawerBody.innerHTML)) {
            els.drawerBody.innerHTML = els.drawerBody.innerHTML.replace(backPattern, (_, open, close) => `${open}${nextBackText}${close}`);
          }
          if (typeof state.drawer.detailBaseGrid === 'string' && backPattern.test(state.drawer.detailBaseGrid)) {
            state.drawer.detailBaseGrid = state.drawer.detailBaseGrid.replace(backPattern, (_, open, close) => `${open}${nextBackText}${close}`);
          }
        };
        if (next.sessionTitlesEnabled === false) {
          const fallbackTitle = s.sessionGroup && !s.subagentGroup
            ? s.title
            : (s.projectLabel || s.clientLabel || s.sessionId || s.key || '');
          const redactedRows = Array.isArray(s.groupRows)
            ? s.groupRows.map(redactMember)
            : s.groupRows;
          const nextSession = {
            ...s,
            title: fallbackTitle,
            ...(Array.isArray(redactedRows) ? { groupRows: redactedRows } : {})
          };
          const prevTitle = state.drawer.redactedFromTitle ?? s.title;
          const prevRows = state.drawer.redactedFromGroupRows ?? s.groupRows;
          const prevReturnToGroup = state.drawer.redactedFromReturnToGroup ?? state.drawer.returnToGroup;
          const nextReturnToGroup = prevReturnToGroup ? redactGroup(prevReturnToGroup) : undefined;
          if (s.sessionGroup && Array.isArray(redactedRows) && typeof openDrawer === 'function') {
            openDrawer({ kind: 'session', session: nextSession });
            state.drawer = {
              ...state.drawer,
              redactedFromTitle: prevTitle,
              redactedFromGroupRows: prevRows
            };
          } else {
            state.drawer = {
              ...state.drawer,
              session: nextSession,
              redactedFromTitle: prevTitle,
              ...(Array.isArray(prevRows) ? { redactedFromGroupRows: prevRows } : {}),
              ...(nextReturnToGroup ? { returnToGroup: nextReturnToGroup, redactedFromReturnToGroup: prevReturnToGroup } : {})
            };
            if (els.drawerTitle) els.drawerTitle.textContent = fallbackTitle;
            if (nextReturnToGroup) updateBackButtonLabel(nextReturnToGroup);
          }
        } else if (state.drawer.redactedFromTitle || state.drawer.redactedFromGroupRows || state.drawer.redactedFromReturnToGroup) {
          const restoredReturnToGroup = state.drawer.redactedFromReturnToGroup || state.drawer.returnToGroup;
          const restoredSession = {
            ...s,
            title: state.drawer.redactedFromTitle || s.title,
            ...(Array.isArray(state.drawer.redactedFromGroupRows) ? { groupRows: state.drawer.redactedFromGroupRows } : {})
          };
          if (s.sessionGroup && Array.isArray(restoredSession.groupRows) && typeof openDrawer === 'function') {
            openDrawer({ kind: 'session', session: restoredSession });
          } else {
            state.drawer = {
              ...state.drawer,
              session: restoredSession,
              ...(restoredReturnToGroup ? { returnToGroup: restoredReturnToGroup } : {})
            };
            if (els.drawerTitle) els.drawerTitle.textContent = restoredSession.title;
            if (restoredReturnToGroup) updateBackButtonLabel(restoredReturnToGroup);
          }
        }
      }
    }
    needsRender = true;
  }
  if (typeof syncDashboardSettings === 'function') syncDashboardSettings(state.settings);
  if (next.dashboardShowVelocity !== undefined && next.dashboardShowVelocity !== previousSettings?.dashboardShowVelocity
    || next.dashboardShowQuotas !== undefined && next.dashboardShowQuotas !== previousSettings?.dashboardShowQuotas) needsRender = true;
  if (needsRender) render();
});

window.tokenMonitor.onStatsPush?.((payload) => {
  if (!payload) return;
  if (payload.event === 'status') {
    state.streamConnected = Boolean(payload.data?.connected);
    if (payload.data?.mode) state.statsMode = payload.data.mode;
    return;
  }
  if (payload.event === 'session-activity') {
    localSessionActivity = payload.data || null;
    if (state.stats) {
      const next = applyLocalSessionActivity(state.stats);
      if (next !== state.stats) {
        state.stats = next;
        state.motion = 'update';
        render();
      }
    }
    return;
  }
  if (payload.data?.stats) {
    if (!['local', 'presentation', 'read'].includes(payload.data?.reason)) {
      state.streamConnected = true;
    }
    if (applyIncomingStats(payload.data.stats, { fromPush: true, mode: payload.data?.mode || '' })) {
      state.motion = 'update';
      render();
    }
  }
});

reducedMotionMedia?.addEventListener?.('change', () => {
  if (state.reduceMotion !== 'system') return;
  applyReduceMotionPreference('system');
  render();
});

function handleDashboardHistoryChanged() {
  if (document.hidden) {
    refreshQueued = true;
    return;
  }
  void refresh();
}

window.tokenMonitor.onDashboardHistoryChanged?.(handleDashboardHistoryChanged);

els.velocityFigure?.addEventListener('click', () => {
  state.rateMode = state.rateMode === 'burn' ? 'speed' : 'burn';
  state.motion = 'update';
  render();
  window.tokenMonitor.updateSettings?.({ tokenRateMode: state.rateMode });
});

document.addEventListener('pointerdown', (ev) => {
  if (state.deviceMenuOpen
    && !ev.target.closest?.('#dashDeviceScope')
    && !ev.target.closest?.('#dashDeviceMenu')) {
    setDeviceMenuOpen(false);
  }
});

els.stage?.addEventListener('scroll', hideTooltip, { passive: true });

els.tabs.forEach((tab) => tab.addEventListener('click', () => {
  if (state.tab === tab.dataset.tab) return;
  hideTooltip();
  state.tab = tab.dataset.tab;
  state.motion = 'entry';
  els.tabs.forEach((x) => x.classList.toggle('active', x === tab));
  syncSegIndicator(els.tabsContainer);
  render();
}));

els.stackBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.stackBy === b.dataset.stack) return;
  hideTooltip();
  state.stackBy = b.dataset.stack;
  state.soloKey = null;
  state.motion = 'series';
  activateSegButton(els.stackBtns, b);
  render();
}));

els.modeBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  hideTooltip();
  state.mode = b.dataset.mode;
  state.motion = 'update';
  activateSegButton(els.modeBtns, b);
  render();
}));

els.trendMetricBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.trendMetric === b.dataset.tmetric) return;
  hideTooltip();
  state.trendMetric = b.dataset.tmetric;
  state.motion = 'update';
  activateSegButton(els.trendMetricBtns, b);
  render();
}));

dashboardSettings.popover?.addEventListener('change', (event) => {
  const input = event.target;
  if (dashboardSettings.choices.contains(input)) {
    const selected = Array.from(dashboardSettings.choices.querySelectorAll('input:checked'), item => item.value);
    if (selected.length) void saveDashboardSettings({ dashboardVisiblePeriods: selected });
  } else if (input === dashboardSettings.follow) {
    void saveDashboardSettings({ dashboardFollowPeriodTabs: input.checked });
  } else if (input === dashboardSettings.velocity) {
    void saveDashboardSettings({ dashboardShowVelocity: input.checked });
  } else if (input === dashboardSettings.quotas) {
    void saveDashboardSettings({ dashboardShowQuotas: input.checked });
  } else if (input === dashboardSettings.stage) {
    void saveDashboardSettings({ dashboardStageView: input.value });
  } else if (input === dashboardSettings.metric) {
    void saveDashboardSettings({ dashboardHeatmapMetric: input.value });
  }
});
document.getElementById('dashOpenAppSettings')?.addEventListener('click', () => {
  dashboardSettings.popover.hidePopover();
  window.tokenMonitor.dashboard.openAppSettings();
});

els.stageViewBtns.forEach((b) => b.addEventListener('click', () => {
  const nextView = b.dataset.view;
  if (!nextView || state.stageView === nextView) return;
  hideTooltip();
  clearTopologyFocus();
  state.stageView = nextView;
  if (nextView === '2d' || nextView === '3d') {
    state.heatmapView = nextView;
    state.motion = 'entry';
  } else {
    state.motion = 'update';
  }
  activateSegButton(els.stageViewBtns, b);
  render();
  window.tokenMonitor.updateSettings?.({ dashboardStageView: state.stageView });
}));

els.heatmapMetricBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.heatmapMetric === b.dataset.val) return;
  hideTooltip();
  state.heatmapMetric = b.dataset.val;
  state.motion = 'update';
  activateSegButton(els.heatmapMetricBtns, b);
  render();
  window.tokenMonitor.updateSettings({ dashboardHeatmapMetric: state.heatmapMetric });
}));

els.skylineColorBtns?.forEach((b) => b.addEventListener('click', () => {
  const nextColor = b.dataset.color === 'tool' ? 'tool' : 'heat';
  if (state.skylineColorMode === nextColor) return;
  hideTooltip();
  state.skylineColorMode = nextColor;
  state.motion = 'update';
  activateSegButton(els.skylineColorBtns, b);
  render();
}));

els.skylineReset?.addEventListener('click', () => {
  dismissSkylineHint();
  skylineController?.resetCamera?.();
});

els.breakdownModeBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.breakdownMode === b.dataset.bd) return;
  state.breakdownMode = b.dataset.bd;
  state.motion = 'update';
  activateSegButton(els.breakdownModeBtns, b);
  render();
}));

els.workModeBtns.forEach((b) => b.addEventListener('click', () => {
  if (state.workMode === b.dataset.work) return;
  state.workMode = b.dataset.work;
  state.motion = 'update';
  activateSegButton(els.workModeBtns, b);
  render();
}));

els.deviceMenu?.addEventListener('keydown', (event) => {
  const items = Array.from(els.deviceMenu.querySelectorAll('.dash-device-menu-item'));
  fixedPeriodRangesApi.handlePeriodMenuNavigation(event, {
    currentIndex: items.indexOf(document.activeElement),
    itemCount: items.length,
    focusIndex: index => items[index].focus()
  });
});
els.deviceMenu?.addEventListener('click', (ev) => {
  const item = ev.target.closest('.dash-device-menu-item');
  if (!item) return;
  ev.stopPropagation();
  setDeviceMenuOpen(false);
  els.deviceTrigger.focus({ preventScroll: true });
  const id = item.dataset.device;
  if (state.selectedDeviceId === id) return;
  hideTooltip();
  closeDrawer();
  state.selectedDeviceId = id;
  state.motion = 'update';
  render();
});

els.topology?.addEventListener('pointerover', (ev) => {
  const node = ev.target.closest('.topo-node[data-topo-kind]');
  if (!node) return;
  const kind = node.dataset.topoKind;
  const id = node.dataset.topoId;
  if (!kind || !id) return;
  applyTopologyFocus(kind, id);
  showTopologyTooltip(kind, id, node);
});

els.topology?.addEventListener('pointerout', (ev) => {
  const left = ev.target.closest('.topo-node[data-topo-kind]');
  const entered = ev.relatedTarget?.closest?.('.topo-node[data-topo-kind]');
  if (left && !entered) {
    clearTopologyFocus();
    if (activeHover?.kind === 'topo') hideTooltip();
  }
});

els.topology?.addEventListener('pointerleave', () => {
  clearTopologyFocus();
  if (activeHover?.kind === 'topo') hideTooltip();
});

els.topology?.addEventListener('scroll', (ev) => {
  if (!ev.target?.classList?.contains('dash-topo-col-scroll')) return;
  const canvas = els.topology.querySelector('.dash-topo-canvas');
  syncTopologyScrollFades(canvas);
  if (activeHover?.kind === 'topo') hideTooltip();
  if (topologyScrollFrame) return;
  topologyScrollFrame = requestAnimationFrame(() => {
    topologyScrollFrame = 0;
    if (state.stageView === 'flow' && state.overview?.topology) {
      layoutTopologyLinks(state.overview.topology);
    }
  });
}, { capture: true, passive: true });

els.topology?.addEventListener('click', (ev) => {
  const node = ev.target.closest('.topo-node[data-topo-kind]');
  const graph = state.overview?.topology;
  if (!node || !graph) return;
  const kind = node.dataset.topoKind;
  const id = node.dataset.topoId;
  if (kind === 'device') {
    const device = graph.devices.find((d) => d.id === id);
    if (!device) return;
    if (state.overview?.fleet?.isFleetMode) {
      hideTooltip();
      clearTopologyFocus();
      state.selectedDeviceId = state.selectedDeviceId === device.id ? 'all' : device.id;
      state.motion = 'update';
      render();
      return;
    }
    if (device.raw) openDrawer({ kind: 'machine', machine: device.raw });
    return;
  }
  if (kind === 'hub') {
    const hub = graph.hubs.find((h) => h.id === id);
    if (!hub) return;
    if (graph.mode === 'sessions') {
      openDrawer({
        kind: 'workspace',
        workspace: hub.raw || {
          name: hub.isGeneral ? t('dashboard.topology.generalWorkspace') : hub.name,
          tokens: hub.tokens,
          cost: hub.cost,
          unpricedTokens: hub.unpricedTokens,
          clients: hub.clients || [],
          share: 0,
          accordionRows: []
        }
      });
    } else if (hub.raw) {
      openDrawer({ kind: 'client', item: hub.raw });
    }
    return;
  }
  if (kind === 'endpoint') {
    const ep = graph.endpoints.find((item) => item.id === id);
    if (!ep?.raw) return;
    if (graph.mode === 'sessions') openDrawer({ kind: 'session', session: ep.raw });
    else openDrawer({ kind: 'model', item: ep.raw });
  }
});
els.topology?.addEventListener('keydown', handleKeyboardClick);

els.breakdown?.addEventListener('click', (ev) => {
  const rowEl = ev.target.closest('.dash-bd-row[data-bd-kind]');
  if (!rowEl || !state.overview) return;
  const kind = rowEl.dataset.bdKind;
  const id = rowEl.dataset.bdId;
  const list = kind === 'model' ? state.overview.models : state.overview.tools;
  const item = (list || []).find((entry) => entry.id === id);
  if (item) openDrawer({ kind, item });
});
els.breakdown?.addEventListener('keydown', handleKeyboardClick);

els.workPanel?.addEventListener('click', (ev) => {
  if (!state.overview) return;
  const devRow = ev.target.closest('.dash-device-row[data-device-id]');
  if (devRow) {
    const fleet = state.overview.fleet;
    const machine = (fleet?.machines || []).find((m) => m.deviceId === devRow.dataset.deviceId);
    if (!machine) return;
    if (fleet?.isFleetMode && state.selectedDeviceId !== machine.deviceId) {
      hideTooltip();
      state.selectedDeviceId = machine.deviceId;
      state.motion = 'update';
      render();
      return;
    }
    openDrawer({ kind: 'machine', machine });
    return;
  }
  const wsRow = ev.target.closest('.dash-project-row[data-ws-key]');
  if (wsRow) {
    const ws = (state.overview.workspaces || []).find((w) => w.key === wsRow.dataset.wsKey);
    if (ws) openDrawer({ kind: 'workspace', workspace: ws });
    return;
  }
  const sessRow = ev.target.closest('.dash-session-row[data-session-key]');
  if (sessRow) {
    const session = (state.overview.sessions || []).find((s) => s.key === sessRow.dataset.sessionKey);
    if (session) openDrawer({ kind: 'session', session });
  }
});
els.workPanel?.addEventListener('keydown', handleKeyboardClick);
els.dailyLedger?.addEventListener('keydown', handleKeyboardClick);
els.legend?.addEventListener('keydown', handleKeyboardClick);

els.drawerClose?.addEventListener('click', closeDrawer);
els.drawerScrim?.addEventListener('click', closeDrawer);
els.drawerBody?.addEventListener?.('click', (ev) => {
  const backBtn = ev.target?.closest?.('.dash-drawer-back');
  if (backBtn && state.drawer?.returnToGroup) {
    const origGroup = state.drawer.redactedFromReturnToGroup;
    openDrawer({ kind: 'session', session: state.drawer.returnToGroup });
    if (origGroup && state.drawer?.kind === 'session') {
      state.drawer = {
        ...state.drawer,
        redactedFromTitle: origGroup.title,
        redactedFromGroupRows: origGroup.groupRows
      };
    }
    return;
  }
  const memberRow = ev.target?.closest?.('.dash-drawer-member-row[data-drawer-member-idx]');
  if (memberRow) {
    const idx = Number(memberRow.dataset.drawerMemberIdx);
    const member = state.drawer?.groupMembers?.[idx];
    if (member) {
      const origRows = state.drawer.redactedFromGroupRows;
      const origGroup = origRows
        ? {
            ...(state.drawer.rawGroupSession || state.drawer.session),
            title: state.drawer.redactedFromTitle || state.drawer.session?.title,
            groupRows: origRows
          }
        : null;
      openDrawer({
        kind: 'session',
        session: member,
        returnToGroup: state.drawer.rawGroupSession || state.drawer.session
      });
      if (origGroup && state.drawer?.kind === 'session') {
        state.drawer = {
          ...state.drawer,
          redactedFromTitle: origRows[idx]?.title || member.title,
          redactedFromReturnToGroup: origGroup
        };
      }
    }
  }
});
els.drawerBody?.addEventListener?.('keydown', handleKeyboardClick);
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (state.drawer) closeDrawer();
    if (state.deviceMenuOpen) {
      setDeviceMenuOpen(false);
      els.deviceTrigger.focus({ preventScroll: true });
    }
    hideTooltip();
  }
});

els.themeToggle.addEventListener('click', () => {
  state.flat = !state.flat;
  els.body.classList.toggle('flat', state.flat);
  skylineController?.refreshTheme?.();
  window.tokenMonitor.updateSettings({ dashboardFlat: state.flat });
});
els.refreshBtn.addEventListener('click', () => { void manualRefresh(); });
els.minBtn.addEventListener('click', () => window.tokenMonitor.dashboard.minimize());
els.closeBtn.addEventListener('click', () => window.tokenMonitor.dashboard.close());

els.chart.addEventListener('mousemove', (ev) => {
  const hit = ev.target.closest('.bar-hover');
  if (!hit || !state.chartModel) { hideTooltip(); return; }
  const i = Number(hit.getAttribute('data-i'));
  const candles = state.chartKind === 'candle';
  const entry = candles ? state.chartModel.candles[i] : state.chartModel.bars[i];
  if (!entry) { hideTooltip(); return; }
  activeHover = { kind: 'trend', chartKind: state.chartKind, key: candles ? entry.key : entry.label };
  if (candles) showCandleTooltip(entry, hit);
  else showBarTooltip(entry, hit);
});
els.chart.addEventListener('mouseleave', hideTooltip);

els.heatmap.addEventListener('pointermove', (ev) => {
  const svg = els.heatmap.querySelector('svg.dash-heatmap');
  if (svg && !svg.classList.contains('dash-heatmap--iso')) {
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox?.baseVal;
    if (rect.width > 0 && view && view.width > 0) {
      const vx = view.x + (ev.clientX - rect.left) * view.width / rect.width;
      const vy = view.y + (ev.clientY - rect.top) * view.height / rect.height;
      moveHeatmapSpotlight(vx, vy);
    }
  }
  const hit = ev.target.closest('.heat[data-d], .iso-col[data-d]');
  const rawDate = hit?.getAttribute('data-d');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate || '')) ? rawDate : null;
  if (!hit || !date) {
    els.heatmap.querySelectorAll('[data-active="true"]').forEach((c) => c.removeAttribute('data-active'));
    if (activeHover?.kind === 'heat') hideTooltip();
    return;
  }
  if (activeHover?.kind !== 'heat' || activeHover.date !== date) {
    els.heatmap.querySelectorAll('[data-active="true"]').forEach((c) => c.removeAttribute('data-active'));
    hit.setAttribute('data-active', 'true');
  }
  activeHover = { kind: 'heat', date };
  const anchor = hit.querySelector('.iso-face-top') || hit;
  showHeatTooltip(date, state.dayMap && state.dayMap.get(date), anchor);
});
els.heatmap.addEventListener('pointerleave', hideHeatmapHover);
els.heatmap.addEventListener('click', (ev) => {
  const hit = ev.target.closest('.heat[data-d], .iso-col[data-d]');
  const rawDate = hit?.getAttribute('data-d');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate || '')) ? rawDate : null;
  if (!date) return;
  const day = (state.overview?.dailyLedger || []).find((d) => d.date === date);
  if (day) openDrawer({ kind: 'day', day });
});

els.heroRibbon?.addEventListener('pointermove', (ev) => {
  const seg = ev.target.closest('.dash-ribbon-seg');
  if (!seg) {
    if (activeHover?.kind === 'ribbon') hideTooltip();
    return;
  }
  showRibbonTooltip(seg);
});
els.heroRibbon?.addEventListener('pointerleave', () => {
  if (activeHover?.kind === 'ribbon') hideTooltip();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  hideTooltip();
  setDeviceMenuOpen(false);
  syncAllSegIndicators({ animate: false });
  skylineController?.resize?.();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { state.motion = 'none'; render(); }, 120);
});

window.addEventListener('blur', hideTooltip);

function handleDashboardFocus() {
  if (!document.hidden) scheduleDashboardRefresh();
}

window.addEventListener('focus', handleDashboardFocus);

boot();
