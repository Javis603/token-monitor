'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');
const { fetchCopilotLimits, copilotProfiles } = require('../../src/shared/providers/copilot/limits');
const { hashKey } = require('../../src/shared/hashKey');

const usage = { copilot_plan: 'pro', quota_snapshots: {
  premium_interactions: { entitlement: 100, remaining: 75, percent_remaining: 75 }
} };
function fixture(initial = {}, env = {}) {
  const settings = structuredClone(initial);
  const requests = [];
  let failSave = false;
  const fetch = async (url, init) => {
    const token = init.headers.Authorization.slice(6);
    requests.push({ url, token });
    if (token === 'bad-token') return { ok: false, status: 401 };
    return { ok: true, json: async () => url.endsWith('/user') && !url.includes('copilot_internal')
      ? { login: token.startsWith('personal') ? 'alice' : 'bob', id: token.startsWith('personal') ? 1 : 2 } : usage };
  };
  const api = createCopilotAccounts({ getSettings: () => settings, env, changed: () => {},
    saveSettings: () => { if (failSave) throw new Error('disk full'); }, probeDeps: () => ({ fetch, env }) });
  return { api, settings, fetch, requests, failSave: () => { failSave = true; } };
}

test('Copilot adds multiple accounts without replacing legacy tokens, and updates duplicate identities', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' });
  await f.api.addAccount('work-token');
  assert.equal(f.settings.copilotApiToken, 'personal-token');
  assert.equal(f.api.getAccounts().length, 2);
  assert.deepEqual(f.api.getAccounts().map(a => a.accountName).sort(), ['alice', 'bob']);
  await f.api.addAccount('personal-new-token');
  assert.equal(f.api.getAccounts().length, 2);
  assert.equal(f.settings.copilotApiToken, 'personal-new-token');
  assert.equal(Object.values(copilotProfiles(f.settings)).some(p => p.token === 'personal-token'), false);
  assert.equal(JSON.stringify(f.api.getAccounts()).includes('-token'), false);
});

test('Copilot scopes refreshes, isolates failed tokens, and retains failed account identity', async () => {
  const f = fixture();
  await f.api.addAccount('personal-token');
  await f.api.addAccount('work-token');
  const work = f.api.getAccounts().find(a => a.accountName === 'bob');
  f.settings.copilotProfiles[work.id].token = 'bad-token';
  f.requests.length = 0;
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.accountName === 'alice').status, 'ok');
  assert.equal(rows.find(r => r.accountKey === work.accountKey).status, 'unauthorized');
  assert.equal(rows.find(r => r.accountKey === work.accountKey).accountName, 'bob');
  f.requests.length = 0;
  const scoped = await fetchCopilotLimits({ ...f.settings,
    limitRefreshScope: { provider: 'copilot', accountKey: work.accountKey } }, { fetch: f.fetch, env: {} });
  assert.equal(scoped.length, 1);
  assert.ok(f.requests.every(r => r.token === 'bad-token'));
  f.requests.length = 0;
  assert.deepEqual(await fetchCopilotLimits({ ...f.settings,
    limitRefreshScope: { provider: 'copilot', accountKey: 'removed' } }, { fetch: f.fetch, env: {} }), []);
  assert.equal(f.requests.length, 0);
});

test('Copilot disabling and deleting accounts preserves other accounts and provider selection', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' }, { COPILOT_API_TOKEN: 'env-token' });
  await f.api.addAccount('work-token');
  f.settings.limitsEnabled = false;
  f.settings.limitProviders = '';
  const personal = f.api.getAccounts().find(a => a.accountName === 'alice');
  await f.api.setEnabled(personal.id, false);
  assert.equal(f.api.getAccounts().find(a => a.id === personal.id).enabled, false);
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  assert.deepEqual(rows.map(r => r.accountName), ['bob']);
  await f.api.removeAccount(personal.id);
  assert.equal(f.settings.copilotApiToken, '');
  assert.equal(f.api.getAccounts().length, 1);
  assert.equal(f.settings.limitsEnabled, false);
  assert.equal(f.settings.limitProviders, '');
});

test('Copilot cancelled, rejected and failed saves leave credentials unchanged', async () => {
  const f = fixture({ copilotApiToken: 'personal-token' });
  const before = structuredClone(f.settings);
  await assert.rejects(f.api.addAccount('bad-token'));
  await assert.rejects(f.api.addAccount('work-token', () => false), /cancelled/);
  assert.deepEqual(f.settings, before);
  f.failSave();
  await assert.rejects(f.api.addAccount('work-token'), /disk full/);
  assert.equal(f.settings.copilotApiToken, before.copilotApiToken);
  assert.equal(f.api.getAccounts().length, 1);
});

