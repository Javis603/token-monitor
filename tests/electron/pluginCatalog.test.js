'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseIndex, createCatalogSources, download } = require('../../src/electron/plugins/catalogSources');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const { digest, packageDirectory } = require('../../src/electron/plugins/package');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const URL = 'https://catalog.example/index.json';
function packageBytes(version = '1.0.0') {
  return Buffer.from(JSON.stringify({ format: 2, manifest: { id: 'community-demo', name: 'Community demo', version, tmApi: 1, ui: 'ui.mjs', files: ['ui.mjs'],
    views: [{ id: 'overview', title: 'Overview', surfaces: ['page'] }] }, files: { 'ui.mjs': Buffer.from('export function mount() {}').toString('base64') } }));
}
function index(bytes = packageBytes()) {
  return { format: 1, title: 'Test fixture catalog', official: true, plugins: [{ id: 'community-demo', name: 'Demo', author: 'Fixture author', versions: [{ version: JSON.parse(bytes).manifest.version,
    sha256: digest(bytes), url: 'https://catalog.example/demo.tmplugin' }] }] };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-catalog-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('the shipped official catalog remains available and empty without showcase plugins', t => {
  const catalog = createPluginCatalog({ root: temp(t), manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    fetchImpl: () => assert.fail('local discovery must not fetch') });
  t.after(() => catalog.dispose());
  assert.deepEqual(catalog.list().sources.map(source => [source.id, source.kind]), [['bundled', 'official']]);
  assert.deepEqual(catalog.list().entries, []); assert.equal(catalog.list().error, '');
});
test('local official packages install offline, survive restart, update with renewed trust and roll back', async t => {
  const root = temp(t), userDir = path.join(root, 'plugins'), catalogDirectory = path.join(root, 'official');
  fs.mkdirSync(catalogDirectory);
  let settings = { pluginStates: {} }, manager, managed, catalog;
  const boot = async () => {
    manager = createPluginManager({ userDir, dataDir: path.join(root, 'data'), getSettings: () => settings, saveStates: value => { settings.pluginStates = value; } });
    managed = createManagedPlugins({ root: path.join(root, 'managed'), userDir, dataDir: path.join(root, 'data'), manager, getSettings: () => settings,
      saveSettings: patch => { settings = { ...settings, ...patch }; } });
    managed.recover(); await manager.reload();
    catalog = createPluginCatalog({ catalogDirectory, root: path.join(root, 'catalog'), manager, managed, fetchImpl: () => assert.fail('official catalog is offline') });
  };
  t.after(async () => { catalog?.dispose(); managed?.dispose(); await manager?.dispose(); });
  fs.writeFileSync(path.join(catalogDirectory, 'fixture.tmplugin'), packageBytes()); await boot();
  const entry = catalog.list().entries[0]; assert.equal(entry?.origin.kind, 'official'); assert.equal(entry.status, 'available');
  await assert.rejects(catalog.preview('bundled', entry.id, '9.0.0'), /version/);
  await managed.install((await catalog.preview('bundled', entry.id, entry.version)).token);
  assert.equal(manager.list().plugins[0].status, 'disabled'); manager.setEnabled(entry.id, true);
  const trustedRevision = settings.pluginStates[entry.id].trustedRevision;
  catalog.dispose(); managed.dispose(); await manager.dispose(); await boot();
  assert.equal(manager.list().plugins[0].status, 'active'); assert.equal(manager.backendCount(), 0);
  assert.equal(managed.describe(entry.id).origin.id, 'bundled');
  catalog.dispose(); managed.dispose(); await manager.dispose();
  fs.writeFileSync(path.join(catalogDirectory, 'fixture.tmplugin'), packageBytes('2.0.0')); await boot();
  assert.equal(catalog.list().entries[0].status, 'update');
  await managed.install((await catalog.preview('bundled', entry.id, '2.0.0')).token);
  assert.equal(manager.list().plugins[0].status, 'needsApproval');
  await managed.rollback(entry.id); assert.equal(manager.list().plugins[0].status, 'active');
  assert.equal(settings.pluginStates[entry.id].trustedRevision, trustedRevision);
  await managed.uninstall(entry.id); assert.equal(manager.list().plugins.length, 0);
});
test('invalid or incompatible local catalog entries never execute or block management', async t => {
  const root = temp(t), catalogDirectory = path.join(root, 'official'); fs.mkdirSync(catalogDirectory);
  fs.writeFileSync(path.join(catalogDirectory, 'broken.tmplugin'), '{broken');
  const pkg = JSON.parse(packageBytes()); pkg.manifest.engines = { tokenMonitor: '>=999' };
  fs.writeFileSync(path.join(catalogDirectory, 'future.tmplugin'), JSON.stringify(pkg));
  const catalog = createPluginCatalog({ root: path.join(root, 'sources'), catalogDirectory,
    manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {}, preview() { assert.fail('incompatible preview'); } } });
  t.after(() => catalog.dispose());
  assert.match(catalog.list().error, /broken.tmplugin/); assert.equal(catalog.list().entries[0].status, 'incompatible');
  await assert.rejects(catalog.preview('bundled', 'community-demo', '1.0.0'), /incompatible/);
});
test('catalog validation rejects insecure URLs, duplicate identities, missing digests and incompatible versions', () => {
  assert.equal(parseIndex(Buffer.from(JSON.stringify(index()))).plugins.length, 1);
  for (const url of ['http://catalog.example/a', 'https://user:password@catalog.example/a', 'file:///tmp/a', 'https://catalog.example/a#part']) {
    const raw = index(); raw.plugins[0].versions[0].url = url; assert.throws(() => parseIndex(Buffer.from(JSON.stringify(raw))));
  }
  const raw = index(); raw.plugins[0].versions[0].sha256 = ''; assert.throws(() => parseIndex(Buffer.from(JSON.stringify(raw))), /SHA-256/);
  const duplicate = index(); duplicate.plugins.push(duplicate.plugins[0]); assert.throws(() => parseIndex(Buffer.from(JSON.stringify(duplicate))), /duplicate/);
  const incompatible = index(); incompatible.plugins[0].versions[0].engines = { tokenMonitor: '>=999' };
  assert.equal(parseIndex(Buffer.from(JSON.stringify(incompatible))).plugins[0].versions[0].compatible, false);
});
test('optional key pinning verifies signed bytes and rejects tampering without treating signatures as review', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const payload = Buffer.from(JSON.stringify(index()));
  const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, privateKey).toString('base64') };
  assert.equal(parseIndex(Buffer.from(JSON.stringify(envelope)), publicKey).plugins.length, 1);
  envelope.payload = Buffer.from(JSON.stringify({ ...index(), title: 'tampered' })).toString('base64');
  assert.throws(() => parseIndex(Buffer.from(JSON.stringify(envelope)), publicKey), /invalid/);
  assert.throws(() => parseIndex(payload, publicKey), /required/);
});
test('streaming byte limits and redirects are enforced before package parsing', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await assert.rejects(download(async () => new Response(stream), URL, 20), /size limit/); assert.equal(cancelled, true);
  await assert.rejects(download(async () => new Response('', { status: 302, headers: { location: 'https://other.example/a' } }), URL, 20), /redirects/);
});
test('sources persist validated cache, preserve it after failed refresh and never self-label official', async t => {
  const root = temp(t); let offline = false;
  const fetchImpl = async (_url, init) => { assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual'); if (offline) throw new Error('offline fixture'); return new Response(JSON.stringify(index())); };
  const source = createCatalogSources({ root, fetchImpl }); await source.add({ url: URL });
  const id = source.list().sources[0].id; assert.equal(source.entries()[0].origin.kind, 'community');
  offline = true; await source.refresh(id);
  assert.match(source.list().sources[0].error, /offline/); assert.equal(source.entries().length, 1);
  const restored = createCatalogSources({ root, fetchImpl }); assert.equal(restored.entries().length, 1);
  restored.remove(id); assert.equal(restored.entries().length, 0);
  assert.equal(createCatalogSources({ root, fetchImpl }).list().sources.length, 0);
});
test('only App-supplied definitions receive maintainer provenance, including after cache restart', async t => {
  const root = temp(t), maintainerSources = [{ id: 'maintainer-fixture', url: URL }];
  const raw = index(); raw.title = 'Token Monitor 社群';
  Object.assign(raw, { kind: 'maintainer', featured: true });
  Object.assign(raw.plugins[0], { author: 'Token Monitor 官方', origin: { kind: 'maintainer' } });
  const fetchImpl = async () => new Response(JSON.stringify(raw));
  const sources = createCatalogSources({ root, fetchImpl, maintainerSources });
  t.after(() => sources.dispose());
  assert.equal(sources.list().sources[0].kind, 'maintainer');
  assert.throws(() => sources.remove('maintainer-fixture'), /cannot be removed/);
  await sources.refresh('maintainer-fixture');
  assert.equal(sources.entries()[0].origin.kind, 'maintainer');
  await sources.add({ url: 'https://custom.example/catalog.json', kind: 'maintainer', featured: true });
  assert.equal(sources.entries()[1].origin.kind, 'community');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'sources.json')));
  assert.equal(saved.length, 1); assert.match(saved[0].id, /^custom-/);
  const restored = createCatalogSources({ root, fetchImpl, maintainerSources });
  t.after(() => restored.dispose());
  assert.equal(restored.entries().find(p => p.origin.id === 'maintainer-fixture').origin.kind, 'maintainer');
  const noPreset = createCatalogSources({ root, fetchImpl }); t.after(() => noPreset.dispose());
  assert.equal(noPreset.entries().length, 1); assert.equal(noPreset.entries()[0].origin.kind, 'community');
});
for (const broken of ['malformed', 'directory']) test(`maintainer discovery refreshes independently of ${broken} user configuration`, async t => {
  const root = temp(t), configFile = path.join(root, 'sources.json');
  if (broken === 'malformed') fs.writeFileSync(configFile, '{broken');
  else { fs.mkdirSync(configFile); fs.writeFileSync(path.join(configFile, 'retained'), 'keep'); }
  let requests = 0;
  const catalog = createPluginCatalog({ root, manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    maintainerSources: [{ id: 'maintainer-fixture', url: URL }],
    fetchImpl: async url => { assert.equal(url, URL); requests++; return new Response(JSON.stringify(index())); } });
  t.after(() => catalog.dispose());
  assert.match(catalog.list().error, /could not be loaded/);
  assert.equal(catalog.list().sources.find(s => s.id === 'maintainer-fixture').cached, false);
  const discovered = await catalog.discover();
  assert.equal(requests, 1); assert.equal(discovered.entries[0].origin.kind, 'maintainer');
  assert.match(discovered.error, /could not be loaded/);
  await catalog.discover(); assert.equal(requests, 1);
  await catalog.discover(true); assert.equal(requests, 2);
  await assert.rejects(catalog.addSource({ url: 'https://custom.example/catalog.json' }), /could not be loaded/);
  await assert.rejects(catalog.refreshSource('custom-missing'), /could not be loaded/);
  assert.throws(() => catalog.removeSource('custom-missing'), /could not be loaded/);
  if (broken === 'malformed') assert.equal(fs.readFileSync(configFile, 'utf8'), '{broken');
  else { assert.ok(fs.statSync(configFile).isDirectory()); assert.equal(fs.readFileSync(path.join(configFile, 'retained'), 'utf8'), 'keep'); }
  assert.ok(fs.existsSync(path.join(root, 'maintainer-fixture.json')));
});
test('maintainer discovery bootstraps cache and keeps catalog order, hashes and installation approval', async t => {
  const root = temp(t), userDir = path.join(root, 'plugins');
  let settings = { pluginStates: {} }, requests = 0;
  const manager = createPluginManager({ userDir, dataDir: path.join(root, 'data'), getSettings: () => settings, saveStates: value => { settings.pluginStates = value; } });
  const managed = createManagedPlugins({ root: path.join(root, 'managed'), userDir, dataDir: path.join(root, 'data'), manager, getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } });
  managed.recover(); await manager.reload();
  const raw = index(); raw.plugins.push({ ...raw.plugins[0], id: 'another-plugin' });
  const catalog = createPluginCatalog({ root: path.join(root, 'catalog'), manager, managed,
    maintainerSources: [{ id: 'maintainer-fixture', url: URL }],
    fetchImpl: async url => { requests++; return new Response(url === URL ? JSON.stringify(raw) : packageBytes()); } });
  t.after(async () => { catalog.dispose(); managed.dispose(); await manager.dispose(); });
  assert.equal(requests, 0); assert.deepEqual(catalog.list().entries, []);
  const discovered = await catalog.discover(); assert.equal(requests, 1);
  assert.deepEqual(discovered.entries.map(p => p.id), ['community-demo', 'another-plugin']);
  await catalog.discover(); assert.equal(requests, 1);
  const preview = await catalog.preview('maintainer-fixture', 'community-demo', '1.0.0');
  assert.equal(preview.origin.kind, 'maintainer'); assert.equal(manager.list().plugins.length, 0);
  await managed.install(preview.token, { trustInstall: true });
  assert.equal(managed.describe('community-demo').origin.kind, 'maintainer');
  assert.equal(manager.list().plugins[0].status, 'active');
  await assert.rejects(catalog.preview('maintainer-fixture', 'another-plugin', '1.0.0'), /identity/);
  raw.plugins[0].versions[0].sha256 = '0'.repeat(64); await catalog.discover(true);
  await assert.rejects(catalog.preview('maintainer-fixture', 'community-demo', '1.0.0'), /SHA-256/);
});
test('bundled README uses its GitHub homepage and preserves manual filename order', async t => {
  const root = temp(t), catalogDirectory = path.join(root, 'official'); fs.mkdirSync(catalogDirectory);
  for (const [file, id] of [['20-a.tmplugin', 'alpha-plugin'], ['10-z.tmplugin', 'zulu-plugin']]) {
    const pkg = JSON.parse(packageBytes()); pkg.manifest.id = id; pkg.manifest.homepage = 'https://github.com/owner/plugins';
    fs.writeFileSync(path.join(catalogDirectory, file), JSON.stringify(pkg));
  }
  const catalog = createPluginCatalog({ root: path.join(root, 'catalog'), catalogDirectory,
    manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    fetchImpl: async () => new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('![Preview](shot.png)').toString('base64'),
      html_url: 'https://github.com/owner/plugins/blob/main/README.md', download_url: 'https://raw.githubusercontent.com/owner/plugins/main/README.md' })) });
  t.after(() => catalog.dispose());
  assert.deepEqual(catalog.list().entries.map(p => p.id), ['zulu-plugin', 'alpha-plugin']);
  const details = await catalog.details('bundled', 'zulu-plugin'); assert.equal(details.imageCount, 1);
});
test('removing a source aborts its download and prevents a late result restoring the source', async t => {
  const root = temp(t); let resolve;
  const sources = createCatalogSources({ root, fetchImpl: () => new Promise(r => { resolve = r; }) });
  const pending = sources.add({ url: URL }); const id = sources.list().sources[0].id;
  sources.remove(id); resolve(new Response(JSON.stringify(index()))); await pending;
  assert.equal(sources.entries().length, 0); assert.equal(sources.list().sources.length, 0);
});
for (const operation of ['install', 'update']) test(`a same-source refresh does not block a real ${operation} preview and explicit approval`, async t => {
  const root = temp(t), userDir = path.join(root, 'plugins');
  let settings = { pluginStates: {} }, pkg = packageBytes(), holdIndex = false, finishIndex;
  const manager = createPluginManager({ userDir, dataDir: path.join(root, 'data'), getSettings: () => settings,
    saveStates: states => { settings.pluginStates = states; } });
  const managed = createManagedPlugins({ root: path.join(root, 'managed'), userDir, dataDir: path.join(root, 'data'), manager,
    getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } });
  managed.recover(); await manager.reload();
  const catalog = createPluginCatalog({ root: path.join(root, 'catalog'), manager, managed, fetchImpl: async url => {
    if (url === URL && holdIndex) return new Promise(resolve => { finishIndex = () => resolve(new Response(JSON.stringify(index(pkg)))); });
    return new Response(url === URL ? JSON.stringify(index(pkg)) : pkg);
  } });
  t.after(async () => { finishIndex?.(); catalog.dispose(); managed.dispose(); await manager.dispose(); });
  await catalog.addSource({ url: URL });
  if (operation === 'update') {
    const entry = catalog.list().entries[0];
    await managed.install((await catalog.preview(entry.origin.id, entry.id, entry.version)).token, { trustInstall: true });
    pkg = packageBytes('2.0.0'); await catalog.refreshSource(entry.origin.id);
  }
  const entry = catalog.list().entries[0]; assert.equal(entry.status, operation === 'install' ? 'available' : 'update');
  holdIndex = true; const refreshing = catalog.refreshSource(entry.origin.id);
  assert.equal(catalog.list().sources.find(source => source.id === entry.origin.id).refreshing, true);
  // Keep the index response pending throughout download, preview and install.
  const preview = await catalog.preview(entry.origin.id, entry.id, entry.version);
  assert.equal(preview.version, entry.version); assert.equal(preview.sha256, digest(pkg));
  assert.equal(preview.origin.id, entry.origin.id);
  await managed.install(preview.token, operation === 'install' ? { trustInstall: true } : { trustUpdate: true });
  assert.equal(manager.list().plugins[0].version, entry.version);
  assert.equal(manager.list().plugins[0].status, 'active');
  assert.equal(catalog.list().sources.find(source => source.id === entry.origin.id).refreshing, true);
  finishIndex(); await refreshing;
  assert.equal(catalog.list().sources.find(source => source.id === entry.origin.id).error, '');
  assert.equal(catalog.list().entries[0].status, 'installed');
});
test('package-first overlap stays bounded independently and does not masquerade as an index refresh', async t => {
  const pending = [];
  let hold = false;
  const sources = createCatalogSources({ root: temp(t), fetchImpl: async url => hold
    ? new Promise(resolve => pending.push({ url, resolve })) : new Response(JSON.stringify(index())) });
  t.after(() => sources.dispose()); await sources.add({ url: URL });
  const id = sources.list().sources[0].id; hold = true;
  const downloading = sources.request(id, 'https://catalog.example/demo.tmplugin', 1024);
  assert.equal(sources.list().sources[0].refreshing, false);
  await assert.rejects(sources.request(id, 'https://catalog.example/another.tmplugin', 1024), /download in progress/);
  const refreshing = sources.refresh(id);
  assert.equal(pending.length, 2); assert.equal(sources.list().sources[0].refreshing, true);
  await sources.refresh(id); assert.equal(pending.length, 2);
  assert.match(sources.list().sources[0].error, /download in progress/);
  pending.find(item => item.url === URL).resolve(new Response(JSON.stringify(index()))); await refreshing;
  assert.equal(sources.list().sources[0].refreshing, false);
  pending.find(item => item.url !== URL).resolve(new Response('package')); assert.equal((await downloading).toString(), 'package');
  assert.equal(sources.list().sources[0].error, '');
});
for (const action of ['remove', 'dispose']) test(`${action} aborts both an index refresh and package download and discards late bytes`, async t => {
  const root = temp(t), pending = [];
  let hold = false;
  const sources = createCatalogSources({ root, fetchImpl: async (url, init) => hold
    ? new Promise(resolve => pending.push({ url, signal: init.signal, resolve })) : new Response(JSON.stringify(index())) });
  t.after(() => sources.dispose()); await sources.add({ url: URL });
  const id = sources.list().sources[0].id, cachePath = path.join(root, `${id}.json`), saved = fs.readFileSync(cachePath);
  hold = true; const refreshing = sources.refresh(id);
  const downloading = assert.rejects(sources.request(id, 'https://catalog.example/demo.tmplugin', 1024), /removed|cancelled/);
  assert.equal(pending.length, 2); sources[action](id);
  assert.ok(pending.every(item => item.signal.aborted));
  for (const item of pending) item.resolve(new Response(item.url === URL ? JSON.stringify(index(packageBytes('2.0.0'))) : 'package'));
  await Promise.all([refreshing, downloading]);
  if (action === 'remove') {
    assert.equal(sources.entries().length, 0); assert.equal(fs.existsSync(cachePath), false);
  } else {
    assert.equal(sources.entries()[0].versions[0].version, '1.0.0'); assert.deepEqual(fs.readFileSync(cachePath), saved);
  }
});
test('overlapping index and package requests retain their independent 15-second deadlines', async t => {
  let hold = false;
  const signals = [];
  const sources = createCatalogSources({ root: temp(t), fetchImpl: async (_url, init) => {
    if (!hold) return new Response(JSON.stringify(index()));
    signals.push(init.signal);
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('deadline aborted')), { once: true }));
  } }); t.after(() => sources.dispose()); await sources.add({ url: URL });
  const id = sources.list().sources[0].id;
  t.mock.timers.enable({ apis: ['setTimeout'] }); hold = true;
  const refreshing = sources.refresh(id);
  t.mock.timers.tick(5000);
  const downloading = assert.rejects(sources.request(id, 'https://catalog.example/demo.tmplugin', 1024), /deadline aborted/);
  t.mock.timers.tick(10000); await refreshing;
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(5000); await downloading;
  assert.equal(signals[1].aborted, true);
});
test('discover → verify → install → approve → update pauses new access → rollback → uninstall', async t => {
  const dir = temp(t), userDir = path.join(dir, 'plugins'), builtinDir = path.join(dir, 'builtin'); fs.mkdirSync(builtinDir);
  let settings = { pluginStates: {}, homeModuleOrder: '', hiddenHomeModules: '', edgeDockItems: null, notchPluginPages: [] };
  const manager = createPluginManager({ builtinDir, userDir, dataDir: path.join(dir, 'data'), getSettings: () => settings,
    saveStates: states => { settings.pluginStates = states; } });
  t.after(() => { manager.dispose(); });
  const managed = createManagedPlugins({ root: path.join(dir, 'managed'), userDir, dataDir: path.join(dir, 'data'), manager,
    getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } }); managed.recover(); await manager.reload();
  let pkg = packageBytes(); let mismatch = false;
  const catalog = createPluginCatalog({ root: path.join(dir, 'catalog'), manager, managed,
    fetchImpl: async url => new Response(url.endsWith('.tmplugin') ? (mismatch ? packageBytes('3.0.0') : pkg) : JSON.stringify(index(pkg))) });
  t.after(() => catalog.dispose()); await catalog.addSource({ url: URL });
  let entry = catalog.list().entries.find(p => p.id === 'community-demo'); assert.equal(entry.origin.kind, 'community');
  assert.deepEqual(entry.types, []); // Old catalogs need no new metadata.
  let preview = await catalog.preview(entry.origin.id, entry.id, entry.version); assert.deepEqual(preview.types, ['page']); await managed.install(preview.token);
  assert.deepEqual(manager.list().plugins[0].types, ['page']);
  assert.equal(manager.list().plugins[0].status, 'disabled'); manager.setEnabled(entry.id, true);
  assert.equal(manager.list().plugins[0].status, 'active');
  pkg = packageBytes('2.0.0', ['sys.cpu']); await catalog.refreshSource(entry.origin.id);
  entry = catalog.list().entries.find(p => p.id === entry.id); assert.equal(entry.status, 'update');
  mismatch = true; await assert.rejects(catalog.preview(entry.origin.id, entry.id, entry.version), /SHA-256/); mismatch = false;
  preview = await catalog.preview(entry.origin.id, entry.id, entry.version); await managed.install(preview.token);
  assert.equal(manager.list().plugins[0].status, 'needsApproval'); assert.ok(settings.pluginStates[entry.id].trustedRevision);
  await managed.rollback(entry.id); assert.equal(manager.list().plugins[0].status, 'active');
  assert.equal(packageDirectory(path.join(userDir, entry.id)).manifest.version, '1.0.0');
  await managed.uninstall(entry.id); assert.equal(manager.list().plugins.length, 0);
});
test('normalized source URLs are bounded before persistence and existing sources remain writable', async t => {
  const root = temp(t), fetchImpl = async () => new Response(JSON.stringify(index()));
  const sources = createCatalogSources({ root, fetchImpl });
  await sources.add({ url: URL });
  const before = fs.readFileSync(path.join(root, 'sources.json'));
  await assert.rejects(sources.add({ url: 'https://example.test/' + '中'.repeat(300) }), /normalized HTTPS URL/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'sources.json')), before);
  sources.dispose();
  const restored = createCatalogSources({ root, fetchImpl }); t.after(() => restored.dispose());
  assert.equal(restored.list().error, ''); assert.equal(restored.list().sources.length, 1);
  await restored.add({ url: 'https://second.example/index.json' });
  restored.remove(restored.list().sources[0].id);
  assert.equal(restored.list().sources.length, 1);
  const raw = index(); raw.plugins[0].versions[0].url = 'https://example.test/' + '中'.repeat(300);
  assert.throws(() => parseIndex(Buffer.from(JSON.stringify(raw))), /normalized HTTPS URL/);
});
test('catalog recovery updates use the managed version when discovery is invalid', async t => {
  const root = temp(t), origins = new Map();
  const manager = { list: () => ({ plugins: [{ id: 'community-demo', status: 'invalid' }, { id: 'token-pulse', status: 'invalid' }, { id: 'unknown-local', status: 'invalid' }] }) };
  const managed = { describe: id => origins.get(id), cancelSource() {}, preview: pkg => ({ version: pkg.manifest.version }) };
  const pkg = packageBytes('2.0.0');
  const catalog = createPluginCatalog({ root, manager, managed, fetchImpl: async url => new Response(url.endsWith('.tmplugin') ? pkg : JSON.stringify(index(pkg))) });
  t.after(() => catalog.dispose());
  await catalog.addSource({ url: URL });
  const source = catalog.list().sources.find(s => s.kind === 'community');
  origins.set('community-demo', { version: '1.0.0', origin: { id: source.id } });
  origins.set('token-pulse', { version: '0.0.1', origin: { id: 'bundled' } });
  const entries = catalog.list().entries;
  assert.equal(entries.some(e => e.id === 'token-pulse'), false);
  const entry = entries.find(e => e.id === 'community-demo');
  assert.equal(entry.status, 'update'); assert.equal(entry.installedVersion, '1.0.0');
  assert.equal(entry.versions[0].installable, true);
  assert.equal((await catalog.preview(source.id, entry.id, entry.version)).version, '2.0.0');
  origins.delete('community-demo');
  assert.equal(catalog.list().entries.find(e => e.id === 'community-demo').versions[0].installable, false);
});

