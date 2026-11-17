"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDocument } = require('./accountOwnerDom.fixture.cjs');
const legacyList = require('../../src/electron/renderer/limits/legacyAccountList');
const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(provider, overrides = {}) {
  const document = createDocument();
  const source = fs.readFileSync(path.join(renderer, `limits/providerOwners/${provider}.js`), 'utf8');
  const nodes = {};
  const ids = new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]));
  ids.add(`${provider}ProfileList`);
  for (const id of ids) {
    const node = document.createElement('div'); node.id = id; node.options = []; nodes[id] = node;
    node.before = child => node.parentElement.insertBefore(child, node);
    if (/Details$/.test(id)) node.classList.add('hidden');
    document.root.append(node);
  }
  const originalCreate = document.createElement;
  document.createElement = tag => { const node = originalCreate(tag); node.appendChild = child => { node.append(child); return child; }; node.before = child => node.parentElement.insertBefore(child, node); return node; };
  const originalQuery = document.querySelectorAll;
  document.querySelectorAll = selector => selector.startsWith('[data-managed-profile-') ? [] : originalQuery(selector);
  const settings = {};
  const calls = [];
  const api = { accounts: async () => [], onAccounts() {}, onLoginStatus() {}, getKeys: async () => [],
    getProfiles: async () => ({ profiles: {} }), status: async () => ({ profiles: {}, accounts: [] }),
    addAccount: async (...args) => { calls.push(args); return { ok: false, errorCode: 'cancelled', outcome: 'cancelled' }; },
    cancelLogin: async () => ({ ok: true, cancelled: true }), ...overrides };
  let owner;
  const host = {
    document, providerLabel: `Display ${provider}`, initial: { cursorAccount: { status: { accounts: [] }, busy: false }, codexWorkspaceChoices: [] },
    getSettings: () => settings, getAccountContext: () => ({ settings }), preserveScroll: fn => fn(),
    t: (key, params) => key === 'settings.slots.add' ? `＋ Add ${params.provider} account` : key,
    window: { TokenMonitorLegacyAccountList: legacyList, tokenMonitor: { [provider]: api } },
    isSettingsSurfaceVisible: () => true, localProviderStatuses: () => [], limitProviderEnabled: () => true,
    accountShellApi, setCursorStatusText() {}, setCursorCheckboxesEnabled() {}, setSettingsSectionExpanded() {}, accountShellErrors: {},
    accountProfileRequests: { begin: () => () => true }, accountProfileStatuses: { begin: () => () => true, retire() {} },
    accountProfileSaves: accountShellApi.createBusyGuard(),
    renderAccountShellError() {}, renderSettingsSummaries() {}, renderSubscriptionSettings() {}, setAccountShellError() {},
    setAccountGroupExpanded() {}, setAccountPanelMessage() {}, encodeURIComponent,
    renderExternalProviderStatus() { owner.renderClaudeWebAccounts(); }, refreshStats: async () => {},
    limitProviderPresentationApi: { limitProviderSettingsRecord: () => null },
  };
  owner = require(path.join(renderer, `limits/providerOwners/${provider}`)).create(host);
  const render = { codex: 'renderCodexAccounts', claude: 'renderClaudeWebAccounts', cursor: 'renderCursorStatus', antigravity: 'renderAntigravityStatus',
    mimo: 'renderMimoStatus', workbuddy: 'renderWorkbuddyStatus', minimax: 'renderMinimaxApiKeys', opencode: 'renderOpenCodeProfiles', thirdparty: 'renderThirdPartyProfiles' }[provider];
  return { document, nodes, owner, api, calls, settings,
    async render() { await owner[render](); await flush(); },
    add: () => document.root.querySelector('.slot-add') };
}
for (const provider of ['codex', 'claude', 'cursor', 'antigravity', 'mimo', 'workbuddy', 'minimax', 'opencode', 'thirdparty']) {
  test(`${provider}: the first account uses the visible common add footer and provider display label`, async () => {
    const h = harness(provider);
    await h.render();
    const add = h.add();
    assert.ok(add, 'zero accounts must still mount a footer');
    assert.equal(add.classList.contains('hidden'), false);
    assert.equal(add.textContent, `＋ Add Display ${provider} account`);
    assert.equal(h.document.root.querySelector('.slot-row'), undefined);
    await add.click();
    if (['codex', 'antigravity'].includes(provider)) assert.equal(h.calls.length, 1);
    else if (provider === 'claude') {
      assert.equal(h.owner.editor.open, true);
      h.owner.cancelClaudeWebAccountEdit();
      await add.click();
      assert.equal(h.owner.editor.open, true);
    } else if (provider === 'workbuddy') {
      assert.equal(h.nodes.workbuddyAddCnAccountButton.classList.contains('hidden'), false);
      assert.equal(h.nodes.workbuddyAddAiAccountButton.classList.contains('hidden'), false);
    } else {
      const id = { cursor: 'cursorManualDetails', mimo: 'mimoAddDetails', minimax: 'minimaxAddDetails', opencode: 'opencodeAddDetails', thirdparty: 'thirdpartyAddDetails' }[provider];
      assert.equal(h.nodes[id].classList.contains('hidden'), false);
      await add.click();
      assert.equal(h.nodes[id].classList.contains('hidden'), true);
      await add.click();
      assert.equal(h.nodes[id].classList.contains('hidden'), false);
    }
  });
}
test('Codex common add stays disabled during login, then cancellation permits retry before the old result settles', async () => {
  const pending = [];
  const h = harness('codex', { addAccount: () => new Promise(resolve => pending.push(resolve)) });
  h.owner.setup(); await flush();
  const first = h.add().click();
  assert.equal(pending.length, 1);
  assert.equal(h.add().disabled, true);
  assert.equal(h.nodes.codexCancelLoginButton.classList.contains('hidden'), false);
  await h.add().click();
  assert.equal(pending.length, 1, 'busy guard must also reject synthetic clicks');
  await h.nodes.codexCancelLoginButton.click();
  assert.equal(h.add().disabled, false);
  const second = h.add().click();
  assert.equal(pending.length, 2);
  pending[0]({ ok: false, outcome: 'cancelled' }); await first;
  assert.equal(h.add().disabled, true, 'late result cannot settle the new login');
  pending[1]({ ok: false, outcome: 'cancelled' }); await second;
  assert.equal(h.add().disabled, false);
});
test('WorkBuddy footer retains both realm protocols and cancel/retry', async () => {
  const realms = [];
  const pending = [];
  const h = harness('workbuddy', { addAccount: realm => { realms.push(realm); return new Promise(resolve => pending.push(resolve)); } });
  h.owner.setup(); await flush();
  assert.equal(h.nodes.workbuddyAddCnAccountButton.classList.contains('hidden'), true);
  await h.add().click();
  const first = h.nodes.workbuddyAddAiAccountButton.click();
  assert.deepEqual(realms, ['ai']);
  assert.equal(h.add().disabled, true);
  assert.equal(h.nodes.workbuddyCancelLoginButton.classList.contains('hidden'), false);
  await h.nodes.workbuddyCancelLoginButton.click();
  assert.equal(h.add().disabled, false);
  await h.add().click();
  const second = h.nodes.workbuddyAddCnAccountButton.click();
  assert.deepEqual(realms, ['ai', 'cn']);
  pending[0]({ ok: true, accounts: [{ id: 'stale' }] }); await first;
  assert.equal(h.owner.state.workbuddySignInBusy, true);
  pending[1]({ ok: false, errorCode: 'cancelled' }); await second;
  assert.equal(h.add().disabled, false);
});
test('Cursor external-agent gate disables the common add footer', async () => {
  const h = harness('cursor');
  h.owner.state.cursorAccount.status.managementBlocked = true;
  await h.render();
  assert.equal(h.add().disabled, true);
  await h.add().click();
  assert.equal(h.nodes.cursorManualDetails.classList.contains('hidden'), true);
});
