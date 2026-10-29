'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { initialSetupReview, initialSetupPlan } = require('../../src/electron/plugins/initialSetup');
const { runtimeFixture } = require('../helpers/trustedPlugin');

function raw() {
  return { tmApi: 1, id: 'setup-fixture', name: 'Setup fixture', version: '1.0.0', ui: 'ui.mjs', backend: 'backend.cjs', files: ['ui.mjs', 'backend.cjs'], background: true,
    views: [{ id: 'page', title: 'Page', surfaces: ['page', 'notch'], defaultSurfaces: ['page'] },
      { id: 'details', title: 'Details', targets: ['main.home.content'], mode: 'replace' },
      { id: 'compact', title: 'Compact', targets: ['main.home.content'], mode: 'replace' }],
    skins: [{ id: 'blue', name: 'Blue', colors: { accent: '#abcdef' }, appearance: { font: 'mono' } }],
    defaults: { content: { 'main.home.content': 'compact' }, background: true, skin: 'blue' } };
}
async function fixture(t) {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-test-'));
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
  const manifest = raw(), file = path.join(sourceDirectory, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(path.join(sourceDirectory, 'ui.mjs'), 'export function mount(){}');
  fs.writeFileSync(path.join(sourceDirectory, 'backend.cjs'), 'exports.activate=()=>({});');
  const f = await runtimeFixture(t, { sourceDirectory, initialSettings: { pluginMainPages: [], notchPluginPages: [], notchEnabled: false, edgeDockEnabled: false, themeColors: { accent: '#112233' }, vendorColors: {} } });
  return { f, manifest, file };
}

test('manifest defaults select declared replacements, optional background support and a declared skin', () => {
  const manifest = normalizeManifest(raw()).manifest;
  const review = initialSetupReview({}, manifest);
  assert.equal(review.values['content:main.home.content'], 'setup-fixture/compact');
  assert.equal(review.values.background, true); assert.equal(review.values.skin, 'setup-fixture/blue');
  for (const defaults of [{ content: { 'main.home.content': 'missing' } }, { content: { 'main.unknown.content': null } }, { background: 'yes' }, { skin: 'missing' }, { other: true }, []]) {
    assert.equal(normalizeManifest({ ...raw(), defaults }).ok, false, JSON.stringify(defaults));
  }
  assert.equal(normalizeManifest({ ...raw(), background: false }).ok, false);
  assert.equal(normalizeManifest({ ...raw(), defaults: { content: { 'main.home.content': null }, background: false, skin: null } }).ok, true);
});

test('initial review rejects undeclared or incorrectly typed choices before changing anything', () => {
  const plugin = normalizeManifest(raw()).manifest, settings = { pluginInitialSetup: {} };
  for (const choices of [{ background: null }, { skin: 'other/blue' }, { 'content:main.home.content': 'other/view' }, { unknown: true }, { 'placement:setup-fixture/page:tray': true }]) {
    assert.throws(() => initialSetupPlan(settings, plugin, choices), /Invalid initial/);
  }
  assert.deepEqual(settings, { pluginInitialSetup: {} });
});

test('install-and-enable applies all four author suggestions together, using host-owned skin snapshots', async t => {
  const { f } = await fixture(t); const preview = await f.invoke('plugins:import', 'directory');
  assert.ok(preview.initialSetup.fields.some(field => field.kind === 'skin'));
  await f.invoke('plugins:install', preview.token, { trustInstall: true, initialSetup: preview.initialSetup.values });
  assert.deepEqual(f.settings.pluginMainPages, ['setup-fixture/page']);
  assert.equal(f.settings.pluginContentSelections['main.home.content'], 'setup-fixture/compact');
  assert.equal(f.settings.pluginStates['setup-fixture'].background, true);
  assert.equal(f.settings.themeColors.accent, '#abcdef');
  assert.equal(f.settings.pluginAuthorSkin.ref, 'setup-fixture/blue');
  assert.equal(f.settings.pluginAuthorSkin.appearance.font, 'mono');
  assert.equal(f.settings.notchEnabled, false);
  assert.equal(f.invoke('plugins:list').plugins[0].initialSetup.fields.length, 0);
});

test('install-only persists explicit opt-outs and applies them only on first enable', async t => {
  const { f } = await fixture(t); const preview = await f.invoke('plugins:import', 'directory');
  const values = { ...preview.initialSetup.values, background: false, skin: null, 'content:main.home.content': null, 'placement:setup-fixture/page:page': false };
  await f.invoke('plugins:install', preview.token, { initialSetup: values });
  assert.equal(f.runtime.manager.backendCount(), 0); assert.equal(f.settings.themeColors.accent, '#112233');
  assert.deepEqual(f.settings.pluginInitialSetup['setup-fixture'].applied, []);
  await f.runtime.manager.reload(); await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true });
  assert.deepEqual(f.settings.pluginMainPages, []); assert.equal(f.settings.pluginContentSelections['main.home.content'], undefined);
  assert.equal(f.settings.pluginStates['setup-fixture'].background, false); assert.equal(f.settings.pluginAuthorSkin, null);
  assert.equal(f.settings.themeColors.accent, '#112233');
});

