'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { createRequire } = require('node:module');
const { createDataBus } = require('../../src/shared/plugins/dataBus');
const { createPluginManager } = require('../../src/electron/plugins/manager');
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
function fixture(t, initialSettings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-author-preset-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userDir = path.join(dir, 'plugins'); fs.mkdirSync(userDir);
  for (const id of ['author', 'second']) {
    fs.mkdirSync(path.join(userDir, id)); fs.writeFileSync(path.join(userDir, id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', tmApi: '^1', permissions: [], skins: [{ id: 'mono', name: 'Mono', appearance: tokens }], views: [{ id: 'card', title: 'Card', surfaces: ['home', 'page', 'notch', 'edgeDock'], layout: { type: 'text', text: 'Preset' } }] }));
  }
  const settings = { pluginStates: {}, ...initialSettings }; const bus = createDataBus();
  let getAppearance;
  const legacyFile = path.join(dir, 'plugin-appearance.json'); const legacy = '{"font":"system","corners":"square"}'; fs.writeFileSync(legacyFile, legacy);
  // Instantiate real runtime wiring and real manager; isolate Electron/background owners.
  const filename = path.join(root, 'src/electron/plugins/runtime.js'); const nativeRequire = createRequire(filename);
  let manager; const timers = [];
  const mocks = {
    './systemDetails': { registerSystemSources() {} }, './appSources': { createAppSources: () => ({ publish() {} }) },
    './sandbox': { createPluginSandbox: () => null }, './pages': { createPluginPages: () => ({ refresh() {}, dispose() {} }) },
    './managed': { createManagedPlugins: () => ({ recover() {}, dispose() {} }) }, './catalog': { createPluginCatalog: () => ({ dispose() {} }) },
    './manager': { createPluginManager: options => { getAppearance = options.getAppearance; manager = createPluginManager({ ...options, builtinDir: path.join(dir, 'empty'), safeMode: false, setTimer: fn => { timers.push(fn); return fn; }, clearTimer: fn => { const index = timers.indexOf(fn); if (index >= 0) timers.splice(index, 1); }, saveStates: value => { settings.pluginStates = value; } }); return manager; } },
    '../limits/fetch': { createElectronNetFetch: () => () => {} }, '../../shared/outboundFetch': { resolveProxyConfig: () => ({}) }
  };
  const module = { exports: {} }; vm.runInNewContext(runtimeSource, { module, require: id => mocks[id] || nativeRequire(id), __dirname: path.dirname(filename), process, console, setTimeout, clearTimeout, structuredClone });
  const runtime = module.exports.createPluginRuntime({ electron: { app: {}, ipcMain: { handle() {}, on() {}, removeHandler() {}, removeListener() {} } }, userDataDir: dir, getSettings: () => settings, getLocale: () => 'en', isMainSender: () => false, env: {} });
  runtime.start(); t.after(() => runtime.dispose()); t.after(() => bus.dispose());
  return { runtime, manager, settings, getAppearance, legacyFile, legacy, userDir, flush: () => { while (timers.length) timers.shift()(); } };
}
test('real manager DTOs and runtime resolve active identities; snapshot survives disable/remove and repaints tokens', t => {
  const f = fixture(t);
  assert.throws(() => f.runtime.resolveSkin('author/mono'), /unavailable/);
  for (const id of ['author', 'second']) f.manager.setEnabled(id, true);
  const skin = f.runtime.resolveSkin('author/mono'); assert.equal(skin.ref, 'author/mono');
  assert.equal(f.runtime.resolveSkin('second/mono').ref, 'second/mono');
  assert.equal(f.manager.list().plugins.find(p => p.id === 'author').skins[0].ref, skin.ref);
  f.settings.pluginAuthorSkin = { ref: skin.ref, appearance: skin.appearance };
  const payloads = []; f.manager.onViews((surface, value) => payloads.push({ surface, value }));
  for (const surface of ['home', 'page', 'notch', 'edgeDock']) f.manager.setSurfaceDemand(surface, ['second/card']);
  f.flush(); payloads.length = 0; f.runtime.settingsChanged(); f.flush();
  assert.equal(payloads.length, 4); for (const payload of payloads) assert.deepEqual(plain(payload.value.appearance), tokens); assert.deepEqual(plain(f.runtime.payload('home').appearance), tokens);
  const viewSource = fs.readFileSync(path.join(root, 'src/electron/renderer/pluginViews.js'), 'utf8');
  const properties = {}; const container = { dataset: {}, style: { setProperty: (key, value) => { properties[key] = value; }, removeProperty: key => delete properties[key] } };
  const context = { container, value: f.runtime.payload('home').appearance }; vm.createContext(context); vm.runInContext(extract(viewSource, 'applyAppearance') + '\napplyAppearance(container, value)', context);
  assert.deepEqual(container.dataset, { pvFont: 'mono', pvDensity: 'comfortable', pvCorners: 'soft', pvPanel: 'outline' });
  assert.equal(properties['--pv-background'], tokens.colors.background); assert.equal(Object.keys(properties).length, 5);
  f.manager.setEnabled('author', false); assert.throws(() => f.runtime.resolveSkin(skin.ref), /unavailable/);
  fs.rmSync(path.join(f.userDir, 'author'), { recursive: true }); f.manager.reload();
  f.settings.pluginAuthorSkin = JSON.parse(JSON.stringify(f.settings.pluginAuthorSkin)); f.runtime.settingsChanged();
  assert.deepEqual(plain(f.getAppearance()), tokens); assert.equal(fs.readFileSync(f.legacyFile, 'utf8'), f.legacy);
  const restarted = fixture(t, { pluginAuthorSkin: JSON.parse(JSON.stringify(f.settings.pluginAuthorSkin)) });
  assert.throws(() => restarted.runtime.resolveSkin(skin.ref), /unavailable/);
  assert.deepEqual(plain(restarted.runtime.payload('home').appearance), tokens);
  f.settings.pluginAuthorSkin = null; assert.equal(f.getAppearance().font, 'system'); assert.equal(f.getAppearance().corners, 'square');
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
    latestUsageHost: null, settingsForRenderer: () => ({})
  });
  vm.runInContext(main.slice(start, end), h);
  let pending = handler(event, { pluginSkinRef: 'author/mono' }); active = false; release();
  await assert.rejects(pending, /unavailable/); assert.equal(commits, 0);
  active = true; pending = handler(event, { pluginSkinRef: 'author/mono' }); h.mainWindow = null; release();
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
