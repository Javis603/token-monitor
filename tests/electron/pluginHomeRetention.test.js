'use strict';
// Execute the actual Home render pipeline with the actual content compositor.
// The DOM double records disconnections/focus loss, not browser scroll layout.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const espree = require('espree');
const { Element } = require('../helpers/notchPanel');
const { create } = require('../../src/electron/renderer/pluginContent');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest' });
function extract(name) {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name); return source.slice(node.start, node.end);
}
function fixture(t, mode = 'replace', selector = '.home-module-tool > .home-module-body') {
  const instances = new Map(), trace = [], mutations = [];
  let input, container, mounts = 0, disposals = 0, ready = true, latest;
  const disconnected = node => {
    if (input?.isConnected && node.contains(input)) mutations.push('author-disconnect');
    if (document.activeElement && node.contains(document.activeElement)) document.activeElement = null;
  };
  const document = { createElement(tag) {
    const node = new Element(tag, document);
    node.remove = () => {
      disconnected(node);
      Element.prototype.remove.call(node);
    };
    node.replaceChildren = (...children) => {
      for (const child of [...node.children]) child.remove();
      node.append(...children);
    };
    node.prepend = (...children) => {
      for (const child of children.reverse()) node.insertBefore(child, node.children[0] || null);
    };
    node.insertBefore = (child, next) => {
      if (child === next) return;
      if (child.parentNode) child.remove();
      const index = next ? node.children.indexOf(next) : node.children.length;
      assert.ok(index >= 0); child.parent = node; node.children.splice(index, 0, child);
    };
    node.moveBefore = (child, next) => {
      // A state-preserving move, as supported by the target Chromium.
      if (child === next) return;
      child.parent.children.splice(child.parent.children.indexOf(child), 1);
      const index = next ? node.children.indexOf(next) : node.children.length;
      child.parent = node; node.children.splice(index, 0, child);
    };
    Object.defineProperties(node, {
      childNodes: { get: () => node.children },
      isConnected: { get: () => document.body?.contains(node) || false },
      nextSibling: { get: () => node.parent?.children[node.parent.children.indexOf(node) + 1] }
    });
    return node;
  } };
  document.body = document.createElement('body');
  const home = document.createElement('main'); document.body.append(home);
  const originalQuery = home.querySelectorAll.bind(home);
  home.querySelectorAll = selector => selector === '.home-module-tool > .home-module-body'
    ? originalQuery('.home-module-tool').map(module => module.querySelector('.home-module-body'))
    : originalQuery(selector);
  const descriptor = { ref: 'fixture/cards', revision: 'one', targets: ['main.home.content'], selector, mode };
  let views = mode === 'native' ? [] : [descriptor];
  const composition = create({ document, getViews: () => views, selection: () => descriptor.ref,
    host: {
      mount(node, _descriptor, context) {
        container = node; latest = context;
        if (!instances.has(node)) {
          input = document.createElement('input'); input.value = 'draft'; node.append(input);
          instances.set(node, input); mounts++;
        }
        trace.push({ connected: node.isConnected, focused: document.activeElement === input });
        if (ready !== null) context.onMountStatus(ready);
      },
      unmount(node) { instances.delete(node); disposals++; }
    }
  });
  t.after(() => composition.dispose());
  const state = { stats: { periods: { today: { totalTokens: 100, clients: { codex: 100 } },
    month: { totalTokens: 200, clients: { codex: 200 } } } }, period: 'today', settings: {},
    breakdown: 'home', floatingBubble: { collapsed: false } };
  let context, modules = ['tool', 'model', 'trends'];
  const navigations = [];
  context = vm.createContext({ document, state, els: { homePanel: home }, pluginContent: composition,
    pluginViewHost: { refreshContext() {} }, homeSessionRenderPending: false,
    sessionTooltipShouldHoldRender: () => false, hideHomeActivityTooltip() {},
    homeModuleIds: () => modules, loadHomeHistory() {},
    homeModulePreferencesApi: { homeModuleCount: () => 5, isPluginModuleId: () => false },
    homeToolSourceRows: p => Object.entries(p.clients).map(([key, value]) => ({ key, name: key, value })),
    homeOverviewApi: { homeToolRows: rows => rows.map(row => ({ ...row, share: 1 })), homeActivityScrollTarget: () => 0 },
    applyHomeListMark() {}, iconKindFor: () => 'dot', formatCompact: String, formatPercent: String,
    t: key => key, VIEW_ICON_CLASSES: {}, renderBreakdownChange: id => navigations.push(id),
    renderHomeModelModule() { return context.homeModuleShell('model', 'Models', 'model').module; },
    renderHomeTrendsModule() {
      const { module, body } = context.homeModuleShell('trends', 'Trends', 'trends');
      const scroller = document.createElement('div'); scroller.className = 'home-activity-scroll';
      Object.defineProperties(scroller, {
        scrollWidth: { get() { trace.push({ geometry: true, connected: container?.isConnected }); return 500; } },
        clientWidth: { get: () => 300 }
      });
      body.append(scroller); return module;
    },
    homeActivityProgrammaticScrollers: new WeakSet(), renderAppContent() { context.renderHome(); },
    visibleStatsSurface: () => 'main', openViewFromTray() {}, isSettingsPanelOpen: () => false,
    isRendererWindowHidden: () => false
  });
  vm.runInContext(['homeModuleShell', 'renderHomeToolModule', 'applyHomeActivityScroll', 'renderHome', 'render'].map(extract).join('\n'), context);
  return { render: () => context.render(), home, state, document, trace, mutations, navigations,
    get input() { return input; }, get container() { return container; }, get mounts() { return mounts; },
    get disposals() { return disposals; }, get latest() { return latest; },
    set ready(value) { ready = value; }, set views(value) { views = value; },
    set modules(value) { modules = value; }
  };
}

