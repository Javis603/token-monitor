'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');
const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const presentation = require('../../src/electron/renderer/limits/providerPresentation');
const subscriptionApi = require('../../src/shared/subscriptionDisplay');
const { createStatsRenderScheduler } = require('../../src/electron/renderer/statsRenderScheduler');
const { MESSAGES } = require('../../src/electron/renderer/i18n');
const renderer = path.join(__dirname, '../../src/electron/renderer');
const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The same small DOM surface is used for settings rendering and real click
// handlers, so these tests exercise state transitions rather than source regexes.
class Element {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.textContent = '';
    this.disabled = false;
    this.classes = new Set();
    this.classList = {
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      contains: (name) => this.classes.has(name)
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  fire(name) { return this.handlers[name]?.(); }
}

const nodeIds = ['AccountList', 'AccountStatus', 'AccountErrorMessage', 'LoginStatus', 'AddCnAccountButton', 'AddAiAccountButton', 'CancelLoginButton', 'SettingsToggle'];
function settingsHarness(api = {}, providers = []) {
  const nodes = Object.fromEntries(nodeIds.map((id) => [`workbuddy${id}`, new Element()]));
  const state = { settings: { workbuddyManagedAccounts: [] }, workbuddyLoginAttempt: 0, workbuddyAccountError: '' };
  const refreshes = [];
  const context = vm.createContext({
    state,
    window: { tokenMonitor: { workbuddy: api } },
    document: { getElementById: (id) => nodes[id], createElement: () => new Element() },
    accountIdentityApi, accountShellApi,
    limitProviderPresentationApi: presentation,
    t: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), MESSAGES.en[key] || key),
    localProviderStatuses: () => providers,
    translatedLimitProviderTag: (tag) => tag?.label || '',
    renderSettingsSummaries() {}, renderSubscriptionSettings() {}, setAccountGroupExpanded() {},
    refreshStats: async (options) => { refreshes.push(options); }
  });
  const start = app.indexOf('function workbuddyAccountError(');
  vm.runInContext(app.slice(start, app.indexOf('function renderAntigravityStatus()', start)), context);
  return { state, nodes, refreshes, context, run: (expression) => vm.runInContext(expression, context) };
}

const account = { id: 'managed-cn', realm: 'cn', accountKey: 'sha256:primary', accountName: 'Personal', accountEmail: 'member@example.com', enabled: true };

test('widget and Dock load the shared WorkBuddy identity rule before presentation', () => {
  for (const file of ['index.html', 'edgeDock/index.html']) {
    const html = fs.readFileSync(path.join(renderer, file), 'utf8');
    const identity = [...html.matchAll(/<script src="([^"]*providers\/workbuddy\/identity\.js)"><\/script>/g)][0];
    assert.ok(identity, file);
    assert.ok(identity.index < html.indexOf('limits/providerPresentation.js'), file);
    const context = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync(path.resolve(path.dirname(path.join(renderer, file)), identity[1]), 'utf8'), context);
    for (const key of [
      'sha256:6ff2121c4f5c0196427ef836a66871994d1208557ff71d282c5ada1964378185',
      'sha256:89611f6e433217c45827d1bc99bcabe93a3dc58ff826efd996601ca74349348b'
    ]) {
      const row = { provider: 'workbuddy', accountKey: key, status: 'notConfigured' };
      assert.equal(context.window.TokenMonitorWorkbuddyIdentity.isWorkbuddyPlaceholder(row), presentation.isWorkbuddyPlaceholder(row));
    }
  }
});

