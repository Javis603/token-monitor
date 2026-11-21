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
function harness(provider, overrides = {}, context = {}, localReadings = []) {
  const document = createDocument();
  const source = fs.readFileSync(path.join(renderer, `limits/providerOwners/${provider}.js`), 'utf8');
  const nodes = {};
  const ids = new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]));
  ids.add(`${provider}ProfileList`); ids.add(`${provider}Status`);
  for (const id of ids) {
    const node = document.createElement('div'); node.id = id; node.options = []; nodes[id] = node;
    node.before = child => node.parentElement.insertBefore(child, node);
    node.appendChild = child => { node.append(child); return child; };
    if (/Details$/.test(id)) node.classList.add('hidden');
    document.root.append(node);
  }
  if (provider === 'minimax') {
    const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
    assert.match(html, /id="minimaxAddDetails"[^>]*>\s*<div class="settings-actions">\s*<button id="minimaxOpenBrowser"/);
    nodes.minimaxAddDetails.append(nodes.minimaxOpenBrowser);
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
    getSettings: () => settings, getAccountContext: () => ({ settings, ...context }), preserveScroll: fn => fn(),
    t: (key, params) => key === 'settings.slots.add' ? `＋ Add ${params.provider} account` : key === 'settings.slots.connectedCount' ? `${params.linked}/${params.total}` : key,
    window: { TokenMonitorLegacyAccountList: legacyList, tokenMonitor: { [provider]: api } },
    isSettingsSurfaceVisible: () => true, localProviderStatuses: () => localReadings, limitProviderEnabled: () => true,
    accountShellApi, setCursorStatusText(element, text) { element.textContent = text; }, setCursorCheckboxesEnabled() {}, setSettingsSectionExpanded() {}, accountShellErrors: {},
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
  return { document, nodes, owner, api, calls, settings, bridge: host.window.tokenMonitor,
    async render() { await owner[render](); await flush(); },
    add: () => document.root.querySelector('.slot-add') };
}
// The header counts the rows the list shows, so an account read on another
// device is counted, and is connected only when its own reading is healthy.
const headerStatus = {
  codex: h => h.nodes.codexAccountStatus.textContent,
  claude: h => h.owner.claudeAccountStatusText('fallback'),
  cursor: h => h.nodes.cursorAccountStatus.textContent,
  antigravity: h => h.nodes.antigravityAccountStatus.textContent,
  mimo: h => h.nodes.mimoAccountStatus.textContent,
  workbuddy: h => h.nodes.workbuddyAccountStatus.textContent,
  opencode: h => h.nodes.opencodeCookieStatus.textContent,
  thirdparty: h => h.nodes.thirdpartyStatus.textContent
};
for (const [provider, read] of Object.entries(headerStatus)) {
  test(`${provider}: the account header counts connected accounts from other devices`, async () => {
    const records = [
      { provider, sourceDeviceId: 'peer', accountKey: `remote-${provider}`, status: 'ok' },
      { provider, sourceDeviceId: 'peer', accountKey: `failing-${provider}`, status: 'unavailable' }
    ];
    const h = harness(provider, {}, { records, localDeviceId: 'local' });
    await h.render();
    assert.equal(read(h), '1/2');
  });
}

test('OpenCode counts an account configured only through the environment cookie', async () => {
  const h = harness('opencode', { getProfiles: async () => ({ profiles: {}, hasEnvVar: true, environmentAccountKey: 'env-key' }) });
  await h.render();
  assert.equal(headerStatus.opencode(h), '0/1');
  assert.equal(h.document.root.querySelector('.slot-row').dataset.slotId, 'environment');
});

test('OpenCode keeps a profile load error through quota pushes until profiles reload', async () => {
  let loadFailed = false;
  const records = [{ provider: 'opencode', sourceDeviceId: 'peer', accountKey: 'remote', status: 'unavailable' }];
  const h = harness('opencode', { getProfiles: async () => {
    if (loadFailed) throw new Error('profile read failed');
    return { profiles: {} };
  } }, { records, localDeviceId: 'local' });
  await h.render();
  assert.equal(headerStatus.opencode(h), '0/1');

  loadFailed = true;
  await h.render();
  assert.equal(headerStatus.opencode(h), 'settings.opencode.connectFailed');
  records[0] = { ...records[0], status: 'ok' };
  h.owner.refreshReadings();
  assert.equal(headerStatus.opencode(h), 'settings.opencode.connectFailed');
  assert.match(h.document.root.querySelector('.slot-status').className, /slot-connected/);

  loadFailed = false;
  await h.render();
  assert.equal(headerStatus.opencode(h), '1/1');
});

