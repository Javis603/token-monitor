'use strict';

// Shared renderer for EdgeDock and the macOS top entry. Their independent
// main-process controllers own placement and hover decisions; this page paints
// projected data and reports input and measured content size.

const bridge = window.tokenMonitorEdgeDock;
const presentation = window.TokenMonitorEdgeDockPresentation;
// The running reading is derived from the projected rows at paint time rather than
// frozen into the cell, so the rail and the card answer at the same clock (see
// runningSessionSummary).
const runningSessionSummary = presentation.runningSessionSummary;
const i18n = window.TokenMonitorI18n;
const themePresetsApi = window.TokenMonitorThemePresets;
const fontSettingsApi = window.TokenMonitorFontSettings;
const motionPreferenceApi = window.TokenMonitorMotionPreference;
const currencyApi = window.TokenMonitorCurrency;
const compactTokenApi = window.TokenMonitorCompactTokens;
const compactMoneyApi = window.TokenMonitorCompactMoney;
const balanceDisplay = window.TokenMonitorLimitBalanceDisplay;
const accountIdentityApi = window.TokenMonitorAccountIdentity;
const glassRenderingApi = window.TokenMonitorGlassRendering;
const limitPresentationApi = window.TokenMonitorLimitProviderPresentation;
const limitWindowLabels = window.TokenMonitorLimitWindowLabels;
const { mimoAccountGroups, mimoProductLabel } = limitWindowLabels;
const limitWindowTextApi = window.TokenMonitorLimitWindowText;
const limitResetMotionApi = window.TokenMonitorLimitResetMotion;
const limitResetAnimatorApi = window.TokenMonitorLimitResetAnimator;
const limitWindowsViewApi = window.TokenMonitorLimitWindowsView;
const subscriptionDisplayApi = window.TokenMonitorSubscriptionDisplay;
const subscriptionTextApi = window.TokenMonitorSubscriptionText;
const { limitFillPercent, limitModeSuffix } = window.TokenMonitorLimitDisplayMode;
const codexAccountControlApi = window.TokenMonitorCodexAccountControl;
const { activateOnPress } = window.TokenMonitorPressActivation;
const { clientColors, modelColor, modelVendorFor } = window.TokenMonitorUsageCharts;
const { UNATTRIBUTED_KEY } = window.TokenMonitorUsageAttributionRows;
const { LIMIT_PROVIDER_LABELS } = window.TokenMonitorLimitProviders;
const { CLIENT_LABELS } = window.TokenMonitorClientCatalog;
// The same predicate the Sessions list uses. The card repaints from its last
// payload on a timer, so whether a session is still running has to be answered
// at paint time rather than frozen at push time.
const sessionLive = window.TokenMonitorSessionLive;
const sessionRowsApi = window.TokenMonitorSessionRows;
const overflowText = window.TokenMonitorOverflowText.create({
  document, window, prefersReducedMotion
});
const SESSION_STATE_GLYPHS = sessionLive.sessionStateMarkup({
  spin: 'edge-dock-session-spin',
  check: 'edge-dock-session-check',
  idle: 'edge-dock-session-idle',
  waiting: 'edge-dock-session-waiting'
});

const BRAND_VENDOR_COLORS = { ...clientColors };
const SVG_NS = 'http://www.w3.org/2000/svg';
// Inset the thicker quota stroke so its outer edge stays within the 42px ring.
const RING_RADIUS = 18.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const DRAG_THRESHOLD_PX = 4;
const BREAKDOWN_VISIBLE_ROWS = 6;
// Keep the phase anchor in sync with edge-dock-running-spin in dock.css.
const RUNNING_SPIN_MS = 1400;
// Match the waiting pulse in dock.css. Keep its entry clock across rail
// rebuilds so usage pushes and live-status renewals preserve the breathing phase.
const WAITING_PULSE_MS = 2400;
const waitingRingStarts = new Map();

const root = document.getElementById('edgeDockRoot');
const query = new URLSearchParams(window.location.search);
const surface = query.get('surface') || 'rail';
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const tokenNumberAnimationApi = window.TokenMonitorTokenNumberAnimation;
const railNumberRollApi = window.TokenMonitorEdgeDockRailNumberRoll;
const railNumberRoll = railNumberRollApi.create({ animation: tokenNumberAnimationApi, selector: '[data-roll-key]:not([data-plugin-roll])', mode: () => tokenNumberAnimationApi.normalize(appearance().tokenNumberAnimation) });
const markRoll = railNumberRollApi.mark;

const state = {
  payload: null,
  locale: 'en',
  appearanceKey: '',
  breakdownMode: 'tools'
};
const maskSupport = new Map();

root.dataset.surface = surface;

// Two persistent layers: the silhouette and the content. Rebuilding the whole
// root on every update replaced the painted shape too, which flickered on
// macOS; the shape is now only touched when its path actually changes, and
// the rail keeps one element so an in-progress pointer capture survives.
const shapeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
shapeLayer.setAttribute('class', 'edge-dock-shape');
shapeLayer.setAttribute('aria-hidden', 'true');
const contentLayer = document.createElement('div');
contentLayer.className = 'edge-dock-content';
root.append(shapeLayer, contentLayer);

function t(key, params) {
  return i18n.translate(state.locale, key, params);
}

// Plugin views drawn on this surface. Each dock window keeps its own copy of
// the resolved views it shows and reports which are on screen; main pushes
// updates on a channel separate from cell renders, so a plugin's live value
// repaints only its own node.
const pluginSurface = surface === 'notch' ? 'notch' : 'edgeDock';
const pluginViewsApi = window.TokenMonitorPluginViews;
const pluginHost = pluginViewsApi && bridge.onPluginViews ? pluginViewsApi.createPluginViewHost({
  document,
  window,
  t,
  services: { app: bridge, native: { get quota() { return limitWindowsView; } } },
  getContext: () => ({ nativeData: state.payload, surfaceVariant: surface }),
  onLoaded: () => { if (surface === 'notch') notchRenderer?.paintSummaryPlugins(); },
  isSurfaceActive: (_surface, container) => !container.closest('.notch-page')?.inert,
  onDemand: (_surface, refs) => bridge.setPluginDemand(refs),
  motionAllowed: () => !prefersReducedMotion(),
  motionMode: () => tokenNumberAnimationApi.normalize(appearance().tokenNumberAnimation)
}) : null;
let contentSelections = {};
const pluginContent = pluginHost ? window.TokenMonitorPluginContent.create({ document,
  host: { mount: (container, view, context) => pluginHost.mount(container, view.ref, pluginSurface, context), unmount: container => pluginHost.unmount(container) },
  getViews: () => pluginHost.descriptors(pluginSurface), selection: target => contentSelections[target]
}) : null;
// Settings previews have no preload/plugin host; keep native ready/render wiring
// independent of trusted plugin APIs.
if (pluginHost) void window.tokenMonitorTrustedPlugins.contentSelections().then(value => { contentSelections = value; if (state.payload) render(state.payload); });
let pluginContentsKey = '';
function updatePluginViews(payload) {
  if (payload?.surface !== pluginSurface) return;
  pluginHost?.update(payload);
  if (surface === 'notch') notchRenderer?.paintSummaryPlugins();
  if (surface === 'rail') refreshPluginCellLabels(railNode);
  const key = JSON.stringify(Object.values(payload.views || {}).map(view => [view.ref, view.revision, view.targets, view.mode, view.selector, view.contentOrder]));
  void window.tokenMonitorTrustedPlugins.contentSelections().then(value => {
    const next = key + JSON.stringify(value);
    if (pluginContentsKey === next) return;
    pluginContentsKey = next; contentSelections = value;
    if (surface === 'notch') notchRenderer?.pluginViewsChanged();
    else if (state.payload) render(state.payload);
  });
}
if (pluginHost) {
  bridge.onPluginViews(updatePluginViews);
  void window.tokenMonitorTrustedPlugins.views(pluginSurface).then(updatePluginViews);
}

function pluginCellLabel(ref) {
  const view = pluginHost?.state('edgeDock', ref);
  return view?.title || ref;
}

// Plugin values repaint in place between rail renders; keep the spoken label
// in step with the painted value.
function refreshPluginCellLabels(rail) {
  for (const node of rail?.querySelectorAll('.edge-dock-cell-plugin[data-plugin-ref]') || []) {
    node.setAttribute('aria-label', pluginCellLabel(node.dataset.pluginRef));
  }
}

function pluginCellNode(cell, retained) {
  const node = retained || el('div', 'edge-dock-cell edge-dock-cell-plugin');
  node.dataset.pluginRef = cell.ref;
  const mount = retained?.firstElementChild || el('div', 'edge-dock-plugin-cell');
  if (!retained) node.append(mount);
  pluginHost?.mount(mount, cell.ref, 'edgeDock', { variant: 'compact' });
  node.setAttribute('aria-label', pluginCellLabel(cell.ref));
  return node;
}

function pluginCard(cell) {
  const card = el('section', 'edge-dock-card edge-dock-card-plugin');
  card.dataset.pluginRef = cell.ref;
  const head = el('header', 'edge-dock-card-head');
  const view = pluginHost?.state('edgeDock', cell.ref);
  const identity = el('div', 'edge-dock-plugin-identity');
  identity.append(el('span', 'edge-dock-stat-caption', view?.title || cell.ref));
  if (view?.pluginName && view.pluginName !== view.title) identity.append(el('span', 'edge-dock-plugin-owner', view.pluginName));
  const headerActions = el('div', 'edge-dock-plugin-header-actions');
  head.append(identity, headerActions);
  const body = el('div', 'edge-dock-plugin-card');
  card.append(head, body);
  pluginHost?.mount(body, cell.ref, 'edgeDock', { variant: 'full', headerActions });
  return card;
}

