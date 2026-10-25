'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPluginRuntime, registerPluginScheme } = require('../../src/electron/plugins/runtime');

test('runtime declares both isolated schemes in one Electron registration', () => {
  const calls = [];
  const switches = new Map();
  registerPluginScheme({ registerSchemesAsPrivileged: schemes => calls.push(schemes) }, {
    getSwitchValue: name => switches.get(name) || '', appendSwitch: (name, value) => switches.set(name, value)
  });
  assert.equal(switches.get('enable-features'), 'ConnectionAllowlists,OverrideConnectionAllowlistOriginTrial');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(s => s.scheme).sort(), ['tm-plugin', 'tm-plugin-ui']);
  for (const { privileges } of calls[0]) {
    assert.equal(privileges.standard, true); assert.equal(privileges.secure, true);
    assert.notEqual(privileges.bypassCSP, true); assert.notEqual(privileges.supportFetchAPI, true);
  }
});

for (const [file, content] of [
  ['installed.json', '{broken'], ['transaction.json', '{broken'],
  ['installed.json', '42'], ['installed.json', '{"demo":null}'],
  ['transaction.json', '{"id":"demo","phase":"prepared"}'],
  ['transaction.json', 'null']
]) test(`runtime contains corrupt ${file}: ${content}`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-recovery-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'plugin-manager'); fs.mkdirSync(root);
  const metadata = path.join(root, file); fs.writeFileSync(metadata, content);
  const original = fs.statSync(metadata);
  const sentinel = path.join(root, 'transaction', 'stage'); fs.mkdirSync(sentinel, { recursive: true });
  fs.writeFileSync(path.join(sentinel, 'keep'), 'recovery evidence');
  const handlers = new Map(), ipcMain = new EventEmitter(), logs = [];
  ipcMain.handle = (name, fn) => { assert.equal(handlers.has(name), false, `duplicate ${name}`); handlers.set(name, fn); };
  ipcMain.removeHandler = name => handlers.delete(name);
  const sender = new EventEmitter(); sender.id = 1; sender.mainFrame = {}; sender.isDestroyed = () => false; sender.send = () => {};
  const event = { sender, senderFrame: sender.mainFrame };
  const settings = { pluginsEnabled: true, pluginStates: {} };
  const args = { electron: { app: {}, BrowserWindow: {}, WebContentsView: function () {}, ipcMain },
    userDataDir: dir, getSettings: () => settings, persistPluginStates: states => { settings.pluginStates = states; },
    persistManagementSettings: patch => Object.assign(settings, patch), getLocale: () => 'en',
    isMainSender: e => e.sender === sender, env: {}, log: message => logs.push(message) };
  let runtime;
  t.after(() => runtime?.dispose());
  try { runtime = createPluginRuntime(args); }
  catch (error) { assert.fail(`runtime construction threw ${error.message}; leaked handlers: ${[...handlers.keys()].join(', ')}`); }
  runtime.start();
  const invoke = (name, ...values) => handlers.get(name)(event, ...values);
  let list = invoke('plugins:list');
  assert.equal(list.management.available, false);
  assert.equal(list.management.error.code, 'management-unavailable');
  assert.match(invoke('plugins:catalog').error, /Plugin management unavailable/);
  assert.ok(logs.some(line => /management unavailable/i.test(line)));
  const builtin = list.plugins.find(p => p.source === 'builtin'); assert.ok(builtin);
  list = invoke('plugins:setEnabled', { id: builtin.id, enabled: true });
  assert.equal(list.plugins.find(p => p.id === builtin.id).status, 'active');
  runtime.manager.setSurfaceDemand('home', [`${builtin.id}/${builtin.views[0].id}`]);
  assert.equal(runtime.payload('home').views[`${builtin.id}/${builtin.views[0].id}`].status, 'ok');
  for (const [name, values] of [
    ['plugins:install', ['missing']], ['plugins:rollback', ['demo']], ['plugins:uninstall', ['demo']],
    ['plugins:catalogPreview', ['bundled', 'demo']], ['plugins:addSource', [{}]], ['plugins:removeSource', ['demo']], ['plugins:refreshSource', ['demo']]
  ]) assert.throws(() => invoke(name, ...values), /Plugin management unavailable/, name);
  assert.equal(fs.readFileSync(metadata, 'utf8'), content);
  assert.equal(fs.statSync(metadata).mtimeMs, original.mtimeMs);
  assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'recovery evidence');
  runtime.dispose(); assert.equal(handlers.size, 0); assert.equal(ipcMain.eventNames().length, 0);
  runtime = createPluginRuntime(args); runtime.start(); runtime.dispose(); assert.equal(handlers.size, 0);
});

test('managed recovery failure stays closed until explicit successful recovery', t => {
  const { createManagedPlugins } = require('../../src/electron/plugins/managed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-managed-closed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'installed.json'), '{broken');
  let mutations = 0;
  const api = createManagedPlugins({ root: dir, userDir: path.join(dir, 'plugins'), dataDir: path.join(dir, 'data'),
    manager: { list: () => ({ plugins: [] }), beginMutation: () => mutations++ }, getSettings: () => ({}), saveSettings: () => mutations++ });
  assert.throws(() => api.recover());
  for (const call of [() => api.preview({}), () => api.previewFile('/nonexistent'), () => api.previewDirectory('/nonexistent'),
    () => api.install('token'), () => api.rollback('demo'), () => api.uninstall('demo')]) {
    assert.throws(call, { code: 'management-unavailable' });
  }
  assert.equal(mutations, 0);
  // This test owns the fixture: runtime never attempts this replacement.
  fs.writeFileSync(path.join(dir, 'installed.json'), '{}');
  assert.throws(() => api.assertAvailable(), { code: 'management-unavailable' });
  api.recover(); assert.equal(api.status().available, true); api.dispose();
});
