'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('the production plugin host receives the shared transport without a keyring dependency', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.indexOf('pluginRuntime = createPluginRuntime({');
  const options = main.slice(start, main.indexOf('userDataDir:', start));
  const literal = options.match(/electron: (\{[^]*?\}),/)[1];
  const context = {};
  for (const key of ['app','BrowserWindow','Notification','ipcMain','nativeImage','session','shell','dialog']) context[key] = { fixture: key };
  const utilityProcess = { fixture: 'utilityProcess' }; context.require = name => { assert.equal(name, 'electron'); return { utilityProcess }; };
  const injected = vm.runInNewContext(`(${literal})`, context);
  assert.equal(Object.hasOwn(injected, 'safeStorage'), false);
  assert.equal(injected.utilityProcess, utilityProcess);
  assert.match(options, /fetchImpl: electronLimitsFetch\(\)/);
});
