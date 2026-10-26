'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const themePresetsApi = require('../../src/electron/renderer/themePresets');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(process.env.TM_APP_SOURCE || path.join(root, 'src/electron/renderer/app.js'), 'utf8');
function extract(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, name);
  return match[0];
}
function catalogHarness() {
  const calls = [];
  const context = { state: {}, pluginPageDesigns: {}, isSettingsSurfaceVisible: () => true,
    preserveSettingsPanelScroll: fn => fn() };
  for (const name of ['render', 'renderViewSwitcher', 'renderThemePresetChips', 'renderNotchPageChoices', 'renderViewPreferences']) context[name] = () => calls.push(name);
  vm.createContext(context);
  vm.runInContext(`let pluginCatalogKey = ''; ${extract('applyPluginCatalog')}`, context);
  return { calls, context, apply: context.applyPluginCatalog };
}
const catalog = () => ({ enabled: true, plugins: [{ id: 'test', name: 'Design', status: 'active', revision: 1,
  views: [{ ref: 'test/card', title: 'Card', surfaces: ['home', 'page'], placements: { page: true } }],
  skins: [{ id: 'blue', name: 'Blue', colors: { accent: '#123456' } }],
  webDocuments: [{ ref: 'test/models', title: 'Models', target: 'models', slot: 'replace', height: 240 }],
  runtime: { cpuPercent: 1, memoryMB: 12 }, logs: [] }] });
