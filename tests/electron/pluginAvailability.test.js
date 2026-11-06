'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const trayLayout = require('../../src/shared/trayLayout');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const root = path.join(__dirname, '../../src/electron');
const ref = 'system-monitor/cpu';
function source(file, from, to) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert.ok(start >= 0 && end > start); return text.slice(start, end);
}
test('production Dock projection removes disabled, missing and master-off views without changing saved items', () => {
  const plugin = { status: 'active', views: [{ ref, surfaces: ['edgeDock'] }] };
  const settings = { edgeDockItems: [{ type: 'plugin', ref }] }, before = JSON.stringify(settings);
  const context = { settings, pluginRuntime: { manager: { list: () => { throw new Error('full catalog must not be described on stats push'); }, surfaceCatalog: surface => plugin.status === 'active' ? plugin.views.filter(view => view.surfaces.includes(surface)) : [] } }, buildEdgeDockCells,
    refreshEdgeDockDerivedPeriods() {}, refreshEdgeDockForecast() {}, syncCodexPresentationActiveAccount() {},
    edgeDockDerivedPeriods: {}, edgeDockForecastWanted: () => false, syncProvenanceActive: () => false,
    codexAccountsForRenderer: () => [], codexPresentationPendingAccountId: '', codexPresentationActiveAccountId: '',
    edgeDockLiveRateSample: () => ({}) };
  vm.createContext(context);
  vm.runInContext(source('main.js', 'function edgeDockCellsFor(', '\nfunction updateEdgeDockCells('), context);
  const cells = () => context.edgeDockCellsFor({});
  assert.equal(cells().length, 1);
  for (const status of ['disabled', 'pluginsOff', 'safeMode', 'crashed']) {
    plugin.status = status; assert.deepEqual(cells(), []);
  }
  plugin.status = 'active'; assert.equal(cells().length, 1);
  plugin.views = []; assert.deepEqual(cells(), []);
  assert.equal(JSON.stringify(settings), before);
});
test('production Tray bitmap omits inactive plugin placeholders and restores enabled content', () => {
  const view = { status: 'active', tray: { text: '42%' } }, rendered = [];
  const layout = { version: trayLayout.VERSION, items: [{ id: 'plugin-cell', type: 'plugin', ref }] };
  const context = { state: { settings: {} }, localLiveCodexProvider: () => null, trayLayoutApi: trayLayout,
    currentCurrency: () => 'USD', compactTokenDisplayOptions: () => ({}), trayProviderImages: {},
    displayLiveTokenRateSamples: () => ({}), pluginTrayViews: () => ({ [ref]: view }),
    renderCustomTrayItemCanvas: item => { rendered.push(item); return { width: 20 }; },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'bitmap' }) } };
  vm.createContext(context);
  vm.runInContext(source('renderer/app.js', 'function renderCustomTrayLayout(', '\nfunction barsDataUrlForMode('), context);
  assert.equal(context.renderCustomTrayLayout({}, layout), 'bitmap'); assert.equal(rendered.length, 1);
  for (const status of ['disabled', 'pluginsOff', 'safeMode', 'missing', 'error']) {
    view.status = status; rendered.length = 0;
    assert.equal(context.renderCustomTrayLayout({}, layout), null); assert.equal(rendered.length, 0);
  }
  view.status = 'active'; assert.equal(context.renderCustomTrayLayout({}, layout), 'bitmap');
  assert.equal(rendered.length, 1); assert.equal(layout.items[0].ref, ref);
});

test('Notch stats projection reads only active surface metadata and preserves saved selections', () => {
  let available = [{ ref, title: 'CPU', icon: 'activity' }], result;
  const context = { settings: {}, pluginRuntime: { manager: { list() { throw new Error('full catalog on stats push'); }, surfaceCatalog: surface => { assert.equal(surface, 'notch'); return available; } } },
    edgeDockCellsFor: () => [], notchPanelItems: () => [], notchDataFor: () => ({ panel: { pluginPages: [ref, 'missing/view'] } }),
    notchHistory: { read: () => null }, hubModeGeneration: 0, notchController: { setData: data => { result = data; } }, scheduleSessionExpiry() {} };
  vm.createContext(context);
  vm.runInContext('let notchLastCells;\n' + source('main.js', 'function pushNotchCells(', '\n// The soonest'), context);
  context.pushNotchCells({});
  assert.equal(JSON.stringify(result.panel.pluginPages), JSON.stringify([ref]));
  assert.equal(result.panel.pluginCatalog[ref].title, 'CPU');
  available = []; context.pushNotchCells({});
  assert.equal(result.panel.pluginPages.length, 0);
});
