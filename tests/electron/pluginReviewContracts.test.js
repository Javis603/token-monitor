'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parsePackage } = require('../../src/electron/plugins/package');
const { normalizePluginStates } = require('../../src/electron/plugins/manager');

function webPackage(main, asset) {
  const manifest = { id: 'portable-demo', name: 'Demo', version: '1.0.0', tmApi: '^1', main,
    permissions: ['ui.web', 'tm.pages'], webUi: { version: 1, assets: ['ui/index.html', asset],
      documents: [{ id: 'models', entry: 'ui/index.html', target: 'model', slot: 'replace' }] } };
  return JSON.stringify({ format: 1, manifest, code: '', assets: { 'ui/index.html': '', [asset]: '' } });
}
for (const [main, asset] of [['lib/main.js', 'lib/Main.js'], ['lib/main.js', 'LIB/MAIN.js'], ['lib/main.js', 'lib/main.js/child.js'], ['lib/main.js/child.js', 'LIB/main.js'], ['manifest.json/entry.js', 'lib/app.js']]) {
  test(`package rejects portable file collision ${main} / ${asset}`, () => {
    assert.throws(() => parsePackage(webPackage(main, asset)), /conflict/);
  });
}
test('distinct entry and asset names retain package bytes and content', () => {
  const bytes = webPackage('lib/main.js', 'lib/view.js');
  const pkg = parsePackage(bytes);
  assert.equal(pkg.bytes.toString(), bytes);
  assert.equal(pkg.code, '');
  assert.ok(Object.hasOwn(pkg.assets, 'lib/view.js'));
});

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function functionSource(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf('\n}', start) + 2);
}
test('actual main plugin persistence rolls back failed consent and does not notify renderers', () => {
  const saved = { pluginsEnabled: true, pluginStates: {}, marker: 'persisted' };
  let writes = 0, pushes = 0, failed = true;
  const error = new Error('injected rename failure');
  const context = { settings: structuredClone(saved), persistedSettingsSnapshot: structuredClone(saved), normalizePluginStates,
    ensureCredentialStore: () => ({}), settingsPath: '/unused',
    persistSettingsAndCredentials: () => { writes++; if (failed) throw error; },
    refreshTrayContextMenu() {}, reportCredentialStorageError() {}, pushSettingsToRenderer: () => pushes++ };
  vm.createContext(context);
  vm.runInContext(functionSource('cloneSettingsSnapshot') + '\n' + functionSource('saveSettings'), context);
  for (const key of ['persistPluginStates', 'persistManagementSettings']) {
    const start = main.indexOf(`${key}: (`);
    const end = main.indexOf('\n        },', start);
    const callback = vm.runInContext(`({${main.slice(start, end)}\n}}).${key}`, context);
    const grant = { demo: { enabled: true, grant: { permissions: ['sys.cpu'], hosts: [] } } };
    assert.throws(() => callback(key === 'persistPluginStates' ? grant : { pluginStates: grant }), e => e === error);
    assert.equal(JSON.stringify(context.settings), JSON.stringify(saved));
    assert.equal(JSON.stringify(context.persistedSettingsSnapshot), JSON.stringify(saved));
    assert.equal(pushes, 0);
  }
  assert.equal(writes, 2);
  failed = false;
  const start = main.indexOf('persistPluginStates: (');
  const end = main.indexOf('\n        },', start);
  const callback = vm.runInContext(`({${main.slice(start, end)}\n}}).persistPluginStates`, context);
  callback({ demo: { enabled: true, grant: { permissions: ['sys.cpu'], hosts: [] } } });
  assert.equal(context.settings.pluginStates.demo.enabled, true);
  assert.equal(context.persistedSettingsSnapshot.pluginStates.demo.enabled, true);
  assert.equal(pushes, 1);
});
