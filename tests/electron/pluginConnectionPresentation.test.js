'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { Element } = require('../helpers/notchPanel');
const { translate } = require('../../src/electron/renderer/i18n');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const extract = name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];
test('HTTP rejection gets reconnect copy and storage failures get existing localized error copy', async () => {
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, t: key => translate('zh-TW', key), pluginBridge: { connection: async () => ({ state: 'error', error: 'reconnect-required' }) } });
  vm.runInContext(extract('pluginLimitAccountOptions'), context);
  const box = context.pluginLimitAccountOptions({ connection: 'openai', pluginId: 'fixture', moduleId: 'quota' });
  await box.children[2].listeners.click[0](); assert.equal(box.children[0].textContent, '需要重新連接');
  context.pluginBridge.connection = async () => { throw Error('synthetic storage failure'); };
  await box.children[2].listeners.click[0](); assert.equal(box.children[0].textContent, translate('zh-TW', 'settings.limits.status.error'));
});
test('missing demand handler is caught instead of becoming an unhandled rejection', async () => {
  const errors = [];
  const context = vm.createContext({ state: { breakdown: 'limits' }, visibleStatsSurface: () => 'main', isSettingsPanelOpen: () => false,
    pluginBridge: { limitsDemand: () => Promise.reject(Error('no handler')) }, console: { warn: (...args) => errors.push(args) } });
  vm.runInContext(extract('syncPluginLimitsDemand'), context); context.syncPluginLimitsDemand(); await new Promise(setImmediate);
  assert.equal(errors.length, 1);
});
test('connection and filter labels are translated in Korean, Japanese and Brazilian Portuguese', () => {
  const expected = { ko: ['연결','플러그인 유형'], ja: ['接続','プラグインの種類'], 'pt-BR': ['Conectar','Tipo de plugin'] };
  for (const [locale, values] of Object.entries(expected)) {
    assert.equal(translate(locale, 'plugins.connection.connect'), values[0]); assert.equal(translate(locale, 'plugins.filter.type'), values[1]);
    for (const key of ['status','disconnect','state.notConnected','state.connecting','state.connected','state.reconnectRequired','state.error','forget']) assert.notEqual(translate(locale, 'plugins.connection.'+key), translate('en', 'plugins.connection.'+key));
    assert.notEqual(translate(locale, 'plugins.filter.all'), translate('en', 'plugins.filter.all'));
  }
});