test('Copilot legacy and environment refreshes never return a different scoped account', async () => {
  const f = fixture();
  const row = await fetchCopilotLimits({}, { fetch: f.fetch, env: { COPILOT_API_TOKEN: 'personal-token' } });
  assert.equal(row.accountName, 'alice');
  assert.equal(row.accountKey, hashKey('copilot', 'alice'));
  const other = await fetchCopilotLimits({ copilotApiToken: 'work-token',
    limitRefreshScope: { provider: 'copilot', accountKey: row.accountKey } }, { fetch: f.fetch, env: {} });
  assert.deepEqual(other, []);
});

test('Copilot profiles stay in the credential store, outside settings and renderer projections', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CredentialStore, persistSettingsAndCredentials, credentialSettingsForRenderer } = require('../../src/shared/credentialStore');
  const { limitsAccountConfig } = require('../../src/electron/limits/accountSettings');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'copilot-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture();
  await f.api.addAccount('personal-token');
  const store = new CredentialStore(directory);
  const settingsPath = path.join(directory, 'settings.json');
  persistSettingsAndCredentials({ store, settingsPath, settings: f.settings, previousSettings: {} });
  assert.equal(fs.readFileSync(settingsPath, 'utf8').includes('personal-token'), false);
  assert.equal(JSON.stringify(credentialSettingsForRenderer(f.settings)).includes('personal-token'), false);
  assert.equal(Object.values(store.settingsCredentials().copilotProfiles)[0].token, 'personal-token');
  assert.equal(Object.values(limitsAccountConfig(f.settings).copilotProfiles)[0].token, 'personal-token');
});

test('Copilot legacy and environment scoped failures retain identity only for the unchanged credential and host', async () => {
  for (const fromEnv of [false, true]) {
    let unauthorized = false;
    const f = fixture();
    const options = fromEnv ? {} : { copilotApiToken: 'personal-token' };
    const deps = { env: fromEnv ? { COPILOT_API_TOKEN: 'personal-token' } : {},
      providerRuntimeState: new Map(),
      fetch: (url, init) => unauthorized ? { ok: false, status: 401 } : f.fetch(url, init) };
    const initial = await fetchCopilotLimits(options, deps);
    assert.equal(initial.status, 'ok');
    unauthorized = true;
    const limitRefreshScope = { provider: 'copilot', accountKey: initial.accountKey };
    const expired = await fetchCopilotLimits({ ...options, limitRefreshScope }, deps);
    assert.equal(expired.status, 'unauthorized');
    assert.equal(expired.accountKey, initial.accountKey);
    assert.equal(expired.accountName, initial.accountName);
    // A different token, even sharing its prefix, cannot inherit that identity.
    assert.deepEqual(await fetchCopilotLimits({ copilotApiToken: 'personal-other-token', limitRefreshScope }, deps), []);
    assert.deepEqual(await fetchCopilotLimits({ ...options, copilotEnterpriseHost: 'other.ghe.com', limitRefreshScope }, deps), []);
  }
});

test('Copilot keeps the same GitHub login on separate hosts as distinct accounts', async () => {
  const f = fixture({ copilotApiToken: 'personal-token', copilotEnterpriseHost: 'github.com' });
  await f.api.addAccount('work-token');
  const publicAccounts = f.api.getAccounts();
  f.settings.copilotEnterpriseHost = 'https://company.ghe.com/';
  await f.api.addAccount('work-enterprise-token');
  assert.equal(f.api.getAccounts().length, 3);
  const enterprise = f.api.getAccounts().find(account => !publicAccounts.some(previous => previous.id === account.id));
  assert.equal(enterprise.accountName, 'bob');
  assert.notEqual(enterprise.accountKey, publicAccounts.find(account => account.accountName === 'bob').accountKey);
  assert.equal(f.api.getAccounts().find(account => account.accountName === 'alice').accountKey, hashKey('copilot', 'alice'));
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  assert.equal(rows.length, 3);
  assert.ok(f.requests.some(request => request.url.startsWith('https://api.company.ghe.com/')));
});