// Claude's rows are derived from the readings themselves, so it is rebuilt with
// its header by renderExternalProviderStatus('claude') rather than this hook.
const refreshedWithStatus = new Set(['claude']);
test('every account owner takes quota pushes through refreshReadings', () => {
  const owners = fs.readdirSync(path.join(renderer, 'limits/providerOwners')).map(file => path.basename(file, '.js'));
  assert.ok(owners.length >= 9);
  for (const provider of owners) {
    const owner = harness(provider).owner;
    assert.equal(typeof owner.refreshReadings === 'function', !refreshedWithStatus.has(provider), provider);
  }
});

for (const provider of Object.keys(headerStatus).filter(provider => !refreshedWithStatus.has(provider))) {
  test(`${provider}: a quota push updates the rows and header without a settings push`, async () => {
    const records = [{ provider, sourceDeviceId: 'peer', accountKey: `remote-${provider}`, status: 'unavailable' }];
    const h = harness(provider, {}, { records, localDeviceId: 'local' });
    await h.render();
    assert.equal(headerStatus[provider](h), '0/1');
    records[0] = { ...records[0], status: 'ok' };
    h.owner.refreshReadings();
    assert.equal(headerStatus[provider](h), '1/1');
    assert.match(h.document.root.querySelector('.slot-status').className, /slot-connected/);
  });
}