test('maintainer catalogs refresh after six hours, coalesce calls, and retain cached entries offline', async t => {
  let time = 1000, calls = 0, offline = false, finish;
  const raw = index();
  const catalog = createPluginCatalog({ root: temp(t), now: () => time,
    manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    maintainerSources: [{ id: 'maintainer-clock', url: URL }], fetchImpl: async () => {
      calls++; if (offline) throw Error('offline');
      if (finish === null) return new Promise(resolve => { finish = () => resolve(new Response(JSON.stringify(raw))); });
      return new Response(JSON.stringify(raw));
    } });
  t.after(() => catalog.dispose());
  await catalog.discover(); assert.equal(calls, 1);
  time += 5 * 60 * 60 * 1000; await catalog.discover(); assert.equal(calls, 1);
  time += 60 * 60 * 1000; finish = null;
  const pending = [catalog.discover(), catalog.discover(true)]; assert.equal(calls, 2); finish(); await Promise.all(pending);
  offline = true; time += 6 * 60 * 60 * 1000;
  const failed = await catalog.discover(); assert.equal(calls, 3); assert.equal(failed.entries.length, 1); assert.match(failed.sources[1].error, /offline/);
  time += 60000; await catalog.discover(); assert.equal(calls, 3);
  await catalog.discover(true); assert.equal(calls, 4);
});
