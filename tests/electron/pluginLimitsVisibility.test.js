'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];
test('quota demand exists only for visible main Limits, never bubble or settings overlay', () => {
  let surface = 'main', settings = false;
  const demands = [], state = { breakdown: 'limits' };
  const context = vm.createContext({ state, pluginBridge: { limitsDemand: value => { demands.push(value); return Promise.resolve(); } }, visibleStatsSurface: () => surface, isSettingsPanelOpen: () => settings });
  vm.runInContext(extract('syncPluginLimitsDemand'), context);
  const sync = () => context.syncPluginLimitsDemand();
  sync(); settings = true; sync(); settings = false; surface = 'bubble'; sync();
  surface = null; sync(); surface = 'main'; sync(); state.breakdown = 'home'; sync();
  assert.deepEqual(demands, [true, false, false, false, true, false]);
  for (const name of ['renderLimits', 'setBreakdown', 'applyFloatingBubbleState', 'handleWindowVisibilityChange', 'openSettingsPanel', 'openViewFromTray']) assert.match(extract(name), /syncPluginLimitsDemand\(\)/, name);
});
