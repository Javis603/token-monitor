'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { initialSetupReview, initialSetupPlan } = require('../../src/electron/plugins/initialSetup');
const { runtimeFixture } = require('../helpers/trustedPlugin');

function raw() {
  return { tmApi: 1, id: 'setup-fixture', name: 'Setup fixture', version: '1.0.0', ui: 'ui.mjs', backend: 'backend.cjs', files: ['ui.mjs', 'backend.cjs'], background: true,
    backgroundDescription: { en: 'Refresh usage periodically.', 'zh-TW': '定期更新用量資料。' },
    views: [{ id: 'page', title: 'Page', surfaces: ['page', 'notch'], defaultSurfaces: ['page'] },
      { id: 'compact', title: 'Compact', targets: ['main.home.content'], mode: 'replace' }],
    skins: [{ id: 'blue', name: 'Blue', colors: { accent: '#abcdef' }, appearance: { font: 'mono' } }],
    defaults: { content: { 'main.home.content': 'compact' }, background: true, skin: 'blue' } };
}
async function fixture(t, { manifest = raw(), safeMode = false } = {}) {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-test-'));
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
  const file = path.join(sourceDirectory, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(path.join(sourceDirectory, 'ui.mjs'), 'export function mount(){}');
  fs.writeFileSync(path.join(sourceDirectory, 'backend.cjs'), 'exports.activate=()=>({});');
  const f = await runtimeFixture(t, { sourceDirectory, safeMode, initialSettings: { pluginMainPages: [], notchPluginPages: [], notchEnabled: false, edgeDockEnabled: false, themeColors: { accent: '#112233' }, vendorColors: {} } });
  return { f, manifest, file };
}

test('the production App adapter preserves all four reviewed first-use choices through runtime IPC', async t => {
  const { f } = await fixture(t);
  await f.install();
  const source = fs.readFileSync(path.resolve('src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('pluginApi = pluginBridge ? {');
  assert.ok(start >= 0);
  const adapter = source.slice(start, source.indexOf('\npluginSettingsPanel =', start));
  const api = vm.runInNewContext(adapter + ';pluginApi', {
    loadPluginCatalog: () => f.invoke('plugins:list'), applyPluginCatalog: value => value,
    pluginBridge: { setEnabled: (id, enabled, initialSetup) => f.invoke('plugins:setEnabled', { id, enabled, initialSetup }) }
  });
  const choices = { 'placement:setup-fixture/page:page': false, 'placement:setup-fixture/page:notch': false,
    'content:main.home.content': null, background: false, skin: null };
  await api.setEnabled('setup-fixture', true, choices);
  assert.deepEqual(f.settings.pluginMainPages, []);
  assert.deepEqual(f.settings.notchPluginPages, []);
  assert.equal(f.settings.pluginContentSelections['main.home.content'], undefined);
  assert.equal(f.settings.pluginStates['setup-fixture'].background, false);
  assert.equal(f.settings.themeColors.accent, '#112233');
  assert.deepEqual(f.settings.pluginInitialSetup['setup-fixture'].values, choices);
  assert.equal(f.runtime.manager.active('setup-fixture'), true);
});

for (const activate of [true, false]) test(`updates prune removed owned targets before enforcing the selection limit, activate=${activate}`, () => {
  const target = 'main.new.content', plugin = { ...normalizeManifest(raw()).manifest,
    views: [{ id: 'compact', mode: 'replace', targets: [target], surfaces: [], defaultSurfaces: [] }] };
  const selections = Object.fromEntries(Array.from({ length: 127 }, (_, i) => [`main.kept${i}.content`, 'other/view']));
  selections['main.removed.content'] = 'setup-fixture/old';
  const settings = { pluginContentSelections: selections };
  const plan = initialSetupPlan(settings, plugin, undefined, { activate, updating: true });
  assert.equal(plan.patch.pluginContentSelections['main.removed.content'], undefined);
  assert.equal(Object.keys(plan.patch.pluginContentSelections).length, activate ? 128 : 127);
  for (let i = 0; i < 127; i++) assert.equal(plan.patch.pluginContentSelections[`main.kept${i}.content`], 'other/view');
  assert.equal(plan.patch.pluginContentSelections[target], activate ? 'setup-fixture/compact' : undefined);
  assert.equal(settings.pluginContentSelections['main.removed.content'], 'setup-fixture/old', 'planning must not mutate persisted settings');
});

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

for (const target of ['constructor', 'toString']) test(`legal ${target} target remains cloneable through preview, list and native selection`, async t => {
  const manifest = { ...raw(), views: [{ id: 'compact', mode: 'replace', targets: [target] }], defaults: {} };
  const { f } = await fixture(t, { manifest }); f.settings.pluginContentSelections = {}; f.settings.pluginContentOrder = {};
  const preview = await f.invoke('plugins:import', 'directory');
  assert.doesNotThrow(() => structuredClone(preview));
  assert.deepEqual(preview.initialSetup.fields.find(field => field.target === target).options.map(option => option.value), ['setup-fixture/compact']);
  const installed = await f.invoke('plugins:install', preview.token);
  assert.doesNotThrow(() => structuredClone(installed));
  await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true, initialSetup: { [`content:${target}`]: null } });
  assert.equal(Object.hasOwn(f.settings.pluginContentSelections, target), false);
  assert.equal(f.runtime.payload('page').views['setup-fixture/compact'].contentOrder[target], Number.MAX_SAFE_INTEGER);
  f.settings.pluginContentOrder[target] = ['setup-fixture/compact'];
  assert.equal(f.runtime.payload('page').views['setup-fixture/compact'].contentOrder[target], 0);
  await f.invoke('plugins:selectContent', target, 'setup-fixture/compact');
  assert.equal(f.settings.pluginContentSelections[target], 'setup-fixture/compact');
  await f.invoke('plugins:selectContent', target, null);
  assert.equal(Object.hasOwn(f.settings.pluginContentSelections, target), false);
  assert.doesNotThrow(() => structuredClone(f.invoke('plugins:list')));
});

test('install-and-enable applies all four author suggestions together, using host-owned skin snapshots', async t => {
  const { f } = await fixture(t); const preview = await f.invoke('plugins:import', 'directory');
  assert.ok(preview.initialSetup.fields.some(field => field.kind === 'skin'));
  assert.equal(preview.background.description, 'Refresh usage periodically.');
  await f.invoke('plugins:install', preview.token, { trustInstall: true, initialSetup: preview.initialSetup.values });
  assert.deepEqual(f.settings.pluginMainPages, ['setup-fixture/page']);
  assert.equal(f.settings.pluginContentSelections['main.home.content'], 'setup-fixture/compact');
  assert.equal(f.settings.pluginStates['setup-fixture'].background, true);
  assert.equal(f.settings.themeColors.accent, '#abcdef');
  assert.equal(f.settings.pluginAuthorSkin.ref, 'setup-fixture/blue');
  assert.equal(f.settings.pluginAuthorSkin.appearance.font, 'mono');
  assert.equal(f.settings.notchEnabled, false);
  assert.equal(f.invoke('plugins:list').plugins[0].initialSetup.fields.length, 0);
  assert.equal(f.invoke('plugins:list').plugins[0].background.description, 'Refresh usage periodically.');
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

for (const mode of ['running', 'paused', 'safe-mode', 'disabled']) for (const optOut of [false, true]) {
  test(`reviewed update choices apply once in ${mode}, optOut=${optOut}`, async t => {
    const original = { ...raw(), background: false, backgroundDescription: undefined, defaults: {}, skins: [],
      views: [{ id: 'old-page', surfaces: ['page'], defaultSurfaces: [] }] };
    const { f, file } = await fixture(t, { manifest: original, safeMode: mode === 'safe-mode' });
    await f.install(); await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true });
    if (mode === 'paused') await f.setMasterEnabled(false);
    if (mode === 'disabled') await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: false });
    fs.writeFileSync(file, JSON.stringify({ ...raw(), version: '2.0.0', views: [...original.views, ...raw().views] }));
    const preview = await f.invoke('plugins:import', 'directory');
    const choices = Object.fromEntries(preview.initialSetup.fields.map(field => [field.key, optOut
      ? field.kind === 'placement' || field.kind === 'background' ? false : null : field.value]));
    assert.equal(Object.keys(choices).length, 5);
    await f.invoke('plugins:install', preview.token, { trustUpdate: true, initialSetup: choices });
    if (mode === 'disabled') {
      assert.equal(f.runtime.manager.active('setup-fixture'), false);
      assert.equal(f.invoke('plugins:list').plugins[0].initialSetup.fields.length, 5);
      assert.deepEqual(f.settings.pluginMainPages, []); assert.equal(f.settings.themeColors.accent, '#112233');
      await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true });
    }
    assert.deepEqual(f.settings.pluginMainPages, optOut ? [] : ['setup-fixture/page']);
    assert.equal(f.settings.pluginContentSelections?.['main.home.content'], optOut ? undefined : 'setup-fixture/compact');
    assert.equal(f.settings.pluginStates['setup-fixture'].background, !optOut);
    assert.equal(f.settings.themeColors.accent, optOut ? '#112233' : '#abcdef');
    assert.equal(f.settings.pluginStates['setup-fixture'].enabled, true);
    assert.equal(f.invoke('plugins:list').plugins[0].initialSetup.fields.length, 0);
    if (mode === 'paused' || mode === 'safe-mode') {
      assert.equal(f.runtime.manager.active('setup-fixture'), false);
      assert.equal(f.children.length, 0, 'settings must not execute paused code');
    }
    if (mode === 'paused') await f.setMasterEnabled(true);
    if (mode !== 'safe-mode') {
      assert.equal(f.runtime.manager.active('setup-fixture'), true);
      f.settings.themeColors.accent = '#445566';
      await f.setMasterEnabled(false); await f.setMasterEnabled(true);
      assert.equal(f.settings.themeColors.accent, '#445566', 'master resume must not reapply author defaults');
    }
  });
}

test('new installation while paused stays disabled with pending choices until individual enable', async t => {
  const { f } = await fixture(t); await f.setMasterEnabled(false);
  const preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true, initialSetup: preview.initialSetup.values });
  await f.setMasterEnabled(true);
  assert.equal(f.runtime.manager.active('setup-fixture'), false);
  assert.equal(f.invoke('plugins:list').plugins[0].trusted, false);
  assert.deepEqual(f.settings.pluginInitialSetup['setup-fixture'].applied, []);
  assert.deepEqual(f.settings.pluginMainPages, []); assert.equal(f.settings.themeColors.accent, '#112233');
  await f.invoke('plugins:setEnabled', { id: 'setup-fixture', enabled: true });
  assert.equal(f.runtime.manager.active('setup-fixture'), true);
  assert.deepEqual(f.settings.pluginMainPages, ['setup-fixture/page']);
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
  assert.equal(plan.patch.pluginContentSelections['main.home.content'], 'setup-fixture/compact');
  assert.equal(plan.patch.pluginContentSelections['main.model.content'], undefined);
});
