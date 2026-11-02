'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
function harness() {
  const context = { state: { settings: {}, pluginCatalog: { plugins: [{ status: 'active' }, { status: 'disabled' }] } },
    t: (key, args) => key === 'settings.summary.plugins' ? `${args.active}/${args.total} enabled` : key === 'plugins.catalog.updatesAvailable' ? `${args.count} updates` : 'Off',
    renderSettingsSummaries() {}, applyPluginCatalog: value => value };
  vm.createContext(context);
  vm.runInContext(`let pluginUpdateCount = 0; ${extract('settingsSectionSummary')} ${extract('applyPluginCatalogUpdates')} ${extract('loadPluginCatalog')}`, context);
  return context;
}
test('collapsed plugin summary counts available updates, including while plugins are off, and clears them', () => {
  const h = harness();
  assert.equal(h.settingsSectionSummary('plugins'), '1/2 enabled');
  h.applyPluginCatalogUpdates({ entries: [{ status: 'update' }, { status: 'available' }, { status: 'incompatible' }, { status: 'repository' }] });
  assert.equal(h.settingsSectionSummary('plugins'), '1/2 enabled · 1 updates');
  h.state.settings.pluginsEnabled = false;
  assert.equal(h.settingsSectionSummary('plugins'), 'Off · 1 updates');
  h.applyPluginCatalogUpdates({ entries: [{ status: 'installed' }] });
  assert.equal(h.settingsSectionSummary('plugins'), 'Off');
});
test('loading installed state reads update availability from the local catalog without opening settings', async () => {
  const h = harness(); let reads = 0;
  h.pluginBridge = { list: async () => ({ plugins: [] }), catalog: async () => { reads++; return { entries: [{ status: 'update' }] }; } };
  await h.loadPluginCatalog();
  assert.equal(reads, 1);
  assert.equal(h.settingsSectionSummary('plugins'), '1/2 enabled · 1 updates');
  h.pluginBridge.catalog = async () => { throw Error('temporary read failure'); };
  await h.loadPluginCatalog();
  assert.equal(h.settingsSectionSummary('plugins'), '1/2 enabled · 1 updates');
});