test('Copilot token rotation preserves a disabled account', async () => {
  const f = fixture();
  await f.api.addAccount('personal-token');
  const before = f.api.getAccounts()[0];
  await f.api.setEnabled(before.id, false);
  await f.api.addAccount('personal-replacement-token');
  assert.deepEqual(f.api.getAccounts(), [{ ...before, enabled: false }]);
  assert.deepEqual(await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} }), []);
});

test('Copilot begins all account probes before waiting for a slow account', async () => {
  const release = Promise.withResolvers();
  const started = new Set();
  const collection = fetchCopilotLimits({ copilotProfiles: {
    a: { token: 'a-token', accountKey: 'a' }, b: { token: 'b-token', accountKey: 'b' }
  } }, { env: {}, fetch: async (url, init) => {
    const token = init.headers.Authorization;
    if (!url.includes('copilot_internal')) return { ok: true, json: async () => ({ login: token }) };
    started.add(token);
    await release.promise;
    return token === 'token a-token' ? { ok: false, status: 503 } : { ok: true, json: async () => usage };
  } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.size, 2);
  } finally { release.resolve(); }
  const rows = await collection;
  assert.deepEqual(rows.map(row => row.status), ['unavailable', 'ok']);
});

test('Copilot sign-in cancellation aborts identity and quota verification without saving', async () => {
  for (const phase of ['identity', 'quota']) {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const controller = new AbortController();
    const settings = {};
    let requestSignal;
    const api = createCopilotAccounts({ getSettings: () => settings, env: {}, changed: () => {},
      saveSettings: () => assert.fail('cancelled sign-in must not save'),
      probeDeps: () => ({ fetch: async (url, init) => {
        const quota = url.includes('copilot_internal');
        if ((phase === 'quota') === quota) {
          requestSignal = init.signal;
          started.resolve();
          await Promise.race([release.promise, new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          })]);
        }
        return { ok: true, json: async () => quota ? usage : { login: 'alice', id: 1 } };
      } }) });
    const adding = api.addAccount('personal-token', () => true, controller.signal);
    const rejected = assert.rejects(adding, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    try { assert.equal(requestSignal.aborted, true); }
    finally { release.resolve(); }
    await rejected;
    assert.deepEqual(settings, {});
  }
});

test('Copilot IPC failures expose a bounded message instead of provider or storage internals', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/main'), 'utf8');
  const start = source.indexOf("  for (const method of ['addAccount', 'removeAccount', 'setEnabled'])");
  const end = source.indexOf("  ipcMain.handle('copilot:signIn'", start);
  const handlers = new Map();
  const fail = () => { throw new Error('/private/credential-store/provider-response-private'); };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    copilotAccounts: { addAccount: fail, removeAccount: fail, setEnabled: fail }
  });
  assert.equal(handlers.size, 3);
  for (const handler of handlers.values()) {
    const result = await handler({});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Could not update GitHub Copilot account. Please try again.');
  }
});

test('Copilot legacy checkbox migration preserves its original account key, including offline migration', async () => {
  for (const offline of [false, true]) {
    const f = fixture({ copilotApiToken: 'personal-token' });
    const original = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
    const api = createCopilotAccounts({ getSettings: () => f.settings, env: {}, changed: () => {}, saveSettings: () => {},
      probeDeps: () => ({ fetch: offline ? async () => { throw new Error('offline'); } : f.fetch }) });
    await api.setEnabled('legacy', false);
    await api.setEnabled('legacy', true);
    const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
    assert.equal(rows[0].accountKey, original.accountKey);
    assert.equal(rows[0].accountName, original.accountName);
    const scoped = await fetchCopilotLimits({ ...f.settings,
      limitRefreshScope: { provider: 'copilot', accountKey: original.accountKey } }, { fetch: f.fetch, env: {} });
    assert.equal(scoped[0].accountKey, original.accountKey);
  }
});

test('Copilot collection keeps both accounts through Node and Worker aggregate views', async () => {
  const f = fixture();
  await f.api.addAccount('personal-token');
  await f.api.addAccount('work-token');
  const rows = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  for (const { aggregateLimits } of [require('../../src/shared/limits/core'), require('../../worker/src/shared/limits/core')]) {
    const aggregate = aggregateLimits([{ deviceId: 'local', limits: { providers: rows } }]);
    assert.equal(aggregate.providers.length, 2);
    const mixed = aggregateLimits([{ deviceId: 'local', limits: {
      providers: [rows[0], { ...rows[1], status: 'unauthorized', windows: [] }]
    } }]);
    assert.equal(mixed.providers.length, 2);
    assert.deepEqual(mixed.providers.map(row => row.accountKey).sort(), rows.map(row => row.accountKey).sort());
    const repeated = aggregateLimits([
      { deviceId: 'local', limits: { providers: rows } }, { deviceId: 'remote', limits: { providers: rows } }
    ]);
    assert.equal(repeated.providers.length, 2);
  }
});

