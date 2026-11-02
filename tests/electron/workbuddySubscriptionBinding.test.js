'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const os = require('node:os');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { createWorkbuddyLocalAuth } = require('../../src/electron/providers/workbuddy/localAuth');
const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');
const subscriptionApi = require('../../src/shared/subscriptionDisplay');
const limitProviderPresentationApi = require('../../src/electron/renderer/limits/providerPresentation');
const { fetchWorkbuddyLimits, workbuddyAccountKey } = require('../../src/shared/providers/workbuddy/limits');
const { fetchClineLimits, CLINE_API_BASE, USAGE_LIMITS_PATH, USERS_ME_PATH } = require('../../src/shared/providers/cline/limits');
test.beforeEach(t => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T00:00:00Z') }));

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function functionSource(name) {
  const index = app.indexOf('function ' + name + '(');
  const start = app.slice(Math.max(0, index - 6), index) === 'async ' ? index - 6 : index;
  const next = /\n(?:async )?function \w+\(/.exec(app.slice(index + 1));
  return app.slice(start, index + 1 + next.index);
}

class Select {
  constructor(value = '') { this.value = value; this.options = []; }
  replaceChildren() { this.options = []; this.value = ''; }
  append(option) { this.options.push(option); if (this.options.length === 1) this.value = option.value; }
}

function harness(live, saved, managed = []) {
  const els = { subscriptionProviderInput: new Select('workbuddy'), subscriptionAccountInput: new Select(), subscriptionCurrencyInput: new Select('USD') };
  for (const field of ['subscriptionPlanNameInput', 'subscriptionAmountInput', 'subscriptionIntervalCountInput', 'subscriptionIntervalInput', 'subscriptionStartDateInput', 'subscriptionNextRenewalInput', 'subscriptionSubmit']) {
    els[field] = { value: '', textContent: '' };
  }
  els.subscriptionAutoRenewInput = { checked: true };
  const state = { settings: { subscriptions: saved, workbuddyManagedAccounts: managed }, stats: { limits: { providers: [] } }, subscriptionFormBase: {} };
  let written;
  const context = vm.createContext({
    Date, accountIdentityApi, subscriptionApi, limitProviderPresentationApi, state, els,
    currencyApi: { CURRENCY_CODES: ['USD'], normalizeCurrency: () => 'USD' }, localDeviceLimitsProviders: () => live,
    subscriptionText: { providerLabel: (id) => id }, document: { createElement: () => ({}) }, t: (key) => key,
    setSubscriptionFormKind() {}, setSubscriptionFormMode() {}, syncSubscriptionDateBounds() {}, positionSubscriptionEditor() {}, openSubscriptionEditor() {}, setSubscriptionError() {},
    subscriptionFormTopUps: () => [], subscriptionFormIsTopUp: () => false,
    saveSubscriptions: async (list) => { written = list; return true; }, closeSubscriptionEditor() {}, renderSubscriptionSettings() {}
  });
  for (const name of ['subscriptionList', 'limitProvidersForSubscriptions', 'subscriptionAccountChoices', 'subscriptionAccountValue', 'subscriptionForAccount', 'renderSubscriptionPickers', 'beginSubscriptionEdit', 'submitSubscription']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, els, written: () => written, run: (code) => vm.runInContext(code, context) };
}

const saved = { id: 'saved-sub', provider: 'workbuddy', kind: 'subscription', binding: { accountKey: 'missing-key', profileName: 'Saved C' }, planName: 'Old plan', amountMinor: 1000, currency: 'USD', interval: 'month', intervalCount: 1, startDate: '2026-01-01', autoRenew: true };

test('a healthy anonymous Cline reading remains selectable when its profile read fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-picker-cline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'settings'));
  fs.writeFileSync(path.join(directory, 'settings/providers.json'), JSON.stringify({ providers: {
    cline: { settings: { auth: { accessToken: 'fixture-old-signin' } } }
  } }));
  const calls = [];
  const provider = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: directory },
    fetch: async (url) => {
      calls.push(url);
      const usage = url === `${CLINE_API_BASE}${USAGE_LIMITS_PATH}`;
      return { ok: usage, status: usage ? 200 : 503, headers: { get: () => null },
        json: async () => usage ? { success: true, data: { limits: [{ type: 'weekly', percentUsed: 20 }] } } : {} };
    }
  });
  assert.deepEqual(calls, [`${CLINE_API_BASE}${USAGE_LIMITS_PATH}`, `${CLINE_API_BASE}${USERS_ME_PATH}`]);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, '');
  assert.equal(provider.accountEmail, '');
  const h = harness([provider], []);
  assert.equal(h.run('subscriptionAccountChoices().length'), 1);
  assert.equal(h.run('subscriptionAccountChoices()[0].provider.provider'), 'cline');
  h.els.subscriptionProviderInput.value = 'cline';
  h.run('renderSubscriptionPickers()');
  assert.equal(h.els.subscriptionAccountInput.options.length, 1);
});

