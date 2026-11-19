'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { placementPatch, placementsFor } = require('../../src/electron/plugins/placementSettings');
const homePrefs = require('../../src/electron/renderer/homeModulePreferences');
const { normalizeEdgeDockItems, itemId } = require('../../src/electron/renderer/edgeDock/items');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const trayLayout = require('../../src/shared/trayLayout');
const { buildNotchData } = require('../../src/electron/notch/data');

const BUILTINS = ['limits', 'tool', 'model', 'session', 'device', 'trends'].map((id) => ({ id }));
const REF = 'system-monitor/cpu';

test('Home keeps plugin entries in the stored order even when main does not know them', () => {
  const order = homePrefs.normalizeHomeModuleOrder('limits,plugin:system-monitor/cpu,tool,plugin:bad id,plugin:gone/view', BUILTINS);
  assert.deepEqual(order, ['limits', 'plugin:system-monitor/cpu', 'tool', 'plugin:gone/view', 'model', 'session', 'device', 'trends']);
  const hidden = homePrefs.normalizeHiddenHomeModules('limits,tool,model,session,device,trends,plugin:gone/view', BUILTINS);
  assert.equal(hidden, 'plugin:gone/view', 'hiding every built-in still resets them, plugin entries survive');
});

test('placing on Home appends once and unhides; removing drops the entry', () => {
  const settings = { homeModuleOrder: 'limits,tool', hiddenHomeModules: `tool,plugin:${REF}` };
  const placed = placementPatch(settings, { ref: REF, surface: 'home', placed: true });
  assert.deepEqual(placed, { homeModuleOrder: `limits,tool,plugin:${REF}`, hiddenHomeModules: 'tool' });
  assert.equal(placementsFor({ ...settings, ...placed }, REF).home, true);
  const again = placementPatch({ ...settings, ...placed }, { ref: REF, surface: 'home', placed: true });
  assert.equal(again.homeModuleOrder, `limits,tool,plugin:${REF}`);
  assert.deepEqual(placementPatch({ ...settings, ...placed }, { ref: REF, surface: 'home', placed: false }).homeModuleOrder, 'limits,tool');
});

test('placing on the Edge Dock materialises the automatic list and adds a plugin cell', () => {
  const patch = placementPatch({ edgeDockItems: null }, { ref: REF, surface: 'edgeDock', placed: true }, { defaultEdgeDockProviders: ['claude', 'codex'] });
  assert.deepEqual(patch.edgeDockItems.map(itemId), ['limit:claude', 'limit:codex', `plugin:${REF}`]);
  assert.deepEqual(normalizeEdgeDockItems([...patch.edgeDockItems, { type: 'plugin', ref: '../x' }]).map(itemId), ['limit:claude', 'limit:codex', `plugin:${REF}`]);
  const cells = buildEdgeDockCells({ periods: {} }, { items: patch.edgeDockItems, limitsEnabled: false });
  assert.deepEqual(cells.map((cell) => [cell.id, cell.kind]), [[`plugin:${REF}`, 'plugin']]);
});

test('placing on the tray turns the current preset into a custom layout plus the plugin item', () => {
  const preset = trayLayout.createDefaultTrayLayout();
  const patch = placementPatch({ trayContent: 'tokens' }, { ref: REF, surface: 'tray', placed: true }, { trayPresetLayout: preset });
  assert.equal(patch.trayContent, 'custom');
  assert.deepEqual(patch.trayCustomLayout.items.map((item) => item.type), ['icon', 'plugin']);
  assert.deepEqual(trayLayout.trayLayoutPluginRefs(patch.trayCustomLayout), [REF]);
  const resolved = trayLayout.resolveTrayLayout(patch.trayCustomLayout, {}, { pluginViews: { [REF]: { status: 'active', tray: { text: '42%' } } } });
  assert.equal(resolved.items[1].available, true);
  assert.equal(resolved.items[1].plugin.tray.text, '42%');
  const removed = placementPatch({ trayContent: 'custom', ...patch }, { ref: REF, surface: 'tray', placed: false });
  assert.deepEqual(removed.trayCustomLayout.items.map((item) => item.type), ['icon']);
  assert.ok(!trayLayout.STYLE_IDS.includes('plugin'), 'plugin choices come from installed views, not a static native style');
});

test('Notch selection is independent of visible tab capacity and preserves built-in choices', () => {
  let settings = { notchPluginPages: [] };
  for (const ref of ['a1/v', 'b1/v', 'c1/v', 'd1/v', 'e1/v', 'f1/v', 'g1/v']) settings = { ...settings, ...placementPatch(settings, { ref, surface: 'notch', placed: true }) };
  settings.notchBuiltinPages = ['limits', 'sessions'];
  const data = buildNotchData({ periods: {} }, [], { ...settings, notchSummaryEnabled: false });
  assert.deepEqual(data.panel.builtinPages, ['limits', 'sessions']);
  assert.deepEqual(data.panel.pluginPages, ['a1/v', 'b1/v', 'c1/v', 'd1/v', 'e1/v', 'f1/v', 'g1/v']);
  assert.deepEqual(buildNotchData({ periods: {} }, [], { ...settings, notchSummaryEnabled: false, pluginsEnabled: false }).panel.pluginPages, []);
});

test('Edge Dock omits inactive plugin cells while retaining their saved placements', () => {
  const items = [{ type: 'stat', metric: 'liveRate' }, { type: 'plugin', ref: REF }];
  const before = JSON.stringify(items);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [REF] }).some(c => c.kind === 'plugin'), true);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [] }).some(c => c.kind === 'plugin'), false);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [REF] }).some(c => c.kind === 'plugin'), true);
  assert.equal(JSON.stringify(items), before);
});

test('uninstall removes only owned compact items and page-order tokens, without materializing absent settings', () => {
  const { removePluginPlacements } = require('../../src/electron/plugins/placementSettings');
  const layout = {version:1,items:[trayLayout.createTrayLayoutItem('appIcon',{idFactory:()=> 'native'}),trayLayout.createTrayLayoutItem('plugin',{ref:REF,idFactory:()=> 'owned'}),trayLayout.createTrayLayoutItem('plugin',{ref:'other/panel',idFactory:()=> 'other'})]};
  const settings = {floatingBubbleCustomLayout:layout,notchCustomLayout:layout,notchPageOrder:['home',`plugin:${REF}`,'plugin:other/panel','limits']};
  const result = removePluginPlacements(settings,'system-monitor');
  for (const key of ['floatingBubbleCustomLayout','notchCustomLayout']) assert.deepEqual(result[key].items.map(item=>item.id),['native','other']);
  assert.deepEqual(result.notchPageOrder,['home','plugin:other/panel','limits']);
  assert.equal(settings.floatingBubbleCustomLayout.items.length,3);
  const absent=removePluginPlacements({},'system-monitor');
  for (const key of ['floatingBubbleCustomLayout','notchCustomLayout','notchPageOrder']) assert.equal(Object.hasOwn(absent,key),false);
});
