'use strict';

// Renderer for the three edge dock surfaces. All placement and hover decisions
// live in the main process (edgeDock.js); this page only paints what it is
// pushed and reports clicks, drags and its own content height.

const bridge = window.tokenMonitorEdgeDock;
const presentation = window.TokenMonitorEdgeDockPresentation;
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

function providerColor(id) {
  if (id === 'factory') return readableColor(clientColors.droid);
  if (id === 'mimo') return readableColor(clientColors.xiaomi);
  return readableColor(clientColors[id] || clientColors.default);
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

// Limit figures use the Limits view's fixed English wording ("43% left",
// "Reset 4h 26m", "Updated just now"): provider window labels such as
// "Monthly" or "Gemini 5-hour" arrive in English, and translating only the
// words around them produced a mixed card that read worse than either.
function windowValueText(window) {
  if (window.credits && window.credits.amount !== null && window.credits.amount !== undefined) {
    return balanceDisplay.formatCompactMoney(window.credits.amount, window.credits.currency);
  }
  const showUsed = appearance().showLimitUsed === true;
  const shown = presentation.displayPercent(window.remainingPercent, showUsed);
  if (shown === null) return '--';
  return `${Math.round(shown)}% ${showUsed ? 'used' : 'left'}`;
}

const WINDOW_KIND_LABELS = { session: 'Session', daily: 'Daily', weekly: 'Weekly', billing: 'Monthly' };

function windowLabel(window) {
  return window.label || WINDOW_KIND_LABELS[window.kind] || 'Limit';
}

function boundaryText(window) {
  const at = Date.parse(window.resetsAt || '');
  if (!Number.isFinite(at)) return window.resetDescription || '';
  const remaining = at - Date.now();
  const mixed = window.boundaryKind === 'mixed';
  const prefix = window.boundaryKind === 'expiry' ? 'Expires' : mixed ? 'Changes in' : 'Reset';
  if (remaining <= 0) return mixed ? 'Changes now' : `${prefix} now`;
  return `${prefix} ${presentation.formatResetDuration(remaining)}`;
}

function updatedText(value) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return '';
  const diffMs = Math.max(0, Date.now() - at);
  if (diffMs < 45_000) return 'Updated just now';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

function accountTitle(account) {
  const name = account.accountName || '';
  if (name) return name;
  const email = account.accountEmail || '';
  if (!email) return '';
  return appearance().maskLimitAccountEmails === true ? accountIdentityApi.maskEmailAddress(email) : email;
}

// The Limits view and dock both call the same renderer control. This wrapper
// only maps the dock card's projected account shape into that shared contract.
function accountControl(account, titleNode, options = {}) {
  const accountId = String(account.switchAccountId || '');
  return codexAccountControl.render({
    titleNode,
    active: options.showActive !== false && account.active === true,
    switchAccount: accountId ? { id: accountId } : null,
    accountLabel: accountTitle(account)
  });
}

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
  ring.append(svg, mark);
  return ring;
}

function providerCellNode(cell) {
  const node = el('div', 'edge-dock-cell');
  node.dataset.status = cell.status;
  const color = providerColor(cell.provider);
  const value = el('span', 'edge-dock-value');
  if (cell.credits && cell.credits.amount !== null && cell.credits.amount !== undefined) {
    value.textContent = balanceDisplay.formatCompactMoney(cell.credits.amount, cell.credits.currency);
  } else {
    value.textContent = percentText(cell.remainingPercent);
  }
  value.dataset.severity = displaySeverity(cell.remainingPercent);
  node.append(ringNode(cell.remainingPercent, color, markNode(cell.provider)), value);
  node.setAttribute('aria-label', `${providerLabel(cell.provider)} ${value.textContent}`);
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
  return t(`edgeDock.periodShort.${cell.metric}`);
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
  } else if (!cell.available) {
    node.classList.add('is-idle');
    node.append(el('span', 'edge-dock-stat-value', '—'));
  } else {
    node.append(
      el('span', 'edge-dock-stat-value', formatTokens(cell.totalTokens)),
      el('span', 'edge-dock-stat-cost', formatRailCost(cell.costUsd))
    );
  }
  const readout = [...node.children].slice(1).map((child) => child.textContent).join(' ');
  node.setAttribute('aria-label', `${statLabel(cell.metric)} ${readout}`);
  return node;
}

let railNode = null;

