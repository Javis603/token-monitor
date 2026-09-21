'use strict';

// Renderer for the three edge dock surfaces. All placement and hover decisions
// live in the main process (edgeDock.js); this page only paints what it is
// pushed and reports clicks, drags and its own content height.

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
const balanceDisplay = window.TokenMonitorLimitBalanceDisplay;
const accountIdentityApi = window.TokenMonitorAccountIdentity;
const glassRenderingApi = window.TokenMonitorGlassRendering;
const limitPresentationApi = window.TokenMonitorLimitProviderPresentation;
const limitWindowLabels = window.TokenMonitorLimitWindowLabels;
const limitWindowTextApi = window.TokenMonitorLimitWindowText;
const limitResetMotionApi = window.TokenMonitorLimitResetMotion;
const limitWindowsViewApi = window.TokenMonitorLimitWindowsView;
const subscriptionDisplayApi = window.TokenMonitorSubscriptionDisplay;
const subscriptionTextApi = window.TokenMonitorSubscriptionText;
const { limitFillPercent, limitModeSuffix } = window.TokenMonitorLimitDisplayMode;
const codexAccountControlApi = window.TokenMonitorCodexAccountControl;
const { clientColors } = window.TokenMonitorUsageCharts;
const { LIMIT_PROVIDER_LABELS } = window.TokenMonitorLimitProviders;
const { CLIENT_LABELS } = window.TokenMonitorClientCatalog;
// The same predicate the Sessions list uses. The card repaints from its last
// payload on a timer, so whether a session is still running has to be answered
// at paint time rather than frozen at push time.
const sessionLive = window.TokenMonitorSessionLive;
const SESSION_STATE_GLYPHS = sessionLive.sessionStateMarkup({
  spin: 'edge-dock-session-spin',
  check: 'edge-dock-session-check',
  idle: 'edge-dock-session-idle'
});

const BRAND_VENDOR_COLORS = { ...clientColors };
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 19;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const DRAG_THRESHOLD_PX = 4;
// The period of `edge-dock-mark-breathe` in dock.css, which the running halo's phase
// is taken modulo (see ringNode). A test holds the two numbers together.
const BREATH_MS = 2600;

