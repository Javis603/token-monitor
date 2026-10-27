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

function fixture({ blocked = false } = {}) {
  const nodes = new Map();
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const status = { accounts: [{ id: 'work', email: 'owner@example.test', enabled: true }], managementBlocked: blocked };
  const context = {
    state: { cursorAccount: { status } },
    document: { getElementById: getNode, createElement: tag => new Element(tag) },
    window: { tokenMonitor: { cursor: {} } },
    t: key => key, isSettingsSurfaceVisible: () => true,
    accountShellApi: { render() {} }, accountShellErrors: {},
    setCursorStatusText() {}, setCursorCheckboxesEnabled() {}, setSettingsSectionExpanded() {}, setCursorAccountExpanded() {},
    renderSettingsSummaries() {}, limitProviderPresentationApi: { limitProviderDisplayLabel: value => value }
  };
  context.setAccountShellError = (id, message) => { context.accountShellErrors[id] = message || ''; };
  const body = app.slice(app.indexOf('function renderCursorStatus()'), app.indexOf('async function refreshCursorStatus('));
  vm.runInNewContext(`${body}\nrenderCursorStatus();`, context);
  const elements = node => [node, ...node.children.flatMap(elements)];
  return { context, texts: elements(getNode('cursorAccountList')).map(node => node.textContent) };
}

test('Cursor account rows do not offer a Grok billing sign-in', () => {
  const f = fixture();
  assert.equal(f.texts.includes('settings.cursor.billingConnect'), false);
  assert.equal(f.texts.includes('settings.cursor.billingReconnect'), false);
  assert.equal(f.texts.includes('settings.cursor.billingDisconnect'), false);
});

test('Cursor logout refreshes usage without a Grok billing session', async () => {
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

test('startup does not open a Grok billing sign-in or poll billing accounts', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const startup = main.slice(main.indexOf('app.whenReady().then('), main.indexOf('  syncLoginItemSettingFromOs();', main.indexOf('app.whenReady().then(')));
  assert.doesNotMatch(startup, /openGrokDashboardWindow\(|startGrokBillingRefresh\(|selectedCursorBillingAccounts\(/);
  assert.doesNotMatch(main, /ipcMain\.handle\('cursor:connectBilling'|ipcMain\.handle\('cursor:disconnectBilling'/);
  const settingsPage = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'renderer/i18n.js'), 'utf8');
  assert.doesNotMatch(settingsPage, /settings\.cursor\.billingNote/);
  assert.doesNotMatch(i18n, /settings\.cursor\.billingNote/);
});
