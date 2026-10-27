'use strict';

const { createNotchPanel } = require('../../src/electron/renderer/notch/panel');
const i18n = require('../../src/electron/renderer/i18n');
const fs = require('node:fs');

class Element {
  constructor(tag = 'div', document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.classes = new Set();
    this.scrollLeft = 0; this.offsetWidth = 0; this.clientWidth = 0;
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, on = !this.classes.has(name)) => on ? this.classes.add(name) : this.classes.delete(name)
    };
  }
  set className(value) { this.classes = new Set(String(value).split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.value = String(value ?? ''); this.replaceChildren(); }
  get textContent() { return (this.value || '') + this.children.map(node => node.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
  scrollTo({ left }) { this.scrollLeft = left; this.fire('scroll'); }
  // Every child is laid out 40 units after the previous one.
  get parentNode() { return this.parent || null; }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (node.classList.contains(selector.slice(1))) return node;
    }
    return null;
  }
  get offsetLeft() { return this.parent ? this.parent.children.indexOf(this) * 40 : 0; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() {
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement?.fire('blur');
    this.ownerDocument.activeElement = this; this.fire('focus');
  }
  querySelectorAll(selector) {
    const match = node => selector[0] === '.' ? node.classes.has(selector.slice(1))
      : selector.startsWith('[data-') ? Object.hasOwn(node.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, char) => char.toUpperCase()))
        : selector === 'button.is-selected' ? node.tagName === 'BUTTON' && node.classes.has('is-selected') : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(node => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function panelFixture(t, settings = {}, { viaRenderer = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-18T10:00:00Z') });
  const savedRaf = global.requestAnimationFrame, savedCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = () => 1; global.cancelAnimationFrame = () => {};
  t.after(() => { global.requestAnimationFrame = savedRaf; global.cancelAnimationFrame = savedCancel; });
  const document = { activeElement: null };
  document.createElementNS = (_ns, tag) => new Element(tag, document);
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = value => { const node = new Element('#text', document); node.textContent = value; return node; };
  const el = (tag, className = '', value) => {
    const node = new Element(tag, document); node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const rolls = [], settled = [];
  const resizeObservers = [];
  const pageEvents = new EventTarget();
  let scrollListener = null;
  const pageHide = () => pageEvents.dispatchEvent(new Event('pagehide'));
  const window = {
    addEventListener: (...args) => pageEvents.addEventListener(...args),
    getComputedStyle: () => ({ width: '600px', columnGap: '40px', getPropertyValue: name => name === '--notch-page-gap' ? '40px' : '' }),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; resizeObservers.push(this); }
      observe(node) { this.node = node; }
      disconnect() { this.node = null; }
    },
    TokenMonitorEdgeDockPresentation: require('../../src/electron/renderer/edgeDock/presentation'),
    TokenMonitorTrayText: require('../../src/shared/trayText'),
    TokenMonitorTrayLayout: require('../../src/shared/trayLayout'),
    TokenMonitorLimitBalanceDisplay: require('../../src/shared/limits/balanceDisplay'),
    TokenMonitorLimitWindowLabels: require('../../src/shared/limits/windowLabels'),
    TokenMonitorLimitWindowText: require('../../src/shared/limits/windowText'),
    TokenMonitorLimitResetMotion: require('../../src/electron/renderer/limits/resetMotion'),
    TokenMonitorAccountIdentity: require('../../src/electron/renderer/accountIdentity'),
    TokenMonitorSessionRows: require('../../src/electron/renderer/sessionRows'),
    TokenMonitorSessionLive: require('../../src/shared/sessionLive'),
    TokenMonitorUsageCharts: require('../../src/electron/renderer/usageCharts'),
    TokenMonitorClientCatalog: require('../../src/shared/clientCatalog'),
    TokenMonitorPressActivation: require('../../src/electron/renderer/pressActivation'),
    TokenMonitorHomeOverview: require('../../src/electron/renderer/homeOverview'),
    TokenMonitorLimitUsageItems: require('../../src/shared/limits/usageItems'),
    TokenMonitorLimitProviderPresentation: require('../../src/electron/renderer/limits/providerPresentation'),
    TokenMonitorTokenNumberAnimation: {
      duration: 1000, normalize: value => value === 'count' ? 'count' : 'roll',
      capture: node => node.rolling ? ['in-flight'] : null,
      beginRoll(node, from, to, increasing, _prepare, glyphs) {
        rolls.push({ from, to, increasing, glyphs }); node.rolling = true;
        return () => { settled.push(node); node.rolling = false; node.textContent = to; };
      }
    }
  };
  const state = { locale: 'en', appearanceKey: 'initial' };
  const overflowText = {
    bound: [], stopped: [], preserved: [],
    bind(node) { node.classList.add('fade-overflow'); this.bound.push(node); },
    stop(node) { this.stopped.push(node); },
    preserveReading(previous, next) { this.preserved.push({ previous, next }); },
    refresh() {}
  };
  // The real Limits-view plan text, so the panel is held to the same labels.
  const plans = require('../../src/electron/renderer/limits/windowsView').createLimitWindowsView({
    document, t: (key, params) => i18n.translate(state.locale, key, params), settings: () => settings,
    currentLocale: () => state.locale, presentation: window.TokenMonitorLimitProviderPresentation,
    motion: window.TokenMonitorLimitResetMotion,
    tooltip: { hasOpened: () => false, markOpened() {}, release() {} }
  });
  const shared = {
    overflowText,
    limitWindowsView: {
      // Like the real one, the tooltip names its entries as the element's label.
      setDetailTooltip(node, entries, options) {
        node.tooltipEntries = entries;
        node.tooltipOptions = options;
        node.setAttribute('aria-label', entries.map(entry => Array.isArray(entry) ? entry.join(': ') : entry.full).join(', '));
      },
      limitAccountPlan: (...args) => plans.limitAccountPlan(...args),
      limitDetailInfoNode: (...args) => plans.limitDetailInfoNode(...args)
    },
    markNode: id => el('span', 'edge-dock-mark', id), hasMask: () => true,
    providerLabel: id => id, limitProviderColor: () => '#888',
    limitAccountTitle: (_id, record, index, peers) => window.TokenMonitorAccountIdentity.accountTitleLabel(record, peers, { index, maskEmail: settings.maskLimitAccountEmails === true }),
    formatTokens: value => String(value), formatCardTokens: value => String(value), formatBreakdownTokens: value => String(value), formatCost: value => `$${value}`,
    formatRate: value => value > 0 && value < 0.1 ? '<0.1' : value > 0 && value < 1
      ? value.toLocaleString(state.locale, { maximumFractionDigits: 1 })
      : window.TokenMonitorTrayText.formatCompactNumber(value, { compactTokenUnits: settings.compactTokenUnits, locale: state.locale }),
    appearance: () => settings, prefersReducedMotion: () => settings.reduceMotion === true,
    ensureRefreshButton: () => el('button', 'edge-dock-refresh')
  };
  // Exercise the production cost builder supplied by the dock script, whose
  // top-level boot requires Electron. Do not mirror its partial-pricing policy.
  const dockSource = fs.readFileSync(require.resolve('../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const costSource = dockSource.match(/function usageCostNode\([^]*?\n\}/)[0];
  shared.usageCostNode = Function('el', 'formatCost', 't', 'formatCardTokens', 'limitWindowsView', `return (${costSource})`)(
    el, shared.formatCost, (key, params) => i18n.translate(state.locale, key, params), shared.formatCardTokens, shared.limitWindowsView
  );
  const deps = { document, window, el, t: (key, params) => i18n.translate(state.locale, key, params), state,
    bridge: { toggleRateMode() {}, onAnimate() {}, onMotion() {},
      onScroll(callback) { scrollListener = callback; return () => { scrollListener = null; }; }
    }, shared };
  let panel;
  if (viaRenderer) {
    // Exercise the real dependency handoff instead of giving the panel helpers
    // directly: the renderer must forward everything its child needs.
    window.TokenMonitorNotchPanel = { createNotchPanel: options => (panel = createNotchPanel(options)) };
    const { createNotchRenderer } = require('../../src/electron/renderer/notch/renderer');
    const previousObserver = global.ResizeObserver;
    global.ResizeObserver = window.ResizeObserver;
    try {
      createNotchRenderer({ ...deps, surface: 'notch', root: el('main'), shapeLayer: el('svg'), contentLayer: el('div'),
        shared: { ...shared, el, t: deps.t } });
    } finally { global.ResizeObserver = previousObserver; }
  } else panel = createNotchPanel(deps);
  t.after(pageHide);
  return { panel, document, state, settings, rolls, settled, el, overflowText, pageHide,
    scroll: record => scrollListener?.(record),
    get scrollSubscribed() { return scrollListener !== null; },
    resize: () => resizeObservers.forEach(observer => { if (observer.node) observer.callback(); }),
    find: className => panel.node.querySelector(`.${className}`),
    all: className => panel.node.querySelectorAll(`.${className}`) };
}

module.exports = { Element, panelFixture };