const root = document.getElementById('edgeDockRoot');
const query = new URLSearchParams(window.location.search);
const surface = query.get('surface') || 'rail';
const reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const state = {
  payload: null,
  locale: 'en',
  appearanceKey: ''
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

const codexAccountControl = codexAccountControlApi.createCodexAccountControl({
  document,
  requestAnimationFrame,
  translate: t,
  switchAccount: (accountId) => bridge.switchCodexAccount(accountId),
  requestRender: () => {
    if (surface === 'bubble' && state.payload?.cell) renderBubble(state.payload);
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
  const key = JSON.stringify([appearance, payload?.platform, payload?.glass]);
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
  docEl.classList.toggle('is-windows', payload?.platform === 'win32');
  docEl.classList.toggle('is-mac-legacy', isMacLegacy(payload));
  docEl.classList.toggle(
    'edge-dock-reduced-motion',
    motionPreferenceApi.shouldReduceMotion(appearance.reduceMotion, reducedMotionMedia?.matches)
  );

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
  if (id === 'mimo') return clientColors.xiaomi;
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

// Whether styles.css defines a mask for `.row-icon-<id>`. Probed rather than
// listed so the dock can never drift from the icon table it borrows.
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

function formatTokens(value) {
  const units = compactTokenApi.effectiveCompactTokenUnits(appearance().compactTokenUnits, state.locale);
  return compactTokenApi.formatCompactTokens(value, units, state.locale, { style: 'tray' });
}

function formatCost(value) {
  return currencyApi.formatCurrencyFromUsd(value, appearance().currency || 'USD');
}

// Low and critical colours are opt-in (edgeDockWarnColors): by default every
// figure reads in the normal text colour. Unknown values stay muted either way,
// since `--` is an absence of data rather than a warning.
function displaySeverity(remainingPercent) {
  const severity = presentation.remainingSeverity(remainingPercent);
  if (severity === 'unknown' || appearance().edgeDockWarnColors === true) return severity;
  return 'ok';
}

function percentText(remainingPercent) {
  const shown = presentation.displayPercent(remainingPercent, appearance().showLimitUsed === true);
  return shown === null ? '--' : `${Math.round(shown)}%`;
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

const limitWindowsView = limitWindowsViewApi.createLimitWindowsView({
  document,
  t,
  settings: appearance,
  currentLocale: () => state.locale,
  presentation: limitPresentationApi,
  // Which device a row's reading came from — "· imac-m1" beside the provider's
  // own source label. The card has no settings and no device list, so both
  // facts ride the cell it is rendering, the same way its account set does.
  provenanceContext: () => state.payload?.cell?.provenanceContext || {},
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
        if (state.payload?.cell) renderBubble(state.payload);
      });
    }
  },
  formatCompact: formatTokens,
  formatMoney: balanceDisplay.formatMoney,
  formatCompactMoney: balanceDisplay.formatCompactMoney,
  formatPercent: (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--'),
  formatDuration: presentation.formatResetDuration,
  formatLimitBoundary: limitPresentationApi.limitBoundaryText,
  limitFillPercent,
  limitModeSuffix,
  optionalFiniteNumber,
  colorWithAlpha,
  applyBarScale,
  creditsAmount: balanceDisplay.creditsAmount,
  creditsMeterPercent: balanceDisplay.creditsMeterPercent,
  isCreditsWindow: balanceDisplay.isCreditsWindow,
  spendWindow: balanceDisplay.spendWindow,
  limitWindowLabel: limitWindowLabels.limitWindowLabel,
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
  subscriptionAccounts: () => state.payload?.cell?.subscriptionAccounts || [],
  // What this month's tokens would have cost, which the subscription card
  // compares the plan's price against. It rides the cell because it changes with
  // every stats push, while the appearance is only re-pushed on a settings edit.
  monthClientCosts: () => state.payload?.cell?.monthClientCosts,
  resetForecast: () => ({ busy: false, forecast: cardForecast })
});

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

function renderPeek(payload) {
  root.dataset.side = payload.side;
  root.title = t('settings.display.edgeDock');
  if (!contentLayer.firstChild) contentLayer.append(el('span', 'edge-dock-grip'));
  // The handle's exit is a move, not a blink, so the withdrawn pose is held as a
  // class and one transition carries it both ways (see the grip's rules). The class
  // goes on in the same frame the grip is built, which is what keeps a page that
  // loads with the rail already open from animating into a pose it starts in.
  root.classList.toggle('is-handle-hidden', payload.peeking !== true);
}

if (surface === 'peek') root.addEventListener('click', () => bridge.click(null));

// ---- Rail ----------------------------------------------------------------

function ringNode(remainingPercent, color, mark) {
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
  // The halo the running state breathes (see dock.css). It is always emitted and
  // transparent until the cell is marked running, so what decides whether it shows is
  // the cell's state alone. What it cannot carry is its own phase: renderRail rebuilds
  // every cell from the payload on every push, so a fresh node restarts the breath at
  // 0% each time - and the pushes are closest together exactly while a session is
  // working, which is when this mark is worth anything. Anchoring the phase to the
  // clock instead puts it somewhere a rebuild cannot reach, and the swap between the
  // two nodes is invisible because they are at the same point of the same cycle.
  const glow = el('span', 'edge-dock-ring-glow');
  glow.style.animationDelay = `-${Date.now() % BREATH_MS}ms`;
  ring.append(svg, glow, mark);
  return ring;
}

function providerCellNode(cell) {
  const node = el('div', 'edge-dock-cell');
  node.dataset.status = cell.status;
  // Work in flight for this provider's tools, asked of the rows at paint time for
  // the same reason the sessions cell asks: running expires on a clock, so a count
  // frozen into the payload would keep the mark breathing after the work stopped.
  // The glow rides the mark rather than the ring's arc on purpose. A running
  // session is not proof that this quota is what is draining - the tokens may be
  // billed to an API key or another endpoint entirely, which is the same reason
  // local usage is not an adaptive-polling trigger - so it is a fact about the
  // tool, not about the arc. Keeping it off the arc also keeps the signal's
  // strength independent of how much quota is left (an arc-confined glow is
  // faintest at 5%, which is exactly when it matters most), leaves the focused
  // ring's own glow unambiguous, and stays readable on a stale cell, where the
  // dimmed arc means "this number is not to be trusted" while the tool really is
  // working. It is read from the cell's rows whatever the card draws of them: whether
  // a tool is working is not the card's list, so hiding that list is not an off switch
  // for this. An item that genuinely has no session rows never breathes.
  const running = runningSessionSummary(cell.sessions).count;
  if (running > 0) node.dataset.running = 'yes';
  const color = providerColor(cell.provider);
  const value = el('span', 'edge-dock-value');
  if (cell.credits && cell.credits.amount !== null && cell.credits.amount !== undefined) {
    value.textContent = balanceDisplay.formatCompactMoney(cell.credits.amount, cell.credits.currency);
  } else {
    value.textContent = percentText(cell.remainingPercent);
  }
  value.dataset.severity = displaySeverity(cell.remainingPercent);
  node.append(ringNode(cell.remainingPercent, color, markNode(cell.provider)), value);
  // The halo is decorative and carries no text, so the state it announces is
  // spoken here instead, from the same reading it is drawn from.
  const spoken = [providerLabel(cell.provider), value.textContent];
  if (running > 0) spoken.push(t('edgeDock.runningCount', { count: running }));
  node.setAttribute('aria-label', spoken.join(' '));
  return node;
}

function formatRate(rate) {
  const value = Math.max(0, Number(rate) || 0);
  if (value > 0 && value < 0.1) return '<0.1';
  if (value > 0 && value < 1) return value.toLocaleString(state.locale, { maximumFractionDigits: 1 });
  return formatTokens(value);
}

function statLabel(metric) {
  if (metric === 'liveRate') return t('edgeDock.stat.liveRate');
  if (metric === presentation.SESSIONS_METRIC) return t('edgeDock.sessions');
  return t(`edgeDock.period.${metric}`);
}

// Rail-width money: whole units past 100 and compact notation past 10k, so a
// figure like HK$569.82 does not overflow a 56px readout. The card keeps the
// full-precision figure.
function formatRailCost(value) {
  const code = appearance().currency || 'USD';
  const full = currencyApi.formatCurrencyFromUsd(value, code);
  const symbol = full.replace(/[\d.,\s-]+$/, '');
  const amount = Math.abs(currencyApi.convertUsd(value, code));
  if (amount >= 10_000) {
    return `${symbol}${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(amount)}`;
  }
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
    el('span', 'edge-dock-cell-rate-value', missing ? '—' : formatRate(cell.rate)),
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
    node.title = t('edgeDock.rate.switch');
    node.append(el('span', 'edge-dock-stat-value', cell.rate === null || cell.rate === undefined ? '—' : formatRate(cell.rate)));
  } else if (cell.metric === presentation.SESSIONS_METRIC) {
    // Nothing running is a real reading, not a missing one, so the zero is
    // shown - muted, exactly as the live-rate cell mutes its own idle state.
    // Asked of the rows at paint time, so a cell left on screen stops claiming a
    // running session the moment that session crosses the ten-minute window.
    const running = runningSessionSummary(cell.sessions).count;
    node.classList.toggle('is-idle', running === 0);
    node.append(el('span', 'edge-dock-stat-value', String(running)));
    // The third line is the item's own choice: the tools with work in flight, or
    // the live token rate. Rate mode keeps its line even with nothing running, so
    // the cell does not change height as work starts and stops.
    if (cell.cellDetail === 'rate') {
      node.append(cellRateNode(cell));
    } else {
      const marks = runningMarksNode(cell);
      if (marks) node.append(marks);
    }
  } else if (!cell.available) {
    node.classList.add('is-idle');
    node.append(el('span', 'edge-dock-stat-value', '—'));
  } else {
    node.append(
      el('span', 'edge-dock-stat-value', formatTokens(cell.totalTokens)),
      el('span', 'edge-dock-stat-cost', formatRailCost(cell.costUsd))
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
  const spoken = cell.metric === presentation.SESSIONS_METRIC
    // The count already reads as a number in `readout`; the tools are appended only
    // when there are any, so a quiet cell does not end with an empty clause.
    ? [statLabel(cell.metric), readout, workingTools.join(', ')].filter(Boolean).join(' ').trim()
    : `${statLabel(cell.metric)} ${readout}`.trim();
  node.setAttribute('aria-label', spoken);
  return node;
}

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
  if (railReveal !== null && reveal !== railReveal) playRailReveal();
  railReveal = reveal;
  if (!railNode) {
    railNode = el('div', 'edge-dock-rail');
    contentLayer.append(railNode);
    bindRailGestures(railNode);
  }
  const layout = payload.cellLayout || null;
  railNode.classList.toggle('is-compact', layout?.compact === true);
  const nodes = [];
  (payload.cells || []).forEach((cell, index) => {
    const node = cell.kind === 'stat' ? statCellNode(cell) : providerCellNode(cell);
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
  railNode.replaceChildren(...nodes);
}

let gesture = null;

function bindRailGestures(rail) {
  rail.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    gesture = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      grabOffsetY: event.clientY,
      cellIndex: indexFromTarget(event.target),
      dragging: false
    };
    rail.setPointerCapture(event.pointerId);
  });
  rail.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.dragging) return;
    if (Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < DRAG_THRESHOLD_PX) return;
    gesture.dragging = true;
    rail.classList.add('is-dragging');
    bridge.dragStart(gesture.grabOffsetY);
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
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);
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
    el('span', 'edge-dock-usage-tokens', usage ? formatTokens(usage.tokens) : '—')
  );
  if (usage) tile.append(el('span', 'edge-dock-usage-cost', formatCost(usage.costUsd)));
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
function contextNode(session) {
  const context = session?.context;
  if (!context) return null;
  const showUsed = appearance().sessionContextMetric !== 'remaining';
  const percent = showUsed ? context.percentUsed : context.percentLeft;
  const node = el('span', 'edge-dock-session-context');
  node.dataset.tone = String(context.tone || '');
  // The full phrase lives in the tooltip; the line itself stays a bar and a
  // number so it reads at a glance in the meta row.
  node.title = t(showUsed ? 'session.contextUsed' : 'session.contextLeft', { percent });
  const meter = el('span', 'edge-dock-session-context-meter');
  const fill = el('span', 'edge-dock-session-context-fill');
  fill.style.setProperty('--bar-scale', String(percent / 100));
  meter.append(fill);
  node.append(meter, el('span', 'edge-dock-session-context-value', `${percent}%`));
  return node;
}