test('visible Settings follows quota pushes and defers hidden updates without polling', () => {
  const h = settingsHarness();
  h.state.settings.workbuddyManagedAccounts = [account];
  h.state.settings.deviceId = 'local';
  h.state.stats = { limits: { providers: [] }, devices: [] };
  for (const name of ['renderConnectionStatus', 'render', 'renderCodexAccounts', 'renderMimoStatus',
    'renderSettingsSummaries', 'renderLimitProviderCheckboxes', 'renderToolPreferences', 'renderWslPanel',
    'updateOpenRouterProfilesStatus', 'updateThirdPartyProfilesStatus', 'renderExternalProviderStatus',
    'renderCopilotStatus', 'signalContentReady']) h.context[name] = () => {};
  let settingsVisible = true, hidden = false;
  h.context.visibleStatsSurface = () => hidden ? null : 'main';
  h.context.isSettingsSurfaceVisible = () => settingsVisible;
  const localStart = app.indexOf('function localDeviceLimitsProviders()');
  vm.runInContext(app.slice(localStart, app.indexOf('function workbuddyAccountError(', localStart)), h.context);
  const statsStart = app.indexOf('function renderStatsUpdate()');
  vm.runInContext(app.slice(statsStart, app.indexOf('const statsRenderScheduler =', statsStart)), h.context);
  const scheduler = createStatsRenderScheduler({ isHidden: () => hidden, render: () => h.run('renderStatsUpdate()') });
  const label = () => h.nodes.workbuddyAccountList.children[0].children[2].children[0].textContent;
  const push = (status) => {
    h.state.stats = { devices: [{ deviceId: 'local', limits: { providers: [{
      provider: 'workbuddy', accountKey: account.accountKey, status, windows: []
    }] } }] };
    scheduler.request();
  };
  h.run('renderWorkbuddyStatus()');
  assert.equal(label(), MESSAGES.en['settings.workbuddy.notChecked']);
  push('ok');
  assert.equal(label(), 'Live');
  push('unauthorized');
  assert.equal(label(), 'Sign in again');
  settingsVisible = false;
  push('ok');
  assert.equal(label(), 'Sign in again', 'closed Settings does not redraw account controls');
  settingsVisible = true;
  hidden = true;
  push('ok');
  assert.equal(label(), 'Sign in again', 'hidden pushes are coalesced');
  hidden = false;
  scheduler.flush();
  assert.equal(label(), 'Live');
  assert.deepEqual(h.refreshes, [], 'status rendering requests no extra stats or account polling');
});

test('WorkBuddy preload exposes dedicated IPC and rejects membership through generic settings', async () => {
  let bridge;
  const calls = [], listeners = new Map();
  const ipcRenderer = {
    invoke: async (...args) => { calls.push(args); return []; },
    on: (channel, callback) => listeners.set(channel, callback),
    removeListener: (channel, callback) => { assert.equal(listeners.get(channel), callback); listeners.delete(channel); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(renderer, '../preload.js'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } };
    }
  });
  await bridge.workbuddy.accounts();
  await bridge.workbuddy.addAccount('cn');
  await bridge.workbuddy.addAccount('ai');
  await bridge.workbuddy.cancelLogin();
  await bridge.workbuddy.removeAccount('managed-cn');
  await bridge.workbuddy.setAccountEnabled('managed-cn', false);
  assert.deepEqual(calls, [
    ['workbuddy:accounts'], ['workbuddy:addAccount', 'cn'], ['workbuddy:addAccount', 'ai'],
    ['workbuddy:cancelLogin'], ['workbuddy:removeAccount', 'managed-cn'], ['workbuddy:setAccountEnabled', 'managed-cn', false]
  ]);
  let pushed;
  const unsubscribe = bridge.workbuddy.onAccounts((accounts) => { pushed = accounts; });
  listeners.get('workbuddy:accounts')({}, [account]);
  assert.deepEqual(pushed, [account]);
  unsubscribe();
  assert.equal(listeners.size, 0);
  const patch = { workbuddyManagedAccounts: [account], limitsEnabled: true };
  await bridge.updateSettings(patch);
  assert.deepEqual(plain(calls.at(-1)), ['settings:update', { limitsEnabled: true }]);
  assert.equal(patch.workbuddyManagedAccounts.length, 1);
});

