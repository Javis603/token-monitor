'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { translate } = require('../../src/electron/renderer/i18n');

const electronDir = path.join(__dirname, '../../src/electron');
const read = file => readFileSync(path.join(electronDir, file), 'utf8');

test('the app projects defaults only for settings with a reset control', () => {
  const main = read('main.js');
  const html = read('renderer/index.html');
  const keys = Array.from(html.matchAll(/data-reset-setting="([^"]+)"/g), match => match[1]);
  keys.push(
    'heatmapMetric', 'homeActiveDaysWindow', 'showExactHomeTrendTokens', 'homeModuleCounts',
    'homeLimitDisplayMode', 'showHomeLimitBars', 'showHomeLimitProviderNames', 'homeLimitAccountCount',
    'historyIntervalMs', 'sessionContextMetric', 'limitsHistoryOpenMode', 'modelRankingMetric', 'serviceStatusRefreshMs', 'workbuddyQuotaTotalEnabled'
  );
  const defaults = Object.fromEntries(keys.map(key => [key, 1]));
  defaults.currency = 'HKD';
  defaults.limitsRefreshMode = 'fixed';
  defaults.limitsRefreshMs = 900000;
  defaults.secret = 'private';
  const project = vm.runInNewContext(
    main.slice(main.indexOf('function resettableSettingsDefaults()'), main.indexOf('function normalizeCollectionMode('))
      + '\nresettableSettingsDefaults',
    { defaultSettings: () => defaults }
  );
  const projected = project();
  assert.deepEqual(Object.keys(projected).sort(), keys.sort());
  assert.equal(projected.currency, 'HKD');
  assert.equal(projected.limitsRefresh, '900000');
  defaults.limitsRefreshMode = 'adaptive';
  assert.equal(project().limitsRefresh, 'adaptive');
});

test('Limits refresh keeps the inactive fixed interval when restoring Adaptive', async () => {
  const app = read('renderer/app.js');
  const writes = [];
  let refreshes = 0;
  const save = vm.runInNewContext(
    app.slice(app.indexOf('async function saveLimitsRefresh('), app.indexOf('els.limitsRefreshInput.addEventListener('))
      + '\nsaveLimitsRefresh',
    {
      saveSettings: async patch => { writes.push({ ...patch }); },
      refreshStats: async options => { if (options.force) refreshes++; }
    }
  );
  await save('adaptive');
  await save('900000');
  assert.deepEqual(writes, [{ limitsRefreshMode: 'adaptive' }, { limitsRefreshMode: 'fixed', limitsRefreshMs: 900000 }]);
  assert.equal(refreshes, 2);
});

for (const fixture of [
  { key: 'currency', value: 'EUR', fallback: 'HKD', label: 'settings.currency.label' },
  { key: 'edgeDockSide', value: 'right', fallback: 'right', label: 'settings.display.edgeDockSide', floating: 400 }
]) test(`reset saves only ${fixture.key} and returns keyboard focus to its control`, async () => {
  const app = read('renderer/app.js');
  const settings = { [fixture.key]: fixture.value, showTrayIcon: false, edgeDockFloatingX: fixture.floating ?? null };
  const defaults = { [fixture.key]: fixture.fallback };
  const attrs = new Map();
  let click;
  let focusOptions;
  let finishSave;
  const writes = [];
  const document = {
    createElement: () => button,
    activeElement: null
  };
  const control = { focus(options) { focusOptions = options; document.activeElement = this; } };
  const button = {
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    addEventListener: (_event, listener) => { click = listener; }
  };
  const heading = {
    dataset: { resetSetting: fixture.key },
    closest: () => ({ querySelector: () => control }),
    querySelector: () => ({ dataset: { i18n: fixture.label } }),
    append: node => assert.equal(node, button)
  };
  const sync = vm.runInNewContext(
    app.slice(app.indexOf('const settingResetRows ='), app.indexOf('function syncSettingsForm()'))
      + '\nsetupSettingResets(); syncSettingResets',
    {
      state: { settings, appInfo: { resettableSettingsDefaults: defaults } },
      els: { settingsPanel: { querySelectorAll: () => [heading] } },
      document,
      t: (key, params) => translate('en', key, params),
      saveSettings: patch => {
        writes.push({ ...patch });
        return new Promise(resolve => {
          finishSave = () => {
            Object.assign(settings, patch);
            if ('edgeDockSide' in patch) settings.edgeDockFloatingX = null;
            resolve();
          };
        });
      }
    }
  );
  assert.equal(button.hidden, true);
  sync();
  assert.equal(button.hidden, false);
  assert.equal(attrs.get('aria-label'), translate('en', 'settings.common.resetSetting', { setting: translate('en', fixture.label) }));
  document.activeElement = button;
  const save = click();
  await click();
  assert.deepEqual(writes, [{ [fixture.key]: fixture.fallback }]);
  finishSave();
  sync();
  assert.equal(button.hidden, false, 'a settings push can arrive while the save is pending');
  await save;
  assert.equal(button.hidden, true);
  assert.equal(document.activeElement, control);
  assert.equal(focusOptions.preventScroll, true);
  assert.deepEqual(settings, { [fixture.key]: fixture.fallback, showTrayIcon: false, edgeDockFloatingX: null });
});

