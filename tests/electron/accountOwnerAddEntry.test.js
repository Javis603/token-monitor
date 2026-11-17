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
    node.appendChild = child => { node.append(child); return child; };
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

test('third-party editing clears another profile draft credentials and restores only selected metadata', async () => {
  const h = harness('thirdparty', { getProfiles: async () => ({ profiles: { selected: { adapter: 'sub2api', baseUrl: 'https://selected.example', canonicalAccountKey: 'selected-key' } } }) });
  await h.render();
  for (const field of ['AccessToken', 'RefreshToken', 'ApiKey', 'UserId']) h.nodes[`thirdparty${field}Input`].value = 'other-profile-draft';
  await [...h.document.root.walk()].find(node => node.dataset.slotAction === 'replaceKey').click();
  for (const field of ['AccessToken', 'RefreshToken', 'ApiKey', 'UserId']) assert.equal(h.nodes[`thirdparty${field}Input`].value, '', field);
});
test('Cursor discovery response cannot replace a newer successful manual login', async () => {
  let finish;
  const h = harness('cursor', { status: () => new Promise(resolve => { finish = resolve; }), loginManual: async () => ({ ok: true, status: { accounts: [{ id: 'fresh', accountKey: 'fresh' }] } }) });
  h.owner.setup();
  h.nodes.cursorManualInput.value = 'new-login';
  await h.nodes.cursorManualSubmit.click();
  finish({ accounts: [{ id: 'stale', accountKey: 'stale' }] }); await flush();
  assert.equal(h.owner.state.cursorAccount.status.accounts[0].id, 'fresh');
});
test('Antigravity cancel waits for the original add request before permitting a retry', async () => {
  let finish;
  const h = harness('antigravity', { addAccount: () => new Promise(resolve => { finish = resolve; }) });
  h.owner.setup(); await flush();
  const pending = h.add().click();
  await h.nodes.antigravityCancelLoginButton.click();
  assert.equal(h.add().disabled, true);
  finish({ ok: false, errorCode: 'cancelled' }); await pending;
  assert.equal(h.add().disabled, false);
});
test('MiMo preserves a newer draft entered while refreshing saved accounts', async () => {
  let refresh;
  const h = harness('mimo', { addAccount: async () => ({ ok: true }) });
  h.owner.setup(); await flush();
  h.api.accounts = () => new Promise(resolve => { refresh = resolve; });
  await h.add().click();
  h.nodes.mimoCookieInput.value = 'draft-a';
  const saving = h.nodes.mimoSaveAccountButton.click(); await flush();
  h.nodes.mimoCookieInput.value = 'draft-b';
  refresh([]); await saving;
  assert.equal(h.nodes.mimoCookieInput.value, 'draft-b');
  assert.equal(h.nodes.mimoAddDetails.classList.contains('hidden'), false);
});
test('WorkBuddy shared row mutation blocks sign-in until the account update settles', async () => {
  let finish;
  const h = harness('workbuddy', { setAccountEnabled: () => new Promise(resolve => { finish = resolve; }) });
  h.settings.workbuddyManagedAccounts = [{ id: 'a', accountKey: 'a', enabled: true }];
  await h.render();
  const pause = [...h.document.root.walk()].find(node => node.dataset.slotAction === 'pause').click(); await flush();
  await h.owner.startWorkbuddyLogin('cn');
  assert.equal(h.calls.length, 0);
  finish({ ok: true, accounts: [{ id: 'a', accountKey: 'a', enabled: false }] }); await pause;
  assert.equal(h.settings.workbuddyManagedAccounts[0].enabled, false);
});
test('OpenCode saved profile named ambient remains distinct from the detected key', async () => {
  const toggles = [];
  const h = harness('opencode', { getProfiles: async () => ({ profiles: { ambient: { accountKey: 'saved', enabled: true } }, hasAmbientKey: true, ambientAccountKey: 'detected' }),
    setProfileEnabled: async (id,value) => { toggles.push(['saved',id,value]); return {ok:true}; }, setAmbientEnabled: async value => {toggles.push(['ambient',value]);return {ok:true};} });
  await h.render();
  const rows = [...h.document.root.walk()].filter(node=>node.classList.contains('slot-row'));
  assert.equal(rows.length,2);
  await [...rows.find(row=>row.dataset.slotId==='ambient').walk()].find(node=>node.dataset.slotAction==='pause').click();
  assert.deepEqual(toggles,[['saved','ambient',false]]);
});


test('Codex cancelled add result clears progress before a delayed cancel reply', async () => {
  let finishAdd, finishCancel;
  const h = harness('codex', {
    addAccount: () => new Promise(resolve => { finishAdd = resolve; }),
    cancelLogin: () => new Promise(resolve => { finishCancel = resolve; })
  });
  h.owner.setup(); await flush();
  const adding = h.add().click();
  h.owner.state.codexLoginOutput = 'Waiting for browser';
  h.owner.state.codexAccountError = 'Previous error';
  h.nodes.codexLoginDetails.open = true;
  const cancelling = h.nodes.codexCancelLoginButton.click();
  finishAdd({ ok: false, outcome: 'cancelled' }); await adding;
  assert.equal(h.nodes.codexLoginStatus.textContent, '');
  assert.equal(h.nodes.codexLoginOutput.textContent, '');
  assert.equal(h.owner.state.codexAccountError, '');
  assert.equal(h.nodes.codexLoginDetails.open, false);
  assert.equal(h.add().disabled, false);
  const retry = h.add().click();
  const retryFlow = h.owner.state.codexSignInFlowId;
  finishCancel({ ok: true, cancelled: true }); await cancelling;
  assert.equal(h.owner.state.codexSignInFlowId, retryFlow);
  assert.equal(h.add().disabled, true);
  finishAdd({ ok: false, outcome: 'cancelled' }); await retry;
});

test('Cursor initial discovery failure keeps the shared manual-login footer reachable', async () => {
  const h = harness('cursor', { status: async () => { throw new Error('discovery unavailable'); } });
  h.owner.setup(); await flush();
  assert.ok(h.add());
  assert.equal(h.add().disabled, false);
  await h.add().click();
  assert.equal(h.nodes.cursorManualDetails.classList.contains('hidden'), false);
  h.owner.state.cursorAccount = { error: 'discovery unavailable', busy: false, status: { accounts: [], managementBlocked: true } };
  await h.render();
  assert.equal(h.add().disabled, true, 'a known external-agent gate still blocks management on error');
});