test('login cancellation stays pending until acknowledged and fences a late login result', async () => {
  const first = deferred(), second = deferred(), cancel = deferred();
  const realms = [];
  const h = settingsHarness({
    addAccount: (realm) => { realms.push(realm); return realms.length === 1 ? first.promise : second.promise; },
    cancelLogin: () => cancel.promise
  });
  const login = h.run("startWorkbuddyLogin('cn')");
  assert.equal(h.nodes.workbuddyAddAiAccountButton.disabled, true);
  assert.equal(h.nodes.workbuddyLoginStatus.textContent, MESSAGES.en['settings.workbuddy.loginStatus']);
  const cancellation = h.run('cancelWorkbuddyLogin()');
  assert.equal(h.nodes.workbuddyCancelLoginButton.disabled, true);
  assert.equal(h.nodes.workbuddyLoginStatus.textContent, MESSAGES.en['settings.workbuddy.cancelling']);
  await h.run("startWorkbuddyLogin('ai')");
  assert.deepEqual(realms, ['cn']);
  cancel.resolve(true);
  await cancellation;
  assert.equal(h.nodes.workbuddyAddAiAccountButton.disabled, false);
  const nextLogin = h.run("startWorkbuddyLogin('ai')");
  first.resolve({ ok: true, accounts: [{ ...account, id: 'late' }] });
  await login;
  assert.equal(h.state.workbuddySignInBusy, true);
  assert.deepEqual(h.state.settings.workbuddyManagedAccounts, []);
  second.resolve({ ok: true, accounts: [account] });
  await nextLogin;
  assert.equal(h.state.workbuddySignInBusy, false);
  assert.deepEqual(h.state.settings.workbuddyManagedAccounts, [account]);
});

test('a login resolving during cancellation is discarded only after successful cancellation', async () => {
  for (const ok of [true, false]) {
    const pending = deferred(), cancellation = deferred();
    const h = settingsHarness({ addAccount: () => pending.promise, cancelLogin: () => cancellation.promise });
    const login = h.run("startWorkbuddyLogin('ai')");
    const cancel = h.run('cancelWorkbuddyLogin()');
    pending.resolve({ ok: true, accounts: [account] });
    await login;
    assert.deepEqual(h.state.settings.workbuddyManagedAccounts, []);
    cancellation.resolve(ok);
    await cancel;
    assert.deepEqual(h.state.settings.workbuddyManagedAccounts, ok ? [] : [account]);
    assert.equal(h.nodes.workbuddyAddCnAccountButton.disabled, false);
  }
});

test('failed cancellation keeps the login cancellable and login errors never echo service details', async () => {
  const pending = deferred();
  const h = settingsHarness({ addAccount: () => pending.promise, cancelLogin: async () => { throw new Error('secret callback'); } });
  const login = h.run("startWorkbuddyLogin('cn')");
  await h.run('cancelWorkbuddyLogin()');
  assert.equal(h.state.workbuddySignInBusy, true);
  assert.equal(h.nodes.workbuddyCancelLoginButton.disabled, false);
  assert.equal(h.nodes.workbuddyAccountErrorMessage.textContent, MESSAGES.en['settings.workbuddy.cancelFailed']);
  pending.resolve({ ok: false, errorCode: 'UNKNOWN', error: 'private token in URL' });
  await login;
  assert.equal(h.nodes.workbuddyAccountErrorMessage.textContent, MESSAGES.en['settings.workbuddy.loginFailed']);
  assert.equal(h.nodes.workbuddyAddCnAccountButton.disabled, false);
  assert.equal(h.state.workbuddyLoginStatusKey, '');
  for (const code of ['PERSISTENCE_FAILED', 'credentialStorageUnavailable']) {
    assert.equal(h.run(`workbuddyAccountError('${code}')`), MESSAGES.en['settings.workbuddy.credentialStorageUnavailable']);
  }
  assert.equal(h.run("workbuddyAccountError('toString')"), MESSAGES.en['settings.workbuddy.loginFailed']);
  assert.equal(h.run("workbuddyAccountError('TIMEOUT')"), MESSAGES.en['settings.workbuddy.loginTimeout']);
});

