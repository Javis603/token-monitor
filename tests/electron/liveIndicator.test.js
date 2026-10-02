'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '../../src/electron/renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');

function liveDotHarness() {
  const animations = [];
  const dot = {
    live: true,
    classList: {
      contains: () => dot.live,
      toggle: (_name, value) => { dot.live = value; }
    },
    getAnimations: () => animations.filter(animation => !animation.canceled),
    animate(keyframes, options) {
      const animation = { keyframes, options, cancel() { this.canceled = true; } };
      animations.push(animation);
      return animation;
    }
  };
  Object.defineProperty(dot, 'offsetWidth', { get() { throw new Error('Forced layout'); } });
  const context = vm.createContext({
    els: { liveDot: dot }, state: { mode: 'sync' },
    liveDotTitle: () => 'Connection status',
    prefersReducedMotion: () => false,
    isRendererWindowHidden: () => false
  });
  vm.runInContext(app.slice(app.indexOf('function setLiveDot('), app.indexOf('function refreshButtonIdleTitle(')), context);
  return { context, dot, animations };
}

test('fresh data uses a bounded opacity cue without forced layout or shadow animation', () => {
  const { context, animations } = liveDotHarness();
  context.pulseLiveDot();
  assert.equal(animations.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(animations[0].keyframes)), [{ opacity: 0.4 }, { opacity: 1 }]);
  assert.equal(animations[0].options.duration, 420);
  assert.equal(animations[0].options.iterations, undefined);
  assert.equal(animations[0].options.fill, undefined);
  context.pulseLiveDot();
  assert.equal(animations[0].canceled, true);
  assert.equal(animations.length, 2);
  context.setLiveDot(false);
  assert.equal(animations[1].canceled, true);
  assert.doesNotMatch(css, /@keyframes live-pulse\b|\.live-dot\.pulse/);
  assert.doesNotMatch(css.match(/\.live-dot\.live\s*\{([^}]+)\}/)?.[1] || '', /box-shadow/);
});

test('offline, hidden and reduced-motion states do not start data cues', () => {
  for (const mode of ['offline', 'hidden', 'reduced']) {
    const { context, dot, animations } = liveDotHarness();
    if (mode === 'offline') dot.live = false;
    if (mode === 'hidden') context.isRendererWindowHidden = () => true;
    if (mode === 'reduced') context.prefersReducedMotion = () => true;
    context.pulseLiveDot();
    assert.equal(animations.length, 0, mode);
  }
});

test('sync status has distinct static connection icons and only a visible waiting state spins', () => {
  const start = html.indexOf('id="syncPanelSignal"');
  const end = html.indexOf('<div class="sync-panel-state">', start);
  const signal = html.slice(start, end);
  assert.match(signal, /aria-hidden="true"/);
  for (const kind of ['linked', 'unlinked', 'pending']) {
    assert.match(signal, new RegExp(`class="sync-panel-signal-${kind}"`));
  }
  assert.doesNotMatch(css, /sync-signal-ripple|\.sync-panel-signal::after/);
  const animatedRule = css.match(/([^{}]+)\{\s*animation: sync-signal-spin[^}]+\}/);
  assert.ok(animatedRule);
  for (const required of ['.shell.settings-open', '.settings-sync-group.expanded', '[data-state="connecting"]', '[data-visible="true"]', ':not([data-window-hidden="true"])']) {
    assert.ok(animatedRule[1].includes(required), required);
  }
  assert.match(css, /@keyframes sync-signal-spin\s*\{\s*to\s*\{\s*transform: rotate\(360deg\)/);
  assert.match(css, /:root\[data-reduce-motion="on"\] \.sync-panel-signal > svg \{ animation: none !important;/);
  assert.match(css, /:root:not\(\[data-reduce-motion="off"\]\) \.sync-panel-signal > svg \{ animation: none !important;/);
});

test('offscreen observer updates visibility and is released on unload', () => {
  const start = app.indexOf('const syncPanelSignalObserver =');
  const end = app.indexOf('// The sync settings status', start);
  let observer;
  let onUnload;
  const signal = { dataset: {} };
  const context = vm.createContext({
    els: { syncPanelSignal: signal, settingsPanel: {} },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; observer = this; }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    },
    window: { addEventListener(type, callback, options) { assert.equal(type, 'unload'); assert.equal(options.once, true); onUnload = callback; } }
  });
  vm.runInContext(app.slice(start, end), context);
  assert.equal(observer.target, signal);
  assert.equal(observer.options.root, context.els.settingsPanel);
  observer.callback([{ isIntersecting: true }]);
  assert.equal(signal.dataset.visible, 'true');
  observer.callback([{ isIntersecting: false }]);
  assert.equal(signal.dataset.visible, 'false');
  onUnload();
  assert.equal(observer.disconnected, true);
});

test('connection state and window visibility drive the icon without replacing its SVG', () => {
  const start = app.indexOf('function renderSyncPanelConnection(');
  const end = app.indexOf('function updateSyncPanelAges(', start);
  const signal = { dataset: {} };
  const context = vm.createContext({
    els: { syncPanelSignal: signal, syncPanelConnection: { dataset: {} }, syncPanelState: {}, syncPanelDetail: { dataset: {} } },
    state: { mode: 'sync', streamConnected: true },
    isRendererWindowHidden: () => false,
    streamFailureText: () => '',
    syncDevicePanelApi: require('../../src/electron/renderer/syncDevicePanel'),
    t: key => key
  });
  vm.runInContext(app.slice(start, end), context);
  context.renderSyncPanelConnection('client');
  assert.equal(context.els.syncPanelConnection.dataset.state, 'connected');
  assert.equal(signal.dataset.windowHidden, 'false');
  context.state.streamConnected = false;
  context.renderSyncPanelConnection('client');
  assert.equal(context.els.syncPanelConnection.dataset.state, 'connecting');
  context.streamFailureText = () => 'Network unavailable';
  context.isRendererWindowHidden = () => true;
  context.renderSyncPanelConnection('client');
  assert.equal(context.els.syncPanelConnection.dataset.state, 'disconnected');
  assert.equal(context.els.syncPanelDetail.textContent, 'Network unavailable');
  assert.equal(signal.dataset.windowHidden, 'true');
  const visibilityStart = app.indexOf('function handleWindowVisibilityChange()');
  const visibilityBody = app.slice(visibilityStart, app.indexOf("document.addEventListener('visibilitychange'", visibilityStart));
  assert.ok(visibilityBody.indexOf('dataset.windowHidden') < visibilityBody.indexOf('statsRenderScheduler.visibilityChanged()'));
});
