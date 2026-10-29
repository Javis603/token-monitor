'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { normalizeInitialSetup, recordSetupChoice, initialSetupReview, initialSetupPlan } = require('../../src/electron/plugins/initialSetup');
const { runtimeFixture } = require('../helpers/trustedPlugin');

function raw() {
  return { tmApi: 1, id: 'setup-fixture', name: 'Setup fixture', version: '1.0.0', ui: 'ui.mjs', backend: 'backend.cjs', files: ['ui.mjs', 'backend.cjs'], background: true,
    backgroundDescription: { en: 'Refresh usage periodically.', 'zh-TW': '定期更新用量資料。' },
    views: [{ id: 'page', title: 'Page', surfaces: ['page', 'notch'], defaultSurfaces: ['page'] },
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

test('persisted setup accepts only typed choices and applies only retained, unique keys', () => {
  const values = {
    background: false, skin: null, 'content:main.home.content': 'other/view',
    'placement:setup-fixture/page:page': false,
    'placement:setup-fixture/page:settings': true,
    'placement:setup-fixture/page:notch': 'true',
    'placement:../page:page': true, 'content:bad target': null,
    'content:main.model.content': false, unknown: true
  };
  const input = { 'setup-fixture': { values, applied: [...Object.keys(values), 'background', 'missing'] },
    'bad id': { values: {}, applied: [] }, missingValues: { applied: [] },
    'bad-values': { values: [], applied: [] }, 'bad-applied': { values: {}, applied: {} } };
  const before = structuredClone(input);
  const normalized = normalizeInitialSetup(input);
  assert.deepEqual(normalized, { 'setup-fixture': { values: {
    background: false, skin: null, 'content:main.home.content': 'other/view',
    'placement:setup-fixture/page:page': false
  }, applied: ['background', 'skin', 'content:main.home.content', 'placement:setup-fixture/page:page'] } });
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeInitialSetup(normalized), normalized);
});

test('persisted setup bounds valid choices and removes applied keys discarded by that bound', () => {
  const entries = Array.from({ length: 1025 }, (_, i) => [`content:main.target${i}.content`, null]);
  const normalized = normalizeInitialSetup({ 'setup-fixture': {
    values: Object.fromEntries([['invalid', true], ...entries]),
    applied: [...entries.map(([key]) => key).reverse(), entries[0][0]]
  } })['setup-fixture'];
  assert.deepEqual(Object.keys(normalized.values), entries.slice(0, 1024).map(([key]) => key));
  assert.deepEqual(normalized.applied, entries.slice(0, 1024).map(([key]) => key).reverse());
});

test('recording a choice preserves pending values, other plugins and input objects', () => {
  const settings = { pluginInitialSetup: {
    'setup-fixture': { values: { background: true, skin: null }, applied: ['background'] },
    other: { values: { background: true }, applied: [] }
  } };
  const before = structuredClone(settings);
  const recorded = recordSetupChoice(settings, 'setup-fixture', 'background', false);
  assert.deepEqual(recorded['setup-fixture'], { values: { background: false, skin: null }, applied: ['background'] });
  assert.deepEqual(recorded.other, before.pluginInitialSetup.other);
  assert.deepEqual(settings, before);
  const constructor = recordSetupChoice({}, 'constructor', 'background', false);
  assert.ok(Object.hasOwn(constructor, 'constructor'));
  assert.deepEqual(constructor.constructor, { values: { background: false }, applied: ['background'] });
});

test('at the setup storage limit an existing decision can change but a new decision is rejected', () => {
  const values = Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`content:main.target${i}.content`, null]));
  const settings = { pluginInitialSetup: { 'setup-fixture': { values, applied: Object.keys(values) } } };
  const before = structuredClone(settings);
  const updated = recordSetupChoice(settings, 'setup-fixture', 'content:main.target0.content', 'other/view');
  assert.equal(updated['setup-fixture'].values['content:main.target0.content'], 'other/view');
  assert.equal(updated['setup-fixture'].applied.length, 1024);
  assert.throws(() => recordSetupChoice(settings, 'setup-fixture', 'background', false), /Too many initial settings/);
  assert.deepEqual(settings, before);
});

test('review preserves pending opt-outs while newly declared choices use author suggestions', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginInitialSetup: { 'setup-fixture': {
    values: { background: false, skin: null, 'content:main.home.content': null,
      'placement:setup-fixture/page:page': false, 'placement:setup-fixture/removed:page': true },
    applied: ['placement:setup-fixture/page:page']
  } } };
  const before = structuredClone(settings);
  assert.deepEqual(initialSetupReview(settings, plugin).values, {
    'placement:setup-fixture/page:notch': false, 'content:main.home.content': null, background: false, skin: null
  });
  assert.deepEqual(settings, before);
});

test('pending content and skin suggestions removed by an update fall back to native and current appearance', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginInitialSetup: { 'setup-fixture': { values: {
    skin: 'setup-fixture/removed', 'content:main.home.content': 'setup-fixture/removed'
  }, applied: [] } } };
  const review = initialSetupReview(settings, plugin, { updating: true });
  assert.equal(review.values.skin, null);
  assert.equal(review.values['content:main.home.content'], null);
});