// Last activity seen for each session, so the running dot can flare on an
// actual transcript write instead of pulsing forever. Module state on purpose:
// the comparison is against the previous payload.
const lastActivityBySession = new Map();

// Only the sessions this card currently lists keep their entry. A session that
// drops out of the list can never flare again, so holding it would leak one
// entry per session for the life of the process.
function pruneActivity(sessions) {
  const live = new Set(sessions.map(sessionKey));
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
  dot.setAttribute('aria-hidden', 'true');
  // The glyphs come from the shared builder, so this card and the Sessions list
  // cannot drift into different spinner or check shapes.
  dot.innerHTML = SESSION_STATE_GLYPHS;
  dot.dataset.state = state;
  if (state === 'running') dot.title = t('session.running');
  else if (state === 'ended') dot.title = t('session.finished');
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
  if (!Array.isArray(sessions) || !sessions.length) return null;
  pruneActivity(sessions);
  // A provider card's rows are all one client, so their marks would only repeat
  // the card's own header; the standalone Sessions card lists every client and
  // names each row's tool (see sessionsCard).
  const node = sessionsContainer(sessions, { title: t('edgeDock.sessions'), showClientMark: false });
  return node;
}

function sessionsContainer(sessions, options = {}) {
  // Re-derived rather than trusted from the pushed cell: the card repaints
  // every 30s from its last payload, and a session that stopped in between must
  // stop reading as running (and must stop being counted).
  // One derivation serves both the count and the marks, from the same shared
  // predicate the Sessions list uses.
  const stateByKey = new Map(sessions.map((session) => [sessionKey(session), sessionLive.sessionActivityState(session)]));
  const liveCount = [...stateByKey.values()].filter((state) => state === 'running').length;
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
    const row = el('div', 'edge-dock-session');
    const key = sessionKey(session);
    const state = stateByKey.get(key) || 'idle';
    row.classList.toggle('is-running', state === 'running');
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
    nameNode.append(stateMark(session, key, state));
    nameNode.append(document.createTextNode(name));
    // The glyph is decorative and its `title` only reaches pointer users, so the
    // translated state is rendered as real text for assistive technology. It
    // cannot go on the row itself: a plain `div` has the generic role and
    // Chromium ignores an accessible name set on one.
    const stateLabel = state === 'running' ? t('session.running')
      : state === 'ended' ? t('session.finished')
        : t('session.idle');
    nameNode.append(el('span', 'sr-only', ` ${stateLabel}`));
    // The meta line carries model, age, and (when the transcript stated one)
    // the context reading, so nothing the row showed before is displaced.
    const meta = el('span', 'edge-dock-session-meta');
    meta.append(document.createTextNode([session.model, relativeAgo(session.lastUsedAt)].filter(Boolean).join(' · ')));
    const context = contextNode(session);
    if (context) meta.append(context);
    row.append(
      nameNode,
      el('span', 'edge-dock-session-tokens', formatTokens(session.totalTokens)),
      meta
    );
    list.append(row);
  }
  node.append(list);
  return node;
}

