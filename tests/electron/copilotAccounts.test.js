'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCopilotAccounts } = require('../../src/electron/providers/copilot/accounts');
const { fetchCopilotLimits } = require('../../src/shared/providers/copilot/limits');
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
  const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
  const service = createAccountSlotService({ getSettings: () => settings, env, write: patch => { if (failSave) throw new Error('disk full'); Object.assign(settings, patch); }, probeDeps: () => ({ fetch, env }) });
  const api = createCopilotAccounts({ getSettings: () => settings, service, env, probeDeps: () => ({ fetch, env }) });
  return { api, settings, fetch, requests, failSave: () => { failSave = true; } };
}

test('Copilot legacy and environment refreshes never return a different scoped account', async () => {
  const f = fixture();
  const row = await fetchCopilotLimits({}, { fetch: f.fetch, env: { COPILOT_API_TOKEN: 'personal-token' } });
  assert.equal(row.accountName, 'alice');
  assert.equal(row.accountKey, hashKey('copilot', 'alice'));
  const other = await fetchCopilotLimits({ copilotApiToken: 'work-token',
    limitRefreshScope: { provider: 'copilot', accountKey: row.accountKey } }, { fetch: f.fetch, env: {} });
  assert.deepEqual(other, []);
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
    const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
    const service = createAccountSlotService({ getSettings: () => settings, write: () => assert.fail('cancelled sign-in must not save') });
    const api = createCopilotAccounts({ getSettings: () => settings, service, env: {},
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

test('Node and Worker GUI-secret merges preserve every managed Copilot account through repeated headless uploads', async () => {
  const f = fixture();
  await f.api.addAccount(['personal', 'managed', 'fixture'].join('-'));
  await f.api.addAccount('work-token');
  const providers = await require('../../src/shared/limits/registry').LIMIT_PROVIDER_FETCHERS.copilot(f.settings, { fetch: f.fetch, env: {} });
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
