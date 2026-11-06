'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const vm = require('node:vm');
const i18n = require('../../src/electron/renderer/i18n');
const proxy = require('../../src/electron/networkProxy');
const { CredentialStore, persistSettingsAndCredentials } = require('../../src/shared/credentialStore');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function slice(from, to) {
  return app.slice(from, to);
}

function harness(settings = {}, updateSettings) {
  const document = { activeElement: null };
  const control = () => ({
    value: '', hidden: false, textContent: '', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }
  });
  const els = Object.fromEntries(['proxyUrlInput', 'noProxyInput', 'networkProxySource', 'proxyUrlError']
    .map((id) => [id, control()]));
  const state = { settings: { proxyUrl: '', noProxy: '', networkProxySource: 'system', ...settings } };
  const pending = [];
  const context = vm.createContext({
    state, els, document,
    t: (key) => i18n.translate('en', key),
    preserveSettingsPanelScroll: (callback) => callback(),
    // Mirrors the real saveSettings: a refused write re-syncs the whole form
    // from the stored settings before it rejects.
    saveSettings: updateSettings ? async (patch) => {
      try { state.settings = await updateSettings(patch); }
      finally { context.syncNetworkProxyControls(); }
    } : (patch) => new Promise((resolve, reject) => {
      pending.push({
        patch,
        resolve: () => { state.settings = { ...state.settings, ...patch }; context.syncNetworkProxyControls(); resolve(true); },
        reject: (code) => { context.syncNetworkProxyControls(); reject(new Error(`Error invoking remote method 'settings:update': Error: ${code}`)); }
      });
    })
  });
  // The block between the previous function and the next one, and the listener
  // lines, so the harness does not depend on how the state is declared.
  const formEnd = app.indexOf('function renderAutomaticAppUpdateControl() {');
  const formStart = app.lastIndexOf('\n}\n', app.indexOf('const PROXY_SETTING_ERROR_CODES')) + 3;
  const listenersStart = app.indexOf("els.proxyUrlInput?.addEventListener('input'");
  const lastListener = "els.noProxyInput?.addEventListener('change'";
  const listenersEnd = app.indexOf('\n', app.indexOf(lastListener));
  vm.runInContext(`${slice(formStart, formEnd)}\n${slice(listenersStart, listenersEnd)}`, context);
  const type = (input, value) => { input.value = value; input.listeners.input?.(); };
  const commit = (input) => input.listeners.change();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { context, els, state, pending, type, commit, flush };
}

// CodeRabbit on #1049: a refused save used to write its own value back into
// the field, over whatever the user had typed since.
test('a refused save does not overwrite a newer edit', async () => {
  const { els, pending, type, commit, flush } = harness();
  type(els.proxyUrlInput, 'socks5://127.0.0.1:7897');
  const saving = commit(els.proxyUrlInput);
  type(els.proxyUrlInput, 'http://127.0.0.1:7897');
  pending[0].reject('proxy_unsupported_scheme');
  await saving;
  await flush();
  assert.equal(els.proxyUrlInput.value, 'http://127.0.0.1:7897');
  assert.equal(els.proxyUrlError.hidden, true, 'the stale refusal does not describe the new text');
});

test('a refused value stays in the field with its reason across settings pushes', async () => {
  const { context, els, pending, type, commit } = harness({ proxyUrl: 'http://127.0.0.1:1' });
  context.syncNetworkProxyControls();
  type(els.proxyUrlInput, 'socks5://127.0.0.1:7897');
  const saving = commit(els.proxyUrlInput);
  pending[0].reject('proxy_unsupported_scheme');
  await saving;
  context.syncNetworkProxyControls();
  assert.equal(els.proxyUrlInput.value, 'socks5://127.0.0.1:7897');
  assert.equal(els.proxyUrlError.hidden, false);
  assert.equal(els.proxyUrlError.textContent, i18n.translate('en', 'settings.proxy.error.proxy_unsupported_scheme'));

  type(els.proxyUrlInput, 'socks5://127.0.0.1:789');
  assert.equal(els.proxyUrlError.hidden, true, 'editing the field clears its refusal');
});

test('a stored value replaces the field once its save lands', async () => {
  const { context, els, pending, type, commit } = harness();
  type(els.proxyUrlInput, '127.0.0.1:7897');
  const saving = commit(els.proxyUrlInput);
  pending[0].patch.proxyUrl = 'http://127.0.0.1:7897';
  pending[0].resolve();
  await saving;
  context.syncNetworkProxyControls();
  assert.equal(els.proxyUrlInput.value, 'http://127.0.0.1:7897');
});