function renderRail(payload) {
  root.dataset.side = payload.side;
  root.classList.toggle('is-always', payload.always === true);
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

// Meters match the widget's Limits view: a 6px bar on a tint of the provider's
// own colour, the fill following the used/remaining display mode, and weekly
// or longer windows a shade lighter than the session window above them.
function meterNode(window, color) {
  const meter = el('div', 'edge-dock-meter');
  const rgb = parseColor(color);
  if (rgb) meter.style.background = `rgba(${rgb.join(', ')}, 0.16)`;
  const fill = el('div', 'edge-dock-meter-fill');
  fill.style.background = color;
  fill.style.opacity = window.kind === 'session' ? '0.95' : '0.78';
  const shown = presentation.displayPercent(window.remainingPercent, appearance().showLimitUsed === true);
  fill.style.transform = `scaleX(${Math.max(0, Math.min(100, shown ?? 0)) / 100})`;
  meter.append(fill);
  return meter;
}

function windowNode(window, color, labelOverride = '') {
  const node = el('div', 'edge-dock-window');
  const head = el('div', 'edge-dock-window-head');
  const value = el('span', 'edge-dock-window-value', windowValueText(window));
  value.dataset.severity = displaySeverity(window.remainingPercent);
  head.append(el('span', 'edge-dock-window-label', labelOverride || windowLabel(window)), value);
  node.append(head);
  if (window.remainingPercent !== null && window.remainingPercent !== undefined) node.append(meterNode(window, color));
  const boundary = boundaryText(window);
  if (boundary) node.append(el('span', 'edge-dock-window-reset', boundary));
  return node;
}

// Windows labelled "<group> 5-hour" / "<group> weekly" (Antigravity's model
// pools) are shown under one group heading, the same hierarchy as the Limits
// view. Anything that does not fully parse keeps the flat list.
function windowGroups(windows) {
  const parsed = windows.map((window) => ({
    window,
    label: limitPresentationApi?.antigravityQuotaWindow?.(window) || null
  }));
  if (parsed.length < 2 || parsed.some((entry) => !entry.label)) return null;
  const groups = new Map();
  for (const entry of parsed) {
    const key = entry.label.groupLabel;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups.size > 1 ? [...groups] : null;
}

// A metered short window (session/daily/weekly) sits in a half-width column
// beside its neighbour, as in the Limits view; balances, monthly pools and an
// unpaired window take the full width.
function pairable(window) {
  return ['session', 'daily', 'weekly'].includes(window.kind)
    && !window.credits
    && window.remainingPercent !== null && window.remainingPercent !== undefined;
}

function windowGrid(entries, color) {
  const grid = el('div', 'edge-dock-windows');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];
    const node = windowNode(entry.window, color, entry.label);
    if (next && pairable(entry.window) && pairable(next.window)) {
      grid.append(node, windowNode(next.window, color, next.label));
      index += 1;
    } else {
      node.classList.add('is-wide');
      grid.append(node);
    }
  }
  return grid;
}

function appendWindows(block, windows, color) {
  const groups = windowGroups(windows);
  if (!groups) {
    block.append(windowGrid(windows.map((window) => ({ window, label: '' })), color));
    return;
  }
  for (const [label, entries] of groups) {
    const group = el('div', 'edge-dock-window-group');
    group.append(
      el('div', 'edge-dock-window-group-title', label),
      windowGrid(entries.map((entry) => ({ window: entry.window, label: entry.label.windowLabel })), color)
    );
    block.append(group);
  }
}

function usageTile(label, usage) {
  const tile = el('div', 'edge-dock-usage-tile');
  tile.append(
    el('span', 'edge-dock-usage-label', label),
    el('span', 'edge-dock-usage-tokens', usage ? formatTokens(usage.tokens) : '—')
  );
  if (usage) tile.append(el('span', 'edge-dock-usage-cost', formatCost(usage.costUsd)));
  return tile;
}

// Banked Codex resets, as the Limits view lists them: how many, and how long
// until each expires.
function resetCreditsNode(credits) {
  if (!credits?.count) return null;
  const row = el('div', 'edge-dock-detail-row');
  row.append(el('span', '', `${credits.count} reset${credits.count === 1 ? '' : 's'}`));
  const now = Date.now();
  const times = credits.expirations.slice(0, 3).map((value) => {
    const remaining = Date.parse(value) - now;
    return remaining <= 0 ? 'now' : presentation.formatResetDuration(remaining);
  });
  if (credits.expirations.length > 3) times.push(`+${credits.expirations.length - 3}`);
  if (times.length) row.append(el('span', 'edge-dock-detail-value', times.join(' · ')));
  return row;
}

