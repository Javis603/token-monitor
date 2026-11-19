'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];
test('quota demand follows native Home, Limits and quota bubble visibility, never Settings', () => {
  let surface = 'main', settings = false;
  const demands = [], state = { breakdown: 'limits', settings: {} };
  const context = vm.createContext({ state, trayLayoutApi: require('../../src/shared/trayLayout'), pluginBridge: { limitsDemand: value => { demands.push(value); return Promise.resolve(); } }, visibleStatsSurface: () => surface, isSettingsPanelOpen: () => settings });
  vm.runInContext(extract('syncPluginLimitsDemand'), context);
  const sync = () => context.syncPluginLimitsDemand();
  sync(); settings = true; sync(); settings = false; surface = 'bubble'; sync();
  surface = null; sync(); surface = 'main'; sync(); state.breakdown = 'home'; sync();
  assert.deepEqual(demands, [true, false, false, false, true, true]);
  state.settings.hiddenHomeModules = 'limits'; sync(); assert.equal(demands.at(-1), false);
  surface = 'bubble'; state.settings.floatingBubbleContent = 'bars'; sync(); assert.equal(demands.at(-1), true);
  state.settings.floatingBubbleContent = 'tokens'; sync(); assert.equal(demands.at(-1), false);
  for (const name of ['renderLimits', 'setBreakdown', 'applyFloatingBubbleState', 'handleWindowVisibilityChange', 'openSettingsPanel', 'openViewFromTray']) assert.match(extract(name), /syncPluginLimitsDemand\(\)/, name);
});
test('settings render signature includes mixed module order for keyboard moves', () => {
  const order = require('../../src/electron/renderer/limits/providerOrder');
  const state = { settings: { limitProviderOrder: 'plugin:fixture:one,claude,plugin:fixture:two' }, stats: {} };
  const context = vm.createContext({ state, currentLocale: () => 'en', enabledLimitProviderSet: () => new Set(),
    LIMIT_PROVIDER_SETTINGS: {}, LIMIT_PROVIDERS: [{ id: 'claude' }], limitProviderOrderApi: order,
    desktopLimitProviders: () => [{ id: 'claude' }, { id: 'plugin:fixture:one' }, { id: 'plugin:fixture:two' }],
    limitProviderQuery: () => '', limitProviderUsageItemRows: () => [] });
  vm.runInContext(extract('limitProviderSettingsRenderSignature'), context);
  const before = context.limitProviderSettingsRenderSignature();
  state.settings.limitProviderOrder = 'plugin:fixture:two,claude,plugin:fixture:one';
  assert.notEqual(context.limitProviderSettingsRenderSignature(), before);
});
