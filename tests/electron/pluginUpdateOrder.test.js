'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { Element } = require('../helpers/notchPanel');
const { createHost } = require('../../src/electron/renderer/pluginUi');
const { createPluginViewHost } = require('../../src/electron/renderer/pluginViews');
const { create } = require('../../src/electron/renderer/pluginContent');
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, { pendingMount = false, onUpdate = () => {}, variant } = {}) {
  const document = { addEventListener() {}, removeEventListener() {}, createElement(tag) {
    const node = new Element(tag, document); node.style.removeProperty = key => { delete node.style[key]; };
    Object.defineProperties(node, {
      isConnected: { get: () => document.body?.contains(node) || document.head?.contains(node) || false },
      nextSibling: { get: () => node.parent?.children[node.parent.children.indexOf(node) + 1] }
    });
    node.insertBefore = (child, next) => {
      if (child === next) return;
      child.remove(); const index = next ? node.children.indexOf(next) : node.children.length;
      child.parent = node; node.children.splice(index, 0, child);
    };
    return node;
  } };
  document.body = document.createElement('body'); document.head = document.createElement('head');
  const native = document.createElement('main'); native.hidden = false; document.body.append(native);
  const descriptor = { id: 'panel', ref: 'fixture/panel', pluginId: 'fixture', revision: 'one',
    entry: 'fixture', targets: ['main.home.content'], mode: 'replace' };
  const state = { period: 'today', settings: { hubMode: 'local' }, stats: { generation: 1 },
    breakdown: 'home', floatingBubble: { collapsed: false } };
  const calls = [], mountGate = deferred();
  let ui, container, active = 0, maximum = 0, disposals = 0, autoFinish = false;
  const window = { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, tokenMonitorTrustedPlugins: {},
    TokenMonitorPluginUi: { createHost(options) {
      ui = createHost({ ...options, importModule: async () => ({ async mount(node) {
        container = node;
        if (pendingMount) await mountGate.promise;
        return { async update(context) {
          active++; maximum = Math.max(maximum, active);
          const gate = deferred(), value = { period: context.period, source: context.source,
            generation: context.stats.generation, visible: context.visible, variant: context.surfaceVariant };
          calls.push({ gate, value }); onUpdate(context, ui, node);
          if (autoFinish) gate.resolve();
          try {
            await gate.promise;
            const output = document.createElement('span'); output.textContent = JSON.stringify(value);
            node.replaceChildren(output);
          } finally { active--; }
        }, dispose() { disposals++; } };
      } }) }); return ui;
    } }
  };
  const host = createPluginViewHost({ document, window,
    getContext: () => ({ period: state.period, source: state.settings.hubMode, stats: state.stats, surfaceVariant: 'notch' }) });
  host.update({ surface: 'page', views: { [descriptor.ref]: descriptor } });
  const content = create({ document, getViews: () => [descriptor], selection: () => descriptor.ref,
    host: { mount: (node, view, context) => host.mount(node, view.ref, 'page', variant ? { ...context, surfaceVariant: variant } : context),
      unmount: node => host.unmount(node) } });
  // Use the production App wrapper, including its refreshContext/composition order.
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const node = espree.parse(source, { ecmaVersion: 'latest' }).body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'render');
  const context = vm.createContext({ state, els: { homePanel: native }, pluginViewHost: host, pluginContent: content,
    renderAppContent() {}, visibleStatsSurface: () => 'main', isSettingsPanelOpen: () => false,
    isRendererWindowHidden: () => false, openViewFromTray() {} });
  vm.runInContext(source.slice(node.start, node.end), context);
  t.after(async () => {
    autoFinish = true; mountGate.resolve();
    for (const call of calls) call.gate.resolve();
    await tick(); content.dispose(); await host.dispose();
  });
  return { state, native, calls, host, content, mountGate,
    render: () => context.render(), get container() { return container; },
    get maximum() { return maximum; }, get disposals() { return disposals; },
    change(generation) { state.period = 'month'; state.settings.hubMode = 'remote'; state.stats = { generation }; }
  };
}

test('App composition sends one update with current period/source/stats', async t => {
  const f = fixture(t); f.render(); await tick();
  f.change(2); f.render();
  assert.equal(f.calls.length, 1, 'refreshContext must not also repaint cached content options');
  assert.equal(f.calls[0].value.period, 'month'); assert.equal(f.calls[0].value.source, 'remote');
  assert.equal(f.calls[0].value.generation, 2);
  f.calls[0].gate.resolve(); await tick();
  assert.equal(JSON.parse(f.container.textContent).generation, 2);
});

test('one in-flight callback coalesces pending renders to the latest context', async t => {
  const f = fixture(t); f.render(); await tick();
  f.change(2); f.render(); f.change(3); f.render(); f.change(4); f.render();
  assert.equal(f.calls.length, 1, 'a newer callback cannot overtake the in-flight callback');
  f.calls[0].gate.resolve(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].value.generation, 4, 'generation3 is superseded');
  f.calls[1].gate.resolve(); await tick();
  assert.equal(JSON.parse(f.container.textContent).generation, 4); assert.equal(f.maximum, 1);
});

test('pending initial mount and later async updates share the same serial drain', async t => {
  const f = fixture(t, { pendingMount: true }); f.render(); await tick();
  f.change(2); f.render(); f.change(3); f.render();
  assert.equal(f.calls.length, 0);
  f.mountGate.resolve(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].value.generation, 3);
  f.change(4); f.render(); assert.equal(f.calls.length, 1);
  f.calls[0].gate.resolve(); await tick();
  assert.equal(f.calls[1].value.generation, 4);
  f.calls[1].gate.resolve(); await tick(); assert.equal(f.maximum, 1);
});

test('authoritative live context wins cached options and preserves the slot variant', async t => {
  const f = fixture(t, { variant: 'summary' }); f.render(); await tick();
  f.change(2); f.host.refreshContext();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].value.generation, 2); assert.equal(f.calls[0].value.period, 'month');
  assert.equal(f.calls[0].value.source, 'remote'); assert.equal(f.calls[0].value.variant, 'summary');
  f.calls[0].gate.resolve(); await tick();
});

test('unmount drains an in-flight callback and drops queued updates before disposal', async t => {
  const f = fixture(t); f.render(); await tick();
  f.change(2); f.render(); f.change(3); f.render(); f.content.dispose();
  f.calls[0].gate.resolve(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.disposals, 1);
  assert.equal(f.container.children.length, 0, 'late author output is cleared by its owner');
});

test('update rejection restores native content and does not execute queued callbacks', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t); f.render(); await tick(); assert.equal(f.native.hidden, true);
  f.change(2); f.render(); f.change(3); f.render();
  f.calls[0].gate.reject(Error('synthetic update failure')); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.native.hidden, false);
  assert.match(f.container.textContent, /synthetic update failure/);
});

test('a synchronous reentrant visibility update queues behind the current callback', async t => {
  const f = fixture(t, { onUpdate(context, ui, node) { if (context.visible !== false) ui.setVisibility(node, false); } });
  f.render(); await tick(); f.change(2); f.render(); assert.equal(f.calls.length, 1);
  f.calls[0].gate.resolve(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].value.visible, false);
  f.calls[1].gate.resolve(); await tick(); assert.equal(f.maximum, 1);
});
