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
function iconDeliveryFixture(load) {
  const id = 'plugin:synthetic-limits:credits';
  const context = { state: { settings: {}, pluginCatalog: { limits: { modules: [] } } },
    window: { tokenMonitor: { setTrayIcons: async () => {} }, TokenMonitorTrayProviderIcons: { trayProviderIconSources: () => ({}) } },
    trayProviderIconDeliveryGuard: require('../../src/electron/renderer/trayProviderIcons').createTrayProviderIconDeliveryGuard(),
    trayIconProviderIds: [], trayProviderImages: {}, trayProviderImageIds: new WeakMap(),
    loadImage: path => path.startsWith('../../../') ? Promise.resolve({}) : load(path),
    providerImageToPngDataUrl: () => 'bitmap', maybeUpdateBarsIcon() {}, renderFloatingBubbleContent() {} };
  vm.createContext(context);
  vm.runInContext(source('renderer/app.js', 'async function deliverTrayProviderIcons(', '\nfunction setAccountGroupExpanded('), context);
  return { id, context, setIcon(data) { context.state.pluginCatalog.limits.modules = [{ id, presentation: { icon: { data } } }]; }, deliver: () => context.deliverTrayProviderIcons() };
}
test('plugin icon replacement failure and removal discard the previous cached image', async () => {
  const image = {};
  const f = iconDeliveryFixture(async path => { if (path === 'broken') throw Error('decode'); return image; });
  f.setIcon('valid'); await f.deliver();
  assert.equal(f.context.trayProviderImages[f.id], image);
  f.setIcon('broken'); await f.deliver();
  assert.equal(f.context.trayProviderImages[f.id], undefined);
  f.setIcon('valid'); await f.deliver();
  f.setIcon(undefined); await f.deliver();
  assert.equal(f.context.trayProviderImages[f.id], undefined, 'an active module can remove its icon');
  assert.ok(f.context.trayProviderImages.app, 'builtin icon delivery remains intact');
});
test('an obsolete failed icon delivery cannot delete a newer successfully cached image', async () => {
  let rejectOld, started;
  const loading = new Promise(resolve => { started = resolve; });
  const latest = {};
  const f = iconDeliveryFixture(path => path === 'old' ? new Promise((_, reject) => { rejectOld = reject; started(); }) : Promise.resolve(latest));
  f.setIcon('old'); const oldDelivery = f.deliver(); await loading;
  f.setIcon('new'); await f.deliver();
  rejectOld(Error('late decode failure')); await oldDelivery;
  assert.equal(f.context.trayProviderImages[f.id], latest);
});
test('production Dock projection removes disabled, missing and master-off views without changing saved items', () => {
  const plugin = { status: 'active', views: [{ ref, surfaces: ['edgeDock'] }] };
  const settings = { edgeDockItems: [{ type: 'plugin', ref }] }, before = JSON.stringify(settings);
  const context = { settings, desktopQuotaStats: s => s, pluginRuntime: { manager: { list: () => { throw new Error('full catalog must not be described on stats push'); }, surfaceCatalog: surface => plugin.status === 'active' ? plugin.views.filter(view => view.surfaces.includes(surface)) : [] } }, buildEdgeDockCells,
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

test('fixed plugin quota icons disappear from native bitmaps and Notch while their saved source survives', () => {
  const id = 'plugin:sample-plugin:credits';
  const layout = trayLayout.normalizeTrayLayout({ items: [{ type: 'icon', icon: 'provider', source: { provider: id } }] });
  const saved = JSON.stringify(layout), rendered = [];
  const context = { state: { settings: {} }, localLiveCodexProvider: () => null, trayLayoutApi: trayLayout,
    currentCurrency: () => 'USD', compactTokenDisplayOptions: () => ({}), trayProviderImages: {},
    displayLiveTokenRateSamples: () => ({}), pluginTrayViews: () => ({}),
    renderCustomTrayItemCanvas: item => { rendered.push(item); return { width: 20 }; },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'bitmap' }) } };
  vm.createContext(context);
  vm.runInContext(source('renderer/app.js', 'function renderCustomTrayLayout(', '\nfunction barsDataUrlForMode('), context);
  const notch = require('../../src/electron/notch/data');
  const stats = { pluginLimitModules: [{ id, label: 'Credits' }], limits: { providers: [] } };
  const settings = { notchSummaryMode: 'custom', notchCustomLayout: layout };
  const assertShown = shown => {
    rendered.length = 0;
    assert.equal(context.renderCustomTrayLayout(stats, layout), shown ? 'bitmap' : null);
    assert.equal(rendered.length, shown ? 1 : 0);
    const summary = notch.buildNotchData(stats, [], settings).summary;
    assert.equal(summary?.items?.length || 0, shown ? 1 : 0);
    assert.equal(JSON.stringify(layout), saved);
    assert.equal(trayLayout.usesLimits(layout), false, 'fixed icons never start quota sampling');
  };
  assertShown(true); // Active metadata is sufficient, with no reading or cached image.
  stats.pluginLimitModules = []; assertShown(false); // Disabled/removed.
  stats.pluginLimitModules = [{ id, label: 'Credits' }]; assertShown(true);
});

test('Notch stats projection reads only active surface metadata and preserves saved selections', () => {
  let available = [{ ref, title: 'CPU', icon: 'activity' }], result;
  const context = { settings: {}, desktopQuotaStats: s => s, pluginRuntime: { manager: { list() { throw new Error('full catalog on stats push'); }, surfaceCatalog: surface => { assert.equal(surface, 'notch'); return available; } } },
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