function runtimeFixture(t, env = {}, initial = {}) {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../src/electron/main'), 'utf8');
  const area = source.slice(source.indexOf('  const copilotAccounts = createCopilotAccounts('), source.indexOf("  ipcMain.handle('copilot:getAccounts'"));
  const arrow = area.match(/changed: (\([^)]*\) => \{[\s\S]*?\n {4}\})/)[1];
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { runLimitInvalidation } = require('../../src/electron/deviceRuntimeCoordinator');
  const limits = require('../../src/shared/providers/copilot/limits');
  const settings = { limitsEnabled: true, limitProviders: 'copilot', ...initial };
  const f = fixture();
  let failing = false;
  let identityAvailable = true;
  const fetch = (url, init) => !identityAvailable && !url.includes('copilot_internal')
    ? { ok: false, status: 503 } : failing && init.headers.Authorization === 'token work-token'
    ? { ok: false, status: 503 } : f.fetch(url, init);
  const runtime = createLimitsRuntime(settings, { autoStart: false, autoRetry: false, env, fetch });
  t.after(() => runtime.stop());
  const refreshes = [];
  const scopes = [];
  const changed = Function('settings', 'copilotLimits', 'deviceRuntimeHandle', 'pushSettingsToRenderer', 'queueLimitInvalidation', 'electronLimitsConfig', `return (${arrow});`)(
    settings, limits, { reconfigureLimits: options => runtime.reconfigure(options), getSnapshot: () => ({ limits: runtime.getSnapshot() }) },
    () => {}, (scope, reason, options) => {
      scopes.push({ scope, ...options });
      const pending = runLimitInvalidation({ clearLimits: runtime.clear, refreshLimits: runtime.refresh }, scope, reason, options);
      refreshes.push(pending);
      return pending;
    }, () => settings);
  const api = createCopilotAccounts({ getSettings: () => settings, saveSettings: () => {}, env, changed, probeDeps: () => ({ fetch }) });
  return { api, runtime, scopes, flush: () => Promise.all(refreshes), failWork: () => { failing = true; },
    hideIdentity: () => { identityAvailable = false; }, showIdentity: () => { identityAvailable = true; } };
}

test('Copilot settings mutations clear only their account and preserve a failing sibling last-good reading', async t => {
  const { api, runtime, scopes, flush, failWork } = runtimeFixture(t);
  await api.addAccount('personal-token');
  await flush();
  await api.addAccount('work-token');
  await flush();
  const alice = api.getAccounts().find(account => account.accountName === 'alice');
  const bob = api.getAccounts().find(account => account.accountName === 'bob');
  assert.equal(runtime.getSnapshot().providers.find(row => row.accountKey === bob.accountKey).windows.length, 1);
  failWork();
  await api.removeAccount(alice.id);
  await flush();
  assert.deepEqual(scopes.at(-1), { scope: { provider: 'copilot', accountKey: alice.accountKey }, clear: true, refresh: false });
  await runtime.refresh({ provider: 'copilot' }, 'manual');
  const retained = runtime.getSnapshot().providers.find(row => row.accountKey === bob.accountKey);
  assert.equal(retained.status, 'unavailable');
  assert.equal(retained.windows.length, 1);
});

test('Copilot sign-in accepts the quota reading completed before its bridge response', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app'), 'utf8');
  const start = source.indexOf("    document.getElementById('copilotSignInButton').addEventListener");
  const end = source.indexOf("    document.getElementById('copilotCancelSignInButton')", start);
  const statusStart = source.indexOf('function copilotProviderForAccount()');
  const statusEnd = source.indexOf('const externalLimitAccountConfig', statusStart);
  let clock = 1000;
  let reading;
  let click;
  const state = {};
  const context = {
    state, Date: class extends Date { static now() { return clock; } },
    document: { getElementById: () => ({ addEventListener: (_event, handler) => { click = handler; } }) },
    window: { tokenMonitor: { copilot: { signIn: async ({ flowId }) => {
      reading = { accountName: 'alice', status: 'ok', updatedAt: new Date(1500).toISOString() };
      clock = 2000;
      return { ok: true, flowId };
    } } } },
    nextCopilotSignInFlowId: () => 'flow', isCurrentCopilotSignInFlow: id => state.copilotSignInFlowId === id,
    t: key => key, setCopilotError: () => {}, setCopilotManualExpanded: () => {}, renderCopilotStatus: () => {},
    refreshStats: async () => {}, setCopilotAccountExpanded: () => {}, copilotProviderStatus: () => reading,
    copilotAccountLinked: () => Boolean(context.copilotProviderForAccount())
  };
  vm.runInNewContext(source.slice(statusStart, statusEnd) + source.slice(start, end), context);
  await click();
  assert.equal(context.copilotProviderForAccount()?.accountName, 'alice');
});