test('first enable can revise pending choices, and later enables and updates leave those decisions alone', async t => {
  const { f, manifest, file } = await fixture(t); let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token);
  const values = f.invoke('plugins:list').plugins[0].initialSetup.values;
  await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true, initialSetup: { ...values, background: false, skin: null, 'content:main.home.content': null } });
  for (const enabled of [false, true]) await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled });
  manifest.version = '2.0.0'; manifest.views.push({ id: 'new-page', title: 'New', surfaces: ['page'], defaultSurfaces: ['page'] });
  fs.writeFileSync(file, JSON.stringify(manifest)); preview = await f.invoke('plugins:import', 'directory');
  assert.deepEqual(preview.initialSetup.fields.map(field => field.key), ['placement:setup-fixture/new-page:page']);
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginStates['setup-fixture'].background, false);
  assert.equal(f.settings.pluginAuthorSkin, null); assert.equal(f.settings.pluginContentSelections['main.home.content'], undefined);
  assert.deepEqual(f.settings.pluginMainPages, ['setup-fixture/page', 'setup-fixture/new-page']);
});

test('a manual background decision before first enable overrides the author suggestion', async t => {
  const { f } = await fixture(t); await f.install();
  f.invoke('plugins:setBackground', { id: 'setup-fixture', enabled: false });
  assert.equal(f.invoke('plugins:list').plugins[0].initialSetup.fields.some(field => field.kind === 'background'), false);
  await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true });
  assert.equal(f.settings.pluginStates['setup-fixture'].background, false);
});

test('reinstall retains requested layout and content decisions but reviews background and appearance again', async t => {
  const { f } = await fixture(t); let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  const appliedSkin = structuredClone(f.settings.pluginAuthorSkin);
  await f.invoke('plugins:uninstall', 'setup-fixture', { keepPlacements: true });
  assert.equal(f.settings.pluginStates['setup-fixture'], undefined);
  assert.deepEqual(f.settings.pluginAuthorSkin, appliedSkin);
  preview = await f.invoke('plugins:import', 'directory');
  assert.deepEqual(preview.initialSetup.fields.map(field => field.key), ['background', 'skin']);
  await f.invoke('plugins:install', preview.token, { trustInstall: true, initialSetup: { background: false, skin: null } });
  assert.deepEqual(f.settings.pluginMainPages, ['setup-fixture/page']);
  assert.equal(f.settings.pluginContentSelections['main.home.content'], 'setup-fixture/compact');
  assert.equal(f.settings.pluginStates['setup-fixture'].background, false);
  assert.deepEqual(f.settings.pluginAuthorSkin, appliedSkin);
});

test('repairing a removed replacement does not restore a different target explicitly set to native', () => {
  const plugin = normalizeManifest({ ...raw(), views: [...raw().views,
    { id: 'other', title: 'Other', targets: ['main.model.content'], mode: 'replace' }] }).manifest;
  const settings = { pluginInitialSetup: {}, pluginContentSelections: { 'main.home.content': 'setup-fixture/removed', 'main.model.content': 'setup-fixture/other' } };
  const plan = initialSetupPlan(settings, plugin, { 'content:main.model.content': null }, { updating: true });
  assert.equal(plan.patch.pluginContentSelections['main.home.content'], 'setup-fixture/details');
  assert.equal(plan.patch.pluginContentSelections['main.model.content'], undefined);
});
