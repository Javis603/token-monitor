'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parsePackage, packageDirectory } = require('../../src/electron/plugins/package');
const { createManagedPlugins, MAX_REGISTRY_BYTES, MAX_JOURNAL_BYTES } = require('../../src/electron/plugins/managed');
const { MAX_CODE_BYTES } = require('../../src/electron/plugins/contracts');
const { readPluginCode } = require('../../src/electron/plugins/sandbox');
function bytes(version = '1.0.0', extra = {}) {
  return Buffer.from(JSON.stringify({ format: 1, manifest: { id: 'test-plugin', name: 'Test', version, tmApi: '^1', main: 'main.js', permissions: [],
    views: [{ id: 'page', title: 'Page', surfaces: ['page'], layout: { type: 'text', value: 'hello' } }], ...extra }, code: 'tm.onTick(() => {});' }));
}
function fixture(t, fault) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-managed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = { pluginStates: {}, homeModuleOrder: 'summary,plugin:test-plugin/page,plugin:other/page', hiddenHomeModules: '', edgeDockItems: [], notchPluginPages: ['test-plugin/page', 'other/page'] };
  let stopped = 0;
  const manager = { list: () => ({ plugins: [] }), beginMutation: () => stopped++, endMutation() {}, reload() {} };
  const args = { root: path.join(dir, 'manager'), userDir: path.join(dir, 'plugins'), dataDir: path.join(dir, 'data'), settingsDir: path.join(dir, 'author-settings'), manager,
    getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; }, fault };
  const api = createManagedPlugins(args); api.recover();
  const install = (version, extra) => api.install(api.preview(parsePackage(bytes(version, extra))).token);
  return { dir, args, api, install, get settings() { return settings; }, get stopped() { return stopped; } };
}
function historyFixture(t, fault) {
  const f = fixture(t, fault); f.install('1.0.0'); f.install('2.0.0');
  f.settings.pluginStates['test-plugin'] = { enabled: true, background: false, grant: { permissions: [], hosts: [] } };
  // Include every placement key in the rollback baseline.
  f.settings.trayCustomLayout = { version: 1, items: [] };
  f.settings.pluginMainPages = ['test-plugin/page', 'other/page'];
  for (const dir of [f.args.dataDir, f.args.settingsDir]) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'test-plugin.json'), '{"keep":7}');
  }
  return f;
}
function snapshot(f) {
  const files = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(f.dir, file), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) files[relative] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) { files[relative] = null; visit(file); }
      else files[relative] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(f.dir);
  return { files, settings: structuredClone(f.settings) };
}
function operation(api, name, token) {
  if (name === 'preview') return api.preview(parsePackage(bytes('3.0.0', { permissions: ['sys.cpu'] })));
  if (name === 'update') return api.install(token);
  if (name === 'rollback') return api.rollback('test-plugin');
  return api.uninstall('test-plugin', { keepData: false });
}