for (const selector of ['.home-module-tool > .home-module-body', '.home-module-tool'])
  for (const mode of ['replace', 'append', 'decorate']) test(`Home ${mode} at ${selector} stays connected/focused across numeric pushes and module reorder`, t => {
  const f = fixture(t, mode, selector); f.render();
  const shell = f.home.querySelector('.home-module-tool'), body = shell.querySelector('.home-module-body');
  const native = selector === '.home-module-tool' ? shell : body;
  const control = f.input; control.focus(); f.trace.length = 0;
  for (let value = 101; value <= 105; value++) {
    f.state.stats.periods.today.totalTokens = f.state.stats.periods.today.clients.codex = value;
    if (value === 103) f.modules = ['model', 'tool', 'trends'];
    f.render();
    assert.ok(f.home.querySelector('.home-module-tool') === shell, 'native shell identity retained');
    assert.ok(shell.querySelector('.home-module-body') === body, 'native body identity retained');
    assert.equal(f.input, control); assert.equal(f.document.activeElement, control);
    assert.equal(control.value, 'draft'); assert.match(body.textContent, new RegExp(String(value)));
  }
  assert.equal(f.mounts, 1); assert.equal(f.disposals, 0);
  assert.deepEqual(f.mutations, []);
  assert.ok(f.trace.every(row => row.connected), 'connected before both geometry reads and author updates');
  assert.equal(shell.listeners.click.length, 1);
  shell.fire('click', { target: shell }); assert.deepEqual(f.navigations, ['tool']);
  assert.equal(native.hidden === true, mode === 'replace');
});

test('period/source changes reach retained controls; deselection reveals current native rows', t => {
  const f = fixture(t); f.render();
  const native = f.home.querySelector('.home-module-body');
  f.state.period = 'month'; f.state.settings.hubMode = 'hub'; f.render();
  assert.equal(f.latest.period, 'month'); assert.equal(f.latest.source, 'hub');
  assert.match(native.textContent, /200/);
  f.views = []; f.render();
  assert.equal(native.hidden, undefined); assert.equal(f.disposals, 1);
  assert.equal(f.home.querySelector('.plugin-content'), null);
  assert.match(f.home.textContent, /200/);
});

test('failed replacement update restores the refreshed native fallback', t => {
  const f = fixture(t); f.render(); f.ready = false;
  f.state.stats.periods.today.clients.codex = 123; f.render();
  const native = f.home.querySelector('.home-module-body');
  assert.match(native.textContent, /123/); assert.equal(native.hidden, undefined);
});

test('pending replacement update retains its shell and ignores stale completions', t => {
  const f = fixture(t); f.ready = null; f.render();
  const first = f.latest.onMountStatus, shell = f.home.querySelector('.home-module-tool');
  f.render(); const native = shell.querySelector('.home-module-body');
  assert.ok(f.home.querySelector('.home-module-tool') === shell, 'pending mount keeps its shell');
  first(true); assert.equal(native.hidden, undefined);
  f.latest.onMountStatus(true); assert.equal(native.hidden, true);
});

test('removing a Home module disposes its outlet; native-only rendering is unchanged', t => {
  const f = fixture(t); f.render(); f.modules = ['model', 'trends']; f.render();
  assert.equal(f.home.querySelector('.home-module-tool'), null); assert.equal(f.disposals, 1);
  const n = fixture(t, 'native'); n.render();
  assert.match(n.home.querySelector('.home-module-tool').textContent, /codex100100/);
  n.state.stats.periods.today.clients.codex = 101; n.render();
  assert.match(n.home.querySelector('.home-module-tool').textContent, /codex101100/);
  assert.equal(n.home.querySelector('.plugin-content'), null); assert.equal(n.mounts, 0);
});

test('Home session clock repaint never replaces a retained shell with itself', () => {
  let callback, replacements = 0;
  const current = { querySelector() { return null; }, replaceWith() { replacements++; } };
  const context = vm.createContext({ state: { stats: {}, settings: {}, breakdown: 'home' },
    document: { activeElement: null }, els: { homePanel: { querySelector: () => current } },
    visibleStatsSurface: () => 'main', homeModulePreferencesApi: { homeModuleCount: () => 5 },
    sessionPresentationOptions: () => ({}), renderHomeSessionModule: () => current,
    window: { TokenMonitorEdgeDockPresentation: { recentSessionRows: () => [{}],
      nextRunningExpiryAt: () => 0, sessionMembers: rows => rows } },
    setTimeout(fn) { callback = fn; return 1; }, clearTimeout() {}
  });
  vm.runInContext(['stopHomeSessionRepaint', 'scheduleHomeSessionRepaint'].map(extract).join('\n'), context);
  context.scheduleHomeSessionRepaint(); callback();
  assert.equal(replacements, 0);
});
