'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const claudeOwner = require('../../src/electron/renderer/limits/providerOwners/claude');
const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const legacyList = require('../../src/electron/renderer/limits/legacyAccountList');
const { liveSourceIds } = require('../../src/electron/renderer/limits/accountSlotsPanel');
const { createConnectionCard } = require('../../src/electron/renderer/limits/connectionPresentation');
const { connectionSources } = require('../../src/electron/renderer/limits/providerPresentation');

test('Claude Web login health does not light the quota source without a fresh Web reading', () => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const list = document.createElement('div');
  list.id = 'claudeWebAccountList';
  document.root.append(list);
  const settings = {
    claudeManagedAccounts: [{ id: 'saved', accountKey: 'shared', enabled: true }],
    claudeWebLoginStatuses: { saved: 'ok' }
  };
  let readings = [];
  const owner = claudeOwner.create({ document, getSettings: () => settings,
    accountShellApi, getAccountContext: () => ({ settings }), preserveScroll: fn => fn(),
    window: { TokenMonitorLegacyAccountList: legacyList, tokenMonitor: {} },
    localProviderStatuses: () => readings, t: key => key });
  const web = { provider: 'claude', accountKey: 'shared', source: 'web', status: 'ok' };
  const oauth = { ...web, source: 'oauth' };
  try {
    for (const [quota, expected] of [
      [[oauth], ['oauth']],
      [[], []],
      [[{ ...web, stale: true }], []],
      [[web], ['web']]
    ]) {
      readings = quota;
      owner.renderClaudeWebAccounts();
      const row = [...list.walk()].find(node => node.dataset.slotId === 'saved');
      const icon = row.querySelector('.slot-source-icon');
      assert.equal(row.querySelector('.slot-status').classList.contains('slot-connected'), true);
      assert.equal(icon.dataset.kind, 'web');
      const card = createConnectionCard({ document, t: key => key, sources: connectionSources('claude'),
        readings, liveSourceIds: liveSourceIds('claude') });
      const highlighted = [...card.walk()].filter(node => node.classList.contains('is-live'));
      assert.deepEqual(highlighted.map(node => node.dataset.kind), expected);
      assert.equal(icon.classList.contains('is-live'), expected.includes('web'));
    }
  } finally {
    list.remove();
  }
});


test('Claude Web rows retain controls and removal confirmation across quota and login-status updates', async (suite) => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const list = document.createElement('div');
  list.id = 'claudeWebAccountList';
  document.root = list;
  const state = { settings: { claudeManagedAccounts: [{ id: 'a', accountKey: 'same', enabled: true }],
    claudeWebLoginStatuses: { a: 'ok' } } };
  const providers = [{ accountKey: 'same', source: 'oauth', status: 'ok', updatedAt: 'old', windows: [] }];
  const context = claudeOwner.create({ document, initial: {}, getSettings: () => state.settings,
    accountShellApi, getAccountContext: () => ({ settings: state.settings }), preserveScroll: fn => fn(),
    window: { TokenMonitorLegacyAccountList: legacyList, tokenMonitor: {} },
    localProviderStatuses: () => providers, t: key => key });
  context.renderClaudeWebAccounts();
  const row = [...list.walk()].find(n => n.dataset.slotId === 'a');
  const info = row.querySelector('.slot-status');
  const remove = [...row.walk()].find(n => n.dataset.slotAction === 'remove');
  assert.equal(info.textContent, 'settings.limits.sources.web');
  assert.equal(info.classList.contains('slot-connected'), true);
  remove.click();
  document.activeElement = remove;
  providers[0].updatedAt = 'new';
  providers[0].windows = [{ usedPercent: 42 }];
  context.renderClaudeWebAccounts();
  assert.equal([...list.walk()].find(n => n.dataset.slotId === 'a'), row);
  assert.equal(document.activeElement, remove);
  assert.equal(remove.textContent, 'settings.slots.confirmRemove');
  state.settings.claudeWebLoginStatuses.a = 'unauthorized';
  context.renderClaudeWebAccounts();
  await suite.test('Web login rejection remains visible beside healthy OAuth quota', () => {
    assert.equal(info.textContent, 'settings.slots.invalidCookie');
  });
  assert.equal(document.activeElement, remove);
  assert.equal(remove.textContent, 'settings.slots.confirmRemove');
  delete state.settings.claudeWebLoginStatuses.a;
  context.renderClaudeWebAccounts();
  assert.equal(info.textContent, 'settings.slots.unavailable', 'unchecked Web login cannot borrow OAuth health');
  state.settings.claudeWebLoginStatuses.a = 'ok';
  state.settings.claudeManagedAccounts[0].enabled = false;
  context.renderClaudeWebAccounts();
  assert.equal(info.textContent, 'settings.slots.paused', 'pause wins over retained login health');
  assert.equal(document.activeElement, remove);
  assert.equal(remove.textContent, 'settings.slots.confirmRemove');
  state.settings = { ...state.settings, claudeManagedAccounts: [], claudeWebLegacyCookieConfigured: true,
    claudeWebLegacyAccount: { accountKey: 'same' }, claudeWebLegacyCookieSource: 'settings' };
  context.renderClaudeWebAccounts();
  const legacyRemove = () => [...list.walk()].find(n => n.dataset.slotId === 'legacy').querySelector('.plugin-menu').querySelectorAll('button').find(n => n.dataset.slotAction === 'remove');
  assert.equal(legacyRemove().classList.contains('hidden'), false);
  state.settings.claudeWebLegacyCookieSource = 'env';
  context.renderClaudeWebAccounts();
  assert.equal(legacyRemove().classList.contains('hidden'), true, 'falling back to the same env cookie hides Remove');
  state.settings.claudeWebLegacyCookieSource = 'settings';
  context.renderClaudeWebAccounts();
  assert.equal(legacyRemove().classList.contains('hidden'), false);
});