test('Copilot environment readings are retired when saved accounts take precedence and restored after removal', async t => {
  const { api, runtime, flush } = runtimeFixture(t, { COPILOT_API_TOKEN: ['personal', 'environment', 'fixture'].join('-') });
  await runtime.refresh({ provider: 'copilot' }, 'manual');
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountName), ['alice']);
  await api.addAccount('work-token');
  await flush();
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountName), ['bob']);
  await runtime.refresh({ provider: 'copilot' }, 'manual');
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountName), ['bob']);
  await api.removeAccount(api.getAccounts()[0].id);
  await flush();
  assert.deepEqual(runtime.getSnapshot().providers.map(row => row.accountName), ['alice']);
});

test('Node and Worker GUI-secret merges preserve every managed Copilot account through repeated headless uploads', async () => {
  const f = fixture();
  await f.api.addAccount(['personal', 'managed', 'fixture'].join('-'));
  await f.api.addAccount('work-token');
  const providers = await fetchCopilotLimits(f.settings, { fetch: f.fetch, env: {} });
  for (const { mergeDeviceRecord } of [require('../../src/shared/usage'), require('../../worker/src/shared/usage')]) {
    const existing = { deviceId: 'shared', agentRuntime: 'electron-widget', limits: { providers } };
    const incoming = { deviceId: 'shared', agentRuntime: 'headless-agent', limits: {
      providers: [{ provider: 'copilot', status: 'notConfigured' }]
    } };
    let merged = existing;
    for (let upload = 0; upload < 3; upload++) {
      merged = mergeDeviceRecord(merged, incoming);
      assert.deepEqual(merged.limits.providers.map(row => row.accountName).sort(), ['alice', 'bob']);
    }
    const cleared = mergeDeviceRecord(merged, { ...incoming, agentRuntime: 'electron-widget' });
    assert.equal(cleared.limits.providers.length, 1);
    assert.equal(cleared.limits.providers[0].status, 'notConfigured');
    const disabled = mergeDeviceRecord(merged, { ...incoming, limits: { providers: [{ provider: 'copilot', status: 'disabled' }] } });
    assert.equal(disabled.limits.providers.length, 1);
    assert.equal(disabled.limits.providers[0].status, 'disabled');
  }
});

test('Copilot rejects a changed authorization host before sending the new token', async () => {
  const f = fixture({ copilotEnterpriseHost: 'company.ghe.com' });
  await assert.rejects(f.api.addAccount('work-token', () => true, undefined, 'github.com'), /host changed/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.api.getAccounts().length, 0);
  // Manual token entry still uses the current host when no authorization host is supplied.
  await f.api.addAccount('work-token');
  assert.ok(f.requests.every(request => request.url.startsWith('https://api.company.ghe.com/')));
});

test('Copilot unresolved credentials with a shared prefix retain distinct fallback identities', async () => {
  for (const quotaOk of [true, false]) {
    const rows = await fetchCopilotLimits({ copilotProfiles: {
      a: { token: 'gho_abcd-account-a' }, b: { token: 'gho_abcd-account-b' }
    } }, { env: {}, fetch: async url => url.includes('copilot_internal') && quotaOk
      ? { ok: true, json: async () => usage } : { ok: false, status: 401 } });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].accountKey, rows[1].accountKey);
    assert.ok(rows.every(row => row.status === (quotaOk ? 'ok' : 'unauthorized')));
  }
});