test('install-only planning records all choices without applying effects or marking them applied', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginInitialSetup: { other: { values: { background: false }, applied: ['background'] } },
    pluginContentSelections: { 'main.home.content': 'other/view' },
    pluginStates: { 'setup-fixture': { enabled: false, background: false } },
    themeColors: { accent: '#112233' }, pluginMainPages: [] };
  const before = structuredClone(settings);
  const review = initialSetupReview(settings, plugin);
  const plan = initialSetupPlan(settings, plugin, undefined, { activate: false });
  assert.deepEqual(plan.patch, { pluginInitialSetup: {
    ...settings.pluginInitialSetup, 'setup-fixture': { values: review.values, applied: [] }
  } });
  assert.deepEqual(plan.values, review.values);
  assert.deepEqual(settings, before);
});

for (const [label, input] of [['null', null], ['array', []], ['boolean', false], ['string', 'defaults'],
  ['number', 1], ['oversized object', Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`choice${i}`, true]))]]) {
  test(`initial planning rejects a ${label} payload without mutating settings`, () => {
    const settings = { pluginInitialSetup: {} }, before = structuredClone(settings);
    assert.throws(() => initialSetupPlan(settings, normalizeManifest(raw()).manifest, input), /Invalid initial plugin settings/);
    assert.deepEqual(settings, before);
  });
}

test('applied decisions cannot be resubmitted as first-use settings', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginInitialSetup: { 'setup-fixture': { values: { background: false }, applied: ['background'] } } };
  assert.throws(() => initialSetupPlan(settings, plugin, { background: true }), /Invalid initial plugin settings/);
  assert.equal(settings.pluginInitialSetup['setup-fixture'].values.background, false);
});

test('activating defaults preserves other state and produces no setup effects on a second plan', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginStates: { 'setup-fixture': { enabled: true, trustedRevision: 'revision' }, other: { enabled: false } },
    themeColors: { accent: '#112233', text: '#ffffff' }, vendorColors: { claude: '#123456' },
    pluginContentSelections: { 'main.model.content': 'other/view' }, pluginMainPages: ['other/page'],
    notchEnabled: false, edgeDockEnabled: false };
  const before = structuredClone(settings);
  const { patch } = initialSetupPlan(settings, plugin);
  assert.deepEqual(patch.pluginStates, { 'setup-fixture': { enabled: true, trustedRevision: 'revision', background: true }, other: { enabled: false } });
  assert.deepEqual(patch.pluginMainPages, ['other/page', 'setup-fixture/page']);
  assert.deepEqual(patch.pluginContentSelections, { 'main.model.content': 'other/view', 'main.home.content': 'setup-fixture/compact' });
  assert.deepEqual(patch.themeColors, { accent: '#abcdef', text: '#ffffff' });
  assert.deepEqual(patch.vendorColors, { claude: '#123456' });
  assert.equal(patch.pluginAuthorSkin.ref, 'setup-fixture/blue');
  assert.equal(patch.pluginAuthorSkin.appearance.font, 'mono');
  assert.equal(Object.hasOwn(patch, 'notchEnabled'), false);
  assert.equal(Object.hasOwn(patch, 'edgeDockEnabled'), false);
  const applied = patch.pluginInitialSetup['setup-fixture'];
  assert.deepEqual(new Set(applied.applied), new Set(Object.keys(applied.values)));
  assert.deepEqual(initialSetupPlan({ ...settings, ...patch }, plugin), { patch: {}, values: {} });
  assert.deepEqual(settings, before);
});

test('full page locations skip the suggestion without eviction and still apply independent choices', () => {
  const plugin = normalizeManifest(raw()).manifest;
  const pages = Array.from({ length: 32 }, (_, i) => `other/page-${i}`);
  const settings = { pluginMainPages: pages };
  const before = structuredClone(settings);
  const { patch } = initialSetupPlan(settings, plugin);
  assert.equal(Object.hasOwn(patch, 'pluginMainPages'), false);
  assert.equal(patch.pluginContentSelections['main.home.content'], 'setup-fixture/compact');
  assert.equal(patch.pluginStates['setup-fixture'].background, true);
  assert.equal(patch.pluginAuthorSkin.ref, 'setup-fixture/blue');
  assert.ok(patch.pluginInitialSetup['setup-fixture'].applied.includes('placement:setup-fixture/page:page'));
  assert.deepEqual(settings, before);
});

for (const count of [127, 128]) test(`activating a new target with ${count} existing content choices respects the 128-selection limit`, () => {
  const plugin = normalizeManifest(raw()).manifest;
  const settings = { pluginContentSelections: Object.fromEntries(Array.from({ length: count }, (_, i) => [`main.kept${i}.content`, 'other/view'])) };
  const before = structuredClone(settings);
  if (count === 128) assert.throws(() => initialSetupPlan(settings, plugin), /Too many content selections/);
  else {
    const { patch } = initialSetupPlan(settings, plugin);
    assert.deepEqual(patch.pluginContentSelections, { ...settings.pluginContentSelections, 'main.home.content': 'setup-fixture/compact' });
  }
  assert.deepEqual(settings, before);
});
