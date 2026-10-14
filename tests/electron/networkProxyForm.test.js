'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const i18n = require('../../src/electron/renderer/i18n');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function slice(from, to) {
  return app.slice(from, to);
}

function harness(settings = {}) {
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
    saveSettings: (patch) => new Promise((resolve, reject) => {
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
