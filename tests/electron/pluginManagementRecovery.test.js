'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
// Selectable source root lets the same regression run against a frozen baseline.
const root = process.env.PLUGIN_RECOVERY_TEST_ROOT || path.resolve(__dirname, '../..');
const req = file => require(path.join(root, file));
const { createManagedPlugins } = req('src/electron/plugins/managed');
const { createPluginRuntime } = req('src/electron/plugins/runtime');
const { createPluginManager } = req('src/electron/plugins/manager');
const { createPluginCatalog } = req('src/electron/plugins/catalog');
const { createDataBus } = req('src/shared/plugins/dataBus');
const { parsePackage, digest } = req('src/electron/plugins/package');
const { placementsFor, placementPatch } = req('src/electron/plugins/placementSettings');
const { normalizeEdgeDockItems } = req('src/electron/renderer/edgeDock/items');
const runtimeSource = fs.readFileSync(path.join(root, 'src/electron/plugins/runtime.js'), 'utf8');
function extract(start, end) {
  assert.equal(runtimeSource.split(start).length, 2);
  return runtimeSource.slice(runtimeSource.indexOf(start), runtimeSource.indexOf(end, runtimeSource.indexOf(start)));
}
const listSource = extract('  function listWithPlacements() {', '\n  function mainSender(');
const placeSource = extract("    handle('plugins:place',", "    handle('plugins:skins',");
function bytes(version, permissions = []) {
  return Buffer.from(JSON.stringify({ format: 1, manifest: { id: 'recovery-demo', name: 'Recovery demo', version, tmApi: '^1', permissions,
    views: [{ id: 'overview', title: 'Overview', surfaces: ['page', 'edgeDock'], layout: { type: 'text', value: 'synthetic' } }] } }));
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-management-recovery-'));
  const userDir = path.join(dir, 'plugins'), dataDir = path.join(dir, 'data'), settingsDir = path.join(dir, 'settings');
  let settings = { pluginsEnabled: true, pluginStates: {}, edgeDockItems: [], pluginMainPages: [] }, writes = 0;
  const bus = createDataBus();
  const manager = createPluginManager({ builtinDir: path.join(dir, 'builtins'), userDir, dataDir, bus, getSettings: () => settings, saveStates: states => { settings.pluginStates = states; } });
  const args = { root: path.join(dir, 'managed'), userDir, dataDir, settingsDir, manager, getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } };
  let managed = createManagedPlugins(args); managed.recover(); manager.reload();
  t.after(() => { managed.dispose(); manager.dispose(); bus.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const handlers = new Map();
  function context() {
    const ctx = vm.createContext({ manager, managed, getSettings: () => settings, placementsFor, placementPatch,
      handle: (key, fn) => handlers.set(key, fn), requireMain() {}, placementContext: () => ({}),
      applySettingsPatch: patch => { writes++; settings = { ...settings, ...patch, edgeDockItems: normalizeEdgeDockItems(patch.edgeDockItems) }; } });
    vm.runInContext(listSource + '\n' + placeSource + '\nthis.list = listWithPlacements;', ctx); return ctx;
  }
  let ctx = context();
  return { dir, userDir, dataDir, settingsDir, manager, get managed() { return managed; }, get settings() { return settings; }, get writes() { return writes; },
    list: () => ctx.list(), place: (placed = true) => handlers.get('plugins:place')({}, { ref: 'recovery-demo/overview', surface: 'edgeDock', placed }),
    install: version => managed.install(managed.preview(parsePackage(bytes(version))).token),
    restart() { managed.dispose(); managed = createManagedPlugins(args); managed.recover(); manager.reload(); ctx = context(); } };
}
for (const backup of [false, true]) test(`missing managed entry survives runtime reload/restart, backup=${backup}`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-runtime-management-recovery-'));
  const handlers = new Map(), ipcMain = new EventEmitter(), sender = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn); ipcMain.removeHandler = name => handlers.delete(name);
  sender.id = 1; sender.mainFrame = {}; sender.send = () => {}; sender.isDestroyed = () => false;
  const event = { sender, senderFrame: sender.mainFrame }, settings = { pluginsEnabled: true, pluginStates: {} };
  const packageFile = path.join(dir, 'fixture.tmplugin');
  const args = { electron: { app: {}, ipcMain, BrowserWindow: { fromWebContents: () => null },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [packageFile] }) } },
  userDataDir: dir, getSettings: () => settings, getLocale: () => 'en', env: {},
  persistPluginStates: states => { settings.pluginStates = states; }, persistManagementSettings: patch => Object.assign(settings, patch),
  isMainSender: e => e.sender === sender };
  let runtime = createPluginRuntime(args); runtime.start();
  t.after(() => { runtime.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const invoke = (name, ...values) => handlers.get(name)(event, ...values);
  for (const version of backup ? ['1.0.0', '2.0.0'] : ['1.0.0']) {
    fs.writeFileSync(packageFile, bytes(version));
    invoke('plugins:install', (await invoke('plugins:import', 'file')).token);
  }
  fs.rmSync(path.join(dir, 'plugins/recovery-demo'), { recursive: true });
  let list = invoke('plugins:reload');
  for (const restart of [false, true]) {
    if (restart) { runtime.dispose(); assert.equal(handlers.size, 0); runtime = createPluginRuntime(args); runtime.start(); list = invoke('plugins:list'); }
    const p = list.plugins.find(p => p.id === 'recovery-demo');
    assert.ok(p, 'missing installation remains reachable through runtime IPC');
    assert.equal(p.status, 'missing'); assert.equal(p.managementOnly, true); assert.equal(p.enabled, false);
    assert.equal(p.views.length, 0); assert.equal(p.permissions.length, 0);
    assert.equal(p.installation.previousVersion, backup ? '1.0.0' : null);
    assert.equal(runtime.manager.list().plugins.some(p => p.id === 'recovery-demo'), false, 'management entry is not execution discovery');
    assert.throws(() => invoke('plugins:setEnabled', { id: p.id, enabled: true }));
  }
  if (backup) assert.equal(invoke('plugins:rollback', 'recovery-demo').plugins.find(p => p.id === 'recovery-demo').version, '1.0.0');
  assert.equal(invoke('plugins:uninstall', 'recovery-demo').plugins.some(p => p.id === 'recovery-demo'), false);
});
test('enumerated metadata is sanitized, detached, and distinguishes corrupt/replaced paths', t => {
  const f = fixture(t); f.install('1.0.0');
  const registryFile = path.join(f.dir, 'managed/installed.json');
  const registry = JSON.parse(fs.readFileSync(registryFile));
  registry['recovery-demo'].untrusted = 'secret'; registry['recovery-demo'].origin.extra = 'secret';
  fs.writeFileSync(registryFile, JSON.stringify(registry)); f.restart();
  const entries = f.managed.list(); assert.equal(entries[0].installation.untrusted, undefined); assert.equal(entries[0].installation.origin.extra, undefined);
  entries[0].installation.origin.id = 'changed'; assert.equal(f.managed.describe('recovery-demo').origin.id, 'local');
  fs.writeFileSync(path.join(f.userDir, 'recovery-demo/manifest.json'), '{broken'); f.manager.reload();
  assert.equal(f.list().plugins.length, 1); assert.equal(f.list().plugins[0].status, 'invalid');
  fs.rmSync(path.join(f.userDir, 'recovery-demo'), { recursive: true });
  fs.symlinkSync(path.join(f.dir, 'absent'), path.join(f.userDir, 'recovery-demo'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manager.reload(); assert.equal(f.managed.list()[0].missing, false);
  assert.equal(f.list().plugins[0].status, 'invalid');
  assert.throws(() => f.managed.uninstall('recovery-demo'), /missing or replaced/);
});
test('catalog preview rejects corrupt update with repair code; commit rechecks; retained reinstall works', async t => {
  const f = fixture(t); let current = bytes('1.0.0');
  const catalog = createPluginCatalog({ root: path.join(f.dir, 'catalog'), manager: f.manager, managed: f.managed,
    fetchImpl: async url => new Response(url.endsWith('.tmplugin') ? current : JSON.stringify({ format: 1, title: 'Synthetic', plugins: [{ id: 'recovery-demo', name: 'Recovery demo', versions: [{ version: JSON.parse(current).manifest.version, sha256: digest(current), url: 'https://fixture.invalid/demo.tmplugin' }] }] })) });
  t.after(() => catalog.dispose());
  await catalog.addSource({ url: 'https://fixture.invalid/index.json' }); const origin = catalog.list().entries.find(entry => entry.id === 'recovery-demo').origin.id;
  f.managed.install((await catalog.preview(origin, 'recovery-demo', '1.0.0')).token);
  current = bytes('2.0.0', ['sys.cpu']); await catalog.refreshSource(origin);
  const pending = await catalog.preview(origin, 'recovery-demo', '2.0.0');
  fs.writeFileSync(path.join(f.userDir, 'recovery-demo/manifest.json'), '{broken'); f.manager.reload();
  const record = f.managed.describe('recovery-demo'), settings = structuredClone(f.settings);
  assert.throws(() => f.managed.install(pending.token), { code: 'installed-package-invalid' });
  await assert.rejects(() => catalog.preview(origin, 'recovery-demo', '2.0.0'), { code: 'installed-package-invalid' });
  assert.deepEqual(f.managed.describe('recovery-demo'), record); assert.deepEqual(f.settings, settings);
  assert.equal(fs.existsSync(path.join(f.dir, 'managed/transaction.json')), false);
  for (const dir of [f.dataDir, f.settingsDir]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'recovery-demo.json'), '{"retained":7}'); }
  f.settings.pluginMainPages = ['recovery-demo/overview'];
  f.managed.uninstall('recovery-demo', { keepData: true, keepPlacements: true });
  f.managed.install((await catalog.preview(origin, 'recovery-demo', '2.0.0')).token);
  for (const dir of [f.dataDir, f.settingsDir]) assert.equal(fs.readFileSync(path.join(dir, 'recovery-demo.json'), 'utf8'), '{"retained":7}');
  assert.deepEqual(f.settings.pluginMainPages, ['recovery-demo/overview']); assert.equal(f.list().plugins[0].status, 'disabled');
  assert.deepEqual(f.settings.pluginStates['recovery-demo'].grant, { permissions: [], hosts: [] });
});
test('Edge Dock rejects new placement at capacity without writes but allows replace/remove', t => {
  const f = fixture(t); f.install('1.0.0'); f.manager.setEnabled('recovery-demo', true);
  f.settings.edgeDockItems = Array.from({ length: 24 }, (_, i) => ({ type: 'plugin', ref: `slot-${i}/overview` }));
  const before = structuredClone(f.settings.edgeDockItems);
  assert.throws(() => f.place(), /edgeDock-full/); assert.equal(f.writes, 0); assert.deepEqual(f.settings.edgeDockItems, before);
  f.settings.edgeDockItems.pop();
  assert.equal(f.place().plugins[0].views[0].placements.edgeDock, true); assert.equal(f.settings.edgeDockItems.length, 24);
  assert.equal(f.place().plugins[0].views[0].placements.edgeDock, true); assert.equal(f.settings.edgeDockItems.length, 24);
  assert.equal(f.place(false).plugins[0].views[0].placements.edgeDock, false); assert.equal(f.settings.edgeDockItems.length, 23);
});