const codexAccountControl = codexAccountControlApi.createCodexAccountControl({
  document,
  requestAnimationFrame,
  translate: t,
  switchAccount: (accountId) => bridge.switchCodexAccount(accountId),
  requestRender: () => {
    if (surface === 'bubble' && state.payload?.cell) renderBubble(state.payload);
    if (surface === 'notch' && state.payload) notchRenderer.render(state.payload);
  },
  onSwitchFailure: (message) => {
    console.log(`[edge-dock] codex account switch failed: ${message}`);
  },
  onPostSwitchError: (error) => {
    console.log(`[edge-dock] codex post-switch update failed: ${error?.message || error}`);
  }
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// ---- Appearance -----------------------------------------------------------

function isMacLegacy(payload) {
  if (payload?.platform !== 'darwin') return false;
  const major = Number.parseInt(String(payload.osRelease || '').split('.')[0], 10);
  // macOS 26 (Tahoe) is Darwin 25; older releases use the smaller window radius.
  return Number.isFinite(major) && major < 25;
}

function applyAppearance(payload) {
  const appearance = payload?.appearance || {};
  const key = JSON.stringify([appearance, payload?.platform, payload?.glass, payload?.liquidGlass, payload?.style]);
  if (key === state.appearanceKey) return;
  state.appearanceKey = key;

  const docEl = document.documentElement;
  const style = docEl.style;
  const opacity = glassRenderingApi.renderedGlassOpacity(appearance, { platform: payload?.platform });
  const depth = Math.max(0, Math.min(100, Number(appearance.glassBlur ?? 32))) / 100;
  style.setProperty('--glass-alpha', opacity.toFixed(2));
  style.setProperty('--line-alpha', (0.1 + depth * 0.09).toFixed(3));
  style.setProperty('--line-strong-alpha', (0.18 + depth * 0.14).toFixed(3));
  for (const { name, value } of themePresetsApi.themeCssVarEntries(appearance.themeColors)) {
    if (value) style.setProperty(name, value);
    else style.removeProperty(name);
  }
  const vendors = themePresetsApi.mergeVendorColors(BRAND_VENDOR_COLORS, appearance.vendorColors);
  for (const vendor of Object.keys(BRAND_VENDOR_COLORS)) clientColors[vendor] = vendors[vendor];
  const { interfaceFont, displayFont } = fontSettingsApi.resolveEffectiveFontSettings(appearance);
  style.setProperty('--ui-font', interfaceFont);
  style.setProperty('--display-font', displayFont);

  docEl.classList.toggle('system-glass-disabled', appearance.systemGlass === false);
  docEl.classList.toggle('edge-dock-no-material', payload?.glass !== true);
  docEl.classList.toggle('edge-dock-liquid-glass', payload?.glass === true && payload?.liquidGlass === true);
  docEl.classList.toggle('is-windows', payload?.platform === 'win32');
  docEl.classList.toggle('is-mac-legacy', isMacLegacy(payload));
  const reduceMotion = motionPreferenceApi.shouldReduceMotion(appearance.reduceMotion, reducedMotionMedia?.matches);
  docEl.classList.toggle('edge-dock-reduced-motion', reduceMotion);
  if (reduceMotion) settleDockMotions();
  pluginHost?.refreshMotion();

  state.locale = i18n.resolveLocale(appearance.language, navigator.languages);
  docEl.lang = state.locale;
  if (appearance.currencyRatesEffective) currencyApi.configureRates(appearance.currencyRatesEffective);
}

// ---- Formatting -----------------------------------------------------------

function parseColor(value) {
  const text = String(value || '').trim();
  let match = /^#([0-9a-f]{3})$/i.exec(text);
  if (match) return match[1].split('').map((digit) => Number.parseInt(digit + digit, 16));
  match = /^#([0-9a-f]{6})$/i.exec(text);
  if (match) return [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
  match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Brand marks such as Cursor's are near-black (or near-white), which vanish as
// a ring on a surface of the same tone. Keep the brand colour whenever it reads
// against the current glass tint and fall back to the text colour otherwise.
function readableColor(color) {
  const rgb = parseColor(color);
  const surface = parseColor(`rgb(${getComputedStyle(document.documentElement).getPropertyValue('--glass-rgb')})`);
  if (!rgb || !surface) return color;
  const a = luminance(rgb);
  const b = luminance(surface);
  const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast < 1.8 ? 'var(--text)' : color;
}

// The provider's own colour, as the Limits view resolves it.
function limitProviderColor(id) {
  if (id === 'factory') return clientColors.droid;
  return clientColors[id] || clientColors.default;
}

// The same colour corrected for contrast against the current glass tint. Only
// the rail uses it: a near-black brand mark vanishes as a ring, while a meter
// on the card is a filled bar the page paints in the raw brand colour.
function providerColor(id) {
  return readableColor(limitProviderColor(id));
}

function providerLabel(id) {
  return LIMIT_PROVIDER_LABELS[id] || CLIENT_LABELS[id] || id;
}

function clientLabel(id) {
  return CLIENT_LABELS[id] || LIMIT_PROVIDER_LABELS[id] || id;
}

// Whether `.row-icon-<id>` has a mask — a vendor mark installed by
// rowIconMasks.js, or one of the few styles.css keeps (token-monitor). Probed
// rather than listed so the dock can never drift from the rules it borrows.
function hasMask(id) {
  if (maskSupport.has(id)) return maskSupport.get(id);
  const probe = el('span', `row-icon-${id}`);
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const computed = getComputedStyle(probe);
  const image = computed.webkitMaskImage || computed.maskImage || 'none';
  probe.remove();
  const supported = Boolean(id) && image !== 'none';
  maskSupport.set(id, supported);
  return supported;
}

function markNode(id, color) {
  const mark = el('span', 'edge-dock-mark');
  if (hasMask(id)) mark.classList.add(`row-icon-${id}`);
  else mark.classList.add('is-fallback');
  if (color) mark.style.setProperty('--ring-color', color);
  return mark;
}

function appearance() {
  return state.payload?.appearance || {};
}

function prefersReducedMotion() {
  return motionPreferenceApi.shouldReduceMotion(appearance().reduceMotion, reducedMotionMedia?.matches);
}

function formatTokens(value) {
  const units = compactTokenApi.effectiveCompactTokenUnits(appearance().compactTokenUnits, state.locale);
  return compactTokenApi.formatCompactTokens(value, units, state.locale, { style: 'tray' });
}

function formatCardTokens(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

// Breakdown rows copy the widget's home list: a compact token reading, then the
// share. The rail keeps its own tray style (two-decimal B, trailing zeros);
// the card uses the widget's plainer single-decimal reading instead.
function formatBreakdownTokens(value) {
  const units = compactTokenApi.effectiveCompactTokenUnits(appearance().compactTokenUnits, state.locale);
  return compactTokenApi.formatCompactTokens(value, units, state.locale);
}

function compactCardTotal(value) {
  if (appearance().showCompactTotalTokens !== true) return '';
  const units = compactTokenApi.effectiveCompactTokenUnits(appearance().compactTokenUnits, state.locale);
  const tokens = Math.round(Number(value || 0));
  if (Math.abs(tokens) < compactTokenApi.compactTokenUnitThreshold(units, state.locale)) return '';
  return `≈ ${compactTokenApi.formatCompactTokens(tokens, units, state.locale)}`;
}

function formatCost(value) {
  return currencyApi.formatCurrencyFromUsd(value, appearance().currency || 'USD');
}

// Keep the known subtotal compact; the shared info tooltip explains its omissions.
function usageCostNode(className, usage) {
  const node = el('span', className);
  node.classList.add('edge-dock-cost-reading');
  const missing = Number(usage.unpricedTokens || 0);
  node.append(el('span', '', missing > 0 && !(usage.costUsd > 0) ? '—' : formatCost(usage.costUsd)));
  if (missing > 0) {
    const info = el('span', 'usage-cost-info');
    limitWindowsView.setDetailTooltip(info, [{ full: t('usage.excludedFromCost', {
      tokens: formatCardTokens(missing)
    }) }], { centered: true });
    node.append(info);
  }
  return node;
}

// Low and critical colours are opt-in (edgeDockWarnColors): by default every
// figure reads in the normal text colour. Unknown values stay muted either way,
// since `--` is an absence of data rather than a warning.
function displaySeverity(remainingPercent) {
  const severity = presentation.remainingSeverity(remainingPercent);
  if (severity === 'unknown' || appearance().edgeDockWarnColors === true) return severity;
  return 'ok';
}

// The Codex account the card can switch to, resolved from the cell projection
// rather than from settings: the dock renderer has none. The shared row asks
// about the collector record, so the projection is looked up by it.
const accountSummaries = new WeakMap();
let cardForecast = null;

const codexAccounts = {
  matchesActive: (provider) => accountSummaries.get(provider)?.active === true,
  switchTarget: (provider) => {
    const id = String(accountSummaries.get(provider)?.switchAccountId || '');
    return id ? { id } : null;
  },
  canSwitchSystemAccount: () => typeof bridge.switchCodexAccount === 'function'
};

// The card's quota rows are the Limits page's quota rows: the same builder,
// the same DOM, the same CSS (this page loads ../styles.css for exactly that).
// It used to be a second implementation that had been told less — no spend
// line under a balance, no denominator under a money pool, no info tooltips at
// all — and every provider that needed special treatment had to be taught twice.
//
// Everything the builder reads from a page is handed to it here. The dock has
// no renderer state of its own beyond the last pushed payload, so the settings
// accessor is the appearance projection and the formatting is this page's.
function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function colorWithAlpha(color, alpha) {
  const rgb = parseColor(color);
  return rgb ? `rgba(${rgb.join(', ')}, ${alpha})` : `rgba(183, 234, 212, ${alpha})`;
}

// The widget animates a meter from zero when a view is entered; the dock card
// is built in a hidden staging layer and measured before it is shown, so it
// only sets the value.
function applyBarScale(fill, scale) {
  fill.style.setProperty('--bar-scale', String(Math.max(0, Math.min(1, Number(scale) || 0))));
}

// A tooltip the pointer is inside has to survive the countdown repaint, the
// same hold the Limits page keeps. Without it the 30-second tick replaces the
// card out from under an open tooltip and it vanishes mid-read.
const limitTooltip = {
  opened: false,
  active: false,
  pending: false
};

function limitTooltipShouldHoldRender() {
  if (!limitTooltip.active) return false;
  return Boolean(contentLayer.querySelector('.limit-detail-tooltip-wrap:hover, .limit-detail-tooltip-wrap:focus-within'));
}

function createCardWindowsView(cell = () => state.payload?.cell, forecast = () => cardForecast) {
  return limitWindowsViewApi.createLimitWindowsView({
    document,
    t,
    settings: appearance,
    currentLocale: () => state.locale,
    presentation: limitPresentationApi,
    // Which device a row's reading came from — "· imac-m1" beside the provider's
    // own source label. The card has no settings and no device list, so both
    // facts ride the cell it is rendering, the same way its account set does.
    provenanceContext: () => cell()?.provenanceContext || {},
    motion: limitResetMotionApi,
    tooltip: {
      hasOpened: () => limitTooltip.opened,
      markOpened() {
        limitTooltip.opened = true;
        limitTooltip.active = true;
      },
      release() {
        requestAnimationFrame(() => {
          if (limitTooltipShouldHoldRender()) return;
          limitTooltip.active = false;
          if (!limitTooltip.pending) return;
          limitTooltip.pending = false;
          if (surface === 'notch' && state.payload) notchRenderer.render(state.payload);
          else if (state.payload?.cell) renderBubble(state.payload);
        });
      }
    },
    formatCompact: formatTokens,
    compactTokenThreshold: () => compactTokenApi.compactTokenUnitThreshold(
      compactTokenApi.effectiveCompactTokenUnits(appearance().compactTokenUnits, state.locale),
      state.locale
    ),
    formatMoney: balanceDisplay.formatMoney,
    formatCompactMoney: (value, currency) => balanceDisplay.formatCompactMoney(
      value, currency, appearance().compactTokenUnits, state.locale
    ),
    formatPercent: (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--'),
    formatDuration: presentation.formatResetDuration,
    formatLimitBoundary: limitPresentationApi.limitBoundaryText,
    limitFillPercent,
    limitModeSuffix,
    optionalFiniteNumber,
    colorWithAlpha,
    applyBarScale,
    creditsAmount: balanceDisplay.creditsAmount,
    creditsCurrency: balanceDisplay.creditsCurrency,
    creditsMeterPercent: balanceDisplay.creditsMeterPercent,
    isCreditsWindow: balanceDisplay.isCreditsWindow,
    spendWindow: balanceDisplay.spendWindow,
    limitWindowLabel: limitWindowLabels.limitWindowLabel,
    mimoAccountGroups,
    mimoProductLabel,
    limitWindowText: limitWindowTextApi.limitWindowText,
    accountIdentity: accountIdentityApi,
    accountControl: codexAccountControl,
    codexAccounts,
    // Probed off the stylesheet the dock borrows, so the card can never disagree
    // with the page about which providers have a mark.
    hasMark: hasMask,
    formatAgo: relativeAgo,
    // The renderer names the intent; the main process owns the URL.
    openExternal: () => bridge.openResetForecastSource?.(),
    // The subscription records the widget holds, pushed with the appearance. The
    // card's plan cell decorates itself from them exactly as the page's does —
    // same rows, same wording — so a recorded subscription shows the same hover
    // card here as it does there. What is not pushed is nothing: an empty list
    // renders a plain plan label on both surfaces.
    subscriptionApi: subscriptionDisplayApi,
    subscriptionText: subscriptionTextApi,
    currencyApi,
    formatCost,
    subscriptions: () => appearance().subscriptions,
    // The row being decorated is one of this card's own accounts, and a record
    // binds through the same list the page matches against — every account the
    // provider has, never the rows this card happens to draw, or
    // matchProviderAccount()'s sole-account fallback would bind a record to
    // whichever row asked. The composer can hide an account from the card without
    // it leaving the provider, so the cell carries that list beside its rows.
    subscriptionAccounts: () => cell()?.subscriptionAccounts || [],
    // What this month's tokens would have cost, which the subscription card
    // compares the plan's price against. It rides the cell because it changes with
    // every stats push, while the appearance is only re-pushed on a settings edit.
    monthClientCosts: () => cell()?.monthClientCosts,
    resetForecast: () => ({ busy: false, forecast: forecast() })
  });
}
const limitWindowsView = createCardWindowsView();

// ---- Silhouette -------------------------------------------------------------

// The path arrives from the main process, which derived it together with the
// native mask, so the painted tint and the clipped glass cannot disagree.
function updateShape(payload) {
  const shape = payload.shape;
  const key = shape?.key || '';
  if (shapeLayer.dataset.key === key) return;
  shapeLayer.dataset.key = key;
  shapeLayer.replaceChildren();
  if (!shape?.d) return;
  shapeLayer.setAttribute('viewBox', `0 0 ${shape.width} ${shape.height}`);
  shapeLayer.setAttribute('preserveAspectRatio', 'none');
  const fill = document.createElementNS(SVG_NS, 'path');
  fill.setAttribute('class', 'edge-dock-shape-fill');
  fill.setAttribute('d', shape.d);
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'edge-dock-shape-line');
  line.setAttribute('d', shape.outline || shape.d);
  shapeLayer.append(fill, line);
}

// ---- Peek ----------------------------------------------------------------

let refreshButton = null;
let refreshBusy = false;
let refreshResult = '';
let refreshFeedbackTimer = null;
let refreshVisit = 0;

function ensureRefreshButton() {
  if (!refreshButton) {
    refreshButton = el('button', 'edge-dock-refresh');
    refreshButton.type = 'button';
    const icon = el('span', 'edge-dock-refresh-icon');
    icon.setAttribute('aria-hidden', 'true');
    refreshButton.append(icon);
    refreshButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void refreshDockLimits();
    });
  }
  paintRefreshButton();
  return refreshButton;
}

function resetRefreshVisit() {
  refreshVisit++; clearTimeout(refreshFeedbackTimer);
  refreshBusy = false; refreshResult = '';
}

function paintRefreshButton() {
  if (!refreshButton) return;
  const key = refreshBusy ? 'refreshButton.refreshing'
    : refreshResult === 'success' ? 'refreshButton.refreshed'
      : refreshResult === 'error' ? 'refreshButton.failed' : 'edgeDock.refreshLimits';
  refreshButton.setAttribute('aria-label', t(key));
  refreshButton.setAttribute('aria-busy', String(refreshBusy));
  refreshButton.disabled = refreshBusy || state.payload?.refreshable !== true;
  refreshButton.dataset.state = refreshBusy ? 'busy' : refreshResult;
}

async function refreshDockLimits() {
  const allowed = surface === 'notch'
    ? state.payload?.expanded === true && state.payload?.refreshEnabled === true
    : state.payload?.peekMode === 'refresh';
  if (refreshBusy || !allowed || state.payload?.refreshable !== true) return;
  const visit = refreshVisit;
  clearTimeout(refreshFeedbackTimer);
  refreshBusy = true;
  refreshResult = '';
  paintRefreshButton();
  try {
    const result = await bridge.refreshLimits();
    if (visit === refreshVisit) refreshResult = result?.ok === true ? 'success' : 'error';
  } catch {
    if (visit === refreshVisit) refreshResult = 'error';
  } finally {
    if (visit === refreshVisit) {
      refreshBusy = false;
      paintRefreshButton();
      refreshFeedbackTimer = setTimeout(() => {
        refreshResult = '';
        paintRefreshButton();
      }, 1800);
    }
  }
}

function renderPeek(payload) {
  root.dataset.side = payload.side;
  root.dataset.peekMode = payload.peekMode || 'handle';
  // Sized to the window's own geometry rather than the viewport, in case AppKit
  // clamped the window wider than asked and the extra pixels lie off-screen.
  // The geometry is in window pixels and the page is zoomed to the dock's size.
  const zoom = payload.zoom || 1;
  root.style.width = `${(payload.shape?.width || 10) / zoom}px`;
  root.style.height = `${(payload.shape?.height || 88) / zoom}px`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (state.payload === payload) bridge.peekPainted?.(payload.peekMode || 'handle', payload.shape?.key);
  }));
  if (payload.peekMode === 'refresh') {
    root.setAttribute('aria-label', '');
    root.classList.remove('is-handle-hidden');
    ensureRefreshButton();
    if (contentLayer.firstChild !== refreshButton) contentLayer.replaceChildren(refreshButton);
    paintRefreshButton();
    return;
  }
  root.setAttribute('aria-label', t('settings.display.edgeDock'));
  // The handle is the silhouette itself (updateShape), tinted and outlined as the
  // rail is; the refresh button is the only content this window carries.
  if (contentLayer.firstChild) contentLayer.replaceChildren();
  // The handle's exit is a move, not a blink, so the withdrawn pose is held as a
  // class and one transition carries it both ways (see the handle's rules). The
  // class goes on with the first render, which is what keeps a page that loads
  // with the rail already open from animating into a pose it starts in.
  root.classList.toggle('is-handle-hidden', payload.peeking !== true);
}

