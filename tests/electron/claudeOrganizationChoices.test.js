'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

for (const fromCancel of [true, false]) {
  test(`closing the Claude Web form ${fromCancel ? 'restores Cancel keyboard focus to Add account' : 'preserves unrelated focus'}`, () => {
    const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
    const start = app.indexOf('function cancelClaudeWebAccountEdit(');
    const end = app.indexOf('async function runClaudeAccountAction(', start);
    const cancel = { id: 'claudeCancelWebAccountButton' };
    const unrelated = { id: 'elsewhere' };
    const draft = { value: 'discard-this' };
    const document = { activeElement: fromCancel ? cancel : unrelated,
      getElementById: (id) => id === 'claudeWebCookieInput' ? draft : id === 'claudeAddWebAccountButton' ? add : null };
    const add = { focus() { document.activeElement = add; } };
    let choices;
    const context = { document, claudeOrganizationChoicesRevision: 1, claudeWebAccountId: 'work', claudeWebFormOpen: true,
      renderClaudeOrganizationChoices: (value) => { choices = value; }, setAccountPanelMessage() {},
      renderExternalProviderStatus() { if (document.activeElement === cancel) document.activeElement = { id: 'body' }; } };
    vm.runInNewContext(app.slice(start, end), context);
    context.cancelClaudeWebAccountEdit();
    assert.equal(document.activeElement, fromCancel ? add : unrelated);
    assert.equal(draft.value, '');
    assert.equal(choices.length, 0);
    assert.equal(context.claudeWebAccountId, 'new');
    assert.equal(context.claudeWebFormOpen, false);
  });
}

test('Claude card counts healthy identities instead of letting one linked account hide failures', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function claudeWebSettingsAccounts(');
  const end = app.indexOf('function renderClaudeWebAccounts(', start);
  const state = { settings: { claudeManagedAccounts: [
    { id: 'a', accountKey: 'a', enabled: true },
    { id: 'b', accountKey: 'b', enabled: true },
    { id: 'c', accountKey: 'c', enabled: false },
    { id: 'unchecked', enabled: true }
  ] } };
  let providers = [
    { accountKey: 'a', source: 'web', status: 'ok' },
    { accountKey: 'b', source: 'web', status: 'unauthorized' },
    { accountKey: 'c', source: 'web', status: 'ok' },
    { accountKey: 'a', source: 'oauth', status: 'ok' }
  ];
  const context = { state, localProviderStatuses: () => providers,
    t: (_key, { linked, total }) => `${linked}/${total}` };
  vm.runInNewContext(app.slice(start, end), context);
  assert.equal(context.claudeAccountStatusText('fallback', true), '1/4');
  assert.equal(context.claudeAccountStatusText('fallback', false), '0/4');
  providers.push({ accountKey: 'local', source: 'oauth', status: 'ok' });
  assert.equal(context.claudeAccountStatusText('fallback', true), '2/5');
  state.settings = { claudeManagedAccounts: [], claudeWebLegacyCookieConfigured: true };
  providers = [{ accountKey: 'legacy', source: 'web', status: 'ok' }];
  assert.equal(context.claudeAccountStatusText('fallback', true), '1/1');
  state.settings = { claudeManagedAccounts: [{ id: 'managed', accountKey: 'same', enabled: true }],
    claudeWebLegacyCookieConfigured: true, claudeWebLegacyAccount: { accountKey: 'same' } };
  providers = [{ accountKey: 'same', source: 'web', status: 'ok' }];
  assert.equal(context.claudeAccountStatusText('fallback', true), '1/1');
  assert.equal(context.claudeWebSettingsAccounts(providers).length, 2, 'both credential management entries remain reachable');
  state.settings = {};
  providers = [];
  assert.equal(context.claudeAccountStatusText('fallback', true), 'fallback');
});

test('a busy Claude save never reports a credential rejection or clears the draft', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function saveAccountCredential(');
  const end = app.indexOf('// The busy guard generated panels', start);
  const guard = require('../../src/electron/renderer/limits/accountShell').createBusyGuard();
  let release;
  const busy = guard.run('claude', null, () => new Promise((resolve) => { release = resolve; }));
  const messages = [];
  let saved = false;
  let cleared = false;
  const context = { claudeOrganizationChoicesRevision: 0, claudeAccountActions: guard,
    LIMIT_PROVIDERS: [], setAccountPanelMessage: (_id, message) => messages.push(message),
    renderExternalProviderStatus() {}, commitAccountCredential: (operation) => operation(),
    window: { tokenMonitor: { claude: { saveWebAccount: () => { saved = true; } } } } };
  vm.runInNewContext(app.slice(start, end), context);
  await context.saveAccountCredential('claude', { claudeWebAccountId: 'new', claudeWebCookie: 'draft' }, { clearInput: () => { cleared = true; } });
  release();
  await busy;
  assert.equal(saved, false);
  assert.equal(cleared, false);
  assert.equal(messages.some((message) => message?.key?.includes('Rejected')), false);
});

test('an old Claude organization discovery cannot replace a newly saved cookie’s choices', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('let claudeOrganizationChoicesRevision = 0;');
  const end = app.indexOf('\nfunction setupLimitAccountPanels()', start);
  assert.ok(start >= 0 && end > start);
  let resolveOld;
  const oldDiscovery = new Promise((resolve) => { resolveOld = resolve; });
  const select = {
    options: [],
    value: '',
    append(option) { this.options.push(option); }
  };
  const row = { classList: { toggle() {} } };
  const messages = [];
  const state = {
    settingsPushRevision: 0,
    settings: { claudeWebCookieConfigured: true, claudeWebOrganizationId: 'old' }
  };
  const context = {
    state,
    accountShellApi: require('../../src/electron/renderer/limits/accountShell'),
    LIMIT_PROVIDERS: [{ id: 'claude', label: 'Claude' }],
    document: {
      getElementById: (id) => ({
        claudeWebOrganizationIdInput: select,
        claudeWebOrganizationRow: row
      })[id] || null,
      createElement: () => ({ value: '', textContent: '' })
    },
    window: { tokenMonitor: { limits: {
      listOrganizationChoices: () => oldDiscovery,
      clearCredential: async () => ({ settings: { claudeWebCookieConfigured: false, claudeWebOrganizationId: '' } }),
      saveCredential: async () => ({
        saved: true,
        verdict: 'valid',
        choices: [{ id: 'new', name: 'New workspace' }],
        settings: { claudeWebCookieConfigured: true, claudeWebOrganizationId: 'new' }
      })
    } } },
    t: (key) => key,
    setAccountPanelMessage: (_id, message) => messages.push(message),
    renderExternalProviderStatus() {},
    clearExternalProviderCheckPending() {},
    clearExternalProviderPendingStatus() {},
    markExternalProviderCheckPending() {},
    refreshStats: async () => {},
    setExternalAccountExpanded() {},
    externalProviderAccountLinked: () => true,
    applyPersistedSettings: (settings) => { state.settings = settings; }
  };
  vm.runInNewContext(app.slice(start, end), context);

  const loadingOld = context.loadClaudeOrganizationChoices();
  await context.clearAccountCredential('claude');
  await context.saveAccountCredential('claude', { claudeWebCookie: 'sessionKey=sk-ant-new', claudeWebOrganizationId: 'new' });
  resolveOld({ status: 'ok', choices: [{ id: 'old', name: 'Old workspace' }] });
  await loadingOld;

  assert.deepEqual(select.options.map((option) => option.value), ['', 'new']);
  assert.equal(select.value, 'new');
  assert.equal(messages.some((message) => message?.key === 'settings.claude.organizationUnavailable'), false);
});