for (const fromCancel of [true, false]) {
  test(`closing the Claude Web form ${fromCancel ? 'restores Cancel keyboard focus to Add account' : 'preserves unrelated focus'}`, () => {
    const cancel = { id: 'claudeCancelWebAccountButton' };
    const unrelated = { id: 'elsewhere' };
    const draft = { value: 'discard-this' };
    const document = { activeElement: fromCancel ? cancel : unrelated,
      getElementById: (id) => id === 'claudeWebCookieInput' ? draft : id === 'claudeWebAccountList' ? { querySelector: () => add } : null };
    const add = { focus() { document.activeElement = add; } };
    const select = { options: [], append(option) { this.options.push(option); } };
    const get = document.getElementById;
    document.getElementById = id => id === 'claudeWebOrganizationIdInput' ? select : get(id);
    document.createElement = () => ({});
    const context = claudeOwner.create({ document, initial: {}, getSettings: () => ({}), accountShellApi, t: key => key,
      setAccountPanelMessage() {}, renderExternalProviderStatus() { if (document.activeElement === cancel) document.activeElement = { id: 'body' }; } });
    Object.assign(context.editor, { revision: 1, accountId: 'work', open: true });
    context.cancelClaudeWebAccountEdit();
    assert.equal(document.activeElement, fromCancel ? add : unrelated);
    assert.equal(draft.value, '');
    assert.equal(select.options.length, 1);
    assert.equal(select.options[0].value, '');
    assert.equal(context.editor.accountId, 'new');
    assert.equal(context.editor.open, false);
  });
}

