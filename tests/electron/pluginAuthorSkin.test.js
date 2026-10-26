'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { normalizeAppearance, OPTIONS } = require('../../src/shared/plugins/appearance');
const { persistSettingsAndCredentials, writePrivateJsonAtomic } = require('../../src/shared/credentialStore');
const root = path.resolve(__dirname, '../..');
function read(relative) { return fs.readFileSync(process.env.TM_SKIN_BASE ? path.join(process.env.TM_SKIN_BASE, path.basename(relative)) : path.join(root, relative), 'utf8'); }
const main = read('src/electron/main.js');
const runtimeSource = read('src/electron/plugins/runtime.js');
function extract(source, name) {
  let found;
  const walk = node => {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'FunctionDeclaration' && node.id.name === name) { found = source.slice(...node.range); return; }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else walk(value);
  };
  walk(espree.parse(source, { ecmaVersion: 'latest', range: true }));
  assert.ok(found, `production function ${name}`); return found;
}
function helpers(extra = {}) {
  const ctx = { normalizeAppearance, ...extra }; vm.createContext(ctx);
  vm.runInContext(extract(runtimeSource, 'normalizePluginAuthorSkin') + '\n' + extract(main, 'preparePluginSkinSettings') + '\n' + extract(main, 'assertPluginSkinRequest'), ctx);
  return ctx;
}
const tokens = { font: 'mono', density: 'comfortable', corners: 'soft', panel: 'outline', colors: { accent: '#123456', chart: '#234567', text: '#345678', muted: '#456789', background: '#56789a' } };
const plain = value => JSON.parse(JSON.stringify(value));
test('selection resolves host palette and all tokens; style-only selection and copied defaults work', () => {
  const h = helpers(); const current = { themeColors: { chart: '#abcdef' }, vendorColors: { existing: '#123456' } };
  const skin = { ref: 'author/mono', colors: { accent: '#654321' }, vendorColors: { custom: '#abcdef' }, appearance: tokens };
  const runtime = { resolveSkin: ref => { assert.equal(ref, skin.ref); return skin; } };
  const result = h.preparePluginSkinSettings({ pluginSkinRef: skin.ref }, current, runtime);
  assert.deepEqual(plain(result.authorSkin), { ref: skin.ref, appearance: tokens });
  assert.deepEqual(plain(result.patch), { themeColors: { chart: '#abcdef', accent: '#654321' }, vendorColors: { existing: '#123456', custom: '#abcdef' } });
  delete skin.colors; delete skin.vendorColors;
  assert.deepEqual(plain(h.preparePluginSkinSettings({ pluginSkinRef: skin.ref }, current, runtime).patch), current);
  delete skin.appearance;
  assert.deepEqual(plain(h.preparePluginSkinSettings({ pluginSkinRef: skin.ref }, current, runtime).authorSkin.appearance), normalizeAppearance());
});
test('protected snapshot cannot be forged; command is standalone and main-frame-only', () => {
  const sender = { mainFrame: {} }, mainWindow = { webContents: null, isDestroyed: () => false }; mainWindow.webContents = sender;
  const h = helpers({ mainWindow }); const event = { sender, senderFrame: sender.mainFrame };
  h.assertPluginSkinRequest(event, { pluginSkinRef: 'author/mono' });
  h.assertPluginSkinRequest(event, { pluginSkinRef: null, themeColors: {} });
  assert.throws(() => h.assertPluginSkinRequest(event, { pluginSkinRef: null, vendorColors: {} }), /standalone/);
  assert.throws(() => h.assertPluginSkinRequest({ sender: {}, senderFrame: {} }, { pluginSkinRef: null, themeColors: {} }), /main window/);
  for (const patch of [{ pluginAuthorSkin: null }, { pluginAuthorSkin: { ref: 'author/mono', appearance: tokens } }, { pluginSkinRef: 'author/mono', themeColors: {} }]) {
    assert.throws(() => h.assertPluginSkinRequest(event, patch));
    assert.throws(() => h.preparePluginSkinSettings(patch, {}, {}));
  }
  for (const bad of [{ sender, senderFrame: {} }, { sender: { mainFrame: {} }, senderFrame: {} }]) assert.throws(() => h.assertPluginSkinRequest(bad, { pluginSkinRef: 'author/mono' }), /main window/);
  assert.throws(() => h.preparePluginSkinSettings({ pluginSkinRef: 'missing/mono' }, {}, null), /unavailable/);
});
test('load/read normalization retains only valid copied author tokens and drops command input', () => {
  const h = helpers(); const value = { ref: 'author/mono', appearance: { ...tokens, css: 'bad' }, extra: 'bad' };
  assert.deepEqual(plain(h.normalizePluginAuthorSkin(value)), { ref: value.ref, appearance: tokens });
  for (const input of [null, {}, { ref: '../bad', appearance: tokens }, { ref: value.ref, appearance: { font: 'url(bad)' } }]) assert.equal(h.normalizePluginAuthorSkin(input), null);
  // Execute the real load-time statements, not a reconstructed migration.
  const load = extract(main, 'readSettings');
  const lines = load.split('\n').filter(line => /merged\.pluginAuthorSkin|delete merged\.pluginSkinRef/.test(line));
  assert.equal(lines.length, 2);
  h.merged = { pluginAuthorSkin: value, pluginSkinRef: 'untrusted/command' };
  vm.runInContext(lines.join('\n'), h);
  assert.deepEqual(plain(h.merged), { pluginAuthorSkin: { ref: value.ref, appearance: tokens } });
  assert.match(extract(main, 'settingsForRenderer'), /pluginAuthorSkin = normalizePluginAuthorSkin/);
});
test('actual settings candidate and saveSettings rollback commit palette + snapshot together', t => {
  const h = helpers(); const old = { themeColors: { accent: '#000000' }, pluginAuthorSkin: null, syncContentState: {} };
  const selection = h.preparePluginSkinSettings({ pluginSkinRef: 'author/mono' }, old, { resolveSkin: () => ({ ref: 'author/mono', colors: { accent: '#ffffff' }, appearance: tokens }) });
  const apply = extract(main, 'applySettingsPatch');
  assert.match(apply, /const skinSelection = preparePluginSkinSettings\(patch, settings, pluginRuntime\)/);
  const assignment = apply.match(/pluginAuthorSkin: skinSelection\.authorSkin,/); assert.ok(assignment);
  const start = apply.indexOf('    const nextSettingsState = settings;');
  const end = apply.indexOf('    contentRuntime.invalidate();', start); assert.ok(start >= 0 && end > start);
  const transaction = apply.slice(start, end);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-preset-save-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'); writePrivateJsonAtomic(file, old);
  let fail = true; const writes = [];
  Object.assign(h, { settings: structuredClone(old), previousSettingsState: structuredClone(old), persistedSettingsSnapshot: structuredClone(old),
    cloneSettingsSnapshot: structuredClone, normalizeSyncContentState: value => value || {}, syncContentContext: value => value,
    contentRuntime: { beforeDestinationChange() {} }, ensureCredentialStore: () => ({ readDocument: () => ({}), replaceSettingsCredentials() {}, writeDocument() {} }), settingsPath: file, refreshTrayContextMenu() {}, reportCredentialStorageError() {},
    persistSettingsAndCredentials: args => persistSettingsAndCredentials({ ...args, writeSettings: (target, value) => { if (fail) throw Error('disk full'); writePrivateJsonAtomic(target, value); writes.push(structuredClone(value)); } }) });
  vm.runInContext(extract(main, 'saveSettings'), h);
  h.skinSelection = selection; h.normalizedPatch = selection.patch;
  const candidate = `settings = { ...previousSettingsState, ...normalizedPatch, ${assignment[0]} };`;
  assert.throws(() => vm.runInContext(`{ ${candidate} ${transaction} }`, h), /disk full/);
  assert.deepEqual(plain(h.settings), old); assert.equal(writes.length, 0); assert.deepEqual(JSON.parse(fs.readFileSync(file)), old);
  fail = false; vm.runInContext(`{ ${candidate} ${transaction} }`, h);
  assert.equal(writes.length, 1); assert.equal(writes[0].themeColors.accent, '#ffffff'); assert.deepEqual(plain(writes[0].pluginAuthorSkin.appearance), tokens);
  assert.equal(Object.hasOwn(writes[0], 'pluginSkinRef'), false);
  const restarted = JSON.parse(fs.readFileSync(file)); assert.deepEqual(plain(h.normalizePluginAuthorSkin(restarted.pluginAuthorSkin)), plain(selection.authorSkin));
});
test('actual settings IPC revalidates sender and active selection after async publication', async () => {
  const start = main.indexOf("ipcMain.handle('settings:update',");
  const end = main.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start >= 0 && end > start);
  let handler, release, active = true, commits = 0;
  const sender = { mainFrame: {} }; const event = { sender, senderFrame: sender.mainFrame };
  const h = helpers({ mainWindow: { webContents: sender, isDestroyed: () => false } });
  Object.assign(h, {
    ipcMain: { handle: (_channel, fn) => { handler = fn; } },
    getSyncContentRuntime: () => ({ status: () => ({ identity: 'same' }), publishPatch: () => new Promise(resolve => { release = resolve; }) }),
    applySettingsPatch: patch => { h.preparePluginSkinSettings(patch, {}, { resolveSkin: () => active ? { ref: 'author/mono', appearance: tokens } : null }); commits++; },
    pluginRuntime: null, latestUsageHost: null, settingsForRenderer: () => ({})
  });
  vm.runInContext(main.slice(start, end), h);
  let pending = handler(event, { pluginSkinRef: 'author/mono' }); await Promise.resolve(); active = false; release();
  await assert.rejects(pending, /unavailable/); assert.equal(commits, 0);
  active = true; pending = handler(event, { pluginSkinRef: 'author/mono' }); await Promise.resolve(); h.mainWindow = null; release();
  await assert.rejects(pending, /main window/); assert.equal(commits, 0);
  await assert.rejects(handler(event, { pluginAuthorSkin: { ref: 'author/mono', appearance: tokens } }), /host-owned/);
});
test('every finite appearance option reaches actual plugin-content DOM projection', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/pluginViews.js'), 'utf8');
  const container = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  const context = { container }; vm.createContext(context); vm.runInContext(extract(source, 'applyAppearance'), context);
  for (const [key, choices] of Object.entries(OPTIONS)) for (const choice of choices) {
    context.value = normalizeAppearance({ [key]: choice }); vm.runInContext('applyAppearance(container, value)', context);
    assert.equal(container.dataset[`pv${key[0].toUpperCase()}${key.slice(1)}`], choice);
  }
});
