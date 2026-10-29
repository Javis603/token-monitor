'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parsePackage } = require('../../src/electron/plugins/package');
const { normalizePluginStates } = require('../../src/electron/plugins/manager');

function webPackage(main, asset) {
  const manifest = { id: 'portable-demo', name: 'Demo', version: '1.0.0', tmApi: 1, backend: main, files: [main, asset] };
  return JSON.stringify({ format: 2, manifest, files: { [main]: '', [asset]: '' } });
}
for (const [main, asset] of [['lib/main.js', 'lib/Main.js'], ['lib/main.js', 'LIB/MAIN.js'], ['lib/main.js', 'lib/main.js/child.js'], ['lib/main.js/child.js', 'LIB/main.js'], ['manifest.json/entry.js', 'lib/app.js']]) {
  test(`package rejects portable file collision ${main} / ${asset}`, () => {
    assert.throws(() => parsePackage(webPackage(main, asset)), /conflict|duplicate/);
  });
}
test('distinct entry and asset names retain package bytes and content', () => {
  const bytes = webPackage('lib/main.js', 'lib/view.js');
  const pkg = parsePackage(bytes);
  assert.equal(pkg.bytes.toString(), bytes);
  assert.equal(pkg.files['lib/main.js'].length, 0);
  assert.ok(Object.hasOwn(pkg.files, 'lib/view.js'));
});

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function functionSource(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf('\n}', start) + 2);
}

test('safe-mode relaunch uses synchronous host shutdown even without renderer cooperation', () => {
  const start = main.indexOf('onRestartPluginsSafe: () => {');
  const callback = main.slice(start + 'onRestartPluginsSafe: '.length, main.indexOf('\n    },', start) + 6);
  const events = [];
  const context = vm.createContext({ process: { argv: ['electron', 'app', '--plugins-safe-mode'] }, quitRequested: false, quitInProgress: false,
    app: { relaunch: ({ args }) => events.push(['relaunch', args]), exit: code => events.push(['exit', code]) },
    stopAll: () => events.push(['host-cleanup']), console });
  vm.runInContext(functionSource('performQuit') + '\n' + functionSource('requestAppQuit'), context);
  vm.runInContext(`(${callback})()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['relaunch', ['app', '--plugins-safe-mode']], ['host-cleanup'], ['exit', 0]]);
});
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

test('main management persistence includes all compact layout and Notch order transaction fields', () => {
  const context = vm.createContext({ settings: { pluginStates: {} }, normalizePluginStates, saveSettings() {}, pushSettingsToRenderer() {} });
  const start = main.indexOf('persistManagementSettings: ('), end = main.indexOf('\n        },', start);
  const callback = vm.runInContext(`({${main.slice(start, end)}\n}}).persistManagementSettings`, context);
  const patch = { floatingBubbleCustomLayout: { version: 1, items: [] }, notchCustomLayout: { version: 1, items: [] }, notchPageOrder: ['home'], pluginContentDefaults: { demo: ['main.home.content'] } };
  callback(patch);
  for (const key of Object.keys(patch)) assert.deepEqual(context.settings[key], patch[key]);
});

test('all emitted backend states have diagnostic translations in every locale', async t => {
  const { runtimeFixture } = require('../helpers/trustedPlugin');
  const { translate, MESSAGES } = require('../../src/electron/renderer/i18n');
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.invoke('plugins:list').plugins[0].runtime.state, 'idle');
  f.send(f.main, 'home'); await new Promise(setImmediate);
  assert.equal(f.invoke('plugins:list').plugins[0].runtime.state, 'running');
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) for (const state of ['idle', 'running', 'error']) {
    const key = `settings.plugins.runtimeState.${state}`;
    assert.ok(Object.hasOwn(MESSAGES[locale], key), `${locale}/${state} must not depend on English fallback`);
    assert.notEqual(translate(locale, key), key, `${locale}/${state}`);
  }
});
