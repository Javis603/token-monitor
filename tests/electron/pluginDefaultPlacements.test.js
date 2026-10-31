'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { initialSetupPlan, placementKey } = require('../../src/electron/plugins/initialSetup');

async function setup(t, id = 'trusted-fixture') {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-initial-'));
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, '../fixtures/trusted-plugin'), sourceDirectory, { recursive: true });
  const file = path.join(sourceDirectory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.id = id; manifest.views.find(view => view.id === 'panel').defaultSurfaces = ['page', 'notch'];
  fs.writeFileSync(file, JSON.stringify(manifest));
  const f = await runtimeFixture(t, { sourceDirectory, initialSettings: { pluginMainPages: [], notchPluginPages: [], homeModuleOrder: 'native', notchEnabled: false, edgeDockEnabled: false } });
  return { f, manifest, file };
}

test('default surfaces stay within declared locations and initial choices reject foreign views', () => {
  const manifest = { tmApi: 1, id: 'test-plugin', version: '1.0.0', name: 'Test', ui: 'ui.mjs', files: ['ui.mjs'], views: [{ id: 'panel', surfaces: ['page'] }] };
  for (const value of [['notch'], ['page', 'page'], 'page', ['settings']]) assert.equal(normalizeManifest({ ...manifest, views: [{ ...manifest.views[0], defaultSurfaces: value }] }).ok, false);
  assert.throws(() => initialSetupPlan({}, normalizeManifest(manifest).manifest, { 'placement:other/view:page': true }), /Invalid initial/);
});

test('initial locations preserve removal across toggles, updates and retained reinstall without enabling host switches', async t => {
  const { f, manifest, file } = await setup(t);
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.deepEqual(f.settings.pluginMainPages, ['trusted-fixture/panel']);
  assert.deepEqual(f.settings.notchPluginPages, ['trusted-fixture/panel']);
  assert.equal(f.settings.notchEnabled, false); assert.equal(f.settings.edgeDockEnabled, false);
  for (const surface of ['page', 'notch']) await f.invoke('plugins:place', { ref: 'trusted-fixture/panel', surface, placed: false });
  await f.invoke('plugins:setEnabled', { id: manifest.id, enabled: false });
  await f.invoke('plugins:setEnabled', { id: manifest.id, enabled: true });
  manifest.version = '2.0.0'; fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory'); await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  await f.invoke('plugins:uninstall', manifest.id, { keepPlacements: true });
  preview = await f.invoke('plugins:import', 'directory'); await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.deepEqual(f.settings.pluginMainPages, []); assert.deepEqual(f.settings.notchPluginPages, []);
  await f.invoke('plugins:uninstall', manifest.id, { keepPlacements: false });
  preview = await f.invoke('plugins:import', 'directory'); await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.deepEqual(f.settings.pluginMainPages, ['trusted-fixture/panel']);
});

for (const selected of [false, true]) test(`install-only defers explicit initial locations, notch=${selected}`, async t => {
  const { f } = await setup(t); const preview = await f.invoke('plugins:import', 'directory');
  const choices = { ...preview.initialSetup.values };
  for (const key of Object.keys(choices).filter(key => key.startsWith('placement:'))) choices[key] = key.endsWith(':notch') && selected;
  await f.invoke('plugins:install', preview.token, { initialSetup: choices });
  assert.equal(f.runtime.manager.backendCount(), 0); assert.deepEqual(f.settings.notchPluginPages, []);
  await f.runtime.manager.reload(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.deepEqual(f.settings.pluginMainPages, []); assert.deepEqual(f.settings.notchPluginPages, selected ? ['trusted-fixture/panel'] : []);
});

test('full locations do not evict entries and stale pending views are not reapplied', () => {
  const plugin = normalizeManifest({ tmApi: 1, id: 'demo', name: 'Demo', version: '1.0.0', ui: 'ui.mjs', files: ['ui.mjs'], views: [{ id: 'panel', surfaces: ['page'], defaultSurfaces: ['page'] }] }).manifest;
  const settings = { pluginMainPages: Array.from({ length: 32 }, (_, i) => `other/page-${i}`), pluginInitialSetup: { demo: { values: { 'placement:demo/removed:notch': true }, applied: [] } } };
  const { patch } = initialSetupPlan(settings, plugin);
  assert.equal(patch.pluginMainPages, undefined); assert.equal(patch.notchPluginPages, undefined);
  assert.ok(patch.pluginInitialSetup.demo.applied.includes('placement:demo/panel:page'));
});

test('manual placement overrides only that pending field; updates initialize only new view locations', async t => {
  const { f, manifest, file } = await setup(t); let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token);
  await f.invoke('plugins:place', { ref: 'trusted-fixture/panel', surface: 'page', placed: false });
  await f.invoke('plugins:setEnabled', { id: manifest.id, enabled: true });
  assert.deepEqual(f.settings.pluginMainPages, []); assert.deepEqual(f.settings.notchPluginPages, ['trusted-fixture/panel']);
  manifest.version = '2.0.0'; manifest.views.push({ id: 'new-page', title: 'New', surfaces: ['page'], defaultSurfaces: ['page'] });
  fs.writeFileSync(file, JSON.stringify(manifest)); preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.deepEqual(f.settings.pluginMainPages, ['trusted-fixture/new-page']);
});

test('constructor plugin ids use own initial records', async t => {
  const { f } = await setup(t, 'constructor'); const preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.equal(Object.hasOwn(f.settings.pluginInitialSetup, 'constructor'), true);
  assert.ok(f.settings.pluginInitialSetup.constructor.applied.includes(placementKey('constructor/panel', 'page')));
  assert.deepEqual(f.settings.pluginMainPages, ['constructor/panel']);
});