test('Copilot device-flow IPC carries the authorization host through a settings change', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/main'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('copilot:signIn'");
  const end = source.indexOf("  ipcMain.handle('copilot:cancelSignIn'", start);
  const f = fixture({ copilotEnterpriseHost: 'github.com' });
  let signIn;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, handler) => { signIn = handler; } },
    copilotLoginController: null, copilotLoginFlowId: '', AbortController, settings: f.settings,
    process: { env: {} }, copilotAccounts: f.api, fetch: f.fetch,
    copilotLoginErrorMessage: error => error.message,
    runCopilotDeviceFlowLogin: async ({ enterpriseHost }) => {
      assert.equal(enterpriseHost, 'github.com');
      f.settings.copilotEnterpriseHost = 'company.ghe.com';
      return { accessToken: 'work-token' };
    }
  });
  const result = await signIn({ sender: { isDestroyed: () => false, send: () => {} } }, { flowId: 'flow' });
  assert.equal(result.ok, false);
  assert.match(result.error, /host changed/);
  assert.equal(f.requests.length, 0);
});

test('Copilot replaces a provisional runtime identity after GitHub identity lookup recovers', async t => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { aggregateLimits } = require('../../src/shared/limits/core');
  for (const source of ['legacy', 'environment', 'legacyWithSaved']) {
    for (const scopedRecovery of [false, true]) {
      let identityAvailable = false;
      const token = ['personal', 'provisional', 'fixture'].join('-');
      const sibling = source === 'legacyWithSaved';
      const bobKey = hashKey('copilot', 'bob');
      const runtime = createLimitsRuntime({ limitsEnabled: true, limitProviders: 'copilot',
        ...(source === 'environment' ? {} : { copilotApiToken: token }),
        ...(sibling ? { copilotProfiles: { bob: { token: 'work-fixture', accountKey: bobKey, accountName: 'bob' } } } : {})
      }, {
        autoStart: false, autoRetry: false, env: source === 'environment' ? { COPILOT_API_TOKEN: token } : {},
        fetch: async (url, init) => url.includes('copilot_internal') ? { ok: true, json: async () => usage }
          : init.headers.Authorization === 'token work-fixture' ? { ok: true, json: async () => ({ login: 'bob', id: 2 }) }
            : identityAvailable ? { ok: true, json: async () => ({ login: 'alice', id: 1 }) } : { ok: false, status: 503 }
      });
      t.after(() => runtime.stop());
      await runtime.refresh({ provider: 'copilot' }, 'manual');
      const provisional = runtime.getSnapshot().providers.find(row => row.accountKey !== bobKey);
      assert.equal(provisional.status, 'ok');
      identityAvailable = true;
      if (scopedRecovery) {
        await runtime.refresh({ provider: 'copilot', accountKey: provisional.accountKey }, 'account-refresh');
        assert.equal(runtime.getSnapshot().providers.length, sibling ? 2 : 1);
        assert.ok(runtime.getSnapshot().providers.some(row => row.accountKey === provisional.accountKey));
      }
      await runtime.refresh({ provider: 'copilot' }, 'manual');
      const snapshot = runtime.getSnapshot();
      assert.equal(snapshot.providers.length, sibling ? 2 : 1);
      assert.ok(snapshot.providers.some(row => row.accountKey === hashKey('copilot', 'alice')));
      assert.ok(!snapshot.providers.some(row => row.accountKey === provisional.accountKey));
      if (sibling) assert.equal(snapshot.providers.find(row => row.accountKey === bobKey).windows.length, 1);
      assert.equal(aggregateLimits([{ deviceId: 'local', limits: snapshot }]).providers.length, sibling ? 2 : 1);
      assert.equal(JSON.stringify(snapshot).includes('removed'), false);
    }
  }
});

test('Copilot account operations retire a provisional row when resolving a legacy credential', async t => {
  for (const action of ['disable', 'save']) {
    const token = ['personal', 'operation', 'fixture'].join('-');
    const f = runtimeFixture(t, {}, { copilotApiToken: token });
    f.hideIdentity();
    await f.runtime.refresh({ provider: 'copilot' }, 'manual');
    const provisional = f.runtime.getSnapshot().providers[0].accountKey;
    f.showIdentity();
    if (action === 'disable') await f.api.setEnabled('legacy', false);
    else await f.api.addAccount(token);
    await f.flush();
    const rows = f.runtime.getSnapshot().providers;
    assert.equal(rows.length, action === 'disable' ? 0 : 1);
    assert.ok(!rows.some(row => row.accountKey === provisional));
    if (action === 'save') assert.equal(rows[0].accountKey, hashKey('copilot', 'alice'));
  }
});