test('WorkBuddy quota pushes prefer a canonical reading over a stale fallback', async () => {
  const fallback = { provider: 'workbuddy', accountKey: 'fallback', status: 'unavailable' };
  const readings = [fallback];
  const h = harness('workbuddy', {}, {}, readings);
  h.settings.workbuddyManagedAccounts = [{ id: 'saved', accountKey: fallback.accountKey }];
  await h.render();
  assert.equal(headerStatus.workbuddy(h), '0/1');

  readings.push({ provider: 'workbuddy', accountKey: 'canonical', accountKeyAliases: ['fallback'], status: 'ok' });
  h.owner.refreshReadings();
  assert.equal(headerStatus.workbuddy(h), '1/1');
  assert.match(h.document.root.querySelector('.slot-status').className, /slot-connected/);

  readings.splice(0, readings.length, { ...fallback, status: 'ok' },
    { provider: 'workbuddy', accountKey: 'canonical', status: 'unavailable' });
  h.owner.refreshReadings();
  assert.equal(headerStatus.workbuddy(h), '1/1');
});

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
      const revision = h.owner.editor.revision;
      h.nodes.claudeWebCookieInput.value = '草稿';
      await add.click();
      assert.equal(h.document.root.querySelector('.legacy-editor-reveal').inert, true);
      await add.click();
      assert.equal(h.owner.editor.revision, revision);
      assert.equal(h.nodes.claudeWebCookieInput.value, '草稿');
      h.owner.cancelClaudeWebAccountEdit();
      await add.click();
      assert.equal(h.owner.editor.open, true);
    } else if (provider === 'workbuddy') {
      assert.equal(h.nodes.workbuddyAddCnAccountButton.classList.contains('hidden'), false);
      assert.equal(h.nodes.workbuddyAddAiAccountButton.classList.contains('hidden'), false);
    } else {
      const id = { cursor: 'cursorManualDetails', mimo: 'mimoAddDetails', minimax: 'minimaxAddDetails', opencode: 'opencodeAddDetails', thirdparty: 'thirdpartyAddDetails' }[provider];
      assert.equal(h.nodes[id].classList.contains('hidden'), false);
      const reveal = h.document.root.querySelector('.legacy-editor-reveal');
      const input = Object.values(h.nodes).find(node => /Input$/.test(node.id));
      if (input) { input.value = '草稿 draft'; input.selectionStart = 2; }
      await add.click();
      assert.equal(reveal.inert, true);
      await h.render();
      assert.equal(reveal.inert, true);
      await add.click();
      assert.equal(reveal.inert, false);
      assert.equal(h.nodes[id].classList.contains('hidden'), false);
      if (input) { assert.equal(input.value, '草稿 draft'); assert.equal(input.selectionStart, 2); }
    }
  });
}
test('Codex common add remains a toggle during login, then cancellation permits retry before the old result settles', async () => {
  const pending = [];
  const h = harness('codex', { addAccount: () => new Promise(resolve => pending.push(resolve)) });
  h.owner.setup(); await flush();
  const first = h.add().click();
  assert.equal(pending.length, 1);
  assert.equal(h.add().disabled, false);
  assert.equal(h.nodes.codexCancelLoginButton.classList.contains('hidden'), false);
  await h.add().click();
  assert.equal(pending.length, 1, 'folding a busy login cannot launch another request');
  assert.equal(h.document.root.querySelector('.legacy-editor-reveal').inert, true);
  await h.add().click();
  assert.equal(h.document.root.querySelector('.legacy-editor-reveal').inert, false);
  assert.equal(pending.length, 1);
  await h.nodes.codexCancelLoginButton.click();
  assert.equal(h.add().disabled, false);
  const second = h.add().click();
  assert.equal(pending.length, 2);
  pending[0]({ ok: false, outcome: 'cancelled' }); await first;
  assert.equal(h.owner.state.codexSignInBusy, true, 'late result cannot settle the new login');
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
  assert.equal(h.add().disabled, false);
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
  const h = harness('thirdparty', { getProfiles: async () => ({ profiles: { selected: { adapter: 'sub2api', baseUrl: 'http://selected.example', canonicalAccountKey: 'selected-key' } } }) });
  await h.render();
  for (const field of ['AccessToken', 'RefreshToken', 'ApiKey', 'UserId']) h.nodes[`thirdparty${field}Input`].value = 'other-profile-draft';
  await [...h.document.root.walk()].find(node => node.dataset.slotAction === 'replaceKey').click();
  for (const field of ['AccessToken', 'RefreshToken', 'ApiKey', 'UserId']) assert.equal(h.nodes[`thirdparty${field}Input`].value, '', field);
  assert.equal(h.nodes.thirdpartyBaseUrlInput.value, 'http://selected.example');
  assert.equal(h.nodes.thirdpartyHttpWarning.classList.contains('hidden'), false);
});
test('a pending third-party save preserves changes in the relocated editor', async () => {
  let finishSave;
  const h = harness('thirdparty', { saveProfile: () => new Promise(resolve => { finishSave = resolve; }) });
  const { thirdpartyAddForm: original, thirdpartyAddDetails: editor, thirdpartyProfileSubmit: submit,
    thirdpartyProfileName: name, thirdpartyAccessTokenInput: token, thirdpartyPlatformInput: platform } = h.nodes;
  const inputs = [name, token, platform];
  inputs[0].tagName = 'input';
  inputs[1].tagName = 'input';
  inputs[2].tagName = 'select';
  editor.append(...inputs, submit);
  original.append(editor);
  editor.querySelectorAll = selector => [...editor.walk()].filter(node => node.matches(selector));
  const query = h.document.querySelectorAll;
  h.document.querySelectorAll = selector => selector.startsWith('#thirdpartyAddForm ')
    ? inputs.filter(input => original.contains(input)) : query(selector);
  h.owner.setup();
  await h.render();
  await h.add().click();
  assert.ok(h.nodes.thirdpartyProfileList.contains(editor));
  assert.ok(!original.contains(editor));
  name.value = 'Original';
  token.value = 'submitted-fixture-token';
  const pending = submit.click();
  token.value = 'newer-fixture-token';
  platform.value = 'sub2api';
  finishSave({ ok: true });
  await pending;
  assert.equal(token.value, 'newer-fixture-token');
  assert.equal(platform.value, 'sub2api');
  assert.equal(name.value, 'Original');

  const unchanged = submit.click();
  finishSave({ ok: true });
  await unchanged;
  assert.equal(token.value, '');
  assert.equal(name.value, '');
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
  assert.equal(h.add().disabled, false);
  await h.add().click();
  assert.equal(h.owner.state.antigravitySignInBusy, true);
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
for (const name of ['ambient', 'ambient:', 'remote:work']) {
  test(`OpenCode saved profile named ${name} keeps the saved account actions`, async () => {
    const toggles = [];
    const h = harness('opencode', {
      getProfiles: async () => ({ profiles: { [name]: { accountKey: 'saved', enabled: true } },
        hasAmbientKey: true, ambientAccountKey: 'detected' }),
      setProfileEnabled: async (id, enabled) => { toggles.push(['saved', id, enabled]); return { ok: true }; },
      setAmbientEnabled: async enabled => { toggles.push(['ambient', enabled]); return { ok: true }; }
    });
    await h.render();
    const rows = [...h.document.root.walk()].filter(node => node.classList.contains('slot-row'));
    assert.equal(rows.length, 2);
    const saved = rows.find(row => row.dataset.slotId === `profile:${name}`);
    assert.ok(saved);
    const actions = [...saved.walk()].filter(node => node.dataset.slotAction);
    for (const action of [/^pause$/, /^replace/, /^remove$/]) {
      assert.ok(actions.some(node => action.test(node.dataset.slotAction) && !node.classList.contains('hidden')), String(action));
    }
    await actions.find(node => node.dataset.slotAction === 'pause').click();
    assert.deepEqual(toggles, [['saved', name, false]]);
  });
}

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
  assert.equal(h.add().disabled, false);
  assert.equal(h.owner.state.codexSignInBusy, true);
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

for (const removeLast of [false, true]) test(`MiniMax billing is in the Add account form, removeLast=${removeLast}`, async () => {
  let keys = removeLast ? [{ id: 'last', accountKey: 'wallet', billingMode: 'api', apiRegion: 'cn' }] : [];
  const h = harness('minimax', { getKeys: async () => keys, removeKey: async () => { keys = []; return { ok: true }; } });
  const opened = [];
  h.bridge.openExternal = url => opened.push(url);
  h.owner.setup();
  await h.render();
  if (removeLast) {
    const remove = [...h.document.root.walk()].find(node => node.dataset.slotAction === 'remove');
    await remove.click(); await remove.click();
    assert.equal(keys.length, 0);
    assert.equal(h.document.root.querySelector('.slot-row'), undefined);
  }
  const browser = h.nodes.minimaxOpenBrowser;
  const editor = h.document.root.querySelector('.legacy-editor-reveal');
  assert.ok(browser.closest('.legacy-editor-reveal') === editor);
  assert.equal(editor.inert, true);
  assert.ok(browser.closest('.hidden'));
  await h.add().click();
  assert.equal(Boolean(browser.closest('.hidden')), false);
  for (let node = browser; node; node = node.parentElement) assert.notEqual(node.inert, true, 'billing must not be inert');
  for (const [billingMode, apiRegion, expected] of [
    ['token-plan', 'cn', 'https://platform.minimaxi.com/user-center/payment/token-plan'],
    ['api', 'intl', 'https://platform.minimax.io/user-center/payment/balance'],
    ['api', 'auto', 'https://platform.minimax.io/user-center/payment/balance']
  ]) {
    h.nodes.minimaxBillingModeInput.value = billingMode;
    h.nodes.minimaxApiRegionInput.value = apiRegion;
    browser.click();
    assert.equal(opened.at(-1), expected);
  }
  await h.add().click();
  assert.equal(editor.inert, true);
});

for (const masked of [false, true]) test(`Codex titles retain emails and custom names separately from plans (masked=${masked})`, async () => {
  const h = harness('codex');
  h.settings.maskLimitAccountEmails = masked;
  h.settings.codexManagedAccounts = [
    { id: 'a', accountKey: 'ka', email: 'alice@example.com', accountLabel: 'plus', enabled: true },
    { id: 'b', accountKey: 'kb', email: 'bob@example.com', accountLabel: 'free', enabled: false }
  ];
  const rows = () => [...h.document.root.walk()].filter(node => node.classList.contains('slot-row'));
  await h.render();
  assert.deepEqual(rows().map(row => row.querySelector('.slot-name').textContent),
    masked ? ['a***e@example.com', 'b***b@example.com'] : ['alice@example.com', 'bob@example.com']);
  assert.deepEqual(rows().map(row => row.querySelector('.slot-detail').textContent),
    ['Plus · settings.limits.sources.oauth', 'Free · settings.limits.sources.oauth']);
  h.settings.limitAccountPresentation = { codex: { labels: { ka: 'Work', kb: '' } } };
  await h.render();
  assert.equal(rows()[0].querySelector('.slot-name').textContent, 'Work');
  assert.match(rows()[0].querySelector('.slot-detail').textContent, /^Plus/);
  assert.equal(rows()[1].querySelector('.slot-name').textContent, masked ? 'b***b@example.com' : 'bob@example.com');
});
