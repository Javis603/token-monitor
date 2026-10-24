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
const { digest, parsePackage, packageDirectory } = require('../../src/electron/plugins/package');
const { createDataBus } = require('../../src/shared/plugins/dataBus');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const URL = 'https://catalog.example/index.json';
function packageBytes(version = '1.0.0', permissions = []) {
  return Buffer.from(JSON.stringify({ format: 1, manifest: { id: 'community-demo', name: 'Community demo', version, tmApi: '^1', permissions,
    views: [{ id: 'overview', title: 'Overview', surfaces: ['page'], layout: { type: 'text', value: 'community example' } }] } }));
}
function index(bytes = packageBytes()) {
  return { format: 1, title: 'Test fixture catalog', official: true, plugins: [{ id: 'community-demo', name: 'Demo', author: 'Fixture author', versions: [{ version: JSON.parse(bytes).manifest.version,
    sha256: digest(bytes), url: 'https://catalog.example/demo.tmplugin' }] }] };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-catalog-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
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
test('removing a source aborts its download and prevents a late result restoring the source', async t => {
  const root = temp(t); let resolve;
  const sources = createCatalogSources({ root, fetchImpl: () => new Promise(r => { resolve = r; }) });
  const pending = sources.add({ url: URL }); const id = sources.list().sources[0].id;
  sources.remove(id); resolve(new Response(JSON.stringify(index()))); await pending;
  assert.equal(sources.entries().length, 0); assert.equal(sources.list().sources.length, 0);
});
test('discover → verify → install → approve → update pauses new access → rollback → uninstall', async t => {
  const dir = temp(t), userDir = path.join(dir, 'plugins'), builtinDir = path.join(dir, 'builtin'); fs.mkdirSync(builtinDir);
  let settings = { pluginStates: {}, homeModuleOrder: '', hiddenHomeModules: '', edgeDockItems: null, notchPluginPages: [] };
  const bus = createDataBus();
  const manager = createPluginManager({ builtinDir, userDir, dataDir: path.join(dir, 'data'), bus, getSettings: () => settings,
    saveStates: states => { settings.pluginStates = states; } });
  t.after(() => { manager.dispose(); bus.dispose(); });
  const managed = createManagedPlugins({ root: path.join(dir, 'managed'), userDir, dataDir: path.join(dir, 'data'), manager,
    getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } }); managed.recover(); manager.reload();
  let pkg = packageBytes(); let mismatch = false;
  const catalog = createPluginCatalog({ root: path.join(dir, 'catalog'), manager, managed,
    fetchImpl: async url => new Response(url.endsWith('.tmplugin') ? (mismatch ? packageBytes('3.0.0') : pkg) : JSON.stringify(index(pkg))) });
  t.after(() => catalog.dispose()); await catalog.addSource({ url: URL });
  let entry = catalog.list().entries.find(p => p.id === 'community-demo'); assert.equal(entry.origin.kind, 'community');
  let preview = await catalog.preview(entry.origin.id, entry.id, entry.version); managed.install(preview.token);
  assert.equal(manager.list().plugins[0].status, 'disabled'); manager.setEnabled(entry.id, true);
  assert.equal(manager.list().plugins[0].status, 'active');
  pkg = packageBytes('2.0.0', ['sys.cpu']); await catalog.refreshSource(entry.origin.id);
  entry = catalog.list().entries.find(p => p.id === entry.id); assert.equal(entry.status, 'update');
  mismatch = true; await assert.rejects(catalog.preview(entry.origin.id, entry.id, entry.version), /SHA-256/); mismatch = false;
  preview = await catalog.preview(entry.origin.id, entry.id, entry.version); managed.install(preview.token);
  assert.equal(manager.list().plugins[0].status, 'needsApproval'); assert.deepEqual(settings.pluginStates[entry.id].grant.permissions, []);
  managed.rollback(entry.id); assert.equal(manager.list().plugins[0].status, 'active');
  assert.equal(packageDirectory(path.join(userDir, entry.id)).manifest.version, '1.0.0');
  managed.uninstall(entry.id); assert.equal(manager.list().plugins.length, 0);
});
test('the shipped official package matches the authoring example', () => {
  const expected = packageDirectory(path.join(__dirname, '../../docs/plugins/examples/token-pulse'));
  const shipped = parsePackage(fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/catalog/token-pulse.tmplugin')));
  assert.equal(shipped.hash, expected.hash);
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
  assert.equal(entries.find(e => e.id === 'token-pulse').status, 'update');
  const entry = entries.find(e => e.id === 'community-demo');
  assert.equal(entry.status, 'update'); assert.equal(entry.installedVersion, '1.0.0');
  assert.equal(entry.versions[0].installable, true);
  assert.equal((await catalog.preview(source.id, entry.id, entry.version)).version, '2.0.0');
  origins.delete('community-demo');
  assert.equal(catalog.list().entries.find(e => e.id === 'community-demo').versions[0].installable, false);
});