test('account pushes beat stale initial reads and both regional buttons call their own realm', async () => {
  const initial = deferred();
  let push;
  const realms = [];
  const h = settingsHarness({
    onAccounts: (callback) => { push = callback; }, accounts: () => initial.promise,
    addAccount: async (realm) => { realms.push(realm); return { ok: false, errorCode: 'CANCELED' }; }
  });
  h.run('initWorkbuddyAccountSettings()');
  push([account]);
  initial.resolve([]);
  await initial.promise;
  await Promise.resolve();
  assert.deepEqual(h.state.settings.workbuddyManagedAccounts, [account]);
  await h.nodes.workbuddyAddCnAccountButton.fire('click');
  await h.nodes.workbuddyAddAiAccountButton.fire('click');
  assert.deepEqual(realms, ['cn', 'ai']);
});

test('enabled and remove controls use ids, require remove confirmation, and recover from failures', async () => {
  const calls = [];
  const h = settingsHarness({
    setAccountEnabled: async (...args) => { calls.push(['enabled', ...args]); return { ok: true, accounts: [{ ...account, enabled: false }] }; },
    removeAccount: async (id) => { calls.push(['remove', id]); throw new Error('private token'); }
  });
  h.context.__accounts = [account];
  h.run('applyWorkbuddyAccounts(__accounts)');
  const row = h.nodes.workbuddyAccountList.children[0];
  row.children[0].checked = false;
  await row.children[0].fire('change');
  assert.deepEqual(calls, [['enabled', account.id, false]]);
  const remove = h.nodes.workbuddyAccountList.children[0].children[2].children[1];
  assert.equal(remove.attributes['aria-label'], MESSAGES.en['settings.workbuddy.remove']);
  await remove.fire('click');
  assert.equal(calls.length, 1);
  assert.equal(remove.attributes['aria-label'], h.context.t('settings.workbuddy.removeConfirm', { account: account.accountEmail }));
  await remove.fire('click');
  assert.deepEqual(calls.at(-1), ['remove', account.id]);
  assert.equal(h.state.workbuddyMutationBusy, false);
  assert.equal(h.nodes.workbuddyAccountErrorMessage.textContent, MESSAGES.en['settings.workbuddy.removeFailed']);
  assert.equal(h.state.settings.workbuddyManagedAccounts.length, 1);
});

const credits = (overrides = {}) => ({ kind: 'billing', label: 'Credits', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100, usedPercent: 20, resetsAt: null, showMeter: true, ...overrides });
const reading = (key, windows = [credits()], overrides = {}) => ({ provider: 'workbuddy', accountKey: key, status: 'ok', windows, ...overrides });

test('only all-success exactly compatible finite credit windows produce a total', () => {
  const members = [reading('a'), reading('b', [credits({ used: 30, remaining: 170, limit: 200 })])];
  const before = JSON.stringify(members);
  assert.deepEqual(presentation.workbuddyCreditTotals(members), [credits({ used: 50, remaining: 250, limit: 300, usedPercent: 50 / 300 * 100, remainingPercent: 250 / 300 * 100 })]);
  assert.equal(JSON.stringify(members), before);
  for (const invalid of [
    reading('a'), reading('', [credits()]), reading('b', [credits()], { realm: 'ai' }), reading('b', [credits()], { region: 'ai' }),
    reading('b', [], { status: 'unavailable' }), reading('b', [], { status: 'notConfigured' }),
    reading('b', [credits()], { stale: true }), reading('b', [credits()], { status: 'error' }),
    reading('b', [credits({ detail: 'unlimited', limit: null, remaining: null, showMeter: false })]),
    reading('b', [credits({ remaining: NaN })]), reading('b', [credits({ used: 101 })]), reading('b', [credits({ limit: Infinity })]),
    reading('b', [credits({ limit: 0 })]), reading('b', [credits({ currency: 'USD' })]),
    reading('b', [credits({ resetsAt: '2026-12-01T00:00:00Z' })]),
    reading('b', [credits({ label: 'Another pool' })]), reading('b', [credits(), credits()])
  ]) assert.equal(presentation.workbuddyCreditTotals([members[0], invalid]), null, JSON.stringify(invalid));
});

