'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parsePackage, packageDirectory } = require('../../src/electron/plugins/package');
const { createManagedPlugins, MAX_REGISTRY_BYTES, MAX_JOURNAL_BYTES } = require('../../src/electron/plugins/managed');
const { MAX_PACKAGE_BYTES } = require('../../src/electron/plugins/package');
function bytes(version = '1.0.0', extra = {}) {
  return Buffer.from(JSON.stringify({ format: 2, manifest: { id: 'test-plugin', name: 'Test', version, tmApi: 1, ui: 'main.js', backend: 'main.js', files: ['main.js'],
    views: [{ id: 'page', title: 'Page', surfaces: ['page'] }], ...extra }, files: { 'main.js': Buffer.from('exports.activate = () => ({});').toString('base64') } }));
}
function fixture(t, fault) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-managed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = { floatingBubbleCustomLayout: { version: 1, items: [{ id: 'own', type: 'plugin', ref: 'test-plugin/page' }, { id: 'other', type: 'plugin', ref: 'other/page' }] }, notchCustomLayout: { version: 1, items: [{ id: 'own', type: 'plugin', ref: 'test-plugin/page' }, { id: 'other', type: 'plugin', ref: 'other/page' }] }, notchPageOrder: ['plugin:test-plugin/page', 'home', 'plugin:other/page'], pluginContentOrder: { 'main.model.content': ['test-plugin/page', 'other/page'] }, pluginContentSelections: { 'main.limits.content': 'test-plugin/page', 'main.home.content': 'other/page' }, pluginStates: {}, homeModuleOrder: 'summary,plugin:test-plugin/page,plugin:other/page', hiddenHomeModules: '', edgeDockItems: [], notchPluginPages: ['test-plugin/page', 'other/page'] };
  let stopped = 0;
  const manager = { list: () => ({ plugins: [] }), beginMutation: () => stopped++, endMutation() {}, reload() {} };
  const args = { root: path.join(dir, 'manager'), userDir: path.join(dir, 'plugins'), dataDir: path.join(dir, 'data'), settingsDir: path.join(dir, 'author-settings'), manager,
    getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; }, fault };
  const api = createManagedPlugins(args); api.recover();
  const install = async (version, extra) => await api.install(api.preview(parsePackage(bytes(version, extra))).token);
  return { dir, args, api, install, get settings() { return settings; }, get stopped() { return stopped; } };
}
async function historyFixture(t, fault) {
  const f = fixture(t, fault); await f.install('1.0.0'); await f.install('2.0.0');
  f.settings.pluginStates['test-plugin'] = { enabled: true, background: false, trustedRevision: 'a'.repeat(64) };
  // Include every placement key in the rollback baseline.
  f.settings.trayCustomLayout = { version: 1, items: [] };
  f.settings.pluginMainPages = ['test-plugin/page', 'other/page'];
  for (const dir of [f.args.dataDir, f.args.settingsDir]) {
    fs.mkdirSync(dir === f.args.dataDir ? path.join(dir, 'test-plugin') : dir, { recursive: true }); fs.writeFileSync(path.join(dir, ...(dir === f.args.dataDir ? ['test-plugin', 'data.json'] : ['test-plugin.json'])), '{"keep":7}');
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
async function operation(api, name, token) {
  if (name === 'preview') return api.preview(parsePackage(bytes('3.0.0', {})));
  if (name === 'update') return await api.install(token);
  if (name === 'rollback') return await api.rollback('test-plugin');
  return await api.uninstall('test-plugin', { keepData: false });
}

function assetPackage(version) {
  const raw = JSON.parse(bytes(version, { files: ['main.js', 'ui/page.js', 'ui/index.html'] }));
  Object.assign(raw.files, { 'ui/page.js': Buffer.from('console.log(1)').toString('base64'), 'ui/index.html': Buffer.from('<p>Original</p>').toString('base64') });
  return parsePackage(JSON.stringify(raw, null, 2));
}
function changeInstalled(f, kind) {
  const dir = path.join(f.args.userDir, 'test-plugin');
  if (kind === 'code') fs.writeFileSync(path.join(dir, 'main.js'), 'exports.activate = () => ({changed: true});');
  else if (kind === 'asset') fs.writeFileSync(path.join(dir, 'ui/page.js'), 'console.log(2)');
  else {
    const file = path.join(dir, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
    manifest.name = 'Changed'; fs.writeFileSync(file, JSON.stringify(manifest));
  }
}
for (const prefix of ['', '\uFEFF', '\uFEFF\uFEFF']) {
  test(`content integrity preserves ${prefix.length} leading BOMs across restart, update and rollback`, async t => {
    const f = fixture(t), raw = JSON.parse(bytes()); raw.files['main.js'] = Buffer.from(prefix + Buffer.from(raw.files['main.js'], 'base64').toString()).toString('base64');
    const original = parsePackage(JSON.stringify(raw));
    await f.api.install(f.api.preview(original).token);
    const target = path.join(f.args.userDir, 'test-plugin');
    const restarted = createManagedPlugins(f.args); restarted.recover();
    assert.equal(packageDirectory(target).files['main.js'].toString(), original.files['main.js'].toString());
    await restarted.install(restarted.preview(parsePackage(bytes('2.0.0'))).token);
    await restarted.rollback('test-plugin');
    assert.equal(fs.readFileSync(path.join(target, 'main.js'), 'utf8'), original.files['main.js'].toString());
    const token = restarted.preview(parsePackage(bytes('3.0.0'))).token;
    fs.appendFileSync(path.join(target, 'main.js'), '/* changed */');
    const before = snapshot(f);
    await assert.rejects(async () => await restarted.install(token), { code: 'installed-package-invalid' });
    assert.deepEqual(snapshot(f), before);
  });
}

for (const kind of ['code', 'asset', 'manifest']) for (const timing of ['before preview', 'after preview']) {
  test(`content integrity rejects changed ${kind} ${timing} without replacing installed state or backup`, async t => {
    const f = fixture(t);
    for (const version of ['1.0.0', '2.0.0']) await f.api.install(f.api.preview(assetPackage(version)).token);
    const token = timing === 'after preview' ? f.api.preview(assetPackage('3.0.0')).token : null;
    changeInstalled(f, kind);
    const before = snapshot(f), stopped = f.stopped;
    await assert.rejects(async () => token ? await f.api.install(token) : f.api.preview(assetPackage('3.0.0')), { code: 'installed-package-invalid' });
    assert.deepEqual(snapshot(f), before); assert.ok(f.stopped >= stopped);
    const restarted = createManagedPlugins(f.args); restarted.recover();
    assert.throws(() => restarted.preview(assetPackage('3.0.0')), { code: 'installed-package-invalid' });
  });
}
for (const kind of ['code', 'asset', 'manifest']) {
  test(`content integrity rescue rollback discards changed ${kind} reverse backup`, async t => {
    const f = fixture(t), original = assetPackage('1.0.0');
    await f.api.install(f.api.preview(original).token); await f.api.install(f.api.preview(assetPackage('2.0.0')).token);
    changeInstalled(f, kind); await f.api.rollback('test-plugin');
    const restored = packageDirectory(path.join(f.args.userDir, 'test-plugin'));
    assert.deepEqual(restored.rawManifest, original.rawManifest); assert.deepEqual(restored.files, original.files);
    assert.equal(f.api.describe('test-plugin').previousVersion, null);
    assert.equal(fs.existsSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), false);
    await f.api.install(f.api.preview(assetPackage('3.0.0')).token);
    assert.equal(f.api.describe('test-plugin').previousVersion, '1.0.0');
  });
}
test('content integrity accepts archive formatting, manifest key ordering and exact content across repeated rollback', async t => {
  const f = fixture(t), original = assetPackage('1.0.0');
  await f.api.install(f.api.preview(original).token);
  const dir = path.join(f.args.userDir, 'test-plugin'), file = path.join(dir, 'manifest.json');
  assert.notEqual(packageDirectory(dir).hash, original.hash, 'archive hash is not the installed-content fingerprint');
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  fs.writeFileSync(file, JSON.stringify(reorder(original.rawManifest), null, 4));
  const read = () => JSON.parse(fs.readFileSync(path.join(f.args.root, 'installed.json')))['test-plugin'];
  const fingerprint = read().contentSha256;
  assert.match(fingerprint, /^[a-f0-9]{64}$/); assert.equal(read().sha256, original.hash);
  const restarted = createManagedPlugins(f.args); restarted.recover();
  await restarted.install(restarted.preview(assetPackage('2.0.0')).token);
  await restarted.rollback('test-plugin'); assert.equal(read().contentSha256, fingerprint);
  await restarted.rollback('test-plugin'); assert.equal(read().version, '2.0.0');
});
for (const invalid of [undefined, null, 123, 'not-a-digest']) {
  test(`content integrity rejects malformed stored fingerprint ${JSON.stringify(invalid)}`, async t => {
    const f = fixture(t); await f.install('1.0.0');
    const file = path.join(f.args.root, 'installed.json'), registry = JSON.parse(fs.readFileSync(file));
    registry['test-plugin'].contentSha256 = invalid; fs.writeFileSync(file, JSON.stringify(registry));
    const before = snapshot(f), api = createManagedPlugins(f.args);
    assert.throws(() => api.recover(), /invalid installed plugin registry/);
    assert.equal(api.status().available, false); assert.deepEqual(snapshot(f), before);
  });
}

for (const restart of [false, true]) for (const name of ['preview', 'update', 'rollback', 'uninstall']) {
  test(`missing target permits ${name}${restart ? ' after restart' : ''}`, async t => {
    const f = await historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
    if (name !== 'update') fs.rmSync(target, { recursive: true });
    const api = restart ? createManagedPlugins(f.args) : f.api;
    if (restart) api.recover();
    // Confirmation must also tolerate deletion after a successful preview.
    const token = name === 'update' ? api.preview(parsePackage(bytes('3.0.0', {}))).token : null;
    if (name === 'update') fs.rmSync(target, { recursive: true });
    const before = snapshot(f), consent = structuredClone(f.settings.pluginStates['test-plugin']);
    const result = await operation(api, name, token);
    if (name === 'preview') {
      assert.equal(result.operation, 'update'); assert.equal(result.installedVersion, '2.0.0');
      assert.deepEqual(snapshot(f), before);
      await api.install(result.token);
    }
    if (name === 'uninstall') {
      assert.equal(api.describe('test-plugin'), null);
      assert.equal(fs.existsSync(target), false);
      assert.equal(f.settings.pluginStates['test-plugin'], undefined);
    assert.equal(f.settings.pluginContentSelections['main.limits.content'], undefined);
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
  test(`missing target uninstall respects keepData=${keepData}, keepPlacements=${keepPlacements}`, async t => {
    const f = await historyFixture(t);
    fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
    const before = structuredClone(f.settings);
    await f.api.uninstall('test-plugin', { keepData, keepPlacements });
    assert.equal(f.api.describe('test-plugin'), null);
    for (const dir of [f.args.dataDir, f.args.settingsDir]) {
      const file = path.join(dir, ...(dir === f.args.dataDir ? ['test-plugin', 'data.json'] : ['test-plugin.json']));
      assert.equal(fs.existsSync(file), keepData);
      if (keepData) assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":7}');
    }
    for (const key of ['floatingBubbleCustomLayout', 'notchCustomLayout']) assert.deepEqual(f.settings[key].items.map(item => item.ref), keepPlacements ? ['test-plugin/page', 'other/page'] : ['other/page']);
    assert.deepEqual(f.settings.notchPageOrder, keepPlacements ? before.notchPageOrder : ['home', 'plugin:other/page']);
    assert.equal(f.settings.homeModuleOrder, keepPlacements ? before.homeModuleOrder : 'summary,plugin:other/page');
    assert.deepEqual(f.settings.notchPluginPages, keepPlacements ? before.notchPluginPages : ['other/page']);
    assert.equal(f.settings.pluginStates['test-plugin'], undefined);
    assert.equal(f.settings.pluginContentSelections['main.limits.content'], keepPlacements ? 'test-plugin/page' : undefined);
    assert.deepEqual(f.settings.pluginContentOrder['main.model.content'], keepPlacements ? ['test-plugin/page', 'other/page'] : ['other/page']);
  });
}
for (const restart of [false, true]) for (const state of ['symlink', 'dangling-symlink', 'file']) {
  for (const name of ['preview', 'update', 'rollback', 'uninstall']) {
    test(`${state} replacement rejects ${name}${restart ? ' after restart' : ''} without mutation`, async t => {
      const f = await historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
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
      await assert.rejects(async () => await operation(api, name, token), /managed plugin directory is missing or replaced/);
      assert.deepEqual(snapshot(f), before);
      assert.equal(f.stopped, stopped);
    });
  }
}
for (const name of ['update', 'rollback', 'uninstall']) {
  for (const point of ['prepared', 'old-moved', 'new-moved', 'registry-written', 'settings-written', 'reloaded']) {
    test(`missing target ${name} restores absence and all state after ${point}`, async t => {
      let armed = false;
      const f = await historyFixture(t, step => { if (armed && step === point) throw new Error('injected interruption'); });
      const target = path.join(f.args.userDir, 'test-plugin');
      fs.rmSync(target, { recursive: true });
      const before = snapshot(f), record = f.api.describe('test-plugin');
      armed = true;
      await assert.rejects(async () => await operation(f.api, name, name === 'update' ? f.api.preview(parsePackage(bytes('3.0.0'))).token : null), /injected interruption/);
      assert.deepEqual(snapshot(f), before);
      assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' });
      assert.deepEqual(f.api.describe('test-plugin'), record);
      const recovered = createManagedPlugins(f.args); recovered.recover();
      assert.deepEqual(snapshot(f), before);
      assert.deepEqual(recovered.describe('test-plugin'), record);
    });
  }
  test(`missing target ${name} recovers after actual process termination`, async t => {
    const f = await historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
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
test('missing target preserves source, version and stale-confirmation checks', async t => {
  const f = await historyFixture(t); fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
  const before = snapshot(f);
  assert.throws(() => f.api.preview(parsePackage(bytes('3.0.0')), { id: 'other' }), /source differs/);
  for (const version of ['1.0.0', '2.0.0']) assert.throws(() => f.api.preview(parsePackage(bytes(version))), /newer version/);
  assert.deepEqual(snapshot(f), before);
  const stale = f.api.preview(parsePackage(bytes('4.0.0'))).token;
  await f.install('3.0.0');
  await assert.rejects(async () => await f.api.install(stale), /version changed/);
});
for (const corruption of ['manifest', 'missing-manifest', 'version', 'id']) {
  test(`existing target update still rejects ${corruption} corruption`, async t => {
    const f = await historyFixture(t), manifest = path.join(f.args.userDir, 'test-plugin/manifest.json');
    if (corruption === 'manifest') fs.writeFileSync(manifest, '{broken');
    else if (corruption === 'missing-manifest') fs.rmSync(manifest);
    else {
      const data = JSON.parse(fs.readFileSync(manifest)); data[corruption] = corruption === 'id' ? 'other-plugin' : '9.0.0';
      fs.writeFileSync(manifest, JSON.stringify(data));
    }
    const registry = fs.readFileSync(path.join(f.args.root, 'installed.json'));
    const backup = fs.readFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin'));
    const settings = structuredClone(f.settings), stopped = f.stopped;
    await assert.rejects(async () => await f.install('3.0.0'), { code: 'installed-package-invalid' });
    assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'installed.json')), registry);
    assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), backup);
    assert.deepEqual(f.settings, settings); assert.equal(f.stopped, stopped);
  });
}
for (const code of ['EACCES', 'ENOTDIR']) {
  test(`target lstat ${code} is propagated without mutation`, async t => {
    const f = await historyFixture(t), target = path.join(f.args.userDir, 'test-plugin');
    const token = f.api.preview(parsePackage(bytes('3.0.0'))).token;
    const before = snapshot(f), stopped = f.stopped, lstat = fs.lstatSync;
    const error = Object.assign(new Error('cannot inspect target'), { code });
    const mock = t.mock.method(fs, 'lstatSync', function (file, ...args) {
      if (file === target) throw error;
      return lstat.call(this, file, ...args);
    });
    for (const name of ['preview', 'update', 'rollback', 'uninstall']) await assert.rejects(async () => await operation(f.api, name, token), e => e === error);
    mock.mock.restore();
    assert.deepEqual(snapshot(f), before); assert.equal(f.stopped, stopped);
  });
}
for (const corruption of ['id', 'version', 'hash', 'compatibility']) {
  test(`missing target rollback still rejects backup ${corruption} mismatch`, async t => {
    const f = await historyFixture(t); fs.rmSync(path.join(f.args.userDir, 'test-plugin'), { recursive: true });
    const extra = corruption === 'id' ? { id: 'other-plugin' } : corruption === 'compatibility' ? { tmApi: 99} : {};
    let backup = bytes(corruption === 'version' ? '9.0.0' : '1.0.0', extra);
    if (corruption === 'hash') backup = Buffer.concat([backup, Buffer.from(' ')]);
    fs.writeFileSync(path.join(f.args.root, 'previous/test-plugin.tmplugin'), backup);
    const before = snapshot(f), stopped = f.stopped;
    await assert.rejects(async () => await f.api.rollback('test-plugin'), corruption === 'compatibility' ? /incompatible-plugin-api/ : /identity mismatch/);
    assert.deepEqual(snapshot(f), before); assert.equal(f.stopped, stopped);
  });
}
test('package preview is data-only and rejects traversal, large archives and incompatible manifests', () => {
  assert.equal(parsePackage(bytes()).manifest.id, 'test-plugin');
  for (const backend of ['../escape.js', '/escape.js', 'CON.js', 'dir/../escape.js', 'dir//escape.js']) assert.throws(() => parsePackage(bytes('1.0.0', { backend })));
  assert.throws(() => parsePackage(bytes('1.0.0', { tmApi: 2 })), /incompatible-plugin-api/);
  assert.throws(() => parsePackage(bytes('1.0.0', { engines: { tokenMonitor: '>=999' } })), /incompatible/);
  assert.throws(() => parsePackage(Buffer.alloc(MAX_PACKAGE_BYTES + 1)), /large|size|MiB/);
});
test('install, update, rollback and uninstall preserve trust decisions and explicit retention choices', async t => {
  const f = fixture(t); await f.install('1.0.0');
  assert.equal(f.settings.pluginStates['test-plugin'].enabled, false);
  f.settings.pluginStates['test-plugin'] = { enabled: true, trustedRevision: 'a'.repeat(64) };
  fs.mkdirSync(path.join(f.args.dataDir, 'test-plugin'), { recursive: true }); fs.writeFileSync(path.join(f.args.dataDir, 'test-plugin', 'data.json'), '{"count":7}');
  await f.install('2.0.0', {});
  assert.equal(f.settings.pluginStates['test-plugin'].trustedRevision, 'a'.repeat(64));
  assert.equal(f.api.describe('test-plugin').previousVersion, '1.0.0');
  await f.api.rollback('test-plugin'); assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  assert.equal(f.api.describe('test-plugin').previousVersion, '2.0.0');
  await f.api.uninstall('test-plugin', { keepData: true, keepPlacements: false });
  assert.equal(fs.existsSync(path.join(f.args.dataDir, 'test-plugin', 'data.json')), true);
  assert.deepEqual(f.settings.notchPluginPages, ['other/page']);
  assert.equal(f.settings.pluginStates['test-plugin'], undefined);
  await f.install('1.0.0'); await f.api.uninstall('test-plugin', { keepData: false, keepPlacements: true });
  assert.equal(fs.existsSync(path.join(f.args.dataDir, 'test-plugin', 'data.json')), false);
});
test('stale confirmations, source substitution, version replacement and local-folder collisions are refused', async t => {
  const f = fixture(t), pkg = parsePackage(bytes()); const a = f.api.preview(pkg), b = f.api.preview(pkg); await f.api.install(a.token);
  await assert.rejects(async () => await f.api.install(b.token), /version changed/);
  assert.throws(() => f.api.preview(pkg), /newer version/);
  assert.throws(() => f.api.preview(parsePackage(bytes('2.0.0')), { id: 'other' }), /source differs/);
  await f.api.uninstall('test-plugin'); fs.mkdirSync(path.join(f.args.userDir, 'test-plugin'));
  assert.throws(() => f.api.preview(pkg), /development plugin/);
});
test('flush failure leaves the installed files and registry untouched', async t => {
  const f = fixture(t); await f.install('1.0.0'); f.args.manager.beginMutation = () => { throw new Error('flush failed'); };
  await assert.rejects(async () => await f.install('2.0.0'), /flush failed/);
  assert.equal(f.api.describe('test-plugin').version, '1.0.0');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
});
for (const point of ['prepared', 'old-moved', 'new-moved', 'registry-written', 'settings-written', 'reloaded']) {
  test(`failed update restores files, data and consent after ${point}`, async t => {
    let armed = false; const f = fixture(t, step => { if (armed && step === point) throw new Error('injected interruption'); }); await f.install('1.0.0');
    f.settings.pluginStates['test-plugin'] = { enabled: true, trustedRevision: 'a'.repeat(64) }; armed = true;
    await assert.rejects(async () => await f.install('2.0.0'), /injected interruption/);
    assert.equal(f.api.describe('test-plugin').version, '1.0.0');
    assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
    assert.equal(f.settings.pluginStates['test-plugin'].enabled, true);
    assert.equal(fs.existsSync(path.join(f.args.root, 'transaction.json')), false);
  });
}
test('startup recovers a transaction interrupted by actual process termination', async t => {
  const f = fixture(t); await f.install('1.0.0');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/pluginManagedInterrupt.js')], {
    input: JSON.stringify({ root: f.args.root, userDir: f.args.userDir, dataDir: f.args.dataDir, package: bytes('2.0.0').toString() })
  });
  assert.equal(child.status, 87, child.stderr.toString());
  const recovered = createManagedPlugins(f.args); recovered.recover();
  assert.equal(recovered.describe('test-plugin').version, '1.0.0');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
});

test('installed backend bytes preserve exact content', async t => {
  const f = fixture(t); await f.install('1.0.0');
  const target = path.join(f.args.userDir, 'test-plugin');
  assert.deepEqual(packageDirectory(target).files['main.js'], parsePackage(bytes()).files['main.js']);
});
test('corrupt current versions can be rolled back or uninstalled without parsing them', async t => {
  const f = fixture(t); await f.install('1.0.0'); await f.install('2.0.0');
  fs.writeFileSync(path.join(f.args.userDir, 'test-plugin/manifest.json'), '{broken');
  await f.api.rollback('test-plugin');
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  assert.equal(f.api.describe('test-plugin').previousVersion, null);
  assert.equal(fs.existsSync(path.join(f.args.root, 'previous/test-plugin.tmplugin')), false);
  fs.writeFileSync(path.join(f.args.userDir, 'test-plugin/manifest.json'), 'x'.repeat(300 * 1024));
  await f.api.uninstall('test-plugin');
  assert.equal(f.api.describe('test-plugin'), null);
});
test('host upgrade permits removal and replacement while refusing incompatible rollback targets', async t => {
  const f = fixture(t), host = require('../../package.json'), original = host.version;
  t.after(() => { host.version = original; });
  await f.install('1.0.0', { engines: { tokenMonitor: original } });
  host.version = '999.0.0';
  await f.install('2.0.0', { engines: { tokenMonitor: '999.0.0' } });
  await assert.rejects(async () => await f.api.rollback('test-plugin'), /incompatible/);
  assert.equal(f.api.describe('test-plugin').version, '2.0.0');
  host.version = '1000.0.0';
  await f.api.uninstall('test-plugin');
  assert.equal(f.api.describe('test-plugin'), null);
});
test('sixty catalog installations with long URLs survive registry reload and interrupted update', async t => {
  let armed = false;
  const f = fixture(t, step => { if (armed && step === 'registry-written') throw new Error('interrupted'); });
  const origin = { id: 'custom-11111111-1111-1111-1111-111111111111', kind: 'community', label: 'Fixture catalog', fingerprint: '', signed: false, cached: true, lastFetched: Date.now(), error: '', url: 'https://catalog.example/index?' + 's'.repeat(2000), packageUrl: 'https://catalog.example/package?' + 'p'.repeat(2000) };
  for (let i = 0; i < 60; i++) await f.api.install(f.api.preview(parsePackage(bytes('1.0.0', { id: 'plugin-' + i })), origin).token);
  const size = fs.statSync(path.join(f.args.root, 'installed.json')).size;
  assert.ok(size > 256 * 1024 && size < MAX_REGISTRY_BYTES);
  const restarted = createManagedPlugins(f.args); restarted.recover();
  assert.equal(restarted.describe('plugin-59').version, '1.0.0');
  armed = true;
  await assert.rejects(async () => await restarted.install(restarted.preview(parsePackage(bytes('2.0.0', { id: 'plugin-59' })), origin).token), /interrupted/);
  restarted.recover(); assert.equal(restarted.describe('plugin-59').version, '1.0.0');
});
test('registry and journal capacity failures leave prior installs recoverable', async t => {
  const f = fixture(t); await f.install('1.0.0');
  const before = fs.readFileSync(path.join(f.args.root, 'installed.json'));
  const oversizedOrigin = { id: 'local', label: 'x'.repeat(MAX_REGISTRY_BYTES) };
  await assert.rejects(async () => await f.api.install(f.api.preview(parsePackage(bytes('2.0.0')), oversizedOrigin).token), /metadata exceeds/);
  assert.deepEqual(fs.readFileSync(path.join(f.args.root, 'installed.json')), before);
  f.settings.homeModuleOrder = 'x'.repeat(MAX_JOURNAL_BYTES);
  await assert.rejects(async () => await f.install('2.0.0'), /metadata exceeds/);
  assert.equal(fs.existsSync(path.join(f.args.root, 'transaction.json')), false);
  assert.equal(packageDirectory(path.join(f.args.userDir, 'test-plugin')).manifest.version, '1.0.0');
  createManagedPlugins(f.args).recover();
});

for (const point of ['old-moved', 'registry-written', 'settings-written', 'reloaded']) {
  test(`author settings uninstall rollback preserves bytes after ${point}`, async t => {
    let armed = false;
    const f = fixture(t, step => { if (armed && step === point) throw new Error('interrupted'); });
    await f.install('1.0.0');
    fs.mkdirSync(f.args.settingsDir);
    const file = path.join(f.args.settingsDir, 'test-plugin.json');
    const original = '{"version":1,"revision":7,"values":{"private":"keep"}}';
    fs.writeFileSync(file, original);
    armed = true;
    await assert.rejects(async () => await f.api.uninstall('test-plugin', { keepData: false }), /interrupted/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    armed = false;
    await f.api.uninstall('test-plugin', { keepData: true });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await f.install('1.0.0');
    await f.api.uninstall('test-plugin', { keepData: false });
    assert.equal(fs.existsSync(file), false);
  });
}


for (const version of ['01.0.0', '1.01.0', '1.0.01', '1.0.0-01', '1.0.0-a..b', '1.0.0-', '9007199254740992.0.0']) {
  test(`invalid version ${version} is rejected before registry mutation`, async t => {
    const f = fixture(t); await f.install('1.0.0');
    const before = snapshot(f);
    assert.throws(() => parsePackage(bytes(version)), /version must be semver/);
    assert.deepEqual(snapshot(f), before);
    const restarted = createManagedPlugins(f.args); restarted.recover();
    assert.equal(restarted.status().available, true);
    assert.equal(restarted.describe('test-plugin').version, '1.0.0');
    await restarted.uninstall('test-plugin'); restarted.dispose(); f.api.dispose();
  });
}
for (const version of ['0.0.0', '1.2.3', '1.2.3-alpha.1', '1.2.3+build.01']) {
  test(`valid version ${version} survives install and management restart`, async t => {
    const f = fixture(t); await f.install(version);
    const restarted = createManagedPlugins(f.args); restarted.recover();
    assert.equal(restarted.status().available, true);
    assert.equal(restarted.describe('test-plugin').version, version);
    await restarted.uninstall('test-plugin'); restarted.dispose(); f.api.dispose();
  });
}

for (const keepPlacements of [false, true]) test(`compact placement transaction restores all keys after uninstall interruption, keep=${keepPlacements}`, async t => {
  let armed = false, journal;
  const f = await historyFixture(t, step => {
    if (armed && step === 'settings-written') {
      journal = JSON.parse(fs.readFileSync(path.join(f.args.root, 'transaction.json')));
      throw new Error('compact placement interruption');
    }
  });
  const before = snapshot(f); armed = true;
  await assert.rejects(f.api.uninstall('test-plugin', { keepData: true, keepPlacements }), /compact placement interruption/);
  for (const key of ['floatingBubbleCustomLayout', 'notchCustomLayout', 'notchPageOrder']) assert.deepEqual(journal.settings[key], before.settings[key]);
  assert.deepEqual(snapshot(f), before);
  const restarted = createManagedPlugins(f.args); restarted.recover();
  assert.deepEqual(snapshot(f), before);
});