test('an unsupported bypass entry is refused with its own reason', async () => {
  const { els, pending, type, commit } = harness();
  type(els.noProxyInput, '10.0.0.0/8');
  const saving = commit(els.noProxyInput);
  pending[0].reject('proxy_bypass_unsupported');
  await saving;
  assert.equal(els.noProxyInput.value, '10.0.0.0/8');
  assert.equal(els.proxyUrlError.hidden, false);
  assert.equal(els.proxyUrlError.textContent, i18n.translate('en', 'settings.proxy.error.proxy_bypass_unsupported'));
});

test('an overlong bypass save through renderer and preload leaves persisted settings and routing unchanged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  const settingsPath = path.join(dir, 'settings.json');
  const original = { proxyUrl: 'http://127.0.0.1:7897', noProxy: 'existing.test', claudeWebCookie: 'synthetic-test-only' };
  persistSettingsAndCredentials({ store, settingsPath, settings: original, previousSettings: {} });
  const settingsBytes = fs.readFileSync(settingsPath);
  const credentialBytes = fs.readFileSync(store.filePath);
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const validationStart = main.indexOf('    if (patch.proxyUrl !== undefined) {');
  const validation = main.slice(validationStart, main.indexOf('    if (patch.vendorColors', validationStart));
  const properties = ['proxyUrl', 'noProxy'].map((key) => main.match(new RegExp(`^      ${key}: patch\\.${key}[^\\n]+`, 'm'))[0]).join('\n');
  const saveStart = main.indexOf('function saveSettings(options = {}) {');
  const save = main.slice(saveStart, main.indexOf('\nfunction seedInitialLimitProviders', saveStart));
  const context = vm.createContext({
    ...proxy, settings: { ...original }, persistedSettingsSnapshot: { ...original },
    cloneSettingsSnapshot: (value) => JSON.parse(JSON.stringify(value)),
    persistSettingsAndCredentials, ensureCredentialStore: () => store, settingsPath,
    refreshTrayContextMenu() {}, reportCredentialStorageError() {}
  });
  // The actual main validation and normalization execute before its actual
  // saveSettings implementation, which uses the real atomic credential store.
  vm.runInContext(`${save}\nfunction update(patch) {\n${validation}\nsettings = { ...settings,\n${properties}\n};\nsaveSettings({ throwOnError: true }); return settings; }`, context);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'tokenMonitor') bridge = api; } },
      ipcRenderer: { invoke: async (channel, patch) => {
        assert.equal(channel, 'settings:update');
        return context.update(patch);
      } }
    })
  });
  const h = harness(original, bridge.updateSettings);
  const prefix = Array.from({ length: 198 }, (_, i) => `a${String(i).padStart(3, '0')}.test`).join(',');
  const rejected = `${prefix},pad.test,example.com.evil`;
  assert.equal(rejected.length, 2005);
  h.type(h.els.noProxyInput, rejected);
  await h.commit(h.els.noProxyInput);
  assert.equal(h.els.proxyUrlError.textContent, i18n.translate('en', 'settings.proxy.error.proxy_bypass_too_long'));
  assert.equal(h.els.noProxyInput.value, rejected, 'refused input remains editable');
  assert.equal(context.settings.noProxy, 'existing.test');
  assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes);
  assert.deepEqual(fs.readFileSync(store.filePath), credentialBytes);
  assert.equal(proxy.sessionProxyConfig(context.settings).proxyBypassRules, 'existing.test,*.existing.test');

  const route = proxy.outboundRouteForSettings(context.settings, {});
  const agent = new proxy.AppProxyAgent({ httpProxy: route.env.http_proxy, httpsProxy: route.env.https_proxy, noProxy: route.env.no_proxy });
  t.after(() => agent.close());
  const choices = [];
  const symbols = Object.getOwnPropertySymbols(agent.proxied);
  for (const name of ['no proxy agent', 'http proxy agent', 'https proxy agent']) {
    const symbol = symbols.find((candidate) => candidate.description === name);
    assert.ok(symbol, `undici dispatcher ${name}`);
    agent.proxied[symbol].dispatch = () => { choices.push(name); return true; };
  }
  agent.dispatch({ origin: 'http://example.com', path: '/', method: 'GET' }, {});
  assert.deepEqual(choices, ['http proxy agent'], 'the rejected suffix must not create an example.com bypass');

  for (const length of [1999, 2000, 2001]) {
    const value = `${prefix},${'x'.repeat(length - prefix.length - 1)}`;
    h.type(h.els.noProxyInput, value);
    const previous = fs.readFileSync(settingsPath);
    await h.commit(h.els.noProxyInput);
    if (length <= 2000) {
      assert.equal(h.els.proxyUrlError.hidden, true);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).noProxy, value);
    } else {
      assert.equal(h.els.proxyUrlError.hidden, false);
      assert.deepEqual(fs.readFileSync(settingsPath), previous);
    }
  }
});