if (surface === 'peek') root.addEventListener('click', () => {
  if (state.payload?.peekMode !== 'refresh') bridge.click(null);
});

// On macOS the handle and floating rail pass the pointer through with moves still
// forwarded here, so reporting them lets the main process take the pointer as
// it reaches the handle rather than at its next cursor poll. The report carries
// no position: the main process reads the cursor itself.
if (surface === 'peek' || surface === 'rail') {
  const reportPointer = () => {
    if (surface === 'rail' ? state.payload?.platform === 'darwin' : state.payload?.peekMode !== 'refresh') bridge.pointer();
  };
  document.addEventListener('mousemove', reportPointer);
  document.documentElement.addEventListener('mouseleave', reportPointer);
}

// The notch window passes the pointer through, with its moves forwarded, until
// the main process sees the pointer on the shell. Moves are reported once a
// frame so the shell takes input as the pointer arrives; presses and wheel
// events only reach the page while it does, and the main process decides what
// they mean from the cursor position.
if (surface === 'notch') {
  let pointerFrame = 0;
  const reportPointer = () => {
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(() => { pointerFrame = 0; bridge.pointer(); });
  };
  document.addEventListener('mousemove', reportPointer);
  document.documentElement.addEventListener('mouseleave', () => bridge.pointer());
  document.addEventListener('mousedown', (event) => { if (event.button === 0) bridge.press(); });
  // Line-based deltas are rare on macOS; scale them to points like Chromium.
  window.addEventListener('wheel', (event) => {
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    bridge.wheel(event.deltaX * scale, event.deltaY * scale);
  }, { passive: true });
}

// ---- Rail ----------------------------------------------------------------

function waitingRingStart(cellId, isWaiting) {
  if (!isWaiting) {
    waitingRingStarts.delete(cellId);
    return null;
  }
  if (!waitingRingStarts.has(cellId)) {
    waitingRingStarts.set(cellId, performance.now());
  }
  return waitingRingStarts.get(cellId);
}

function ringNode(remainingPercent, color, mark, waitingStartedAt = null) {
  const ring = el('div', 'edge-dock-ring');
  ring.style.setProperty('--ring-color', color);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 42 42');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'edge-dock-ring-track');
  // The consumed part of the ring is a tint of the provider's own colour, the
  // same treatment as the limit meters' track.
  const trackRgb = parseColor(color);
  if (trackRgb) track.style.stroke = `rgba(${trackRgb.join(', ')}, 0.2)`;
  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('class', 'edge-dock-ring-fill');
  for (const circle of [track, fill]) {
    circle.setAttribute('cx', '21');
    circle.setAttribute('cy', '21');
    circle.setAttribute('r', String(RING_RADIUS));
  }
  // The ring always shows what is left, whatever the text mode: a ring that
  // emptied as a quota recovered would read backwards next to its neighbours.
  const remaining = remainingPercent === null ? 0 : Math.max(0, Math.min(100, remainingPercent));
  fill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  fill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - remaining / 100)));
  if (remainingPercent === null) fill.style.opacity = '0';
  svg.append(track, fill);
  const waiting = document.createElementNS(SVG_NS, 'svg');
  waiting.setAttribute('class', 'edge-dock-ring-waiting');
  waiting.setAttribute('viewBox', '0 0 42 42');
  waiting.setAttribute('aria-hidden', 'true');
  const waitingCircle = document.createElementNS(SVG_NS, 'circle');
  waitingCircle.setAttribute('cx', '21');
  waitingCircle.setAttribute('cy', '21');
  waitingCircle.setAttribute('r', '14');
  waiting.append(waitingCircle);
  if (waitingStartedAt !== null) {
    const elapsed = Math.max(0, performance.now() - waitingStartedAt);
    waiting.style.animationDelay = `-${elapsed % WAITING_PULSE_MS}ms`;
  }
  if (appearance().edgeDockRunningIndicatorEnabled === false) {
    ring.append(svg, mark, waiting);
    return ring;
  }
  // A separate inner arc reports work without moving the quota reading. Rail
  // pushes rebuild these nodes, so anchor rotation to the clock to avoid restarting
  // the spinner each time new usage arrives.
  const spinner = document.createElementNS(SVG_NS, 'svg');
  spinner.setAttribute('class', 'edge-dock-ring-spinner');
  spinner.setAttribute('viewBox', '0 0 42 42');
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.animationDelay = `-${Date.now() % RUNNING_SPIN_MS}ms`;
  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('cx', '21');
  arc.setAttribute('cy', '21');
  arc.setAttribute('r', '14');
  arc.setAttribute('stroke-dasharray', `${7 * Math.PI} ${21 * Math.PI}`);
  spinner.append(arc);
  ring.append(svg, spinner, mark, waiting);
  return ring;
}

function providerCellNode(cell) {
  const node = el('div', 'edge-dock-cell');
  node.dataset.status = cell.status;
  // Work in flight for this provider's tools, asked of the rows at paint time for
  // same reason the sessions cell asks: running expires on a clock. The inner
  // spinner is independent of quota, since tokens may be billed to another
  // endpoint. It also remains visible when the quota is empty or stale. Hiding
  // the card's session list does not hide the running signal.
  const running = runningSessionSummary(cell.sessions).count;
  const waiting = presentation.waitingSessionSummary(cell.sessions).count;
  if (running > 0) node.dataset.running = 'yes';
  if (waiting > 0) node.dataset.waiting = 'yes';
  const color = providerColor(cell.provider);
  const shown = presentation.displayPercent(cell.remainingPercent, appearance().showLimitUsed === true);
  const value = el('span', 'edge-dock-value');
  const hasCreditsAmount = Boolean(cell.credits) && cell.credits.amount !== null && cell.credits.amount !== undefined;
  if (hasCreditsAmount) {
    value.textContent = balanceDisplay.formatCompactMoney(
      cell.credits.amount, cell.credits.currency, appearance().compactTokenUnits, state.locale
    );
  } else {
    value.textContent = shown === null ? '--' : `${Math.round(shown)}%`;
  }
  // What a refill motion compares against to recognise a real reset on this
  // cell: the headline's account and window identities ride the key, so a
  // headline that swapped to another account or pool is never animated as one.
  // The figure's roll keys on the same identity for the same reason.
  node.dataset.ringMotionKey = `${cell.id}\0${cell.headlineAccount || ''}\0${cell.headlineWindowKey || ''}`;
  markRoll(value, `${node.dataset.ringMotionKey}:value`, hasCreditsAmount ? Number(cell.credits.amount) : shown, reading => hasCreditsAmount
    ? balanceDisplay.formatCompactMoney(reading, cell.credits.currency, appearance().compactTokenUnits, state.locale) : `${Math.round(reading)}%`);
  node.dataset.ringRemaining = cell.remainingPercent === null || cell.remainingPercent === undefined
    ? ''
    : String(cell.remainingPercent);
  node.dataset.ringDisplay = cell.credits || shown === null ? '' : String(shown);
  node.dataset.ringResetAt = cell.resetsAt || '';
  // Colour answers "how close is the closest quota to empty"; the figure itself
  // answers "what does the primary window say" (0% when a quota is spent).
  // Splitting the two lets a tight secondary window warn without turning the
  // headline into whichever window is lowest this minute.
  value.dataset.severity = displaySeverity(cell.severityPercent ?? cell.remainingPercent);
  node.append(ringNode(cell.remainingPercent, color, markNode(cell.provider), waitingRingStart(cell.id, waiting > 0)), value);
  // The spinner is decorative and carries no text, so the state it announces is
  // spoken here instead, from the same reading it is drawn from.
  const spoken = [providerLabel(cell.provider), value.textContent];
  if (running > 0) spoken.push(t('edgeDock.runningCount', { count: running }));
  if (waiting > 0) spoken.push(t('edgeDock.waitingCount', { count: waiting }));
  node.setAttribute('aria-label', spoken.join(' '));
  return node;
}

function formatRate(rate) {
  const value = Math.max(0, Number(rate) || 0);
  if (value > 0 && value < 0.1) return '<0.1';
  if (value > 0 && value < 1) return value.toLocaleString(state.locale, { maximumFractionDigits: 1 });
  return formatTokens(value);
}

function formatCacheHitRate(rate) {
  if (!Number.isFinite(rate)) return '—';
  const value = Math.max(0, rate);
  const percent = (number) => number.toLocaleString(state.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }) + '%';
  if (value > 0 && value < 0.1) return '<' + percent(0.1);
  return percent(value);
}

function cacheHitDetail(cell) {
  return t('edgeDock.cacheHit.detail', {
    hit: formatTokens(cell.hit),
    miss: formatTokens(cell.miss)
  });
}

function statLabel(metric) {
  if (metric === 'liveRate') return t('edgeDock.stat.liveRate');
  if (metric === presentation.SESSIONS_METRIC) return t('edgeDock.sessions');
  return t(`edgeDock.period.${metric}`);
}

