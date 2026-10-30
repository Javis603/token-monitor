'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCatalogSources } = require('../../src/electron/plugins/catalogSources');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const { packageDirectory, digest } = require('../../src/electron/plugins/package');
const definition = { id: 'official-fixture', label: 'Host official', url: 'https://official.example/catalog.json' };
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-official-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const original = packageDirectory(path.join(__dirname, '../fixtures/trusted-plugin')).bytes;
const bytes = version => { const p = JSON.parse(original); p.manifest.version = version; return Buffer.from(JSON.stringify(p)); };
const index = data => ({ format: 1, title: 'Publisher-controlled name', kind: 'official', plugins: [{ id: 'trusted-fixture', name: 'Fixture', author: 'Official', versions: [{ version: JSON.parse(data).manifest.version, url: 'https://official.example/package.tmplugin', sha256: digest(data) }] }] });
test('only host definitions grant remote official provenance, including cached restarts', async t => {
  const dir = temp(t), raw = index(bytes('1.0.0'));
  raw.plugins[0].origin = { kind: 'official' };
  const fetchImpl = async () => new Response(JSON.stringify(raw));
  let sources = createCatalogSources({ root: dir, fetchImpl, officialSources: [definition] });
  await sources.refresh(definition.id);
  assert.equal(sources.entries()[0].origin.kind, 'official'); assert.equal(sources.entries()[0].origin.label, definition.label);
  assert.throws(() => sources.remove(definition.id), /cannot be removed/);
  await sources.add({ url: 'https://custom.example/catalog.json', kind: 'official', id: definition.id });
  assert.equal(sources.entries().find(p => p.origin.kind === 'community').origin.label, raw.title);
  sources.dispose(); sources = createCatalogSources({ root: dir, fetchImpl, officialSources: [definition] }); t.after(() => sources.dispose());
  assert.equal(sources.entries().find(p => p.origin.id === definition.id).origin.kind, 'official');
  assert.equal(sources.entries().find(p => p.origin.id.startsWith('custom-')).origin.kind, 'community');
});
test('official source refreshes independently, retains offline cache and validates hashes', async t => {
  let now = 1000, calls = 0, offline = false, bad = false;
  const data = bytes('1.0.0');
  const catalog = createPluginCatalog({ root: temp(t), catalogDirectory: temp(t), now: () => now, officialSources: [definition],
    manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {}, preview() { return 'verified'; } },
    fetchImpl: async url => { calls++; if (offline) throw Error('offline'); return new Response(url === definition.url ? JSON.stringify(index(data)) : bad ? bytes('2.0.0') : data); } });
  t.after(() => catalog.dispose()); await catalog.discover(); assert.equal(calls, 1);
  assert.equal(await catalog.preview(definition.id, 'trusted-fixture', '1.0.0'), 'verified');
  bad = true; await assert.rejects(catalog.preview(definition.id, 'trusted-fixture', '1.0.0'), /SHA-256/);
  now += 6 * 60 * 60 * 1000; offline = true; await catalog.discover();
  assert.equal(catalog.list().entries[0].origin.kind, 'official'); assert.equal(catalog.list().entries[0].status, 'available');
  assert.ok(catalog.list().sources.find(s => s.id === definition.id).error);
});
test('remote install/update remain explicit, disabled and same-origin with retained plugin data', async t => {
  const dir = temp(t); let data = bytes('1.0.0'), settings = { pluginsEnabled: true, pluginStates: {} };
  const userDir = path.join(dir, 'plugins'), dataDir = path.join(dir, 'data');
  const manager = createPluginManager({ userDir, dataDir, getSettings: () => settings, saveStates: value => { settings.pluginStates = value; }, fork: () => assert.fail('install-only must not execute') });
  const managed = createManagedPlugins({ root: path.join(dir, 'managed'), userDir, dataDir, manager, getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } });
  const catalog = createPluginCatalog({ root: path.join(dir, 'catalog'), catalogDirectory: temp(t), officialSources: [definition], manager, managed,
    fetchImpl: async url => new Response(url === definition.url ? JSON.stringify(index(data)) : data) });
  t.after(async () => { catalog.dispose(); managed.dispose(); await manager.dispose(); });
  managed.recover(); await manager.reload(); await catalog.discover();
  assert.equal(manager.list().plugins.length, 0);
  await managed.install((await catalog.preview(definition.id, 'trusted-fixture', '1.0.0')).token);
  fs.mkdirSync(path.join(dataDir, 'trusted-fixture'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'trusted-fixture/marker'), 'retained');
  data = bytes('2.0.0'); await catalog.discover(true); assert.equal(catalog.list().entries[0].status, 'update');
  assert.equal(managed.describe('trusted-fixture').version, '1.0.0', 'discover does not install');
  await managed.install((await catalog.preview(definition.id, 'trusted-fixture', '2.0.0')).token);
  assert.equal(manager.list().plugins[0].status, 'disabled'); assert.equal(manager.backendCount(), 0);
  assert.equal(managed.describe('trusted-fixture').origin.id, definition.id);
  assert.equal(fs.readFileSync(path.join(dataDir, 'trusted-fixture/marker'), 'utf8'), 'retained');
  await managed.rollback('trusted-fixture'); assert.equal(managed.describe('trusted-fixture').version, '1.0.0');
});