function providerCard(cell) {
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
    accounts.append(limitWindowsView.renderLimitProviderGroup(cell.provider, label, records, color));
  } else if (records.length === 1) {
    accounts.append(limitWindowsView.renderLimitProviderSolo(cell.provider, label, records[0], color));
  } else {
    accounts.append(el('div', 'edge-dock-note', t('edgeDock.unavailable')));
  }
  card.append(accounts);

  // The rows are the cell's activity reading as well as this card's list, so the
  // switch decides what is drawn here rather than whether the cell has them.
  const sessions = cell.showSessions === false ? null : sessionsNode(cell.sessions);
  if (sessions) card.append(sessions);

  if (cell.usage) {
    const usage = el('div', 'edge-dock-usage');
    usage.append(
      usageTile(t('edgeDock.period.today'), cell.usage.today),
      usageTile(t('edgeDock.period.month'), cell.usage.month)
    );
    card.append(usage);
  }
  return card;
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
  figure.title = t('edgeDock.rate.switch');
  const unit = el('span', 'edge-dock-rate-unit', t(burnMode ? 'edgeDock.rate.burnUnit' : 'edgeDock.rate.speedUnit'));
  figure.append(el('strong', '', hasSample ? formatRate(cell.rate) : '—'), unit, el('span', 'edge-dock-rate-swap', '⇄'));
  // pointerdown, not click: the card is rebuilt whenever the rate moves, and a
  // rebuild between press and release silently swallows the click.
  figure.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
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
  if (!cell.available) {
    card.append(el('div', 'edge-dock-note', t('edgeDock.periodUnavailable')));
    return card;
  }
  // Same hierarchy as the widget's headline: the token total, its cost beneath.
  const total = el('div', 'edge-dock-stat-headline');
  total.append(el('strong', '', formatTokens(cell.totalTokens)), el('span', '', formatCost(cell.costUsd)));
  card.append(total);
  if (!cell.clients.length) {
    card.append(el('div', 'edge-dock-note', t('edgeDock.noUsagePeriod')));
    return card;
  }
  // Tools read like the widget's Tools list: tokens and share of the period,
  // in fixed columns, with a bar matching the limit meters above.
  const list = el('div', 'edge-dock-accounts edge-dock-clients');
  const top = cell.clients[0].tokens || 1;
  const sum = cell.totalTokens || cell.clients.reduce((value, client) => value + client.tokens, 0) || 1;
  for (const client of cell.clients) {
    const color = readableColor(clientColors[client.client] || clientColors.default);
    const row = el('div', 'edge-dock-client');
    // The same bar as the quota meters above it, built by the same helper.
    const meter = el('div', 'limit-meter');
    meter.style.background = colorWithAlpha(color, 0.16);
    const fill = el('div', 'limit-meter-fill');
    fill.style.background = color;
    fill.style.opacity = '0.95';
    applyBarScale(fill, Math.max(0.02, client.tokens / top));
    meter.append(fill);
    row.append(
      markNode(client.client, color),
      el('span', 'edge-dock-client-name', clientLabel(client.client)),
      el('span', 'edge-dock-client-tokens', formatTokens(client.tokens)),
      el('span', 'edge-dock-client-share', `${Math.round((client.tokens / sum) * 100)}%`),
      meter
    );
    list.append(row);
  }
  card.append(list);
  if (cell.clientCount > cell.clients.length) {
    card.append(el('div', 'edge-dock-note', t('edgeDock.moreClients', { count: cell.clientCount - cell.clients.length })));
  }
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
// Both scroll containers, because which one scrolls depends on the card. A provider
// card and the grouped Sessions card scroll `.edge-dock-accounts`; the ungrouped
// Sessions card's list is `.edge-dock-session-list`, and that is the one which overflows
// there, since running rows are never capped. A repaint rebuilds the card, so a
// selector that missed the container actually in use reset that card's scroll on every
// clock tick - yanking the reader back to the top while they were reading it.
const CARD_SCROLL_SELECTOR = '.edge-dock-accounts, .edge-dock-session-list';

