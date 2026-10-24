'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.TM_APP_SOURCE || require.resolve('../../src/electron/renderer/app.js'), 'utf8');
function body(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, name); return match[0];
}
function fixture(list) {
  const state = { breakdown: 'plugin:demo/page', pluginCatalog: null };
  const context = { state, pluginBridge: { list },
    applyPluginCatalog: value => { state.pluginCatalog = value; context.ensureBreakdownVisible(); return value; },
    pluginPageOptions: () => (state.pluginCatalog?.plugins || []).flatMap(p => p.pages || []),
    pluginPlacementsApi: { isHomeToken: value => value.startsWith('plugin:') },
    availableBreakdownIds: () => ['model'], directBreakdownOverride: null,
    viewDisplayPreferencesApi: { preferredViewId: () => 'model' }, VIEW_DISPLAY_OPTIONS: [],
    effectiveViewDisplayOrderValue: () => [], setBreakdown: value => { state.breakdown = value; } };
  vm.createContext(context);
  const loader = source.includes('async function loadPluginCatalog(') ? body('loadPluginCatalog')
    : `async function loadPluginCatalog() { return (${source.match(/list: (async \(\) => applyPluginCatalog\(await pluginBridge\.list\(\)\))/)[1]})(); }`;
  vm.runInContext(body('ensureBreakdownVisible') + loader, context);
  return context;
}
test('failed initial catalog releases the restored plugin page and later success recovers', async () => {
  let failed = true;
  const h = fixture(async () => { if (failed) throw new Error('No handler registered'); return { plugins: [{ pages: [{ id: 'plugin:demo/page' }] }] }; });
  h.ensureBreakdownVisible(); assert.equal(h.state.breakdown, 'plugin:demo/page');
  await assert.rejects(h.loadPluginCatalog(), /No handler/);
  assert.equal(h.state.breakdown, 'model'); assert.deepEqual(Array.from(h.state.pluginCatalog.plugins), []);
  failed = false; await h.loadPluginCatalog();
  h.state.breakdown = 'plugin:demo/page'; h.ensureBreakdownVisible();
  assert.equal(h.state.breakdown, 'plugin:demo/page');
});
test('a transient refresh failure retains a successfully loaded catalog', async () => {
  const h = fixture(async () => { throw new Error('temporary'); });
  const catalog = { plugins: [{ pages: [{ id: 'plugin:demo/page' }] }] };
  h.state.pluginCatalog = catalog;
  await assert.rejects(h.loadPluginCatalog(), /temporary/);
  assert.equal(h.state.pluginCatalog, catalog); assert.equal(h.state.breakdown, 'plugin:demo/page');
});

test('ordinary App rendering projects rows only for an active matching page design', () => {
  let reads = 0, received;
  const h = { state: { breakdown: 'model', period: 'today', stats: { periods: { today: {} } }, floatingBubble: {} },
    renderAppContent() {}, pluginPageDesigns: { render: input => { received = input; } },
    visibleStatsSurface: () => 'main', isSettingsPanelOpen: () => false, isRendererWindowHidden: () => false,
    prefersReducedMotion: () => false, rowsForPeriod: () => { reads++; return [{ name: 'A', value: 42, cost: 1 }]; } };
  vm.createContext(h); vm.runInContext(body('render'), h);
  for (const catalog of [null, { plugins: [] }, { plugins: [{ status: 'disabled', webDocuments: [{ target: 'model' }] }] },
    { plugins: [{ status: 'active', webDocuments: [{ target: 'tool' }] }] }]) {
    h.state.pluginCatalog = catalog; h.render(); assert.equal(reads, 0); assert.equal(received.snapshot.rows.length, 0);
  }
  h.state.pluginCatalog = { plugins: [{ status: 'active', webDocuments: [{ target: 'model' }] }] };
  h.render(); assert.equal(reads, 1); assert.equal(received.snapshot.rows[0].tokens, 42);
});
