'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '../../src/electron');
const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(event, callback) { this.listeners[event] = callback; }
}

function fixture({ blocked = false, connected = false } = {}) {
  const nodes = new Map();
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const calls = [];
  const status = { accounts: [{ id: 'work', email: 'owner@example.test', enabled: true,
    billingEnabled: connected, billingStatus: connected ? 'connected' : 'notConnected' }], managementBlocked: blocked };
  const context = {
    state: { cursorAccount: { status } },
    document: { getElementById: getNode, createElement: tag => new Element(tag) },
    window: { tokenMonitor: { cursor: {
      connectBilling: async id => { calls.push(['connect', id]); status.accounts[0].billingEnabled = true; return { ok: true, status }; },
      disconnectBilling: async id => { calls.push(['disconnect', id]); status.accounts[0].billingEnabled = false; return { ok: true, status }; }
    } } },
    t: key => key, isSettingsSurfaceVisible: () => true,
    accountShellApi: { render() {} }, accountShellErrors: {},
    setCursorStatusText() {}, setCursorCheckboxesEnabled() {}, setSettingsSectionExpanded() {}, setCursorAccountExpanded() {},
    renderSettingsSummaries() {}, limitProviderPresentationApi: { limitProviderDisplayLabel: value => value }
  };
  const body = app.slice(app.indexOf('function renderCursorStatus()'), app.indexOf('async function refreshCursorStatus('));
  vm.runInNewContext(`${body}\nrenderCursorStatus();`, context);
  const elements = node => [node, ...node.children.flatMap(elements)];
  const button = key => elements(getNode('cursorAccountList')).find(node => node.tag === 'button' && node.textContent === key);
  return { calls, context, button };
}

test('Cursor billing controls explicitly connect and disconnect the displayed account', async () => {
  const f = fixture();
  await f.button('settings.cursor.billingConnect').listeners.click();
  assert.deepEqual(f.calls, [['connect', 'work']]);
  assert.ok(f.button('settings.cursor.billingReconnect'));
  await f.button('settings.cursor.billingDisconnect').listeners.click();
  assert.deepEqual(f.calls, [['connect', 'work'], ['disconnect', 'work']]);
  assert.ok(f.button('settings.cursor.billingConnect'));
});

test('external-agent ownership blocks billing account management', () => {
  const f = fixture({ blocked: true, connected: true });
  assert.equal(f.button('settings.cursor.billingReconnect').disabled, true);
  assert.equal(f.button('settings.cursor.billingDisconnect').disabled, true);
});

test('startup only registers opted-in background polling and does not open a sign-in window', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const startup = main.slice(main.indexOf('app.whenReady().then('), main.indexOf('  syncLoginItemSettingFromOs();', main.indexOf('app.whenReady().then(')));
  assert.doesNotMatch(startup, /openGrokDashboardWindow\(/);
  assert.match(startup, /selectedCursorBillingAccounts\(\)/);
});