const stagingLayer = document.createElement('div');
stagingLayer.className = 'edge-dock-staging';
if (surface === 'bubble') root.append(stagingLayer);

function commitCard(card, cellId) {
  const previous = contentLayer.querySelector('.edge-dock-card');
  const sameCard = previous?.dataset.cellId === cellId;
  const scrollTop = sameCard ? previous.querySelector(CARD_SCROLL_SELECTOR)?.scrollTop || 0 : 0;
  contentLayer.replaceChildren(card);
  const list = card.querySelector(CARD_SCROLL_SELECTOR);
  if (list) list.scrollTop = scrollTop;
}

function renderBubble(payload) {
  root.dataset.side = payload.side;
  const cell = payload.cell;
  if (!cell) {
    stagingLayer.replaceChildren();
    return;
  }
  const card = cell.kind === 'stat' ? statCard(cell) : providerCard(cell);
  card.dataset.cellId = cell.id;
  if (payload.maxCardHeight) card.style.maxHeight = `${payload.maxCardHeight}px`;
  stagingLayer.replaceChildren(card);
  const height = Math.ceil(card.getBoundingClientRect().height);
  if (payload.placed?.cellId === cell.id && payload.placed.height === height) {
    commitCard(card, cell.id);
  } else {
    bridge.reportBubbleSize(cell.id, height);
  }
}

