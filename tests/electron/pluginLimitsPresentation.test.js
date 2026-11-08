'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectPluginLimits } = require('../../src/electron/plugins/limitsPresentation');
const items = require('../../src/electron/renderer/edgeDock/items');
const dock = require('../../src/electron/renderer/edgeDock/presentation');
const tray = require('../../src/shared/trayLayout');
const { buildNotchData } = require('../../src/electron/notch/data');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');
const id = 'plugin:sample-plugin:credits';
const moduleInfo = { id, label: 'API pool', presentation: { icon: { native: 'codex' }, color: { palette: 'codex' } } };
const reading = { provider: id, status: 'ok', windows: [{ kind: 'billing', metric: 'credits', remaining: 80, limit: 100, currency: 'USD', remainingPercent: 80, usedPercent: 20 }] };
const snapshot = { modules: [moduleInfo], providers: [reading] };
const base = () => ({ periods: {}, limits: { providers: [{ provider: 'claude', status: 'ok', windows: [] }] } });
test('desktop projection is immutable, repeatable and drops inactive readings without extending wire providers', () => {
  const raw = base(), before = structuredClone(raw);
  const shown = projectPluginLimits(raw, snapshot);
  assert.deepEqual(raw, before);
  assert.deepEqual(projectPluginLimits(shown, snapshot), shown);
  assert.equal(shown.limits.providers[1].pluginQuota.label, 'API pool');
  assert.deepEqual(projectPluginLimits(shown, { modules: [], providers: [reading] }).limits.providers, raw.limits.providers);
  assert.equal(normalizeLimitProvider(reading), null);
});
test('native dock and Notch share module money, identity and presentation while disabled references stay out', () => {
  const stats = projectPluginLimits(base(), snapshot);
  const configured = items.normalizeEdgeDockItems([{ type: 'limit', provider: id }]);
  assert.equal(configured[0].provider, id);
  const cells = dock.buildEdgeDockCells(stats, { items: configured });
  assert.equal(cells[0].pluginQuota.label, 'API pool');
  assert.deepEqual(cells[0].pluginQuota.presentation, moduleInfo.presentation);
  assert.equal(cells[0].accounts[0].record.windows[0].remaining, 80);
  const notch = buildNotchData(stats, cells, { notchSummaryMode: 'custom', notchCustomLayout: { items: [{ type: 'icon', icon: 'provider', autoMode: 'lowestLimit', source: { provider: id } }] } });
  assert.equal(notch.cells[0].provider, id);
  assert.equal(notch.summary.items[0].providerCell.pluginQuota.label, 'API pool');
  const inactive = projectPluginLimits(stats, { modules: [], providers: [] });
  assert.deepEqual(dock.buildEdgeDockCells(inactive, { items: configured }), []);
  assert.equal(configured[0].provider, id, 'saved configuration is retained');
});
test('maximum-length module identities and hidden windows survive native surface persistence', () => {
  const longId = `plugin:${'p'.repeat(40)}:${'m'.repeat(32)}`;
  assert.equal(longId.length, 80);
  assert.equal(items.normalizeEdgeDockItems([{ type: 'limit', provider: longId }])[0].provider, longId);
  const layout = tray.normalizeTrayLayout({ items: [{ type: 'text', metric: 'percent', source: { provider: longId } }] });
  assert.equal(layout.items[0].source.provider, longId);
  assert.equal(tray.resolveTrayLayout(layout, { limits: { providers: [{ ...reading, provider: longId }] } }).items[0].available, true);
  const usage = require('../../src/shared/limits/usageItems');
  const hidden = usage.normalizeLimitProviderHiddenItems({ [longId]: ['credits'] });
  assert.ok(hidden[longId]);
});
test('quota demand distinguishes custom quota sources from usage-only layouts', () => {
  const uses = item => tray.usesLimits(tray.normalizeTrayLayout({ items: [item] }));
  assert.equal(uses({ type: 'text', metric: 'tokens' }), false);
  assert.equal(uses({ type: 'text', metric: 'custom', text: 'Hello' }), false);
  assert.equal(uses({ type: 'icon', icon: 'provider', autoMode: 'tokens' }), false);
  assert.equal(uses({ type: 'icon', icon: 'provider', autoMode: 'lowestLimit', source: { provider: id } }), false);
  assert.equal(uses({ type: 'icon', icon: 'provider', autoMode: 'lowestLimit', source: { provider: 'auto' } }), true);
  assert.equal(uses({ type: 'stack', metric: 'mixed', rows: [{ metric: 'cost' }, { metric: 'tokens' }] }), false);
  assert.equal(uses({ type: 'stack', metric: 'mixed', rows: [{ metric: 'cost' }, { metric: 'percent' }] }), true);
  assert.equal(uses({ type: 'bars', rows: [{ provider: id }] }), true);
});
test('native demand follows Tray, rail and Notch page/summary visibility independently', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const fn = source.match(/function syncPluginQuotaSurfaceDemand\([^]*?\n}/)[0];
  const calls = [], visibility = { panel: false, summary: true };
  const settings = { limitsEnabled: true, trayContent: 'tokens', notchSummaryMode: 'sessions' };
  let dockVisible = false;
  const context = vm.createContext({ settings, pluginRuntime: { demandLimits: (...args) => calls.push(args) }, trayLayoutApi: tray,
    notchSummaryMode: s => s.notchSummaryMode, notchSummaryLayout: s => s.notchCustomLayout,
    notchController: { quotaVisibility: () => visibility }, edgeDockController: { limitsVisible: () => dockVisible } });
  vm.runInContext(fn, context);
  const run = expected => { context.syncPluginQuotaSurfaceDemand(); assert.deepEqual(calls.at(-1), [expected, 'desktop.native']); };
  run(false); visibility.panel = true; run(true); visibility.panel = false;
  settings.notchSummaryMode = 'custom'; settings.notchCustomLayout = { items: [{ type: 'text', metric: 'percent' }] }; run(true);
  visibility.summary = false; run(false);
  dockVisible = true; settings.edgeDockItems = null; run(true);
  settings.edgeDockItems = [{ type: 'stat', metric: 'today' }]; run(false);
  settings.trayContent = 'bars'; run(true); settings.showTrayIcon = false; run(false);
  settings.showTrayIcon = true; settings.limitsEnabled = false; run(false);
});
test('display preview reuses retained module identity and balances without collecting or mutating them', () => {
  const { buildDisplayPreview } = require('../../src/electron/displayPreview');
  const before = structuredClone(snapshot);
  const preview = buildDisplayPreview({ edgeDockItems: [{ type: 'limit', provider: id }] }, 'edgeDock', 'open', 'darwin', Date.now(), null, snapshot);
  assert.equal(preview.payload.cells[0].pluginQuota.label, 'API pool');
  assert.equal(preview.payload.cells[0].accounts[0].record.windows[0].remaining, 80);
  assert.deepEqual(snapshot, before);
  const disabled = buildDisplayPreview({ edgeDockItems: [{ type: 'limit', provider: id }] }, 'edgeDock', 'open', 'darwin', Date.now(), null, { modules: [], providers: [reading] });
  assert.deepEqual(disabled.payload.cells, []);
});
test('renderer Tray picker retains inactive source labels while the desktop readings omit that module', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const state = { stats: base(), pluginCatalog: { plugins: [{ id: 'sample-plugin', status: 'disabled', limits: [{ id: 'credits', name: 'API pool' }] }], limits: { modules: [], providers: [reading] } } };
  const context = vm.createContext({ state, LIMIT_PROVIDERS: [{ id: 'claude', label: 'Claude' }], trayLayoutApi: tray,
    t: key => key, trayComposerProviderIcon: () => '' });
  for (const name of ['pluginLimitMetadata', 'desktopLimitProviders', 'desktopLimitRecords', 'desktopSurfaceStats', 'trayComposerProviderChoices']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0], context);
  }
  assert.equal(context.desktopSurfaceStats().limits.providers.some(row => row.provider === id), false);
  const retained = context.trayComposerProviderChoices([id]).find(row => row.value === id);
  assert.equal(retained.label, 'API pool');
  assert.equal(retained.detail, 'trayComposer.provider.unavailable');
  assert.equal(context.trayComposerProviderChoices([]).some(row => row.value === id), false);
});
