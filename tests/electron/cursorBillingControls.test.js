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
  context.setAccountShellError = (id, message) => { context.accountShellErrors[id] = message || ''; };
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

test('billing action errors remain visible while account rows keep receiving status updates', async () => {
  const f = fixture({ connected: true });
  f.context.window.tokenMonitor.cursor.disconnectBilling = async () => ({ ok: false, error: 'Cleanup failed' });
  f.context.renderCursorStatus();
  await f.button('settings.cursor.billingDisconnect').listeners.click();
  assert.equal(f.context.accountShellErrors.cursor, 'Cleanup failed');
  assert.equal(f.context.state.cursorAccount.error || '', '');
  const list = f.context.document.getElementById('cursorAccountList');
  const before = list.children[0];
  f.context.state.cursorAccount.status.accounts[0].billingStatus = 'storageLimit';
  f.context.renderCursorStatus();
  const texts = node => [node.textContent, ...node.children.flatMap(texts)];
  assert.notEqual(list.children[0], before, 'the error must not freeze account rows');
  assert.ok(texts(list).includes('settings.cursor.billingStatus.storageLimit'));
  assert.equal(f.context.accountShellErrors.cursor, 'Cleanup failed');
  f.context.window.tokenMonitor.cursor.disconnectBilling = async () => ({ ok: true, status: f.context.state.cursorAccount.status });
  f.context.renderCursorStatus();
  await f.button('settings.cursor.billingDisconnect').listeners.click();
  assert.equal(f.context.accountShellErrors.cursor, '');
});

for (const connected of [false, true]) {
  for (const rejects of [false, true]) {
    test(`failed billing ${connected ? 'disconnect' : 'connect'} permits retry (${rejects ? 'rejection' : 'error result'})`, async () => {
      const f = fixture({ connected });
      const action = connected ? 'disconnectBilling' : 'connectBilling';
      const label = connected ? 'settings.cursor.billingDisconnect' : 'settings.cursor.billingConnect';
      f.context.window.tokenMonitor.cursor[action] = async () => {
        if (rejects) throw new Error('Connection failed');
        return { ok: false, error: 'Connection failed' };
      };
      f.context.renderCursorStatus();
      const button = f.button(label);
      const pending = button.listeners.click();
      assert.equal(button.disabled, true);
      await pending;
      assert.equal(button.disabled, false, 'the existing error view must leave the action retryable');
    });
  }
}

test('Cursor logout finishes after billing storage cleanup fails', async () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('cursor:logout'");
  const body = main.slice(start, main.indexOf("  ipcMain.handle('opencode:logout'", start));
  const calls = [];
  let logout;
  const context = {
    ipcMain: { handle(_name, handler) { logout = handler; } },
    isExternalAgentActive: () => false,
    settings: { cursorManualAccountIds: ['work'], cursorDisabledAccountIds: ['work'], cursorBillingAccountIds: ['work'] },
    normalizeCursorAccountIds: value => value, normalizeCursorDisabledAccountIds: value => value,
    cursorAuth: { runCursorLogout: async () => { calls.push('logout'); } },
    saveSettings: () => { calls.push('save'); }, session: {},
    disconnectGrokBilling: async () => { throw new Error('Storage unavailable'); },
    reconfigureUsageRuntimeForMode: () => { calls.push('usage'); },
    deviceRuntimeHandle: { reconfigureLimits: () => { calls.push('limits'); } },
    electronLimitsConfig: () => ({}), cursorStatusCache: { value: {}, at: 1 },
    queueLimitInvalidation: () => { calls.push('invalidate'); },
    bestEffortTrackedUsageRefresh: () => { calls.push('refresh'); },
    cursorStatusValue: async () => ({ accounts: [] }), console: { log() {} }
  };
  vm.runInNewContext(body, context);
  const result = await logout({}, 'work');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['logout', 'save', 'usage', 'limits', 'invalidate', 'refresh']);
  assert.equal(context.cursorStatusCache.value, null);
});

for (const reconfigureFails of [false, true]) {
  test(`billing disconnect handles failed storage cleanup before reconfiguration (${reconfigureFails ? 'throws' : 'succeeds'})`, async () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const start = main.indexOf("ipcMain.handle('cursor:disconnectBilling'");
    const body = main.slice(start, main.indexOf("  ipcMain.handle('limits:saveCredential'", start));
    let disconnect;
    const context = {
      ipcMain: { handle(name, handler) { if (name === 'cursor:disconnectBilling') disconnect = handler; } },
      ownsUsageRuntime: () => true, isExternalAgentActive: () => false,
      cursorAuth: { listAccounts: () => [{ id: 'work' }] },
      settings: { cursorBillingAccountIds: ['work'] }, normalizeCursorAccountIds: value => value,
      saveSettings() {}, session: {},
      disconnectGrokBilling: async () => { throw new Error('Storage unavailable'); },
      reconfigureUsageRuntimeForMode() { if (reconfigureFails) throw new Error('Reconfiguration failed'); },
      cursorStatusCache: { value: {}, at: 1 },
      cursorStatusValue: async () => ({ accounts: [] }), console: { log() {} }
    };
    vm.runInNewContext(body, context);
    const result = await disconnect({}, 'work');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.ok, !reconfigureFails);
    assert.equal(context.settings.cursorBillingAccountIds.length, 0);
    if (!reconfigureFails) assert.equal(context.cursorStatusCache.value, null);
  });
}

test('startup only registers opted-in background polling and does not open a sign-in window', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const startup = main.slice(main.indexOf('app.whenReady().then('), main.indexOf('  syncLoginItemSettingFromOs();', main.indexOf('app.whenReady().then(')));
  assert.doesNotMatch(startup, /openGrokDashboardWindow\(/);
  assert.match(startup, /selectedCursorBillingAccounts\(\)/);
});