// ---- Wiring ---------------------------------------------------------------

function render(payload) {
  if (!payload || payload.surface !== surface) return;
  state.payload = payload;
  applyAppearance(payload);
  updateShape(payload);
  if (surface === 'peek') renderPeek(payload);
  else if (surface === 'rail') renderRail(payload);
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
// A repaint that no push triggers, because two readings here move on a clock
// rather than on data: a session stops being running when its window expires
// (sessionLive.RUNNING_WINDOW_MS) even with no new stats at all, and reset
// countdowns tick down on their own. Without this the rail kept the count and the
// tool marks it was pushed with, and a card opened later would disagree with the
// cell that opened it. Every surface re-derives from the payload it already holds,
// so this costs no IPC and asks the main process for nothing.
// A cell whose reading moves with the sessions clock. Asked by "does it carry
// rows" rather than by metric: the sessions item is not the only cell that reads
// them any more - a provider cell breathes its mark while that tool is working,
// and that has to stop on the same clock the count does.
function cellReadsSessions(cell) {
  return Array.isArray(cell?.sessions) && cell.sessions.length > 0;
}

function surfacesShowingSessions() {
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
  const cells = surface === 'rail' ? state.payload?.cells || [] : [state.payload?.cell].filter(Boolean);
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
    const expiresAt = presentation.nextRunningExpiryAt(cell.sessions, now);
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
  const period = surface === 'bubble' ? BUBBLE_REPAINT_MS : 0;
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
}

// Re-armed after every repaint rather than fixed at one interval, so a surface
// wakes exactly when its reading can change instead of polling on a fixed period
// and still being late. A stats push re-enters render() with a fresh payload and
// reschedules from it.
let selfRepaintTimer = null;
function scheduleSelfRepaint() {
  if (selfRepaintTimer) clearTimeout(selfRepaintTimer);
  selfRepaintTimer = null;
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