test('multiple pools aggregate by exact semantics, never array order or a partial window set', () => {
  const a = credits({ label: 'Daily', kind: 'daily' }), b = credits({ label: 'Monthly' });
  const total = presentation.workbuddyCreditTotals([reading('a', [a, b]), reading('b', [b, a])]);
  assert.deepEqual(total.map((window) => [window.label, window.limit]), [['Daily', 200], ['Monthly', 200]]);
  assert.equal(presentation.workbuddyCreditTotals([reading('a', [a, b]), reading('b', [a])]), null);
  assert.equal(presentation.workbuddyCreditTotals([reading('a', [credits({ used: 1e308, limit: 1e308, remaining: 0 })]), reading('b', [credits({ used: 1e308, limit: 1e308, remaining: 0 })])]), null);
});

function subscriptionHarness(providers, settings = {}) {
  const context = vm.createContext({ accountIdentityApi, subscriptionApi, limitProviderPresentationApi: presentation,
    localDeviceLimitsProviders: () => providers,
    state: { settings, stats: { limits: { providers: [] } } },
    subscriptionText: { providerLabel: (id) => id }
  });
  vm.runInContext(app.slice(app.indexOf('function limitProvidersForSubscriptions()'), app.indexOf('function subscriptionSuggestedPlanName(')), context);
  return { context, choices: () => plain(vm.runInContext('subscriptionAccountChoices()', context)) };
}

test('subscription choices retain named failed accounts and saved bindings but exclude never-configured bare rows', () => {
  const h = subscriptionHarness([
    reading('known', [], { status: 'notConfigured', accountName: 'Work' }),
    { provider: 'codex', status: 'unavailable', windows: [] },
    { provider: 'cursor', status: 'notConfigured', windows: [] }
  ], { workbuddyManagedAccounts: [account], subscriptions: [
    { provider: 'claude', binding: { accountKey: 'saved', profileName: 'Saved work' } },
    { provider: 'cursor', binding: {} }
  ] });
  assert.deepEqual(h.choices().map((choice) => [choice.provider.provider, choice.provider.accountKey || '']), [
    ['workbuddy', 'known'], ['cursor', ''], ['workbuddy', account.accountKey], ['claude', 'saved']
  ]);
  const withoutBinding = subscriptionHarness([{ provider: 'cursor', status: 'notConfigured' }]);
  assert.deepEqual(withoutBinding.choices(), []);
});

test('nickname changes preserve picker selection and accountKey targeted provenance on the same account', () => {
  const old = { ...account, provider: 'workbuddy', status: 'notConfigured' };
  const renamed = { ...old, accountName: 'Renamed', accountEmail: 'changed@example.com', status: 'unavailable' };
  const h = subscriptionHarness([old]);
  h.context.old = old;
  h.context.renamed = renamed;
  assert.equal(vm.runInContext('subscriptionAccountValue(old) === subscriptionAccountValue(renamed)', h.context), true);
  const provenance = presentation.limitProviderProvenance(renamed, {
    localDeviceId: 'local', devices: [
      { deviceId: 'local', limits: { providers: [old] } },
      { deviceId: 'other', limits: { providers: [{ ...renamed, accountKey: 'different' }] } }
    ]
  });
  // A notConfigured reading is not a usable candidate; a later healthy reading
  // with the original nickname is, by exactly the requested accountKey.
  assert.equal(provenance.candidateCount, 0);
  const healthy = presentation.limitProviderProvenance(renamed, {
    localDeviceId: 'local', devices: [{ deviceId: 'local', limits: { providers: [{ ...old, status: 'ok' }] } }]
  });
  assert.equal(healthy.hasLocalCandidate, true);
  const missing = presentation.limitProviderProvenance({ ...renamed, accountKey: 'different' }, {
    localDeviceId: 'local', devices: [{ deviceId: 'local', limits: { providers: [{ ...old, status: 'ok' }] } }]
  });
  assert.equal(missing.hasLocalCandidate, false);
});