test('identical and metric-only catalogs update state without any app redraw', () => {
  const h = catalogHarness(); h.apply(catalog()); h.calls.length = 0;
  h.apply(catalog());
  const next = catalog(); next.plugins[0].runtime.cpuPercent = 90; next.plugins[0].logs.push('tick');
  h.apply(next);
  assert.equal(h.context.state.pluginCatalog, next);
  assert.deepEqual(h.calls, []);
});
for (const [label, mutate] of [
  ['code revision', p => p.revision++],
  ['plugin name', p => p.name = 'New name'],
  ['skin palette', p => p.skins[0].colors.accent = '#abcdef'],
  ['skin title', p => p.skins[0].name = 'New title'],
  ['skin tokens', p => p.skins[0].appearance = { font: 'mono' }],
  ['view placement', p => p.views[0].placements.page = false],
  ['plugin status', p => p.status = 'disabled']
]) test(`${label} refreshes the app once, then settles`, () => {
  const h = catalogHarness(); h.apply(catalog()); h.calls.length = 0;
  const next = catalog(); mutate(next.plugins[0]); h.apply(next);
  assert.equal(h.calls.filter(name => name === 'render').length, 1);
  h.calls.length = 0; h.apply(structuredClone(next)); assert.deepEqual(h.calls, []);
});
function preloadBridge() {
  let exposed;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/electron/preload.js'), 'utf8'), {
    require: id => { assert.equal(id, 'electron'); return { contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'tokenMonitor') exposed = api; } }, ipcRenderer: { on() {}, invoke() {} } }; },
    process: { platform: 'darwin', versions: {} }
  });
  return exposed.plugins;
}
function skinHarness(fail = false) {
  const saved = [], errors = [];
  const state = { settings: { themeColors: { chart: '#112233' }, vendorColors: { existing: '#445566' } } };
  const context = { state, themePresetsApi, pluginBridge: preloadBridge(),
    applyThemeColors() {}, applyVendorColorOverrides() {}, buildAppearanceColorControls() {}, renderSettingsSummaries() {},
    t: (_key, values) => values?.error || _key, setStatus: (...args) => errors.push(args),
    saveSettings: async patch => { if (fail) throw new Error('disk full'); saved.push(JSON.parse(JSON.stringify(patch))); Object.assign(state.settings, patch); } };
  assert.equal(context.pluginBridge.setAppearance, undefined);
  vm.createContext(context); vm.runInContext(extract('currentThemeOverrides') + '\n' + extract('applyPluginSkin'), context);
  return { context, saved, errors };
}
test('skin sends only canonical identity, never renderer-supplied palette or tokens', async () => {
  const h = skinHarness();
  await h.context.applyPluginSkin({ ref: 'author/mono', colors: { accent: '#abcdef' }, vendorColors: { custom: '#778899' }, appearance: { font: 'mono', density: 'compact' } });
  assert.deepEqual(h.saved, [{ pluginSkinRef: 'author/mono' }]);
});
test('plugin-details skin callback returns persistence failure to its owning panel', async () => {
  const h = skinHarness(true);
  const callback = source.match(/onApplySkin: ([^\n]*applyPluginSkin[^\n]*),/)[1];
  const result = vm.runInContext(`(${callback})({ref:'author/mono'})`, h.context);
  await assert.rejects(result, /disk full/);
  assert.deepEqual(h.errors, [], 'the panel owns feedback, not the global status');
});
test('real Appearance skin click handles rejection locally without an unhandled promise', () => {
  const entrypoint = source.match(/chip\.addEventListener\('click', ([^\n]*applyAppearancePluginSkin[^\n]*)\);/)[1];
  const script = `const vm = require('node:vm'), assert = require('node:assert/strict');
    const {Element} = require(${JSON.stringify(path.join(root, 'tests/helpers/notchPanel'))});
    const document = {createElement: tag => new Element(tag, document)};
    const container = document.createElement('div'), chip = document.createElement('button'); container.append(chip);
    const errors = [], ctx = {document, state:{settingsPushRevision:0}, chip, els:{themePresetChips:container}, skin:{ref:'author/mono'},
      window:{TokenMonitorPluginSettings:require(${JSON.stringify(path.join(root, 'src/electron/renderer/pluginSettings'))})},
      buildAppearanceColorControls() {}, renderSettingsSummaries() {},
      saveSettings: async () => { throw Error('disk full'); },
      t: (_key, values) => values?.error || _key, setStatus: (...args) => errors.push(args)
    };
    vm.createContext(ctx); vm.runInContext(${JSON.stringify(extract('applyPluginSkin') + '\n' + extract('applyAppearancePluginSkin') + '\n(')} + ${JSON.stringify(entrypoint)} + ')()', ctx);
    setImmediate(() => {
      assert.deepEqual(errors, []);
      const notice = container.querySelector('.plugin-action-error');
      assert.equal(notice.textContent, 'disk full'); assert.equal(notice.getAttribute('role'), 'alert');
      assert.equal(chip.getAttribute('aria-describedby'), notice.id);
      assert.equal(container.getAttribute('aria-busy'), 'false');
    });`;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of ['rollback rebuild', 'removed skin', 'changed skin', 'new settings', 'focus moved']) {
  test(`Appearance saveSettings failure with ${scenario}`, async () => {
    const { Element } = require('../helpers/notchPanel');
    const document = { createElement: tag => new Element(tag, document) };
    document.body = document.createElement('body'); document.activeElement = document.body;
    const container = document.createElement('div'); document.body.append(container);
    // Supply the small DOM operations used by the real preset renderer.
    container.appendChild = node => container.append(node);
    Object.defineProperty(container, 'innerHTML', { set() { container.replaceChildren(); document.activeElement = document.body; } });
    const skin = { ref: 'author/mono', name: 'Mono', colors: { accent: '#123456' } };
    const other = document.createElement('button'); document.body.append(other);
    const state = { settings: {}, settingsPushRevision: 0, pluginCatalog: { plugins: [{ status: 'active', name: 'Author', skins: [skin] }] } };
    let rebuilds = 0;
    const ctx = { document, state, els: { themePresetChips: container }, themePresetsApi,
      pendingSettingsPatches: new Set(), appearancePreview: {}, syncContentForm: null,
      setSyncContentEditError() {}, console: { error() {} }, applyEffectiveCurrencyRates() {},
      preserveSettingsPanelScroll: fn => fn(), isSettingsSurfaceVisible: () => true,
      render() {}, restartTimer() {}, maybeUpdateBarsIcon() {}, renderSettingsSummaries() {},
      t: (_key, values) => values?.error || _key,
      window: { TokenMonitorPluginSettings: require('../../src/electron/renderer/pluginSettings'), tokenMonitor: {
        updateSettings: async () => { throw Error('disk full'); }, getSettings: async () => ({})
      } },
      syncSettingsForm() {
        rebuilds++;
        if (scenario === 'removed skin') state.pluginCatalog.plugins = [];
        if (scenario === 'changed skin') state.pluginCatalog.plugins[0].skins = [{ ...skin, colors: { accent: '#abcdef' } }];
        if (scenario === 'new settings') state.settingsPushRevision++;
        ctx.renderThemePresetChips();
        if (scenario === 'focus moved') other.focus();
      }
    };
    vm.createContext(ctx);
    vm.runInContext(['matchingThemePresetId', 'renderThemePresetChips', 'saveSettings', 'applyPluginSkin', 'applyAppearancePluginSkin'].map(extract).join('\n'), ctx);
    ctx.renderThemePresetChips();
    const original = container.querySelector('.theme-preset-chip-plugin'); original.focus();
    await ctx.applyAppearancePluginSkin(skin, original);
    assert.equal(rebuilds, 1); assert.equal(container.contains(original), false);
    const notice = container.querySelector('.plugin-action-error');
    const expected = ['rollback rebuild', 'focus moved'].includes(scenario);
    assert.equal(!!notice, expected);
    if (expected) {
      const replacement = container.querySelector('.theme-preset-chip-plugin');
      assert.equal(notice.textContent, 'disk full'); assert.equal(notice.getAttribute('role'), 'alert');
      assert.equal(replacement.getAttribute('aria-describedby'), notice.id);
      assert.equal(document.activeElement, scenario === 'focus moved' ? other : replacement);
    }
    assert.equal(container.getAttribute('aria-busy'), 'false');
  });
}

test('built-in themes and reset clear author tokens atomically; individual colors retain them', async () => {
  const h = skinHarness();
  vm.runInContext(extract('selectThemePreset') + '\n' + extract('commitThemeColors'), h.context);
  h.context.state.settings.pluginAuthorSkin = { ref: 'removed/skin', appearance: { font: 'mono' } };
  await h.context.selectThemePreset(themePresetsApi.THEME_PRESETS[0].id);
  assert.equal(h.saved[0].pluginSkinRef, null);
  await h.context.commitThemeColors({}, true);
  assert.deepEqual(h.saved[1], { themeColors: {}, pluginSkinRef: null });
  await h.context.commitThemeColors({ accent: '#123456' });
  assert.deepEqual(h.saved[2], { themeColors: { accent: '#123456' } });
  assert.match(source, /resetThemeColorsButton\?\.addEventListener\('click', \(\) => commitThemeColors\(\{\}, true\)\)/);
});
test('theme selection uses author identity and has no separate clear button', () => {
  const { Element } = require('../helpers/notchPanel');
  const document = { createElement: tag => new Element(tag, document) };
  const container = document.createElement('div'); container.appendChild = node => container.append(node);
  Object.defineProperty(container, 'innerHTML', { set() { container.replaceChildren(); } });
  const h = skinHarness();
  Object.assign(h.context, { document, els: { themePresetChips: container }, selectThemePreset() {} });
  h.context.state.settings.pluginAuthorSkin = { ref: 'author/mono' };
  h.context.state.pluginCatalog = { plugins: [{ status: 'active', name: 'Author', skins: [{ ref: 'author/mono', name: 'Mono', colors: {} }, { ref: 'other/mono', name: 'Other', colors: {} }] }] };
  vm.runInContext(extract('matchingThemePresetId') + '\n' + extract('renderThemePresetChips'), h.context);
  h.context.renderThemePresetChips();
  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, themePresetsApi.THEME_PRESETS.length + 2);
  assert.equal(buttons.filter(b => b.classList.contains('active')).length, 1);
  assert.equal(JSON.parse(buttons.find(b => b.classList.contains('active')).dataset.pluginSkin).ref, 'author/mono');
});
