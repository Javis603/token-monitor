'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { placementPatch, placementsFor } = require('../../src/electron/plugins/placementSettings');
const homePrefs = require('../../src/electron/renderer/homeModulePreferences');
const { normalizeEdgeDockItems, itemId } = require('../../src/electron/renderer/edgeDock/items');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const trayLayout = require('../../src/shared/trayLayout');
const { buildNotchData } = require('../../src/electron/notch/data');
const sandbox = require('../../src/electron/plugins/sandbox');

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
  const resolved = trayLayout.resolveTrayLayout(patch.trayCustomLayout, {}, { pluginViews: { [REF]: { status: 'ok', tray: { text: '42%' } } } });
  assert.equal(resolved.items[1].available, true);
  assert.equal(resolved.items[1].plugin.tray.text, '42%');
  const removed = placementPatch({ trayContent: 'custom', ...patch }, { ref: REF, surface: 'tray', placed: false });
  assert.deepEqual(removed.trayCustomLayout.items.map((item) => item.type), ['icon']);
  assert.ok(!trayLayout.STYLE_IDS.includes('plugin'), 'plugin items are placed by the plugin manager, not offered as a composer style');
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

test('the plugin host page admits no network, script or frame sources', () => {
  const csp = sandbox.HOST_CSP;
  for (const directive of ["default-src 'none'", "connect-src 'none'", "script-src 'self'", 'worker-src blob:', "frame-src 'none'", "img-src 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!/unsafe-(eval|inline)/.test(csp));
  assert.equal(sandbox.requestAllowed('tm-plugin://demo/host.html'), true);
  assert.equal(sandbox.requestAllowed('tm-plugin://demo/../../etc/passwd'), false);
  assert.equal(sandbox.requestAllowed('tm-plugin://demo/manifest.json'), false);
  assert.equal(sandbox.requestAllowed('blob:tm-plugin://demo/123'), true);
  for (const url of ['https://example.com/', 'http://127.0.0.1:17321/api/stats', 'file:///etc/passwd', 'data:text/html,x', 'ws://localhost:1']) {
    assert.equal(sandbox.requestAllowed(url), false, url);
  }
});

test('plugin host windows are Chromium-sandboxed with no Node in page or workers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/sandbox.js'), 'utf8');
  for (const option of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'nodeIntegrationInWorker: false', 'webviewTag: false', 'backgroundThrottling: false']) {
    assert.ok(source.includes(option), option);
  }
  assert.match(source, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
  assert.match(source, /webContents\.ipc\.on\('plugin-host:message'/, 'messages are bound to the sending webContents');
  const worker = sandbox.workerSource('tm.log(1);');
  assert.match(worker, /\(function pluginMain\(\) \{\ntm\.log\(1\);\n\}\)\.call\(self\);/);
});


test('Edge Dock omits inactive plugin cells while retaining their saved placements', () => {
  const items = [{ type: 'stat', metric: 'liveRate' }, { type: 'plugin', ref: REF }];
  const before = JSON.stringify(items);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [REF] }).some(c => c.kind === 'plugin'), true);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [] }).some(c => c.kind === 'plugin'), false);
  assert.equal(buildEdgeDockCells({}, { items, availablePluginRefs: [REF] }).some(c => c.kind === 'plugin'), true);
  assert.equal(JSON.stringify(items), before);
});