test('Claude card counts its rows so one linked account cannot hide failures', () => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const container = document.createElement('div'); container.id = 'claudeWebAccountList'; document.root.append(container);
  const state = { settings: { claudeManagedAccounts: [
    { id: 'a', accountKey: 'a', enabled: true },
    { id: 'b', accountKey: 'b', enabled: true },
    { id: 'c', accountKey: 'c', enabled: false },
    { id: 'unchecked', enabled: true }
  ] } };
  let providerEnabled = true;
  let providers = [
    { provider: 'claude', accountKey: 'a', source: 'web', status: 'ok' },
    { provider: 'claude', accountKey: 'b', source: 'web', status: 'unauthorized' },
    { provider: 'claude', accountKey: 'c', source: 'web', status: 'ok' },
    { provider: 'claude', accountKey: 'a', source: 'oauth', status: 'ok' }
  ];
  const context = claudeOwner.create({ document, initial: {}, getSettings: () => state.settings, accountShellApi, localProviderStatuses: () => providers,
    getAccountContext: () => ({ settings: state.settings, providerEnabled }), preserveScroll: fn => fn(), window: { TokenMonitorLegacyAccountList: legacyList, tokenMonitor: {} },
    t: (key, params) => key === 'settings.slots.connectedCount' ? `${params.linked}/${params.total}` : key });
  const status = () => { context.renderClaudeWebAccounts(); return context.claudeAccountStatusText('fallback'); };
  // The rejected login, the paused one and the unchecked one all stay in the total.
  assert.equal(status(), '1/4');
  providerEnabled = false;
  assert.equal(status(), '0/4');
  providerEnabled = true;
  providers.push({ provider: 'claude', accountKey: 'local', source: 'oauth', status: 'ok' });
  assert.equal(status(), '2/5');
  state.settings = { claudeManagedAccounts: [], claudeWebLegacyCookieConfigured: true };
  providers = [{ provider: 'claude', accountKey: 'legacy', source: 'web', status: 'ok' }];
  assert.equal(status(), '1/1');
  state.settings = { claudeManagedAccounts: [{ id: 'managed', accountKey: 'same', enabled: true }],
    claudeWebLegacyCookieConfigured: true, claudeWebLegacyAccount: { accountKey: 'same' } };
  providers = [{ provider: 'claude', accountKey: 'same', source: 'web', status: 'ok' }];
  assert.equal(context.claudeWebSettingsAccounts(providers).length, 2, 'both credential management entries remain reachable');
  assert.equal(status(), '2/2', 'and both are counted, as both are listed');
  state.settings = {};
  providers = [];
  assert.equal(status(), 'fallback');
});

test('a busy Claude save never reports a credential rejection or clears the draft', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('async function saveAccountCredential(');
  const end = app.indexOf('// A quota row', start);
  const guard = require('../../src/electron/renderer/limits/accountShell').createBusyGuard();
  let release;
  const busy = guard.run('claude', null, () => new Promise((resolve) => { release = resolve; }));
  const messages = [];
  let saved = false;
  let cleared = false;
  const context = { legacyAccountOwners: { claude: { editor: { revision: 0 }, claudeAccountActions: guard } },
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
  const start = app.indexOf('async function saveAccountCredential(');
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
  context.legacyAccountOwners = { claude: claudeOwner.create({ ...context, initial: {}, getSettings: () => state.settings }) };
  vm.runInNewContext(app.slice(start, end), context);

  const loadingOld = context.legacyAccountOwners.claude.loadClaudeOrganizationChoices();
  await context.clearAccountCredential('claude');
  await context.saveAccountCredential('claude', { claudeWebCookie: 'sessionKey=sk-ant-new', claudeWebOrganizationId: 'new' });
  resolveOld({ status: 'ok', choices: [{ id: 'old', name: 'Old workspace' }] });
  await loadingOld;

  assert.deepEqual(select.options.map((option) => option.value), ['', 'new']);
  assert.equal(select.value, 'new');
  assert.equal(messages.some((message) => message?.key === 'settings.claude.organizationUnavailable'), false);
});

test('status refresh hides the placeholder-only Claude organization row and shows real choices inside the editor', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf("  if (providerName === 'claude') {\n    const showForm =", app.indexOf('function renderExternalProviderStatus('));
  const end = app.indexOf('\n  const discoveredLogin', start);
  assert.ok(start > 0 && end > start);
  let hidden;
  const select = { options: [{ value: '' }] };
  const context = { providerName: 'claude', legacyAccountOwners: { claude: { editor: { open: true } } }, state: { settings: {} },
    manualPanel: { classList: { toggle() {} } }, openBtn: { classList: { remove() {} } },
    document: { getElementById: id => id === 'claudeWebOrganizationIdInput' ? select : { classList: { toggle(_name, value) { hidden = value; } } } } };
  const refresh = () => vm.runInNewContext(app.slice(start, end), context);
  refresh(); assert.equal(hidden, true);
  select.options.push({ value: 'org-a' });
  refresh(); assert.equal(hidden, false);
  context.legacyAccountOwners.claude.editor.open = false;
  refresh(); assert.equal(hidden, true);
});