test('WorkBuddy account and total copy is present in every locale and auto connection details remain', () => {
  for (const key of Object.keys(MESSAGES.en).filter((key) => key.startsWith('settings.workbuddy.'))) {
    for (const [locale, messages] of Object.entries(MESSAGES)) assert.ok(messages[key], `${locale}: ${key}`);
  }
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  assert.match(html, /id="workbuddyLoginStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="workbuddyAccountErrorMessage"[^>]*role="alert"/);
  assert.match(app, /workbuddy: 'settings\.limits\.connection\.workbuddy'/);
  assert.match(app, /if \(connectionDetailKey\) optionsInner\.append\(limitProviderConnectionDetail\(connectionDetailKey\)\)/);
});


test('Home sends the complete source readings through the shared WorkBuddy collapse helper', () => {
  const source = app.slice(app.indexOf('function homeLimitRows()'), app.indexOf('function homeLimitWindowLabel('));
  const members = [reading('a'), reading('b', [], { status: 'unavailable' })];
  let drawn, collapsed;
  vm.runInNewContext(`${source}\nhomeLimitRows();`, {
    state: { settings: {}, stats: { limits: { providers: members } } },
    enabledLimitProviderSet: () => new Set(['workbuddy']), hiddenHomeLimitProviderSet: () => new Set(),
    LIMIT_PROVIDERS: [], clientColors: {},
    limitProviderOrderApi: { orderedLimitProviders: () => [] },
    limitUsageItemsApi: { isLimitWindowHidden: () => false },
    limitProviderPresentationApi: presentation,
    limitWindowsView: { collapseWorkbuddyAccounts: (providers) => { collapsed = providers; return providers; } },
    homeOverviewApi: { homeLimitAccountsForProviders: (options) => { drawn = options.providers; } }
  });
  assert.equal(collapsed, members);
  assert.equal(drawn.length, 2);
  assert.equal(drawn[1].status, 'unavailable');
});


test('safe managed metadata and stored bindings keep names on failed identities without mutating stats', () => {
  const providers = [
    { provider: 'workbuddy', accountKey: account.accountKey, status: 'notConfigured', windows: [] },
    { provider: 'claude', accountKey: 'saved', status: 'unavailable', windows: [] }
  ];
  const h = subscriptionHarness(providers, {
    workbuddyManagedAccounts: [account],
    subscriptions: [{ provider: 'claude', binding: { accountKey: 'saved', profileName: 'Saved work' } }]
  });
  const choices = h.choices();
  assert.equal(choices[0].provider.accountName, account.accountName);
  assert.equal(choices[0].provider.accountEmail, account.accountEmail);
  assert.equal(choices[1].provider.accountName, 'Saved work');
  assert.equal(providers[0].accountName, undefined);
  assert.equal(providers[1].accountName, undefined);
});

test('a false boolean cancellation acknowledgement does not retire a still-pending login', async () => {
  const pending = deferred();
  const h = settingsHarness({ addAccount: () => pending.promise, cancelLogin: async () => false });
  const login = h.run("startWorkbuddyLogin('cn')");
  await h.run('cancelWorkbuddyLogin()');
  assert.equal(h.state.workbuddySignInBusy, true);
  assert.equal(h.nodes.workbuddyAddAiAccountButton.disabled, true);
  assert.equal(h.nodes.workbuddyAccountErrorMessage.textContent, MESSAGES.en['settings.workbuddy.cancelFailed']);
  pending.resolve({ ok: false, errorCode: 'CANCELED' });
  await login;
  assert.equal(h.state.workbuddySignInBusy, false);
  assert.equal(h.nodes.workbuddyLoginStatus.textContent, MESSAGES.en['settings.workbuddy.loginCancelled']);
  assert.equal(h.nodes.workbuddyAccountErrorMessage.textContent, '');
});