function forecastDate(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const dayDelta = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const time = new Intl.DateTimeFormat(state.locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (Math.abs(dayDelta) <= 1) {
    return `${new Intl.RelativeTimeFormat(state.locale, { numeric: 'auto' }).format(dayDelta, 'day')} ${time}`;
  }
  return new Intl.DateTimeFormat(state.locale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

// The Codex reset forecast, when the Limits view's opt-in is on: the same
// states and wording as there, condensed to one row and a detail line.
function forecastNode(forecast) {
  if (!forecast || forecast.status === 'disabled') return null;
  const node = el('div', 'edge-dock-forecast');
  const row = el('div', 'edge-dock-detail-row');
  row.append(el('span', 'edge-dock-forecast-title', t('limits.codexResetForecast.title')));
  let value;
  let detail = '';
  const expired = forecast.status === 'active' && Date.parse(forecast.expiresAt || '') <= Date.now();
  if (forecast.status === 'scheduled') {
    value = t('limits.codexResetForecast.scheduled');
    const when = forecastDate(forecast.scheduledFor);
    detail = when ? t('limits.codexResetForecast.expected', { date: when }) : t('limits.codexResetForecast.schedulePending');
  } else if (forecast.status === 'active' && !expired) {
    value = Number.isFinite(forecast.chancePercent)
      ? t('limits.codexResetForecast.chance', {
        percent: new Intl.NumberFormat(state.locale, { maximumFractionDigits: 2 }).format(forecast.chancePercent)
      })
      : t('limits.codexResetForecast.signal');
    const when = forecastDate(forecast.predictedAt);
    detail = when ? t('limits.codexResetForecast.expected', { date: when }) : '';
  } else if (forecast.status === 'inactive' || expired) {
    value = t('limits.codexResetForecast.noSignal');
  } else {
    value = forecast.error && forecast.errorKind !== 'invalid-response'
      ? t('limits.codexResetForecast.connectionFailed')
      : t('limits.codexResetForecast.unavailable');
  }
  if (forecast.stale) detail = [detail, t('limits.codexResetForecast.stale')].filter(Boolean).join(' · ');
  row.append(el('span', 'edge-dock-detail-value', value));
  node.append(row);
  if (detail) node.append(el('div', 'edge-dock-forecast-detail', detail));
  return node;
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
  // Re-derived rather than trusted from the pushed cell: the card repaints
  // every 30s from its last payload, and a session that stopped in between must
  // stop reading as running (and must stop being counted).
  // One derivation serves both the count and the marks, from the same shared
  // predicate the Sessions list uses.
  const stateByKey = new Map(sessions.map((session) => [sessionKey(session), sessionLive.sessionActivityState(session)]));
  const liveCount = [...stateByKey.values()].filter((state) => state === 'running').length;
  const node = el('div', 'edge-dock-sessions');
  // "Recent" was doing no work - every row already carries its own `3m ago` -
  // while the running count is the one thing the section can say that the rows
  // cannot. Shown only when something is running: "none running" is noise.
  const head = el('div', 'edge-dock-section-head');
  head.append(el('span', 'edge-dock-section-title', t('edgeDock.sessions')));
  if (liveCount > 0) {
    head.append(el('span', 'edge-dock-section-count', t('edgeDock.runningCount', { count: liveCount })));
  }
  node.append(head);
  const list = el('div', 'edge-dock-session-list');
  for (const session of sessions) {
    const row = el('div', 'edge-dock-session');
    const key = sessionKey(session);
    const state = stateByKey.get(key) || 'idle';
    row.classList.toggle('is-running', state === 'running');
    const name = session.title || session.projectLabel || String(session.sessionId || '').slice(0, 12) || '—';
    // The mark itself is decorative (aria-hidden) because a bare glyph says
    // nothing to a screen reader, and its `title` only reaches pointer users.
    // The translated state therefore rides the row's accessible name, which is
    // the only place a non-visual user can get it.
    const stateLabel = state === 'running' ? t('session.running')
      : state === 'ended' ? t('session.finished') : '';
    if (stateLabel) row.setAttribute('aria-label', `${name} · ${stateLabel}`);
    const nameNode = el('span', 'edge-dock-session-name');
    // The dot sits with the name rather than recolouring it: a green title
    // made the row read as a different kind of row, and the colour carried no
    // more information than the dot does.
    nameNode.append(stateMark(session, key, state));
    nameNode.append(document.createTextNode(name));
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
  const color = providerColor(cell.provider);
  const single = cell.accounts.length === 1 ? cell.accounts[0] : null;
  // The refresh time sits under the name it belongs to, as in the Limits view:
  // under the provider for a single account, under each account otherwise.
  // Name row (mark, name, plan), then the refresh time on its own line starting
  // at the mark's edge, as in the Limits view.
  const head = el('header', 'edge-dock-card-head');
  const nameRow = el('div', 'edge-dock-card-name-row');
  nameRow.append(markNode(cell.provider));
  // With one account the email moves to the header, and so does the switch
  // affordance; with several, each row carries its own (below).
  const headTitle = el('span', 'limit-name-title edge-dock-card-title', providerLabel(cell.provider));
  const headControl = single ? accountControl(single, headTitle, { showActive: false }) : headTitle;
  nameRow.append(headControl);
  if (single?.planLabel) nameRow.append(el('span', 'edge-dock-pill', single.planLabel));
  head.append(nameRow);
  const singleUpdated = single ? updatedText(single.updatedAt) : '';
  if (singleUpdated) head.append(el('span', 'edge-dock-card-subtitle', singleUpdated));
  card.append(head);

  const accounts = el('div', 'edge-dock-accounts');
  card.append(accounts);
  for (const account of cell.accounts) {
    const block = el('div', 'edge-dock-account');
    if (!single) {
      const name = el('div', 'edge-dock-account-name');
      const names = el('div', 'edge-dock-card-titles');
      const title = accountTitle(account) || account.planLabel || providerLabel(cell.provider);
      const titleNode = el('span', 'limit-name-title edge-dock-account-title', title);
      // The row is one of three things, exactly as in the Limits view: the
      // account in use here (check badge plus a "Local" hint), a row that can be
      // switched to (hover reveals Switch), or a plain title.
      names.append(accountControl(account, titleNode));
      const updated = updatedText(account.updatedAt);
      if (updated) names.append(el('span', 'edge-dock-card-subtitle', updated));
      name.append(names);
      if (account.planLabel && accountTitle(account)) name.append(el('span', 'edge-dock-pill', account.planLabel));
      block.append(name);
    }
    if (account.status === 'stale') block.append(el('div', 'edge-dock-note is-warning', t('edgeDock.stale')));
    const windows = account.windows || [];
    if (windows.length) {
      appendWindows(block, windows, color);
    } else if (account.status !== 'ok') {
      block.append(el('div', 'edge-dock-note', t('edgeDock.unavailable')));
    }
    const credits = resetCreditsNode(account.resetCredits);
    if (credits) block.append(credits);
    accounts.append(block);
  }
  if (!cell.accounts.length) accounts.append(el('div', 'edge-dock-note', t('edgeDock.unavailable')));
  const forecast = forecastNode(cell.forecast);
  if (forecast) accounts.append(forecast);
  const sessions = sessionsNode(cell.sessions);
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
    const meter = el('div', 'edge-dock-meter');
    const rgb = parseColor(color);
    if (rgb) meter.style.background = `rgba(${rgb.join(', ')}, 0.16)`;
    const fill = el('div', 'edge-dock-meter-fill');
    fill.style.background = color;
    fill.style.opacity = '0.95';
    fill.style.transform = `scaleX(${Math.max(0.02, client.tokens / top)})`;
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

// Cards are built in a hidden staging layer and measured there. The visible
// card is only replaced once the main process reports that the window has been
// sized and shaped for exactly that card, so a new card never paints into a
// window still at the previous card's size (which read as a flash).
const stagingLayer = document.createElement('div');
stagingLayer.className = 'edge-dock-staging';
if (surface === 'bubble') root.append(stagingLayer);

function commitCard(card, cellId) {
  const previous = contentLayer.querySelector('.edge-dock-card');
  const sameCard = previous?.dataset.cellId === cellId;
  const scrollTop = sameCard ? previous.querySelector('.edge-dock-accounts')?.scrollTop || 0 : 0;
  contentLayer.replaceChildren(card);
  const list = card.querySelector('.edge-dock-accounts');
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
  else if (!codexAccountControl.deferRender(contentLayer)) renderBubble(payload);
}

bridge.onRender(render);
// Reset countdowns move without a stats push; repaint the open card each minute.
setInterval(() => {
  if (
    surface === 'bubble'
    && state.payload?.cell
    && !codexAccountControl.deferRender(contentLayer)
  ) renderBubble(state.payload);
}, 30_000);
bridge.ready();
