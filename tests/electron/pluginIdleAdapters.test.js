'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the shipped adapters with deterministic DOM/IPC boundaries. Override
// only the source directory to reproduce failures against the captured input.
const sourceDir = process.env.IDLE_ADAPTER_SOURCE || path.join(__dirname, '../../src/electron/renderer');
function fixture() {
  const counts = { rect: 0, style: 0, insert: 0, remove: 0, observe: 0 }, timers = new Map(), mutations = [], resizes = [];
  let now = 10000, nextTimer = 0;
  const eventTarget = object => Object.assign(object, {
    listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener() {},
    emit(name) { for (const fn of this.listeners[name] || []) fn(); }
  });
  class Node {
    constructor(tag) {
      eventTarget(this); this.tag = tag; this.children = []; this.parentElement = null; this.style = {}; this.hidden = false;
      this.box = { x: 30, y: 40, left: 30, top: 40, right: 230, bottom: 190, width: 200, height: 150 };
      const classes = new Set();
      this.classList = { contains: k => classes.has(k), remove: k => classes.delete(k), toggle(k, on) { if (on) classes.add(k); else classes.delete(k); } };
    }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] || null; }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
    before(node) { this.insert(node, 0); }
    after(node) { this.insert(node, 1); }
    insert(node, offset) { node.remove(); const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this) + offset, 0, node); node.parentElement = parent; counts.insert++; }
    remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; counts.remove++; } }
    replaceChildren() { for (const child of [...this.children]) child.remove(); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    getBoundingClientRect() { counts.rect++; return this.box; }
    getAnimations() { return []; }
    setAttribute() {}
    querySelector() { return null; }
    focus() {}
  }
  const document = eventTarget({ hidden: false, createElement: tag => new Node(tag), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null });
  document.body = new Node('body'); document.documentElement = new Node('html');
  const window = eventTarget({ innerWidth: 1000, innerHeight: 1000, matchMedia: () => ({ matches: false }) });
  const css = { display: 'block', visibility: 'visible', opacity: '1', clipPath: 'none', overflowX: 'visible', overflowY: 'visible', getPropertyValue: () => '', fontFamily: 'system-ui', colorScheme: 'dark' };
  window.getComputedStyle = () => { counts.style++; return css; };
  window.MutationObserver = class { constructor(fn) { mutations.push(fn); } observe() { counts.observe++; } disconnect() {} };
  window.ResizeObserver = class { constructor(fn) { resizes.push(fn); } observe() {} unobserve() {} disconnect() {} };
  const context = vm.createContext({ window, document, getComputedStyle: window.getComputedStyle, MutationObserver: window.MutationObserver,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id), Date: { now: () => now } });
  async function tick(ms = 16) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  const mutate = () => mutations.forEach(fn => fn([{ target: document.body }]));
  function load(file) { vm.runInContext(fs.readFileSync(path.join(sourceDir, file), 'utf8'), context); }
  function mount() { const node = new Node('card'); node.append(new Node('fallback')); document.body.append(node); document.elementFromPoint = () => node; return node; }
  return { document, window, counts, timers, tick, mutate, load, mount, resizes };
}
function presentation(f, options = {}) {
  f.load('pluginPresentationWeb.js');
  const calls = [], hooks = {}, state = { status: 'ok', revision: 1, webDocuments: [{ ref: 'demo/rich', height: 150 }] };
  const adapter = f.window.TokenMonitorPluginPresentationWeb.create({ document: f.document, window: f.window, surface: 'home', stateFor: () => state,
    bridge: { syncWebPresentation(input) { calls.push(input); return options.sync?.(input) || Promise.resolve({ mounted: input.entries?.map(e => e.instance) || [] }); },
      onWebPresentationReady(fn) { hooks.ready = fn; }, onWebPresentationFailed(fn) { hooks.failed = fn; } } });
  return { adapter, calls, hooks, state };
}
test('three empty presentation adapters do no IPC, style, geometry or timer work over 60 mutation frames', async () => {
  const f = fixture(), adapters = Array.from({ length: 3 }, () => presentation(f));
  for (let i = 0; i < 60; i++) { f.mutate(); f.document.emit('scroll'); f.document.emit('transitionrun'); await f.tick(); }
  assert.equal(adapters.reduce((n, p) => n + p.calls.length, 0), 0);
  assert.equal(f.counts.style, 0); assert.equal(f.counts.rect, 0); assert.equal(f.timers.size, 0);
});
test('an unmounted presentation adapter attaches no document-wide observer or capture listener', () => {
  const f = fixture(), p = presentation(f);
  assert.equal(f.counts.observe, 0);
  assert.deepEqual(Object.keys(f.document.listeners), []);
  p.adapter.track({ container: f.mount(), ref: 'demo/view' });
  assert.equal(f.counts.observe, 1);
  assert.ok(f.document.listeners.scroll?.length);
});
function surfaceWeb(f, kind = 'rail') {
  f.load('pluginSurfaceWeb.js');
  const calls = [], state = { status: 'ok', revision: 1, webDocuments: [{ ref: 'demo/rail', variant: 'compact', height: 40 }] };
  const adapter = f.window.TokenMonitorPluginSurfaceWeb.create({ document: f.document, window: f.window, surface: 'edgeDock', kind, stateFor: () => state, active: () => true, reducedMotion: () => false,
    bridge: { syncWebSurface(input) { calls.push(input); return Promise.resolve({ mounted: input.entries?.map(e => e.ref) || [] }); } } });
  return { adapter, calls, state };
}
test('an empty dock or notch surface settles after one sync and stays idle across renders, mutations and resizes', async () => {
  const f = fixture(), s = surfaceWeb(f);
  s.adapter.refresh(); await f.tick();
  assert.equal(s.calls.length, 1, 'one sync tells main this host holds nothing');
  const style = f.counts.style;
  for (let i = 0; i < 60; i++) { s.adapter.refresh(); f.mutate(); f.document.emit('scroll'); f.window.emit('resize'); await f.tick(); }
  assert.equal(s.calls.length, 1); assert.equal(f.counts.style, style); assert.equal(f.timers.size, 0);
  const node = f.mount(); node.dataset = {}; node.offsetWidth = 200; node.parentElement.clientHeight = 48;
  s.adapter.track({ container: node, ref: 'demo/view', variant: 'compact' }); await f.tick();
  assert.equal(s.calls.length, 2, 'a mounted plugin resumes syncing');
});
test('presentation parks once per motion burst, dedupes unchanged mutation and recovers readiness/visibility', async () => {
  const f = fixture(), p = presentation(f), node = f.mount(); p.adapter.track({ container: node, ref: 'demo/view' }); await f.tick();
  assert.equal(node.classList.contains('pv-web-mounted'), true);
  const initial = p.calls.length;
  for (let i = 0; i < 60; i++) { f.mutate(); await f.tick(); }
  assert.equal(p.calls.length, initial);
  for (let i = 0; i < 60; i++) { f.document.emit('scroll'); f.document.emit('transitionrun'); await f.tick(1); }
  assert.equal(p.calls.filter(c => c.visible === false).length, 1);
  assert.equal(node.classList.contains('pv-web-mounted'), false);
  await f.tick(120); await f.tick(); assert.equal(node.classList.contains('pv-web-mounted'), true);
  const beforeReady = p.calls.length; p.hooks.ready(); await f.tick(); assert.equal(p.calls.length, beforeReady + 1);
  f.document.hidden = true; f.document.emit('visibilitychange'); await f.tick(120);
  const hidden = p.calls.length; for (let i = 0; i < 10; i++) f.document.emit('scroll'); await f.tick(120); assert.equal(p.calls.length, hidden);
  f.document.hidden = false; f.document.emit('visibilitychange'); await f.tick(120); await f.tick(); assert.equal(node.classList.contains('pv-web-mounted'), true);
});
test('presentation fences pending visible completion, security obstruction, removal and late rejection', async () => {
  const f = fixture(); let resolve, reject, delayed = true;
  const p = presentation(f, { sync: input => input.visible && delayed ? new Promise((yes, no) => { resolve = yes; reject = no; }) : null });
  const node = f.mount(); p.adapter.track({ container: node, ref: 'demo/view' }); await f.tick();
  f.document.emit('scroll'); delayed = false; resolve({ mounted: ['presentation-1'] }); await f.tick();
  assert.equal(node.classList.contains('pv-web-mounted'), false); await f.tick(120); await f.tick();
  assert.equal(node.classList.contains('pv-web-mounted'), true);
  f.document.elementFromPoint = () => ({}); f.mutate(); assert.equal(p.calls.at(-1).visible, false);
  await f.tick(120); await f.tick(); assert.equal(node.classList.contains('pv-web-mounted'), false);
  f.document.elementFromPoint = () => node; delayed = true; p.adapter.refresh(); await f.tick();
  p.state.revision++; p.adapter.refresh(); delayed = false; reject(new Error('old request')); await f.tick(); await f.tick();
  assert.equal(node.classList.contains('pv-web-mounted'), true, 'old failure cannot poison revised mount');
  node.remove(); f.mutate(); await f.tick(); const removed = p.calls.length, styles = f.counts.style;
  for (let i = 0; i < 60; i++) { f.mutate(); await f.tick(); }
  assert.equal(p.calls.length, removed); assert.equal(f.counts.style, styles);
});
function pages(f, options = {}) {
  f.load('pluginPageDesigns.js');
  const calls = [], hooks = {}, breakdown = f.mount(); let input, selections = { model: 'demo/page' };
  const api = { webSync(payload) { calls.push(payload); return options.sync?.(payload) || Promise.resolve({ selections, mounted: payload.visible }); },
    webSelect: async (target, ref) => (selections = { [target]: ref }), onWebReady(fn) { hooks.ready = fn; }, onWebRestore(fn) { hooks.restore = fn; }, onWebFailed(fn) { hooks.failed = fn; } };
  const adapter = f.window.TokenMonitorPluginPageDesigns.create({ document: f.document, window: f.window, api, t: x => x, breakdown, update: () => adapter.render(input) });
  const render = (docs = [], tokens = 10, visible = true) => { input = { visible, catalog: { plugins: [{ status: 'active', name: 'Demo', webDocuments: docs }] }, snapshot: { target: 'model', period: 'today', totalTokens: tokens, rows: [] } }; adapter.render(input); };
  return { calls, hooks, render, breakdown, adapter };
}
const pageDoc = { ref: 'demo/page', target: 'model', title: 'Page', height: 150, slot: 'replace' };
test('page no-doc renders and events avoid IPC and layout; none to doc to none recovers saved selection', async () => {
  const f = fixture(), p = pages(f); const baseline = { ...f.counts };
  for (let i = 0; i < 60; i++) { p.render(); f.document.emit('scroll'); f.document.emit('toggle'); f.mutate(); await f.tick(); }
  assert.equal(p.calls.length, 0); assert.equal(f.counts.rect, baseline.rect); assert.equal(f.counts.style, baseline.style);
  p.render([pageDoc]); await f.tick(); assert.ok(p.calls.some(c => c.visible)); assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), true);
  p.render(); await f.tick(); assert.equal(p.calls.at(-1).visible, false); assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), false);
  const calls = p.calls.length, rect = f.counts.rect, style = f.counts.style;
  for (let i = 0; i < 60; i++) { p.render(); f.document.emit('scroll'); await f.tick(); }
  assert.equal(p.calls.length, calls); assert.equal(f.counts.rect, rect); assert.equal(f.counts.style, style);
  p.render([pageDoc]); await f.tick(); assert.equal(p.calls.at(-1).visible, true);
});
test('a native render with no page design writes nothing to the hidden chooser', async () => {
  const f = fixture(), p = pages(f); p.render(); await f.tick();
  const container = f.document.body.children.find(n => n.className === 'plugin-page-designs');
  const [label, select] = container.children[0].children; let writes = 0;
  for (const [node, prop] of [[label, 'textContent'], [select, 'value'], [select, 'disabled'], [container, 'hidden']]) {
    let value = node[prop];
    Object.defineProperty(node, prop, { get: () => value, set: next => { writes++; value = next; } });
  }
  for (let i = 0; i < 60; i++) { p.render([], i); await f.tick(); }
  assert.equal(writes, 0);
  assert.equal(p.calls.length, 0);
  p.render([pageDoc]); await f.tick();
  assert.equal(container.hidden, false, 'a design appearing still shows the chooser');
});
test('page stable panel and payload dedupe retain data/geometry changes and readiness retry', async () => {
  const f = fixture(), p = pages(f); p.render([pageDoc]); await f.tick();
  const calls = p.calls.length, inserts = f.counts.insert, removes = f.counts.remove;
  for (let i = 0; i < 60; i++) { p.render([pageDoc]); f.document.emit('scroll'); await f.tick(); }
  assert.equal(p.calls.length, calls); assert.equal(f.counts.insert, inserts); assert.equal(f.counts.remove, removes);
  p.render([pageDoc], 25); await f.tick(); assert.equal(p.calls.at(-1).snapshot.totalTokens, 25);
  const panel = f.document.body.children.find(n => n.className === 'plugin-web-panel'); panel.box.y = 60;
  f.document.emit('scroll'); await f.tick(); assert.equal(p.calls.at(-1).rect.y, 60);
  const ready = p.calls.length; p.hooks.ready(); await f.tick(); assert.equal(p.calls.length, ready + 1);
  f.document.hidden = true; f.document.emit('visibilitychange'); await f.tick(); assert.equal(p.calls.at(-1).visible, false);
  f.document.hidden = false; f.document.emit('visibilitychange'); await f.tick(); assert.equal(p.calls.at(-1).visible, true);
});
test('page pending selection discovery cannot revive removed docs', async () => {
  const f = fixture(); let resolve, delay = true;
  const p = pages(f, { sync: () => delay ? new Promise(yes => { resolve = yes; }) : null });
  p.render([pageDoc]); p.render(); delay = false; resolve({ selections: { model: 'demo/page' }, mounted: true }); await f.tick();
  assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), false);
  assert.equal(p.calls.filter(c => c.visible).length, 0);
  p.render([pageDoc]); await f.tick(); assert.equal(p.calls.at(-1).visible, true);
});
test('tracked lightweight-only presentations stay idle and gain/lose rich documents without remounting', async () => {
  const f = fixture(), p = presentation(f), node = f.mount(); p.state.webDocuments = [];
  p.adapter.track({ container: node, ref: 'demo/view' }); await f.tick();
  const style = f.counts.style, rect = f.counts.rect;
  for (let i = 0; i < 60; i++) { f.mutate(); f.document.emit('scroll'); await f.tick(); }
  assert.equal(p.calls.length, 0); assert.equal(f.counts.style, style); assert.equal(f.counts.rect, rect);
  p.state.webDocuments = [{ ref: 'demo/rich', height: 150 }]; p.state.revision++; p.adapter.refresh(); await f.tick();
  assert.equal(node.classList.contains('pv-web-mounted'), true);
  p.hooks.failed({ instance: 'presentation-1' }); await f.tick(); assert.equal(p.calls.at(-1).visible, false);
  const failed = p.calls.length; for (let i = 0; i < 60; i++) { f.mutate(); await f.tick(); } assert.equal(p.calls.length, failed);
  p.state.revision++; p.adapter.refresh(); await f.tick(); assert.equal(node.classList.contains('pv-web-mounted'), true);
  p.state.webDocuments = []; p.adapter.refresh(); await f.tick(); assert.equal(node.style.height, ''); assert.equal(p.calls.at(-1).visible, false);
});
test('page readiness polling survives unchanged renders', async () => {
  const f = fixture(); let mounted = false;
  const p = pages(f, { sync: payload => Promise.resolve({ selections: { model: 'demo/page' }, mounted: payload.visible && mounted }) });
  p.render([pageDoc]); await f.tick();
  for (let i = 0; i < 5; i++) { p.render([pageDoc]); await f.tick(10); }
  const before = p.calls.length; mounted = true; await f.tick(100); assert.ok(p.calls.length > before);
  assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), true);
});
test('page failed document recovers after changed catalog and original selection stops recurring work', async () => {
  const f = fixture(), p = pages(f); p.render([pageDoc]); await f.tick();
  p.hooks.failed('changed'); p.render([pageDoc]); await f.tick(); assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), true);
  const container = f.document.body.children.find(n => n.className === 'plugin-page-designs');
  const select = container.children[0].children[1]; select.value = ''; select.emit('change'); await f.tick();
  assert.equal(p.calls.at(-1).visible, false); const calls = p.calls.length, rect = f.counts.rect;
  for (let i = 0; i < 60; i++) { p.render([pageDoc]); f.document.emit('scroll'); await f.tick(); }
  assert.equal(p.calls.length, calls); assert.equal(f.counts.rect, rect);
});

test('same-size page selection changes force IPC and wait for the newly selected document', async () => {
  const f = fixture(); let delay = false, resolve;
  const p = pages(f, { sync: payload => delay && payload.visible ? new Promise(yes => { resolve = yes; }) : null });
  const second = { ...pageDoc, ref: 'demo/second' };
  p.render([pageDoc, second]); await f.tick();
  const before = p.calls.length;
  const container = f.document.body.children.find(n => n.className === 'plugin-page-designs');
  const select = container.children[0].children[1]; delay = true; select.value = second.ref; select.emit('change'); await f.tick();
  assert.ok(p.calls.length > before, 'selection is main-owned and absent from the otherwise identical sync payload');
  const panel = f.document.body.children.find(n => n.className === 'plugin-web-panel');
  assert.equal(panel.style.visibility, 'hidden'); assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), false);
  delay = false; resolve({ selections: { model: second.ref }, mounted: true }); await f.tick();
  assert.equal(panel.style.visibility, ''); assert.equal(p.breakdown.classList.contains('plugin-web-replaced'), true);
});