test('a Home count reset restores only the selected module', async () => {
  const app = read('renderer/app.js');
  const settings = { homeModuleCounts: { model: 20, tool: 12 } };
  const writes = [];
  let click;
  const heading = { dataset: {}, append() {} };
  const button = {
    setAttribute() {}, removeAttribute() {},
    addEventListener(_event, listener) { click = listener; }
  };
  const reset = vm.runInNewContext(
    app.slice(app.indexOf('const settingResetRows ='), app.indexOf('function syncSettingsForm()'))
      + '\naddRenderedSettingReset',
    {
      state: { settings, appInfo: { resettableSettingsDefaults: { homeModuleCounts: { model: 5, tool: 5 } } } },
      document: { createElement: () => button },
      t: (key, params) => translate('en', key, params),
      saveSettings: async patch => {
        writes.push(JSON.parse(JSON.stringify(patch)));
        Object.assign(settings.homeModuleCounts, patch.homeModuleCounts);
      }
    }
  );
  reset({ querySelector: () => null }, heading, { dataset: {}, textContent: 'Item count' }, 'homeModuleCounts', 'model');
  assert.equal(button.hidden, false);
  await click();
  assert.deepEqual(writes, [{ homeModuleCounts: { model: 5 } }]);
  assert.deepEqual(settings.homeModuleCounts, { model: 5, tool: 12 });
  assert.equal(button.hidden, true);
});

test('existing appearance sliders show reset only for nondefault values', () => {
  const app = read('renderer/app.js');
  const defaultAppearance = { glassOpacity: 68, glassBlur: 32, backgroundImageOpacity: 28, zoomFactor: 1 };
  const names = [
    ['glassInput', 'resetGlassButton', 68],
    ['blurInput', 'resetDepthButton', 32],
    ['backgroundImageOpacityInput', 'resetBackgroundImageOpacityButton', 28],
    ['zoomInput', 'resetZoomButton', 100],
    ['macGlassTintInput', 'macGlassTintReset', 0],
    ['macClearGlassTintInput', 'macClearGlassTintReset', 35]
  ];
  const els = Object.fromEntries(names.flatMap(([input, reset, value]) => [[input, { value: String(value) }], [reset, {}]]));
  const sync = vm.runInNewContext(
    app.slice(app.indexOf('function syncSliderRows()'), app.indexOf('function applyAppearanceFromControls()'))
      + app.slice(app.indexOf('function syncSettingResetVisibility('), app.indexOf('function createSettingReset('))
      + '\nsyncSliderRows',
    {
      els, defaultAppearance, document: {}, syncSliderRow() {},
      nativeGlassTintSettings: [['macGlassTint', 'liquid-glass'], ['macClearGlassTint', 'liquid-glass-clear']],
      macBackdropApi: require('../../src/electron/macBackdropMode')
    }
  );
  sync();
  for (const [input, reset, value] of names) {
    assert.equal(els[reset].hidden, true, reset);
    els[input].value = String(value + 5);
  }
  sync();
  for (const [, reset] of names) assert.equal(els[reset].hidden, false, reset);
});

test('provider list restores focus after replacing a setting reset', () => {
  const app = read('renderer/app.js');
  const body = {};
  const focused = [];
  const checkbox = { focus: () => focused.push('checkbox') };
  const button = {
    hidden: true,
    matches: selector => selector === '.settings-reset-button',
    closest: selector => selector === '.settings-item' ? { querySelector: () => checkbox } : null,
    focus: () => focused.push('reset')
  };
  const restore = vm.runInNewContext(
    app.slice(app.indexOf('function restoreSettingsListFocus(')).split('\nfunction ')[0]
      + '\nrestoreSettingsListFocus',
    {
      document: { body, activeElement: body, getElementById: () => button },
      settingResetControl: row => row.querySelector()
    }
  );
  restore('resetWorkbuddyQuotaTotalButton');
  button.hidden = false;
  restore('resetWorkbuddyQuotaTotalButton');
  assert.deepEqual(focused, ['checkbox', 'reset']);
});