test('workbuddy editing and saving retains a missing binding while other accounts are live', async () => {
  for (const count of [1, 2]) {
    const live = ['a', 'b'].slice(0, count).map((key) => ({ provider: 'workbuddy', accountKey: 'live-' + key, accountName: 'Same nickname', status: 'ok', windows: [] }));
    const h = harness(live, [{ ...saved, provider: 'workbuddy' }]);
    h.els.subscriptionProviderInput.value = 'workbuddy';
    h.run("beginSubscriptionEdit('saved-sub')");
    assert.equal(h.els.subscriptionAccountInput.value, 'workbuddy\0missing-key');
    await h.run('submitSubscription()');
    assert.equal(h.written()[0].binding.accountKey, 'missing-key');
    h.context.target = h.run('subscriptionAccountChoices().at(-1).provider');
    assert.equal(h.run("subscriptionForAccount(state.settings.subscriptions, 'workbuddy', target)?.id"), 'saved-sub');
    h.context.target = live[0];
    assert.equal(h.run("subscriptionForAccount(state.settings.subscriptions, 'workbuddy', target)"), null);
  }
});

test('other providers heal rotated keys before saved-only choices and still reject duplicate live records', async () => {
  for (const kind of ['email', 'profile', 'sole']) {
    const account = { provider: 'cursor', accountKey: 'new-key', accountName: 'Work', accountEmail: 'work@example.com', status: 'ok', windows: [] };
    const binding = { accountKey: 'old-key', ...(kind === 'email' ? { accountEmail: 'work@example.com' }
      : kind === 'profile' ? { profileName: 'Work' } : {}) };
    const record = { ...saved, provider: 'cursor', binding };
    const siblings = kind === 'sole' ? [] : [{ ...account, accountKey: 'other', accountName: 'Other', accountEmail: 'other@example.com' }];
    const h = harness([account, ...siblings], [record]);
    h.run("beginSubscriptionEdit('saved-sub')");
    assert.equal(h.els.subscriptionAccountInput.value, 'cursor\0new-key', kind);
    await h.run('submitSubscription()');
    assert.equal(h.written()[0].binding.accountKey, 'new-key', kind);
    h.context.target = account;
    assert.equal(h.run("subscriptionForAccount(state.settings.subscriptions, 'cursor', target)?.id"), 'saved-sub', kind);
    assert.equal(h.run("subscriptionAccountChoices().some((choice) => choice.provider.accountKey === 'old-key')"), false, kind);
  }
  const unavailable = harness([], [{ ...saved, provider: 'cursor' }]);
  assert.equal(unavailable.run('subscriptionAccountChoices()[0].provider.accountKey'), 'missing-key');
});

test('actual unidentified local discovery rows are not choices, while known encrypted accounts and saved bindings remain', async () => {
  const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true, workbuddyLocalSessionReason: 'encrypted' }, { env: {} });
  const h = harness([placeholder], []);
  assert.equal(h.run('subscriptionAccountChoices().length'), 0);
  for (const realm of ['cn', 'ai']) {
    const key = workbuddyAccountKey('', '', '', '', realm);
    assert.equal(limitProviderPresentationApi.isWorkbuddyPlaceholder({ ...placeholder, region: realm, accountKey: key }), true);
    assert.equal(limitProviderPresentationApi.isWorkbuddyPlaceholder({ ...placeholder, accountKey: workbuddyAccountKey('', 'verified-user', '', '', realm) }), false);
  }
  const bound = harness([placeholder], [{ ...saved, binding: { accountKey: placeholder.accountKey, profileName: 'Previously saved' } }]);
  assert.equal(bound.run('subscriptionAccountChoices()[0].provider.accountName'), 'Previously saved');
  const known = harness([{ ...placeholder, accountKey: workbuddyAccountKey('', 'known-user'), accountName: 'Known account' }], []);
  assert.equal(known.run('subscriptionAccountChoices().length'), 1);
});

test('malformed discovery retains a known encrypted identity without successful quota until confirmed absence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-known-encrypted-'));
  const file = path.join(directory, 'workbuddy-desktop.info');
  const now = Date.parse('2026-10-12T00:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'fixture' } }, account: { uid: 'local-c', name: 'Known C' } }));
  const auth = createWorkbuddyLocalAuth({ platform: 'darwin', authDirectory: directory, env: {}, now: () => now });
  const managed = ['a', 'b'].map((id) => ({ id, realm: 'cn', userId: 'managed-' + id }));
  const runtime = createLimitsRuntime({ limitProviders: ['workbuddy'] }, {
    autoStart: false, autoRetry: false, env: {}, now: () => now, providerPhysicalBoundMs: () => 1000,
    resolveConfigSnapshot: () => ({ workbuddyManagedAccounts: managed, workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: auth.getSessionInfos() }),
    resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'fixture' }), workbuddyFetch: auth.request,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { Accounts: [{ Status: 0, CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 80 }] } }) })
  });
  t.after(() => { runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const key = workbuddyAccountKey('', 'local-c');
  await runtime.refresh({ provider: 'workbuddy' }, 'manual');
  assert.equal(runtime.getSnapshot().providers.find((row) => row.accountKey === key).status, 'notConfigured');
  fs.writeFileSync(file, '{');
  await runtime.refresh({ provider: 'workbuddy' }, 'manual');
  const retained = runtime.getSnapshot().providers.find((row) => row.accountKey === key);
  assert.ok(retained);
  assert.equal(retained.status, 'unavailable');
  assert.equal(retained.accountName, 'Known C');
  assert.deepEqual(retained.windows, []);
  const h = harness(runtime.getSnapshot().providers, []);
  assert.equal(h.run(`subscriptionAccountChoices().some((choice) => choice.provider.accountKey === '${key}')`), true);
  fs.unlinkSync(file);
  await runtime.refresh({ provider: 'workbuddy' }, 'manual');
  assert.equal(runtime.getSnapshot().providers.some((row) => row.accountKey === key), false);
});