// Rail-width money: whole units past 100 and compact notation past 10k, so a
// figure like HK$569.82 does not overflow a 56px readout. The card keeps the
// full-precision figure. The compact form goes through the same shared helper
// as the tray and dashboard, so it follows the token unit system — a localized
// user sees 萬/億 here too, never 億 beside K.
function formatRailCost(value, unpricedTokens) {
  if (unpricedTokens > 0) return '—';
  const code = appearance().currency || 'USD';
  const amount = Math.abs(currencyApi.convertUsd(value, code));
  if (amount >= 10_000) {
    return compactMoneyApi.formatCompactCurrencyFromUsd(
      Math.abs(value), code, appearance().compactTokenUnits, state.locale
    );
  }
  const full = currencyApi.formatCurrencyFromUsd(value, code);
  const symbol = full.replace(/[\d.,\s-]+$/, '');
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${symbol}${amount.toFixed(digits)}`;
}

function statShortLabel(cell) {
  if (cell.metric === 'liveRate') return t(cell.rateMode === 'burn' ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit');
  if (cell.metric === presentation.SESSIONS_METRIC) return t('edgeDock.statGlyph.sessions');
  return t(`edgeDock.periodShort.${cell.metric}`);
}

// The live token rate on a sessions cell's third line, shaped like the live-rate
// item's own readout so the two cards read alike. Muted while idle rather than
// blank: "no traffic right now" is a reading, not an absence of one.
function cellRateNode(cell) {
  const missing = cell.rate === null || cell.rate === undefined;
  const node = el('span', 'edge-dock-cell-rate');
  node.classList.toggle('is-idle', missing || cell.rateIdle === true);
  // No tooltip on this line. A `title` needs the pointer to rest on the node, but
  // hovering this cell opens its card after bubbleDelayMs (70ms), so the tooltip
  // is never reached - and the wording it would carry describes the live-rate
  // item's readout, which really does toggle rate mode on click while this cell
  // opens its card. A tooltip nobody can read is not worth five translations.
  node.append(
    markRoll(el('span', 'edge-dock-cell-rate-value', missing ? '—' : formatRate(cell.rate)), `${cell.id}:rate`, cell.rate, formatRate),
    el('span', 'edge-dock-cell-rate-unit', t(cell.rateMode === 'burn' ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit'))
  );
  return node;
}

// The tools with a session running right now, as their own marks. This is what the
// cell can say that no other cell can: which tools are working, in one glance,
// including the tools that have no quota to draw a ring from. The count beside
// them covers the marks that did not fit. Drawn only when the item's cell detail
// asks for marks rather than a rate (see statCellNode).
// How many tool marks fit the 56px cell beside its headline. Past this the
// remainder is a count rather than a mark shrunk past legibility. A drawing
// limit, so it lives here rather than in the projection.
const CELL_MARK_LIMIT = 3;

function runningMarksNode(cell, now = Date.now()) {
  // Derived from the rows at paint time, not from a count frozen into the cell:
  // running expires on a clock, so a rail that never re-projects would keep
  // drawing marks for work that has stopped (see presentation.js).
  const { clients, clientCount } = runningSessionSummary(cell.sessions, now);
  if (!clients.length) return null;
  const row = el('span', 'edge-dock-cell-marks');
  for (const client of clients.slice(0, CELL_MARK_LIMIT)) {
    // Brand colour, corrected for contrast like every other mark the dock
    // draws: the client id is what the mark is looked up by, and the rail
    // already reserves colour for severity, so these stay marks and not meters.
    row.append(markNode(client, readableColor(clientColors[client] || clientColors.default)));
  }
  const rest = clientCount - Math.min(clients.length, CELL_MARK_LIMIT);
  if (rest > 0) row.append(el('span', 'edge-dock-cell-more', `+${rest}`));
  return row;
}

// Caption, tokens, and the period's cost in a smaller line beneath: one item
// per period rather than separate token and cost items, since the two are read
// together. Usage has no quota to measure against, so it gets text, not a ring.
function statCellNode(cell) {
  const node = el('div', 'edge-dock-cell edge-dock-cell-stat');
  node.dataset.metric = cell.metric;
  node.append(el('span', 'edge-dock-stat-label', statShortLabel(cell)));
  if (cell.metric === 'liveRate') {
    node.classList.toggle('is-idle', cell.idle === true);
    node.setAttribute('aria-description', t('edgeDock.rate.switch'));
    node.append(markRoll(el('span', 'edge-dock-stat-value', cell.rate === null || cell.rate === undefined ? '—' : formatRate(cell.rate)),
      `${cell.id}:value`, cell.rate, formatRate));
  } else if (cell.metric === presentation.SESSIONS_METRIC) {
    // Nothing running is a real reading, not a missing one, so the zero is
    // shown - muted, exactly as the live-rate cell mutes its own idle state.
    // Asked of the rows at paint time, so a cell left on screen stops claiming a
    // running session the moment that session crosses the ten-minute window.
    const running = runningSessionSummary(cell.sessions).count;
    node.classList.toggle('is-idle', running === 0);
    node.append(markRoll(el('span', 'edge-dock-stat-value', String(running)), `${cell.id}:value`, running, value => String(Math.round(value))));
    // The third line is the item's own choice: the tools with work in flight, or
    // the live token rate. Rate mode keeps its line even with nothing running, so
    // the cell does not change height as work starts and stops.
    if (cell.cellDetail === 'rate') {
      node.append(cellRateNode(cell));
    } else {
      const marks = runningMarksNode(cell);
      if (marks) node.append(marks);
    }
  } else if (cell.metric === 'cacheHit') {
    node.classList.toggle('is-idle', cell.available !== true);
    const value = el('span', 'edge-dock-stat-value', formatCacheHitRate(cell.rate));
    node.append(value);
  } else if (!cell.available) {
    node.classList.add('is-idle');
    node.append(el('span', 'edge-dock-stat-value', '—'));
  } else {
    node.append(
      markRoll(el('span', 'edge-dock-stat-value', formatTokens(cell.totalTokens)), `${cell.id}:value`, cell.totalTokens, formatTokens),
      markRoll(el('span', 'edge-dock-stat-cost', formatRailCost(cell.costUsd, cell.unpricedTokens)), `${cell.id}:cost`, cell.costUsd, value => formatRailCost(value, cell.unpricedTokens))
    );
  }
  // The tool marks are decorative: the count beside them already says how many
  // are running, so folding their (empty) text into the label would only add
  // whitespace. Everything else keeps contributing to it.
  const readout = [...node.children]
    .filter((child) => !child.classList.contains('edge-dock-cell-marks'))
    .slice(1)
    .map((child) => child.textContent)
    .filter(Boolean)
    .join(' ');
  // The marks themselves are mask-painted spans with no text, so the tools they
  // name are spoken here instead: which tools are working is the whole point of
  // this cell, and it cannot ride on the marks alone. Named from the same summary
  // the marks are drawn from, so the label and the picture cannot disagree, and
  // read from the rows rather than from a frozen field so it ages with them.
  const workingTools = cell.metric === presentation.SESSIONS_METRIC
    ? runningSessionSummary(cell.sessions).clients.map((client) => clientLabel(client))
    : [];
  const spokenParts = cell.metric === presentation.SESSIONS_METRIC
    // The count already reads as a number in `readout`; the tools are appended only
    // when there are any, so a quiet cell does not end with an empty clause.
    ? [statLabel(cell.metric), readout, workingTools.join(', ')]
    : [statLabel(cell.metric), readout];
  if (cell.metric === 'cacheHit' && cell.available) spokenParts.push(cacheHitDetail(cell));
  const spoken = spokenParts.filter(Boolean).join(' ').trim();
  node.setAttribute('aria-label', spoken);
  return node;
}

// ---- Reset refill motion --------------------------------------------------
// A quota resetting to full plays the same refill the Limits page's meters
// play: the arc sweeps to full, the figure counts up to meet it, and a flare
// lands with the last of the sweep. Whether a push is a real reset is
// resetMotion.js's call — this only paints its answer. The card's quota rows
// go through the shared animator itself (commitCard); the ring is the dock's
// own DOM, so its half of the same motion lives here, paced by the same
// constants.

const ringResetMotions = new WeakMap();
const ringNumberAnimations = new Map();
const RING_MOTION_EASING = limitResetAnimatorApi.EASING;
const RING_GLOW_MS = limitResetAnimatorApi.GLOW_MS;
const RING_GLOW_LEAD_MS = limitResetAnimatorApi.GLOW_LEAD_MS;

function captureRingResetMotion(scope = railNode) {
  const snapshot = new Map();
  for (const cell of scope?.querySelectorAll('.edge-dock-cell[data-ring-motion-key]') || []) {
    const key = cell.dataset.ringMotionKey;
    const entry = {
      remainingPercent: cell.dataset.ringRemaining,
      displayPercent: cell.dataset.ringDisplay,
      resetsAt: cell.dataset.ringResetAt,
      motion: ringResetMotions.get(cell.querySelector('.edge-dock-ring-fill'))
    };
    // Ambiguous identities are safer left static than animated on the wrong cell.
    snapshot.set(key, snapshot.has(key) ? null : entry);
  }
  return snapshot;
}

// The arc itself. stroke-dashoffset is the property the circle already paints
// from; a WAAPI pass on it overrides the ring's 420ms CSS transition for the
// run, then lets go — the attribute already holds the target.
function animateRingArc(circle, from, to, duration, startedAt) {
  if (!circle?.animate) return;
  for (const animation of circle.getAnimations()) animation.cancel();
  const fromOffset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, from)) / 100);
  const toOffset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, to)) / 100);
  if (Math.abs(toOffset - fromOffset) < 0.001) return;
  const animation = circle.animate([
    { strokeDashoffset: `${fromOffset}px` },
    { strokeDashoffset: `${toOffset}px` }
  ], {
    duration,
    easing: RING_MOTION_EASING,
    fill: 'backwards'
  });
  if (startedAt !== null) animation.startTime = startedAt;
}

function animateRingPercent(el, from, to, duration, startedAt = performance.now()) {
  if (!el) return;
  if (prefersReducedMotion() || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    el.textContent = `${Math.round(to)}%`;
    return;
  }
  const delta = to - from;
  const entry = { handle: 0, target: to };
  const initialProgress = Math.max(0, Math.min(1, (performance.now() - startedAt) / duration));
  let renderedText = `${Math.round(from + delta * (1 - ((1 - initialProgress) ** 2)))}%`;
  el.textContent = renderedText;
  function frame(now) {
    if (!el.isConnected) {
      if (ringNumberAnimations.get(el) === entry) ringNumberAnimations.delete(el);
      return;
    }
    if (prefersReducedMotion()) {
      el.textContent = `${Math.round(to)}%`;
      if (ringNumberAnimations.get(el) === entry) ringNumberAnimations.delete(el);
      return;
    }
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - ((1 - progress) * (1 - progress));
    const nextText = `${Math.round(from + delta * eased)}%`;
    if (nextText !== renderedText) {
      renderedText = nextText;
      el.textContent = nextText;
    }
    if (progress < 1) {
      entry.handle = requestAnimationFrame(frame);
    } else if (ringNumberAnimations.get(el) === entry) {
      ringNumberAnimations.delete(el);
    }
  }
  entry.handle = requestAnimationFrame(frame);
  ringNumberAnimations.set(el, entry);
}

// The flare the sweep lands with — the ring's counterpart to the meter's
// .limit-meter-completion.
function animateRingCompletion(ring, duration, startedAt = null) {
  if (!ring || prefersReducedMotion()) return;
  const flare = document.createElement('span');
  flare.className = 'edge-dock-ring-complete';
  ring.append(flare);
  const animation = flare.animate([
    { opacity: 0 },
    { offset: RING_GLOW_LEAD_MS / RING_GLOW_MS, opacity: 0.55 },
    { opacity: 0 }
  ], {
    duration: RING_GLOW_MS,
    delay: Math.max(0, duration - RING_GLOW_LEAD_MS),
    easing: 'linear'
  });
  if (startedAt !== null) animation.startTime = startedAt;
  const remove = () => flare.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
}

// Returns the figures a refill counts up, including ones whose count-up starts
// on the next frame, so nothing else animates them in the meantime.
function animateRingResets(snapshot, scope = railNode) {
  const owned = new Set();
  if (!snapshot?.size || prefersReducedMotion()) return owned;
  const motions = [];
  for (const cell of scope?.querySelectorAll('.edge-dock-cell[data-ring-motion-key]') || []) {
    const key = cell.dataset.ringMotionKey;
    const previous = snapshot.get(key);
    const current = {
      remainingPercent: cell.dataset.ringRemaining,
      displayPercent: cell.dataset.ringDisplay,
      resetsAt: cell.dataset.ringResetAt
    };
    if (!previous) continue;
    const circle = cell.querySelector('.edge-dock-ring-fill');
    const active = previous.motion;
    // A stats push rebuilds the rail even when nothing changed. Carry the
    // original timeline across that replacement, including its flare.
    if (
      active
      && circle
      && previous.remainingPercent === current.remainingPercent
      && previous.displayPercent === current.displayPercent
      && previous.resetsAt === current.resetsAt
      && (active.startedAt === null || performance.now() - active.startedAt < active.duration + RING_GLOW_MS - RING_GLOW_LEAD_MS)
    ) {
      motions.push({ cell, circle, motion: active });
      continue;
    }
    if (!limitResetMotionApi.shouldAnimateReset(previous, current)) continue;
    const fromRemaining = Number(previous.remainingPercent);
    const toRemaining = Number(current.remainingPercent);
    const from = Number(previous.displayPercent);
    const to = Number(current.displayPercent);
    if (
      !Number.isFinite(fromRemaining)
      || !Number.isFinite(toRemaining)
      || !circle
    ) continue;
    const duration = limitResetMotionApi.durationMs(fromRemaining, toRemaining);
    motions.push({
      cell,
      circle,
      motion: {
        fromRemaining,
        toRemaining,
        // A cell whose figure is not a percent — a credits balance — still
        // sweeps its arc; it just has no count to run up.
        display: previous.displayPercent !== '' && current.displayPercent !== ''
          && Number.isFinite(from) && Number.isFinite(to)
          ? { from, to }
          : null,
        duration,
        startedAt: null
      }
    });
  }
  if (!motions.length) return owned;
  // The same batch rule the meters follow: refills land on full together,
  // paced by the longest member.
  const duration = limitResetMotionApi.groupDurationMs(
    motions.filter(({ motion }) => motion.startedAt === null).map(({ motion }) => motion.duration)
  );
  for (const { circle, motion } of motions) {
    if (motion.startedAt === null) motion.duration = duration;
    ringResetMotions.set(circle, motion);
  }
  function startMotion({ cell, circle, motion }, now) {
    if (!circle.isConnected || !cell.isConnected || prefersReducedMotion()) return;
    if (motion.startedAt === null) motion.startedAt = now;
    const { fromRemaining, toRemaining, display, duration, startedAt } = motion;
    animateRingArc(circle, fromRemaining, toRemaining, duration, startedAt);
    animateRingCompletion(cell.querySelector('.edge-dock-ring'), duration, startedAt);
    if (display) animateRingPercent(cell.querySelector('.edge-dock-value'), display.from, display.to, duration, startedAt);
  }
  // Resumed effects must cover the replacement DOM before it can paint its
  // static target; new refills still begin after the rest of this render.
  const pending = [];
  for (const entry of motions) {
    if (entry.motion.startedAt === null) pending.push(entry);
    else startMotion(entry, entry.motion.startedAt);
  }
  if (pending.length) requestAnimationFrame((now) => {
    for (const entry of pending) startMotion(entry, now);
  });
  for (const { cell, motion } of motions) {
    if (motion.display) owned.add(cell.querySelector('.edge-dock-value'));
  }
  return owned;
}

// Snapping running effects to their end state when reduced motion turns on —
// the same settle the widget's limits panel gets, for both the rail's own
// motions and the card animator's.
function settleDockMotions() {
  for (const animation of root.getAnimations({ subtree: true })) {
    try { animation.finish(); } catch (_) { animation.cancel(); }
  }
  for (const [el, entry] of ringNumberAnimations) {
    cancelAnimationFrame(entry.handle);
    el.textContent = `${Math.round(entry.target)}%`;
  }
  ringNumberAnimations.clear();
  railNumberRoll.settle();
  cardResetAnimator.settle(contentLayer);
}

// The card's quota rows are the Limits page's rows — including their refill
// motion, driven by the animator the page itself uses, scoped to the card.
const cardResetAnimator = limitResetAnimatorApi.createLimitResetAnimator({
  document,
  motion: limitResetMotionApi,
  prefersReducedMotion,
  formatPercent: (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--'),
  requestAnimationFrame: (frame) => requestAnimationFrame(frame),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  performance
});

let railNode = null;
// `null` until a payload has said: the entrance is keyed to a reveal this page has
// not seen, so a page that loads with the rail already up shows it instead of
// replaying the slide.
let railReveal = null;

// The motion itself is CSS (`edge-dock-rail-in`); this only decides when it
// plays. The root wraps both the silhouette and the cells, so sliding it moves
// the rail as one unit, and the window — which is the screen edge — is what
// clips the part that starts off-screen.
function playRailReveal() {
  if (document.documentElement.classList.contains('edge-dock-reduced-motion')) return;
  // The class is dropped on animationend; clearing it first and flushing the
  // style is what makes a second reveal replay the animation rather than re-add
  // a class whose animation has already finished.
  root.classList.remove('is-revealing');
  void root.offsetWidth;
  root.classList.add('is-revealing');
}

root.addEventListener('animationend', (event) => {
  if (event.animationName === 'edge-dock-rail-in') root.classList.remove('is-revealing');
});

function renderRail(payload) {
  root.dataset.side = payload.side;
  root.classList.toggle('is-always', payload.always === true);
  // Stats arrive every few seconds and each one re-renders this surface, so the
  // slide belongs to the reveal rather than to every payload that follows it: the
  // count moves only on a real reveal, and this plays when it has moved on.
  const reveal = payload.reveal;
  const revealing = railReveal !== null && reveal !== railReveal;
  if (revealing) playRailReveal();
  railReveal = reveal;
  if (!railNode) {
    railNode = el('div', 'edge-dock-rail');
    contentLayer.append(railNode);
    bindRailGestures(railNode);
  }
  const layout = payload.cellLayout || null;
  railNode.classList.toggle('is-compact', layout?.compact === true);
  const retainedPlugins = new Map([...railNode.children].filter(node => node.dataset.pluginRef).map(node => [node.dataset.cellId, node]));
  const nodes = [];
  (payload.cells || []).forEach((cell, index) => {
    const node = cell.kind === 'stat' ? statCellNode(cell) : cell.kind === 'plugin' ? pluginCellNode(cell, retainedPlugins.get(cell.id)?.dataset.pluginRef === cell.ref ? retainedPlugins.get(cell.id) : null) : providerCellNode(cell);
    node.dataset.cellId = cell.id;
    node.dataset.index = String(index);
    // Cells are placed on the main process's layout so hover hit-testing and
    // what is painted can never drift apart.
    if (layout) {
      node.style.top = `${layout.tops[index]}px`;
      node.style.height = `${layout.heights[index]}px`;
    }
    node.classList.toggle('is-focused', payload.focusCellId === cell.id);
    nodes.push(node);
  });
  const providerIds = new Set((payload.cells || []).filter((cell) => cell.kind === 'provider').map((cell) => cell.id));
  for (const id of waitingRingStarts.keys()) {
    if (!providerIds.has(id)) waitingRingStarts.delete(id);
  }
  const ringSnapshot = captureRingResetMotion();
  const rollSnapshot = railNumberRoll.capture(railNode);
  // Keep surviving author controls connected: re-inserting an unchanged node
  // clears browser focus even when its input object and draft survive.
  const keep = new Set(nodes);
  for (const node of [...railNode.children]) if (!keep.has(node)) node.remove();
  let cursor = railNode.firstChild;
  for (const node of nodes) {
    if (node !== cursor) railNode.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  const targets = [];
  (payload.cells || []).forEach((cell, index) => {
    if (cell.kind === 'plugin') return;
    const target = `edgeDock.rail.${cell.kind}.content`;
    targets.push(target);
    if (!pluginContent?.hasTarget(target)) return;
    const node = nodes[index], native = el('div', 'plugin-native-content');
    native.append(...node.childNodes); node.append(native);
    pluginContent.render(target, native, { surface: 'edgeDock', surfaceVariant: 'rail', targetInstance: cell.id, cell, nativeData: payload });
  });
  pluginContent?.retain(targets);
  pluginHost?.refreshDemand();
  const refilling = animateRingResets(ringSnapshot);
  // A retracted rail is not repainted, so a reveal shows the latest readings at
  // once rather than rolling from ones left on screen minutes ago. A refill's
  // count-up owns its figure.
  if (!revealing && !prefersReducedMotion()) {
    railNumberRoll.play(railNode, rollSnapshot, { skip: (node) => refilling.has(node) });
  }
}

let gesture = null;
let nextGestureId = 0;

function startDragFrames() {
  if (state.payload?.platform !== 'win32') return;
  // Windows can round a main-process 16ms timeout up to two system ticks
  // (~31ms). Follow the display's paint clock while dragging instead; the
  // main process still reads the native cursor and owns release/cancellation.
  const id = gesture.id;
  const frame = () => {
    if (gesture?.id !== id || !gesture.dragging) return;
    bridge.dragFrame(id);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

bridge.onDragEnded?.(({ gestureId }) => {
  if (gesture?.id !== gestureId) return;
  gesture = null;
  railNode?.classList.remove('is-dragging');
});

function bindRailGestures(rail) {
  rail.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || gesture) return;
    gesture = {
      id: ++nextGestureId,
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      grabOffsetY: event.clientY,
      grabOffsetX: event.clientX,
      cellIndex: indexFromTarget(event.target),
      dragging: false
    };
    rail.setPointerCapture(event.pointerId);
  });
  rail.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // A later move can prove release even if capture was lost and the native
    // button reader is unavailable. Capture loss alone still proves nothing.
    if (event.buttons === 0) {
      finish(event);
      return;
    }
    if (gesture.dragging) return;
    if (Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < DRAG_THRESHOLD_PX) return;
    gesture.dragging = true;
    rail.classList.add('is-dragging');
    bridge.dragStart(gesture.grabOffsetY, gesture.grabOffsetX, gesture.id);
    startDragFrames();
  });
  const finish = (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const ended = gesture;
    gesture = null;
    rail.classList.remove('is-dragging');
    if (ended.dragging) bridge.dragEnd();
    else if (event.type === 'pointerup') bridge.click(ended.cellIndex);
  };
  rail.addEventListener('pointerup', finish);
  // Cancellation and capture loss do not prove physical release. Main continues
  // while native tracking works, or restores saved placement when it cannot.
  const captureLost = (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.dragging) bridge.dragCaptureLost?.(gesture.id);
    else finish(event);
  };
  rail.addEventListener('pointercancel', captureLost);
  rail.addEventListener('lostpointercapture', captureLost);
}

function indexFromTarget(target) {
  const cell = target?.closest?.('.edge-dock-cell');
  if (!cell) return null;
  const index = Number(cell.dataset.index);
  return Number.isInteger(index) ? index : null;
}

// ---- Detail card ------------------------------------------------------------

function usageTile(label, usage) {
  const tile = el('div', 'edge-dock-usage-tile');
  tile.append(
    el('span', 'edge-dock-usage-label', label),
    el('span', 'edge-dock-usage-tokens', usage ? formatBreakdownTokens(usage.tokens) : '—')
  );
  if (usage) tile.append(usageCostNode('edge-dock-usage-cost', usage));
  return tile;
}

function relativeAgo(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(Math.max(0, Date.now() - ms) / 60000);
  if (minutes < 1) return t('edgeDock.agoNow');
  if (minutes < 60) return t('edgeDock.agoMinutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('edgeDock.agoHours', { count: hours });
  return t('edgeDock.agoDays', { count: Math.round(hours / 24) });
}

// The provider's newest sessions: what the session was (title, else project,
// else a short id), its main model, how long ago, and its tokens.
//
// The session's context headroom is drawn as a small bar plus its percentage on
// the meta line. It ADDS to the row rather than taking the right column: the
// token total is what the row was already for, and headroom is extra, not a
// replacement. Same Remaining/Used preference as the limits meters and the same
// colour rule as the Sessions list - neutral while healthy, a colour only as it
// runs out. Absent for a session whose transcript states no window, which is the
// normal case rather than an error.
// Last activity seen for each session, so the running dot can flare on an
// actual transcript write instead of pulsing forever. Module state on purpose:
// the comparison is against the previous payload.
const lastActivityBySession = new Map();

// Only the sessions this card currently lists keep their entry. A session that
// drops out of the list can never flare again, so holding it would leak one
// entry per session for the life of the process.
function pruneActivity(sessions) {
  const live = new Set([...sessions, ...presentation.sessionMembers(sessions)].map(sessionKey));
  for (const key of lastActivityBySession.keys()) {
    if (!live.has(key)) lastActivityBySession.delete(key);
  }
}

// The canonical key the projection carried, so the state map, the flare cache
// and the row lookup all identify a record the same way. Two clients can carry
// the same sessionId, and keying on it alone let one client's state paint onto
// the other's row.
function sessionKey(session) {
  return String(session?.key || session?.sessionId || '');
}

// The state mark, rendered on every row so all titles start at the same x.
// Three states matching the Sessions list: a spinner while the agent works, a
// check once the transcript said the turn finished, and a faint dot for a
// session that has simply gone quiet.
function stateMark(session, key, state) {
  const dot = el('span', 'edge-dock-session-dot');
  // The glyphs come from the shared builder, so this card and the Sessions list
  // cannot drift into different spinner or check shapes.
  dot.innerHTML = SESSION_STATE_GLYPHS;
  dot.dataset.state = state;
  const labelKey = { running: 'session.running', waiting: 'session.waiting', ended: 'session.finished' }[state];
  dot.setAttribute('aria-hidden', labelKey ? 'false' : 'true');
  if (labelKey) {
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', t(labelKey));
  }
  const previous = lastActivityBySession.get(key) || 0;
  const next = Date.parse(session.lastUsedAt || '') || 0;
  if (next > 0) lastActivityBySession.set(key, next);
  // Never on a first paint: a card that flares every row as it opens says
  // nothing about which session just moved. The flare is a one-shot animation
  // rather than an `infinite` pulse, matching the titlebar dot and the Sessions
  // list, so an open-but-idle card costs the compositor nothing.
  if (state === 'running' && previous && next > previous) dot.classList.add('pulse');
  return dot;
}

function sessionsNode(sessions) {
  sessions = Array.isArray(sessions) ? sessions : [];
  pruneActivity(sessions);
  pruneSessionGroupExpansion(sessions);
  if (!sessions.length) return null;
  // A provider card's rows are all one client, so their marks would only repeat
  // the card's own header; the standalone Sessions card lists every client and
  // names each row's tool (see sessionsCard).
  const node = sessionsContainer(sessions, { title: t('edgeDock.sessions'), showClientMark: false });
  return node;
}

const expandedSessionGroups = new Set();

function sessionGroupExpansionKey(key) {
  return `${state.payload?.cell?.id || ''}|${key}`;
}

function pruneSessionGroupExpansion(sessions) {
  const prefix = sessionGroupExpansionKey('');
  const live = new Set(sessions.filter(row => row.groupRows).map(row => sessionGroupExpansionKey(sessionKey(row))));
  for (const key of expandedSessionGroups) {
    if (key.startsWith(prefix) && !live.has(key)) expandedSessionGroups.delete(key);
  }
}

function sessionsContainer(sessions, options = {}) {
  // Re-derived rather than trusted from the pushed cell: the card repaints
  // every 30s from its last payload, and a session that stopped in between must
  // stop reading as running (and must stop being counted).
  // One derivation serves both the count and the marks, from the same shared
  // predicate the Sessions list uses.
  const stateByKey = new Map(sessions.map((session) => [sessionKey(session), presentation.sessionActivityState(session)]));
  const liveCount = [...stateByKey.values()].filter((activityState) => activityState === 'running').length;
  const node = el('div', 'edge-dock-sessions');
  // The feathered rule above a section separates it from a quota row. A nested
  // list already sits under its group's own header, so it draws none: one line
  // per group would be a rule under every header instead of between sections.
  if (options.separator === false) node.classList.add('is-plain');
  // "Recent" was doing no work - every row already carries its own `3m ago` -
  // while the running count is the one thing the section can say that the rows
  // cannot. Shown only when something is running: "none running" is noise.
  const head = el('div', 'edge-dock-section-head');
  if (options.title) head.append(el('span', 'edge-dock-section-title', options.title));
  // A grouped section states the count beside its tool name one line up, so the
  // nested list stays silent rather than repeating the same number.
  if (liveCount > 0 && options.showCount !== false) {
    head.append(el('span', 'edge-dock-section-count', t('edgeDock.runningCount', { count: liveCount })));
  }
  if (head.childElementCount) node.append(head);
  const list = el('div', 'edge-dock-session-list');
  for (const session of sessions) {
    const row = el(session.groupRows ? 'summary' : 'div', 'edge-dock-session');
    const key = sessionKey(session);
    const activityState = stateByKey.get(key) || 'idle';
    row.classList.toggle('is-running', activityState === 'running');
    const name = session.title || session.projectLabel || String(session.sessionId || '').slice(0, 12) || '—';
    const nameNode = el('span', 'edge-dock-session-name');
    // The row's tool, as the same mark the rest of the widget draws for it. A
    // mixed list has to name each row's client somewhere and the meta line has
    // no room left for a label beside the model, the age and the gauge.
    if (options.showClientMark && session.client) {
      nameNode.append(markNode(session.client));
      // The mark is a mask-painted span with no text, so the tool it stands for is
      // invisible to assistive technology unless the name is said out loud. The
      // client's own label, not its id: this is read as prose.
      nameNode.append(el('span', 'sr-only', `${clientLabel(session.client)} `));
    }
    // The dot sits with the name rather than recolouring it: a green title
    // made the row read as a different kind of row, and the colour carried no
    // more information than the dot does.
    nameNode.append(stateMark(session, key, activityState));
    const title = el('span', 'edge-dock-session-title', name);
    title.dataset.overflowKey = key;
    overflowText.bind(title);
    nameNode.append(title);
    // The glyph is decorative and its `title` only reaches pointer users, so the
    // translated state is rendered as real text for assistive technology. It
    // cannot go on the row itself: a plain `div` has the generic role and
    // Chromium ignores an accessible name set on one.
    const stateLabel = activityState === 'waiting' ? t('session.waiting') : activityState === 'running' ? t('session.running')
      : activityState === 'ended' ? t('session.finished')
        : t('session.idle');
    nameNode.append(el('span', 'sr-only', ` ${stateLabel}`));
    // Membership belongs with model and age, leaving the title its full column.
    const meta = el('span', 'edge-dock-session-meta');
    const description = el('span', 'edge-dock-session-description');
    const memberLabel = session.groupRows && (!session.subagentGroup || session.subagentCount > 0)
      ? (session.subagentGroup ? t('sessions.subagentCount', { count: session.subagentCount })
        : t('sessions.grokBotCount', { count: session.groupRows.length })) : '';
    // The model label is composed by the Sessions list's own helper, so a
    // multi-model session reads "N models" here exactly as it does there —
    // projecting only the top model showed a different name than the list's
    // for the same session. The label is the tooltip trigger there too: one
    // row per model with its tokens and share.
    const modelLabel = sessionRowsApi.sessionModelLabel(session);
    const metadataLabel = sessionRowsApi.sessionModelMetadataLabel(session);
    const age = relativeAgo(session.lastUsedAt || session.startedAt);
    description.append(sessionRowsApi.sessionModelMetadataNode(document, { ...session, modelLabel }, {
      translate: t, view: limitWindowsView,
      unattributedLabel: t('dashboard.tooltip.unclassified'),
      formatTokens: formatBreakdownTokens
    }));
    if (memberLabel) {
      if (metadataLabel) description.append(document.createTextNode(' · '));
      description.append(el('span', 'edge-dock-session-member-count', memberLabel));
    }
    if (age) description.append(document.createTextNode(`${memberLabel || metadataLabel ? ' · ' : ''}${age}`));
    meta.append(description);
    const status = sessionRowsApi.sessionStatusNode(document, session, { prefix: 'edge-dock-session', translate: t,
      view: limitWindowsView, showUsed: appearance().sessionContextMetric !== 'remaining' });
    if (status) meta.append(status);
    row.append(
      nameNode,
      el('span', 'edge-dock-session-tokens', formatBreakdownTokens(session.totalTokens)),
      meta
    );
    if (session.groupRows) {
      const family = el('details', 'edge-dock-session-family');
      const expansionKey = sessionGroupExpansionKey(key);
      family.open = expandedSessionGroups.has(expansionKey);
      row.dataset.sessionGroupKey = key;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-expanded', String(family.open));
      family.addEventListener('toggle', () => {
        if (!family.isConnected || family.open === expandedSessionGroups.has(expansionKey)) return;
        row.setAttribute('aria-expanded', String(family.open));
        if (family.open) expandedSessionGroups.add(expansionKey);
        else expandedSessionGroups.delete(expansionKey);
        // Reuse the existing measured-size handshake so expansion fits the
        // native bubble window as well as this document.
        if (state.payload?.cell && surface === 'bubble') renderBubble(state.payload);
      });
      family.append(row, sessionsContainer(session.groupRows, { showClientMark: true, showCount: false, separator: false }));
      list.append(family);
    } else list.append(row);
  }
  node.append(list);
  return node;
}

function providerCard(cell, view = limitWindowsView) {
  const card = el('section', 'edge-dock-card');
  const color = limitProviderColor(cell.provider);
  const label = providerLabel(cell.provider);
  const records = [];
  for (const account of cell.accounts) {
    if (!account.record) continue;
    accountSummaries.set(account.record, account);
    records.push(account.record);
  }
  cardForecast = cell.forecast || null;

  // The card is the Limits page's provider row: one row for a single account,
  // the page's group header and account list for several. Everything the card
  // used to build by hand — the mark, the plan pill, the "Updated · OAuth" meta
  // line, the account count, the switch affordance, the meters, the spend and
  // balance lines, the reset forecast and its tooltip — is that row, and the
  // per-provider choices the page makes are the view's own policy now, so this
  // caller passes the provider and nothing else.
  const accounts = el('div', 'edge-dock-accounts');
  if (records.length > 1) {
    accounts.append(view.renderLimitProviderGroup(cell.provider, label, records, color));
  } else if (records.length === 1) {
    accounts.append(view.renderLimitProviderSolo(cell.provider, label, records[0], color));
  } else {
    accounts.append(el('div', 'edge-dock-note', t('edgeDock.unavailable')));
  }
  card.append(accounts);

  // The rows are the cell's activity reading as well as this card's list, so the
  // switch decides what is drawn here rather than whether the cell has them.
  const sessions = cell.showSessions === false ? null : sessionsNode(cell.sessions);
  if (sessions) card.append(sessions);

  if (cell.usage) card.append(providerUsageNode(cell.usage));
  return card;
}

function providerUsageNode(usage) {
  const node = el('div', 'edge-dock-usage');
  node.append(usageTile(t('edgeDock.period.today'), usage?.today), usageTile(t('edgeDock.period.month'), usage?.month));
  return node;
}

// Live rate: the selected measure as the headline, the other measure (and the
// device count, when several contribute) on one line beneath. Whether the
// figure is live sits as a small status in the header, where a card's state
// label (like a plan) already lives. Pressing the figure switches tok/s and
// TPM, the same toggle as the widget's own rate readout.
function appendLiveRate(card, head, cell) {
  const hasSample = cell.rate !== null && cell.rate !== undefined;
  const burnMode = cell.rateMode === 'burn';

  const status = el('span', 'edge-dock-rate-status');
  status.classList.toggle('is-live', hasSample && !cell.idle);
  status.append(el('span', 'edge-dock-rate-dot'), el('span', '', t(!hasSample ? 'edgeDock.rate.noSample' : cell.idle ? 'edgeDock.rate.idle' : 'edgeDock.rate.live')));
  head.append(status);

  const headline = el('div', 'edge-dock-stat-headline edge-dock-rate-headline');
  const figure = el('button', 'edge-dock-rate-figure');
  figure.type = 'button';
  figure.setAttribute('aria-description', t('edgeDock.rate.switch'));
  const unit = el('span', 'edge-dock-rate-unit', t(burnMode ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit'));
  figure.append(el('strong', '', hasSample ? formatRate(cell.rate) : '—'), unit, el('span', 'edge-dock-rate-swap', '⇄'));
  // Press-activated, not click: the card is rebuilt whenever the rate moves, and
  // a rebuild between press and release silently swallows the click.
  activateOnPress(figure, () => {
    unit.textContent = t(burnMode ? 'edgeDock.rate.speedUnit' : 'edgeDock.rate.burnUnit');
    bridge.toggleRateMode();
  });
  headline.append(figure);
  const other = burnMode ? cell.speed : cell.burn;
  const secondary = [];
  if (hasSample && other !== null && other !== undefined) {
    secondary.push(`≈ ${formatRate(other)} ${t(burnMode ? 'edgeDock.rate.speedUnit' : 'edgeDock.rate.burnUnit')}`);
  }
  if (cell.deviceCount > 1) secondary.push(t('edgeDock.rate.devices', { count: cell.deviceCount }));
  if (secondary.length) headline.append(el('span', '', secondary.join(' · ')));
  card.append(headline);
  appendLiveRateDetails(card, cell);
}

function appendLiveRateDetails(card, cell) {
  const entries = window.TokenMonitorTokenRate.liveTokenRateTooltipEntries(
    { devices: cell.rateDevices, deviceCount: cell.deviceCount }, cell.rateMode, formatRate
  );
  if (!entries.length) return;
  const list = el('div', 'edge-dock-accounts edge-dock-clients edge-dock-rate-details');
  for (const entry of entries) {
    if (!Array.isArray(entry)) {
      const heading = el('div', 'edge-dock-rate-device', entry.full);
      heading.classList.toggle('is-separated', entry.separated === true);
      list.append(heading);
      continue;
    }
    const row = el('div', 'edge-dock-rate-model');
    const mark = markNode(modelVendorFor(entry[0]) || 'token-monitor');
    mark.setAttribute('aria-hidden', 'true');
    row.append(mark, el('span', 'edge-dock-rate-model-name', entry[0]), el('span', 'edge-dock-rate-model-value', entry[1]));
    list.append(row);
  }
  card.append(list);
}

function statCard(cell) {
  const card = el('section', 'edge-dock-card');
  const head = el('header', 'edge-dock-card-head');
  head.append(el('span', 'edge-dock-stat-caption', statLabel(cell.metric)));
  card.append(head);
  if (cell.metric === 'liveRate') {
    head.classList.add('is-inline');
    appendLiveRate(card, head, cell);
    return card;
  }
  if (cell.metric === presentation.SESSIONS_METRIC) return sessionsCard(cell, card, head);
  if (cell.metric === 'cacheHit') {
    if (!cell.available) {
      card.append(el('div', 'edge-dock-note', t('edgeDock.periodUnavailable')));
      return card;
    }
    const running = Math.max(0, Number(cell.runningCount) || 0);
    if (running > 0) {
      head.classList.add('is-inline');
      head.append(el('span', 'edge-dock-card-status', t('edgeDock.runningCount', { count: running })));
    }
    const headline = el('div', 'edge-dock-stat-headline');
    headline.append(el('strong', '', formatCacheHitRate(cell.rate)));
    card.append(headline);
    card.append(el('div', 'edge-dock-note', cacheHitDetail(cell)));
    if ((cell.sessions || []).length) {
      const list = el('div', 'edge-dock-session-list');
      for (const s of cell.sessions) {
        const row = el('div', 'edge-dock-session');
        row.classList.toggle('is-running', presentation.sessionActivityState(s) === 'running');
        const nameNode = el('span', 'edge-dock-session-name');
        if (s.client) {
          nameNode.append(markNode(s.client));
          nameNode.append(el('span', 'sr-only', `${clientLabel(s.client)} `));
        }
        nameNode.append(el('span', 'edge-dock-session-title', s.title));
        const meta = el('span', 'edge-dock-session-meta');
        meta.append(el('span', 'edge-dock-session-description', cacheHitDetail(s)));
        row.append(nameNode, el('span', 'edge-dock-session-tokens', formatCacheHitRate(s.rate)), meta);
        list.append(row);
      }
      card.append(list);
    }
    return card;
  }
  if (!cell.available) {
    card.append(el('div', 'edge-dock-note', t('edgeDock.periodUnavailable')));
    return card;
  }
  // Keep the exact total, with the optional compact reading beside it as in the widget.
  const total = el('div', 'edge-dock-stat-headline');
  const totalRow = el('div', 'edge-dock-total-row');
  totalRow.append(el('strong', '', formatCardTokens(cell.totalTokens)));
  const compact = compactCardTotal(cell.totalTokens);
  if (compact) {
    const compactNode = el('span', 'edge-dock-total-compact', compact);
    compactNode.setAttribute('aria-hidden', 'true');
    totalRow.append(compactNode);
  }
  total.append(totalRow, usageCostNode('', cell));
  card.append(total);
  if (!cell.clients.length && !(cell.models || []).length) {
    card.append(el('div', 'edge-dock-note', t('edgeDock.noUsagePeriod')));
    return card;
  }
  const breakdownMode = state.breakdownMode === 'models' ? 'models' : 'tools';
  card.dataset.breakdownMode = breakdownMode;
  head.classList.add('is-breakdown');
  const switcher = el('div', 'edge-dock-breakdown-switch');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', `${t('home.tools')} / ${t('home.models')}`);
  for (const mode of ['tools', 'models']) {
    const button = el('button', 'edge-dock-breakdown-option', t(`home.${mode}`));
    button.type = 'button';
    button.classList.toggle('is-active', breakdownMode === mode);
    button.setAttribute('aria-pressed', String(breakdownMode === mode));
    // Press-activated for the same reason as the live-rate figure: a repaint
    // between press and release replaces the button and would swallow the click.
    activateOnPress(button, () => {
      if (state.breakdownMode === mode) return;
      state.breakdownMode = mode;
      renderBubble(state.payload);
    });
    switcher.append(button);
  }
  head.append(switcher);

  // Both breakdowns keep the widget's list rhythm: mark, name, tokens and share,
  // followed by the same meter. The model view borrows the main renderer's vendor
  // and fallback colours so one model never changes identity between surfaces.
  const rows = breakdownMode === 'models'
    ? (cell.models || []).map((model) => ({
      // Match the main widget: an unknown model uses the Token Monitor mark.
      // Passing null to markNode would instead select its generic dot fallback.
      id: modelVendorFor(model.model) || 'token-monitor',
      name: model.model === UNATTRIBUTED_KEY ? t('dashboard.tooltip.unclassified') : model.model,
      tokens: model.tokens,
      color: readableColor(model.unattributed ? clientColors.default : modelColor(model.model))
    }))
    : cell.clients.map((client) => ({
      id: client.unattributed ? 'token-monitor' : client.client,
      name: client.client === UNATTRIBUTED_KEY ? t('dashboard.tooltip.unclassified') : clientLabel(client.client),
      tokens: client.tokens,
      color: readableColor(clientColors[client.client] || clientColors.default)
    }));
  const list = el('div', 'edge-dock-accounts edge-dock-clients');
  const top = rows[0]?.tokens || 1;
  const sum = cell.totalTokens || rows.reduce((value, row) => value + row.tokens, 0) || 1;
  for (const entry of rows) {
    const row = el('div', 'edge-dock-client');
    // The same bar as the quota meters above it, built by the same helper.
    const meter = el('div', 'limit-meter');
    meter.style.background = colorWithAlpha(entry.color, 0.16);
    const fill = el('div', 'limit-meter-fill');
    fill.style.background = entry.color;
    fill.style.opacity = '0.95';
    applyBarScale(fill, Math.max(0.02, entry.tokens / top));
    meter.append(fill);
    row.append(
      markNode(entry.id, entry.color),
      el('span', 'edge-dock-client-name', entry.name),
      el('span', 'edge-dock-client-tokens', formatBreakdownTokens(entry.tokens)),
      el('span', 'edge-dock-client-share', `${Math.round((entry.tokens / sum) * 100)}%`),
      meter
    );
    list.append(row);
  }
  card.append(list);
  return card;
}

// The standalone Sessions card: the widget's sessions across every tracked
// client, including the clients that have no limits provider and therefore no
// other card to appear on. Rows are the same rows a provider card draws, so the
// two surfaces cannot disagree about what running means (see sessionsContainer).
function sessionsCard(cell, card, head) {
  const pushed = Array.isArray(cell.sessions) ? cell.sessions : [];
  const running = runningSessionSummary(pushed).rows;
  // A running-only card re-applies its own filter at paint time. The main process
  // filters when it projects, but the renderer repaints from the payload it already
  // holds when a running window expires, and this card is repainted before the
  // re-projection arrives - so a row that has just gone idle would stay in a card that
  // says it only shows running sessions. The same summary the count and the marks come
  // from decides membership, so the list cannot disagree with the header above it.
  // An empty result is a real reading, and the note below already says so.
  const sessions = cell.runningOnly === true ? running : pushed;
  // The flare cache is pruned against the whole list, not per group: a grouped card
  // renders one section per tool, and pruning inside each of those would delete the
  // entries belonging to every other section. Pruning here is what stops a long-lived
  // card from keeping one entry per session that ever scrolled through it.
  // Pruned against everything the card was handed, not the filtered list: a row that
  // is merely quiet keeps its flare entry, so a session that starts running again flares
  // on its next write rather than being treated as newly seen.
  pruneActivity(pushed);
  pruneSessionGroupExpansion(pushed);
  // The count lives in exactly one place per layout. Grouped, each section states
  // its own, and a card total above them printed the very same number whenever one
  // tool happened to be the only one running. Ungrouped there are no section heads,
  // so the card states it. Running rows keep their spinners either way.
  if (running.length > 0 && cell.groupBy !== 'client') {
    head.classList.add('is-inline');
    head.append(el('span', 'edge-dock-card-status', t('edgeDock.runningCount', { count: running.length })));
  }
  if (!sessions.length) {
    card.append(el('div', 'edge-dock-note', t(cell.runningOnly ? 'edgeDock.sessionsNoneRunning' : 'edgeDock.sessionsNone')));
    return card;
  }
  if (cell.groupBy !== 'client') {
    card.append(sessionsContainer(sessions, { showClientMark: true, showCount: false }));
    return card;
  }
  // Grouped: one section per tool, in the order the tools first appear in the
  // list (which is newest-activity order), so the header names the tool once
  // instead of the mark repeating down every row.
  const groups = new Map();
  for (const session of sessions) {
    const client = String(session.client || '');
    if (!groups.has(client)) groups.set(client, []);
    groups.get(client).push(session);
  }
  const grouped = el('div', 'edge-dock-accounts edge-dock-session-groups');
  for (const [client, rows] of groups) {
    const section = el('div', 'edge-dock-session-group');
    // Its own header class rather than the shared section head: that one is a
    // two-item caption row aligned on the baseline, and a mask-drawn mark has no
    // baseline, so it floated above its label. This row centers its three parts.
    const groupHead = el('div', 'edge-dock-session-group-head');
    groupHead.append(markNode(client), el('span', 'edge-dock-section-title', clientLabel(client)));
    const liveCount = runningSessionSummary(rows).count;
    if (liveCount > 0) groupHead.append(el('span', 'edge-dock-section-count', t('edgeDock.runningCount', { count: liveCount })));
    section.append(groupHead, sessionsContainer(rows, { showCount: false, separator: false }));
    grouped.append(section);
  }
  card.append(grouped);
  return card;
}

// Cards are built in a hidden staging layer and measured there. The visible
// card is only replaced once the main process reports that the window has been
// sized and shaped for exactly that card, so a new card never paints into a
// window still at the previous card's size (which read as a flash).
//
// Both scroll containers, because which one scrolls depends on the card. Provider,
// grouped Sessions, and period-breakdown cards scroll `.edge-dock-accounts`; the
// ungrouped Sessions card's list is `.edge-dock-session-list`. A repaint rebuilds the
// card, so a selector that missed the container actually in use reset that card's
// scroll on every clock tick - yanking the reader back to the top while they read it.
const CARD_SCROLL_SELECTOR = '.edge-dock-accounts, .edge-dock-session-list';

let observedPluginCard = null;
const stagingLayer = document.createElement('div');
stagingLayer.className = 'edge-dock-staging';
if (surface === 'bubble') root.append(stagingLayer);

function commitCard(card, cellId) {
  const previous = contentLayer.querySelector('.edge-dock-card');
  const sameCard = previous?.dataset.cellId === cellId
    && previous?.dataset.breakdownMode === card.dataset.breakdownMode;
  const scrollLists = (node) => [...node.querySelectorAll(CARD_SCROLL_SELECTOR)]
    .filter(list => !list.closest('.edge-dock-session-family'));
  const scrollTops = sameCard ? scrollLists(previous).map(list => list.scrollTop) : [];
  const focusedGroup = sameCard ? document.activeElement?.dataset?.sessionGroupKey : null;
  const resetSnapshot = cardResetAnimator.capture(contentLayer);
  contentLayer.replaceChildren(card);
  overflowText.refresh();
  if (focusedGroup) {
    const summary = [...card.querySelectorAll('summary[data-session-group-key]')]
      .find(node => node.dataset.sessionGroupKey === focusedGroup);
    summary?.focus({ preventScroll: true });
  }
  scrollLists(card).forEach((list, index) => { list.scrollTop = scrollTops[index] || 0; });
  // Measure reading targets only after mounting and restoring their scroll position.
  if (sameCard) overflowText.preserveReading(previous, card);
  cardResetAnimator.animate(card, resetSnapshot);
}

// The period card is a summary even when the period contains dozens of tools or
// models. Keep its natural height at six rows, but leave every row in the list so
// the existing overflow container can reveal the rest. Measuring the rendered
// rows avoids baking the current font metrics and meter spacing into a second
// magic pixel height.
function clampBreakdownList(card) {
  const list = card.querySelector('.edge-dock-clients');
  const rows = Array.from(list?.children || []);
  if (rows.length <= BREAKDOWN_VISIBLE_ROWS) return;
  const first = rows[0].getBoundingClientRect();
  const last = rows[BREAKDOWN_VISIBLE_ROWS - 1].getBoundingClientRect();
  const height = Math.ceil(last.bottom - first.top);
  if (height > 0) list.style.maxHeight = `${height}px`;
}

// Provider details and sessions have separate existing scroll containers. A
// long session list must not squeeze even a short account/forecast block into
// an unreadable strip. Measure its natural height before flex shrink, reserving
// at most half the card so multiple accounts still leave room for sessions.
function reserveAccountHeight(card, maxHeight) {
  const native = card.querySelector(':scope > .plugin-native-content') || card;
  const accounts = native.querySelector(':scope > .edge-dock-accounts');
  if (!accounts || !native.querySelector(':scope > .edge-dock-sessions') || !(maxHeight > 0)) return;
  const shrink = accounts.style.flexShrink;
  accounts.style.flexShrink = '0';
  const naturalHeight = Math.ceil(accounts.getBoundingClientRect().height);
  accounts.style.flexShrink = shrink;
  if (naturalHeight > 0) accounts.style.minHeight = `${Math.min(naturalHeight, maxHeight / 2)}px`;
}

function fitCardTotal(card, scale = 1) {
  const row = card.querySelector('.edge-dock-total-row');
  if (!row) return;
  const number = row.querySelector('strong');
  const compact = row.querySelector('.edge-dock-total-compact');
  const gap = compact ? parseFloat(getComputedStyle(row).columnGap) || 0 : 0;
  const available = row.clientWidth - (compact ? compact.getBoundingClientRect().width / scale : 0) - gap;
  const natural = number.getBoundingClientRect().width / scale;
  if (!(available > 0 && natural > available)) return;
  const base = parseFloat(getComputedStyle(number).fontSize);
  if (base > 0) number.style.fontSize = `${Math.max(12, Math.floor(base * (available - 1) / natural))}px`;
}

function renderBubble(payload) {
  root.dataset.side = payload.side;
  root.style.setProperty('--edge-dock-card-width', `${payload.cardWidth || 280}px`);
  const cell = payload.cell;
  if (!cell) {
    if (observedPluginCard) bubbleSizeObserver?.unobserve(observedPluginCard);
    observedPluginCard = null;
    for (const body of root.querySelectorAll('.edge-dock-plugin-card')) pluginHost?.unmount(body);
    pluginContent?.retain([]);
    contentLayer.replaceChildren();
    stagingLayer.replaceChildren();
    return;
  }
  const retained = cell.kind === 'plugin' && contentLayer.querySelector('.edge-dock-card-plugin');
  if (retained && retained.dataset.pluginRef === cell.ref && retained.dataset.cellId === cell.id) {
    const view = pluginHost?.state('edgeDock', cell.ref);
    const caption = retained.querySelector('.edge-dock-stat-caption'); if (caption) caption.textContent = view?.title || cell.ref;
    retained.style.maxHeight = payload.maxCardHeight ? `${payload.maxCardHeight}px` : '';
    const height = Math.min(Math.ceil(retained.getBoundingClientRect().height), payload.maxCardHeight || Infinity);
    if (payload.placed?.cellId !== cell.id || payload.placed.height !== height) bridge.reportBubbleSize(cell.id, height);
    return;
  }
  const card = cell.kind === 'stat' ? statCard(cell) : cell.kind === 'plugin' ? pluginCard(cell) : providerCard(cell);
  card.dataset.cellId = cell.id;
  pluginContent?.retain(cell.kind === 'plugin' ? [] : [`edgeDock.${cell.kind}.content`]);
  if (cell.kind !== 'plugin' && pluginContent?.hasTarget(`edgeDock.${cell.kind}.content`)) {
    const native = document.createElement('div'); native.className = 'plugin-native-content';
    native.append(...card.childNodes); card.append(native);
    const target = `edgeDock.${cell.kind}.content`;
    pluginContent.retain([target]);
    pluginContent.render(target, native, { surface: 'edgeDock', cell, nativeData: payload });
  }
  if (payload.maxCardHeight) card.style.maxHeight = `${payload.maxCardHeight}px`;
  if (observedPluginCard) bubbleSizeObserver?.unobserve(observedPluginCard);
  observedPluginCard = cell.kind === 'plugin' ? card : null;
  stagingLayer.replaceChildren(card);
  fitCardTotal(card);
  clampBreakdownList(card);
  if (observedPluginCard) bubbleSizeObserver?.observe(observedPluginCard);
  if (cell.kind === 'provider') reserveAccountHeight(card, payload.maxCardHeight);
  const height = Math.min(Math.ceil(card.getBoundingClientRect().height), payload.maxCardHeight || Infinity);
  if (payload.placed?.cellId === cell.id && payload.placed.height === height) {
    commitCard(card, cell.id);
  } else {
    bridge.reportBubbleSize(cell.id, height);
  }
}


const bubbleSizeObserver = surface === 'bubble' && window.ResizeObserver ? new ResizeObserver(() => {
  const card = observedPluginCard?.isConnected ? observedPluginCard : contentLayer.querySelector('.edge-dock-card') || stagingLayer.querySelector('.edge-dock-card');
  const payload = state.payload;
  if (card && payload?.cell?.id === card.dataset.cellId) {
    const height = Math.min(Math.ceil(card.getBoundingClientRect().height), payload.maxCardHeight || Infinity);
    if (height > 0 && payload.placed?.height !== height) bridge.reportBubbleSize(card.dataset.cellId, height);
  }
}) : null;
bubbleSizeObserver?.observe(root);
window.addEventListener('pagehide', () => bubbleSizeObserver?.disconnect(), { once: true });

const notchRenderer = surface === 'notch'
  ? window.TokenMonitorNotchRenderer.createNotchRenderer({
    document, window, bridge, state, root, shapeLayer, contentLayer,
    shared: {
      el, t, appearance, prefersReducedMotion, readableColor, providerLabel, limitProviderColor,
      markNode, hasMask, providerCellNode, formatTokens, formatCardTokens, formatBreakdownTokens, formatCost, usageCostNode, formatRate, overflowText, limitWindowsView,
      limitAccountTitle: (...args) => limitWindowsView.limitAccountTitle(...args),
      captureRingResetMotion, animateRingResets, updateShape, ensureRefreshButton, paintRefreshButton, resetRefreshVisit, pluginHost, pluginContent
    }
  }) : null;

// ---- Wiring ---------------------------------------------------------------

function render(payload) {
  if (!payload || payload.surface !== surface) return;
  state.payload = payload;
  applyAppearance(payload);
  notchRenderer?.applyAppearance(payload);
  if (surface === 'notch') notchRenderer.applyMotion(payload.motion);
  else updateShape(payload);
  if (surface === 'peek') renderPeek(payload);
  else if (surface === 'rail') renderRail(payload);
  else if (surface === 'notch' && !deferBubbleRender()) notchRenderer.render(payload);
  else if (!deferBubbleRender()) renderBubble(payload);
  // A push carries fresh expiry times, so the self-repaint is re-armed from what
  // was just painted rather than left on the schedule the previous payload set.
  scheduleSelfRepaint();
}

// A repaint replaces the whole card, so it waits for whatever the pointer is
// currently inside: an account control mid-gesture, or an open detail tooltip.
function deferBubbleRender() {
  if (codexAccountControl.deferRender(contentLayer)) return true;
  if (!limitTooltipShouldHoldRender()) return false;
  limitTooltip.pending = true;
  return true;
}

bridge.onRender(render);
bridge.onShapeFrame?.(({ shape, side }) => {
  if (surface !== 'rail' || !state.payload) return;
  state.payload = { ...state.payload, shape, side };
  root.dataset.side = side;
  updateShape(state.payload);
});
// A repaint that no push triggers, because two readings here move on a clock
// rather than on data: a session stops being running when its window expires
// (sessionLive.RUNNING_WINDOW_MS) even with no new stats at all, and reset
// countdowns tick down on their own. Without this the rail kept the count and the
// tool marks it was pushed with, and a card opened later would disagree with the
// cell that opened it. Every surface re-derives from the payload it already holds,
// so this costs no IPC and asks the main process for nothing.
// A cell whose reading moves with the sessions clock. Asked by "does it carry
// rows" rather than by metric: the sessions item is not the only cell that reads
// them any more - a provider cell spins its inner arc while that tool is working,
// and that has to stop on the same clock the count does.
function cellReadsSessions(cell) {
  return Array.isArray(cell?.sessions) && cell.sessions.length > 0;
}

function surfacesShowingSessions() {
  if (surface === 'notch') return notchRenderer.sessionCells().some(cellReadsSessions);
  if (surface === 'rail') return (state.payload?.cells || []).some(cellReadsSessions);
  if (surface === 'bubble') return cellReadsSessions(state.payload?.cell);
  return false;
}

// How long until the reading this surface holds could change by itself. A sessions
// cell carries the moment its newest running row expires; anything else falls back
// to the minute that reset countdowns need. Both ends are clamped so a payload
// whose expiry has just passed does not spin the timer.
// The one floor every wait respects, so a payload whose expiry has just passed cannot
// produce a zero-length timer.
const SELF_REPAINT_FLOOR_MS = 1_000;

// The card has always repainted on a period, because its reset countdowns move on the
// clock alone; thirty seconds is that period, unchanged by this feature.
const BUBBLE_REPAINT_MS = 30_000;

// How long until the soonest sessions reading on this surface changes by itself. 0
// when there is nothing to wake for, which is a real answer rather than a fallback: a
// quiet cell never becomes running on its own, so a caller reading 0 must not arm a
// timer at all. The floor keeps a payload whose expiry has just passed from spinning.
function sessionsExpiryDelayMs() {
  if (!surfacesShowingSessions()) return 0;
  const cells = surface === 'notch' ? notchRenderer.sessionCells()
    : surface === 'rail' ? state.payload?.cells || [] : [state.payload?.cell].filter(Boolean);
  let soonest = 0;
  const now = Date.now();
  for (const cell of cells) {
    if (!cellReadsSessions(cell)) continue;
    // Asked of the rows rather than read off the cell. `runningExpiresAt` describes the
    // payload as it was projected, and a repaint does not re-project: once the soonest
    // expiry passes, that field is in the past for good, so a later row's expiry would
    // never wake anything and the cell would keep drawing it as running. The rows are
    // what a repaint re-derives from, so they are what the next wait is computed from -
    // recomputed each time, which is also what makes a second and third expiry wake the
    // surface in turn. Only an expiry still ahead can shorten a wait; a stale one would
    // otherwise pin the delay to the floor and re-arm on every pass.
    const runningExpiry = presentation.nextRunningExpiryAt(cell.sessions, now);
    const cacheExpiry = sessionLive.nextSessionStatusChangeAt(presentation.sessionMembers(cell.sessions), now);
    const expiresAt = [runningExpiry, cacheExpiry].filter((at) => at > now).sort((a, b) => a - b)[0] || 0;
    if (expiresAt > now && (!soonest || expiresAt < soonest)) soonest = expiresAt;
  }
  if (!soonest) return 0;
  return Math.max(SELF_REPAINT_FLOOR_MS, soonest - Date.now() + 50);
}

// Per surface, because the two surfaces have different reasons to wake. The card keeps
// its own period and lets an expiry shorten it; a rail that is not showing sessions
// gets no timer at all, since it was push-driven before this feature and polling it
// would rebuild its children for nothing. Both are re-armed after every repaint, so a
// shortened wait does not lower the period that follows it.
function selfRepaintDelayMs() {
  const expiry = sessionsExpiryDelayMs();
  const period = surface === 'bubble' || surface === 'notch' && notchRenderer.needsClock() ? BUBBLE_REPAINT_MS : 0;
  const waits = [period, expiry].filter((value) => value > 0);
  return waits.length ? Math.min(...waits) : 0;
}

function repaintSelf() {
  // The card defers while a gesture or an open tooltip is inside it, and asks
  // again once that clears (limitTooltip.pending); the rail has nothing to defer.
  if (surface === 'bubble') {
    if (state.payload?.cell && !deferBubbleRender()) renderBubble(state.payload);
    return;
  }
  if (surface === 'rail' && state.payload) renderRail(state.payload);
  if (surface === 'notch' && state.payload && !deferBubbleRender()) {
    notchRenderer.repaint();
  }
}

// Re-armed after every repaint rather than fixed at one interval, so a surface
// wakes exactly when its reading can change instead of polling on a fixed period
// and still being late. A stats push re-enters render() with a fresh payload and
// reschedules from it.
let selfRepaintTimer = null;
function scheduleSelfRepaint() {
  if (selfRepaintTimer) clearTimeout(selfRepaintTimer);
  selfRepaintTimer = null;
  if (bridge.isSettingsPreview) return;
  const delay = selfRepaintDelayMs();
  // 0 means this surface has nothing to wake for: a rail with no sessions expiry, or
  // the peek handle. Leaving the timer unarmed is what keeps the rail push-driven.
  if (!delay) return;
  selfRepaintTimer = setTimeout(() => {
    selfRepaintTimer = null;
    repaintSelf();
    scheduleSelfRepaint();
  }, delay);
}
scheduleSelfRepaint();
bridge.ready();