for (const restart of [false, true]) for (const name of ['preview', 'update', 'rollback', 'uninstall']) {
  test(`missing target permits ${name}${restart ? ' after restart' : ''}`, t => {
    const f = historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
    if (name !== 'update') fs.rmSync(target, { recursive: true });
    const api = restart ? createManagedPlugins(f.args) : f.api;
    if (restart) api.recover();
    // Confirmation must also tolerate deletion after a successful preview.
    const token = name === 'update' ? api.preview(parsePackage(bytes('3.0.0', { permissions: ['sys.cpu'] }))).token : null;
    if (name === 'update') fs.rmSync(target, { recursive: true });
    const before = snapshot(f), consent = structuredClone(f.settings.pluginStates['test-plugin']);
    const result = operation(api, name, token);
    if (name === 'preview') {
      assert.equal(result.operation, 'update'); assert.equal(result.installedVersion, '2.0.0');
      assert.deepEqual(snapshot(f), before);
      api.install(result.token);
    }
    if (name === 'uninstall') {
      assert.equal(api.describe('test-plugin'), null);
      assert.equal(fs.existsSync(target), false);
      assert.equal(f.settings.pluginStates['test-plugin'], undefined);
    } else {
      assert.equal(packageDirectory(target).manifest.version, name === 'rollback' ? '1.0.0' : '3.0.0');
      assert.equal(api.describe('test-plugin').previousVersion, null);
      assert.equal(api.describe('test-plugin').previousSha256, null);
      assert.deepEqual(f.settings.pluginStates['test-plugin'], consent);
      assert.equal(api.describe('test-plugin').origin.id, 'local');
    }
    assert.equal(fs.existsSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), false);
    assert.equal(fs.existsSync(path.join(f.args.root, 'transaction.json')), false);
    const recovered = createManagedPlugins(f.args); recovered.recover();
    assert.deepEqual(recovered.describe('test-plugin'), api.describe('test-plugin'));
  });
}
for (const keepData of [false, true]) for (const keepPlacements of [false, true]) {
  test(`missing target uninstall respects keepData=${keepData}, keepPlacements=${keepPlacements}`, t => {
    const f = historyFixture(t);
    fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
    const before = structuredClone(f.settings);
    f.api.uninstall('test-plugin', { keepData, keepPlacements });
    assert.equal(f.api.describe('test-plugin'), null);
    for (const dir of [f.args.dataDir, f.args.settingsDir]) {
      const file = path.join(dir, 'test-plugin.json');
      assert.equal(fs.existsSync(file), keepData);
      if (keepData) assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":7}');
    }
    assert.equal(f.settings.homeModuleOrder, keepPlacements ? before.homeModuleOrder : 'summary,plugin:other/page');
    assert.deepEqual(f.settings.notchPluginPages, keepPlacements ? before.notchPluginPages : ['other/page']);
    assert.equal(f.settings.pluginStates['test-plugin'], undefined);
  });
}
for (const restart of [false, true]) for (const state of ['symlink', 'dangling-symlink', 'file']) {
  for (const name of ['preview', 'update', 'rollback', 'uninstall']) {
    test(`${state} replacement rejects ${name}${restart ? ' after restart' : ''} without mutation`, t => {
      const f = historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
      const api = restart ? createManagedPlugins(f.args) : f.api;
      if (restart) api.recover();
      const token = name === 'update' ? api.preview(parsePackage(bytes('3.0.0'))).token : null;
      fs.rmSync(target, { recursive: true });
      const external = path.join(f.dir, 'external');
      if (state === 'symlink') { fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'sentinel'), 'untouched'); }
      if (state === 'file') fs.writeFileSync(target, 'replacement');
      else fs.symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
      if (restart && name !== 'update') api.recover();
      const before = snapshot(f), stopped = f.stopped;
      assert.throws(() => operation(api, name, token), /managed plugin directory is missing or replaced/);
      assert.deepEqual(snapshot(f), before);
      assert.equal(f.stopped, stopped);
    });
  }
}
for (const name of ['update', 'rollback', 'uninstall']) {
  for (const point of ['prepared', 'old-moved', 'new-moved', 'registry-written', 'settings-written', 'reloaded']) {
    test(`missing target ${name} restores absence and all state after ${point}`, t => {
      let armed = false;
      const f = historyFixture(t, step => { if (armed && step === point) throw new Error('injected interruption'); });
      const target = path.join(f.args.userDir, 'test-plugin');
      fs.rmSync(target, { recursive: true });
      const before = snapshot(f), record = f.api.describe('test-plugin');
      armed = true;
      assert.throws(() => operation(f.api, name, name === 'update' ? f.api.preview(parsePackage(bytes('3.0.0'))).token : null), /injected interruption/);
      assert.deepEqual(snapshot(f), before);
      assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' });
      assert.deepEqual(f.api.describe('test-plugin'), record);
      const recovered = createManagedPlugins(f.args); recovered.recover();
      assert.deepEqual(snapshot(f), before);
      assert.deepEqual(recovered.describe('test-plugin'), record);
    });
  }
  test(`missing target ${name} recovers after actual process termination`, t => {
    const f = historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
    fs.rmSync(target, { recursive: true });
    const before = snapshot(f);
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { createManagedPlugins } = require(process.argv[1]);
      const { parsePackage } = require(process.argv[2]);
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      const api = createManagedPlugins({ ...input.args,
        manager: { list: () => ({ plugins: [] }), beginMutation() {}, endMutation() {}, reload() {} },
        getSettings: () => input.settings, saveSettings: patch => fs.writeSync(1, JSON.stringify(patch)),
        fault: step => { if (step === 'settings-written') process.exit(87); }
      });
      api.recover();
      if (input.name === 'update') api.install(api.preview(parsePackage(input.package)).token);
      else if (input.name === 'rollback') api.rollback('test-plugin');
      else api.uninstall('test-plugin', { keepData: false });
    `, require.resolve('../../src/electron/plugins/managed'), require.resolve('../../src/electron/plugins/package')], {
      input: JSON.stringify({ args: f.args, settings: f.settings, name, package: bytes('3.0.0').toString() })
    });
    assert.equal(child.status, 87, child.stderr.toString());
    f.args.saveSettings(JSON.parse(child.stdout.toString()));
    const journal = JSON.parse(fs.readFileSync(path.join(f.args.root, 'transaction.json')));
    assert.equal(journal.hadTarget, false); assert.equal(journal.phase, 'prepared');
    const recovered = createManagedPlugins(f.args); recovered.recover();
    assert.deepEqual(snapshot(f), before);
    assert.equal(recovered.describe('test-plugin').version, '2.0.0');
    assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' });
  });
}
test('missing target preserves source, version and stale-confirmation checks', t => {
  const f = historyFixture(t); fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
  const before = snapshot(f);
  assert.throws(() => f.api.preview(parsePackage(bytes('3.0.0')), { id: 'other' }), /source differs/);
  for (const version of ['1.0.0', '2.0.0']) assert.throws(() => f.api.preview(parsePackage(bytes(version))), /newer version/);
  assert.deepEqual(snapshot(f), before);
  const stale = f.api.preview(parsePackage(bytes('4.0.0'))).token;
  f.install('3.0.0');
  assert.throws(() => f.api.install(stale), /version changed/);
});
for (const corruption of ['manifest', 'missing-manifest', 'version', 'id']) {
  test(`existing target update still rejects ${corruption} corruption`, t => {
    const f = historyFixture(t), manifest = path.join(f.args.userDir, 'test-plugin/manifest.json');
    if (corruption === 'manifest') fs.writeFileSync(manifest, '{broken');
    else if (corruption === 'missing-manifest') fs.rmSync(manifest);
    else {
      const data = JSON.parse(fs.readFileSync(manifest)); data[corruption] = corruption === 'id' ? 'other-plugin' : '9.0.0';
      fs.writeFileSync(manifest, JSON.stringify(data));
    }
    const registry = fs.readFileSync(path.join(f.args.root, 'installed.json'));
    const backup = fs.readFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin'));
    const settings = structuredClone(f.settings), stopped = f.stopped;
    assert.throws(() => f.install('3.0.0'), corruption === 'manifest' ? SyntaxError : corruption === 'missing-manifest' ? { code: 'ENOENT' } : /changed outside/);
    assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'installed.json')), registry);
    assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), backup);
    assert.deepEqual(f.settings, settings); assert.equal(f.stopped, stopped);
  });
}
for (const code of ['EACCES', 'ENOTDIR']) {
  test(`target lstat ${code} is propagated without mutation`, t => {
    const f = historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
    const token = f.api.preview(parsePackage(bytes('3.0.0'))).token;
    const before = snapshot(f), stopped = f.stopped, lstat = fs.lstatSync;
    const error = Object.assign(new Error('cannot inspect target'), { code });
    const mock = t.mock.method(fs, 'lstatSync', function (file, ...args) {
      if (file === target) throw error;
      return lstat.call(this, file, ...args);
    });
    for (const name of ['preview', 'update', 'rollback', 'uninstall']) assert.throws(() => operation(f.api, name, token), e => e === error);
    mock.mock.restore();
    assert.deepEqual(snapshot(f), before); assert.equal(f.stopped, stopped);
  });
}
for (const corruption of ['id', 'version', 'hash', 'compatibility']) {
  test(`missing target rollback still rejects backup ${corruption} mismatch`, t => {
    const f = historyFixture(t); fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
    const extra = corruption === 'id' ? { id: 'other-plugin' } : corruption === 'compatibility' ? { tmApi: '^99' } : {};
    let backup = bytes(corruption === 'version' ? '9.0.0' : '1.0.0', extra);
    if (corruption === 'hash') backup = Buffer.concat([backup, Buffer.from(' ')]);
    fs.writeFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin'), backup);
    const before = snapshot(f), stopped = f.stopped;
    assert.throws(() => f.api.rollback('test-plugin'), corruption === 'compatibility' ? /not supported/ : /identity mismatch/);
    assert.deepEqual(snapshot(f), before); assert.equal(f.stopped, stopped);
  });
}
test('package preview is data-only and rejects traversal, oversized code and incompatible manifests', () => {
  assert.equal(parsePackage(bytes()).manifest.id, 'test-plugin');
  for (const main of ['../escape.js', '/escape.js', 'CON.js', 'dir/../escape.js', 'dir//escape.js']) assert.throws(() => parsePackage(bytes('1.0.0', { main })));
  assert.throws(() => parsePackage(bytes('1.0.0', { tmApi: '^99' })), /not supported/);
  assert.throws(() => parsePackage(bytes('1.0.0', { engines: { tokenMonitor: '>=999' } })), /incompatible/);
  const data = JSON.parse(bytes()); data.code = 'x'.repeat(MAX_CODE_BYTES + 1);
  assert.throws(() => parsePackage(JSON.stringify(data)), /under 2 MB/);
  assert.throws(() => parsePackage('{"format":1,"manifest":{"id":{"toString":0}}}'), /invalid plugin manifest/);
});
test('install, update, rollback and uninstall preserve grants and explicit retention choices', t => {
  const f = fixture(t); f.install('1.0.0');
  assert.equal(f.settings.pluginStates['test-plugin'].enabled, false);
  f.settings.pluginStates['test-plugin'] = { enabled: true, grant: { permissions: [], hosts: [] } };
  fs.mkdirSync(f.args.dataDir); fs.writeFileSync(path.join(f.args.dataDir, 'test-plugin.json'), '{"count":7}');
  f.install('2.0.0', { permissions: ['sys.cpu'] });
  assert.deepEqual(f.settings.pluginStates['test-plugin'].grant.permissions, []);
  assert.equal(f.api.describe('test-plugin').previousVersion, '1.0.0');
  f.api.rollback('test-plugin'); assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  assert.equal(f.api.describe('test-plugin').previousVersion, '2.0.0');
  f.api.uninstall('test-plugin', { keepData: true, keepPlacements: false });
  assert.equal(fs.existsSync(path.join(f.args.dataDir, 'test-plugin.json')), true);
  assert.deepEqual(f.settings.notchPluginPages, ['other/page']);
  assert.equal(f.settings.pluginStates['test-plugin'], undefined);
  f.install('1.0.0'); f.api.uninstall('test-plugin', { keepData: false, keepPlacements: true });
  assert.equal(fs.existsSync(path.join(f.args.dataDir, 'test-plugin.json')), false);
});
test('stale confirmations, source substitution, version replacement and local-folder collisions are refused', t => {
  const f = fixture(t), pkg = parsePackage(bytes()); const a = f.api.preview(pkg), b = f.api.preview(pkg); f.api.install(a.token);
  assert.throws(() => f.api.install(b.token), /version changed/);
  assert.throws(() => f.api.preview(pkg), /newer version/);
  assert.throws(() => f.api.preview(parsePackage(bytes('2.0.0')), { id: 'other' }), /source differs/);
  f.api.uninstall('test-plugin'); fs.mkdirSync(path.join(f.args.userDir, 'test-plugin'));
  assert.throws(() => f.api.preview(pkg), /development plugin/);
});
test('flush failure leaves the installed files and registry untouched', t => {
  const f = fixture(t); f.install('1.0.0'); f.args.manager.beginMutation = () => { throw new Error('flush failed'); };
  assert.throws(() => f.install('2.0.0'), /flush failed/);
  assert.equal(f.api.describe('test-plugin').version, '1.0.0');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
});
for (const point of ['prepared', 'old-moved', 'new-moved', 'registry-written', 'settings-written', 'reloaded']) {
  test(`failed update restores files, data and consent after ${point}`, t => {
    let armed = false; const f = fixture(t, step => { if (armed && step === point) throw new Error('injected interruption'); }); f.install('1.0.0');
    f.settings.pluginStates['test-plugin'] = { enabled: true, grant: { permissions: [], hosts: [] } }; armed = true;
    assert.throws(() => f.install('2.0.0'), /injected interruption/);
    assert.equal(f.api.describe('test-plugin').version, '1.0.0');
    assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
    assert.equal(f.settings.pluginStates['test-plugin'].enabled, true);
    assert.equal(fs.existsSync(path.join(f.args.root, 'transaction.json')), false);
  });
}
test('startup recovers a transaction interrupted by actual process termination', t => {
  const f = fixture(t); f.install('1.0.0');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/pluginManagedInterrupt.js')], {
    input: JSON.stringify({ root: f.args.root, userDir: f.args.userDir, dataDir: f.args.dataDir, package: bytes('2.0.0').toString() })
  });
  assert.equal(child.status, 87, child.stderr.toString());
  const recovered = createManagedPlugins(f.args); recovered.recover();
  assert.equal(recovered.describe('test-plugin').version, '1.0.0');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
});

test('accepted manifest and code artifacts stay executable at their runtime boundaries', t => {
  const f = fixture(t); f.install('1.0.0');
  const metadata = Object.fromEntries(Array.from({ length: 18000 }, (_, i) => ['k' + i, 0]));
  const input = bytes('2.0.0', { metadata });
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(input).manifest, null, 2)) > 256 * 1024);
  f.install('2.0.0', { metadata });
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '2.0.0');
  assert.ok(fs.statSync(path.join(f.args.userDir, 'test-plugin/manifest.json')).size <= 256 * 1024);
  f.api.rollback('test-plugin'); f.api.uninstall('test-plugin');
  const data = JSON.parse(bytes()); data.code = '/*' + 'a'.repeat(MAX_CODE_BYTES - 4) + '*/';
  f.api.install(f.api.preview(parsePackage(JSON.stringify(data))).token);
  assert.equal(Buffer.byteLength(readPluginCode(path.join(f.args.userDir, 'test-plugin/main.js'))), MAX_CODE_BYTES);
  data.code = '/*' + 'a'.repeat(MAX_CODE_BYTES) + '*/';
  assert.throws(() => parsePackage(JSON.stringify(data)), /under 2 MB/);
});
test('corrupt current versions can be rolled back or uninstalled without parsing them', t => {
  const f = fixture(t); f.install('1.0.0'); f.install('2.0.0');
  fs.writeFileSync(path.join(f.args.userDir, 'test-plugin/manifest.json'), '{broken');
  f.api.rollback('test-plugin');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  assert.equal(f.api.describe('test-plugin').previousVersion, null);
  assert.equal(fs.existsSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), false);
  fs.writeFileSync(path.join(f.args.userDir, 'test-plugin/manifest.json'), 'x'.repeat(300 * 1024));
  f.api.uninstall('test-plugin');
  assert.equal(f.api.describe('test-plugin'), null);
});
test('host upgrade permits removal and replacement while refusing incompatible rollback targets', t => {
  const f = fixture(t), host = require('../../package.json'), original = host.version;
  t.after(() => { host.version = original; });
  f.install('1.0.0', { engines: { tokenMonitor: original } });
  host.version = '999.0.0';
  f.install('2.0.0', { engines: { tokenMonitor: '999.0.0' } });
  assert.throws(() => f.api.rollback('test-plugin'), /incompatible/);
  assert.equal(f.api.describe('test-plugin').version, '2.0.0');
  host.version = '1000.0.0';
  f.api.uninstall('test-plugin');
  assert.equal(f.api.describe('test-plugin'), null);
});
test('sixty catalog installations with long URLs survive registry reload and interrupted update', t => {
  let armed = false;
  const f = fixture(t, step => { if (armed && step === 'registry-written') throw new Error('interrupted'); });
  const origin = { id: 'custom-11111111-1111-1111-1111-111111111111', kind: 'community', label: 'Fixture catalog', fingerprint: '', signed: false, cached: true, lastFetched: Date.now(), error: '', url: 'https://catalog.example/index?' + 's'.repeat(2000), packageUrl: 'https://catalog.example/package?' + 'p'.repeat(2000) };
  for (let i = 0; i < 60; i++) f.api.install(f.api.preview(parsePackage(bytes('1.0.0', { id: 'plugin-' + i })), origin).token);
  const size = fs.statSync(path.join(f.args.root, 'installed.json')).size;
  assert.ok(size > 256 * 1024 && size < MAX_REGISTRY_BYTES);
  const restarted = createManagedPlugins(f.args); restarted.recover();
  assert.equal(restarted.describe('plugin-59').version, '1.0.0');
  armed = true;
  assert.throws(() => restarted.install(restarted.preview(parsePackage(bytes('2.0.0', { id: 'plugin-59' })), origin).token), /interrupted/);
  restarted.recover(); assert.equal(restarted.describe('plugin-59').version, '1.0.0');
});
test('registry and journal capacity failures leave prior installs recoverable', t => {
  const f = fixture(t); f.install('1.0.0');
  const before = fs.readFileSync(path.join(f.args.root, 'installed.json'));
  const oversizedOrigin = { id: 'local', label: 'x'.repeat(MAX_REGISTRY_BYTES) };
  assert.throws(() => f.api.install(f.api.preview(parsePackage(bytes('2.0.0')), oversizedOrigin).token), /metadata exceeds/);
  assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'installed.json')), before);
  f.settings.homeModuleOrder = 'x'.repeat(MAX_JOURNAL_BYTES);
  assert.throws(() => f.install('2.0.0'), /metadata exceeds/);
  assert.equal(fs.existsSync(path.join(f.args.root, 'transaction.json')), false);
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  createManagedPlugins(f.args).recover();
});

for (const point of ['old-moved', 'registry-written', 'settings-written', 'reloaded']) {
  test(`author settings uninstall rollback preserves bytes after ${point}`, t => {
    let armed = false;
    const f = fixture(t, step => { if (armed && step === point) throw new Error('interrupted'); });
    f.install('1.0.0');
    fs.mkdirSync(f.args.settingsDir);
    const file = path.join(f.args.settingsDir, 'test-plugin.json');
    const original = '{"version":1,"revision":7,"values":{"private":"keep"}}';
    fs.writeFileSync(file, original);
    armed = true;
    assert.throws(() => f.api.uninstall('test-plugin', { keepData: false }), /interrupted/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    armed = false;
    f.api.uninstall('test-plugin', { keepData: true });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    f.install('1.0.0');
    f.api.uninstall('test-plugin', { keepData: false });
    assert.equal(fs.existsSync(file), false);
  });
}
