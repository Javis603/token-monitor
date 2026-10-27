'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectLimitsOnce } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { aggregateLimits } = require('../../src/shared/limits/core');

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => '', getSetCookie: () => [] }, json: async () => body };
}

function fixture() {
  const requests = [];
  const failures = new Map();
  const accounts = ['a', 'b'].map((id) => ({ id, cookie: `sessionKey=sk-ant-${id}`, organizationId: `org-${id}` }));
  let localId = 'c';
  const deps = {
    autoStart: false, autoRetry: false, env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' },
    now: () => Date.parse('2026-10-26T00:00:00Z'),
    platform: 'linux', providerRuntimeState: new Map(),
    resolveClaudeWebCredential: (account) => accounts.find((entry) => entry.id === account.id)?.cookie,
    fetch: async (url, init) => {
      const id = init.headers.cookie?.replace('sessionKey=sk-ant-', '') || localId;
      requests.push({ url, id });
      if (failures.has(id)) return response(failures.get(id), {});
      if (url.endsWith('/api/organizations')) return response(200, [{ uuid: `org-${id}`, name: `Workspace ${id}` }]);
      if (url.endsWith('/api/account')) return response(200, { uuid: `account-${id}`, email_address: `${id}@example.com` });
      if (url.endsWith('/api/oauth/profile')) return response(200, {
        account: { uuid: `account-${id}`, email: `${id}@example.com` }, organization: { uuid: `org-${id}` }
      });
      if (url.endsWith('/prepaid/credits')) return response(200, { amount: 0, currency: 'USD' });
      return response(200, { five_hour: { utilization: id === 'a' ? 10 : 20 } });
    }
  };
  return { accounts, deps, requests, failures, setLocal: (id) => { localId = id; } };
}

test('runtime collection includes multiple Claude Web accounts and local OAuth together', async () => {
  const f = fixture();
  const summary = await collectLimitsOnce({ limitProviders: ['claude'], claudeManagedAccounts: f.accounts }, f.deps);
  assert.deepEqual(summary.providers.map((row) => row.accountEmail).sort(), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.equal(summary.providers.filter((row) => row.source === 'web').length, 2);
  assert.equal(summary.providers.every((row) => row.status === 'ok'), true);
});

test('the legacy Web setting is collected alongside local OAuth without migration', async () => {
  const f = fixture();
  const summary = await collectLimitsOnce({ limitProviders: ['claude'], claudeWebCookie: f.accounts[0].cookie }, f.deps);
  assert.deepEqual(summary.providers.map((row) => row.accountEmail).sort(), ['a@example.com', 'c@example.com']);
});

test('Web and OAuth observations of the same account keep the existing deduplication', async () => {
  const f = fixture();
  f.setLocal('a');
  const summary = await collectLimitsOnce({ limitProviders: ['claude'], claudeManagedAccounts: f.accounts }, f.deps);
  const merged = aggregateLimits([{ deviceId: 'local', limits: summary }]);
  assert.deepEqual(merged.providers.map((row) => row.accountEmail).sort(), ['a@example.com', 'b@example.com']);
});

test('the runtime keeps Web-only prepaid credits when OAuth reports the same account', async (t) => {
  const f = fixture();
  f.setLocal('a');
  const fetch = f.deps.fetch;
  f.deps.fetch = (url, init) => url.endsWith('/prepaid/credits')
    ? response(200, { amount: 2500, currency: 'USD' }) : fetch(url, init);
  const runtime = createLimitsRuntime({ limitProviders: ['claude'], claudeManagedAccounts: [f.accounts[0]] }, f.deps);
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const rows = runtime.getSnapshot().providers;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance.amount, 25);
  assert.equal(rows[0].windows.some((window) => window.metric === 'credits'), true);
});

test('transient Web failures retain credits with old freshness beside current OAuth quota until the cache expires', async (t) => {
  const f = fixture();
  f.setLocal('a');
  let clock = Date.parse('2026-10-26T00:00:00Z');
  let webStatus = 200;
  let oauthUsed = 20;
  const fetch = f.deps.fetch;
  f.deps.now = () => clock;
  f.deps.claudePrepaidCacheTtlMs = 60000;
  f.deps.fetch = (url, init) => {
    if (init.headers.cookie && webStatus !== 200) return response(webStatus, {});
    if (url.endsWith('/prepaid/credits')) return response(200, { amount: 2500, currency: 'USD' });
    if (!init.headers.cookie && url.includes('/api/oauth/usage')) return response(200, { five_hour: { utilization: oauthUsed } });
    return fetch(url, init);
  };
  let config = { limitProviders: ['claude'], claudeManagedAccounts: [f.accounts[0]] };
  const runtime = createLimitsRuntime(config, { ...f.deps, resolveConfigSnapshot: () => config });
  t.after(() => runtime.stop());
  await runtime.refresh('claude', 'credential-save');
  const first = runtime.getSnapshot().providers[0];
  assert.equal(first.balance.amount, 25);
  config = { ...config, claudeManagedAccounts: [{ ...f.accounts[0], accountKey: first.accountKey }] };
  webStatus = 503;
  clock += 10000;
  oauthUsed = 45;
  await runtime.refresh('claude', 'credential-save');
  const partial = runtime.getSnapshot().providers[0];
  assert.equal(partial.balance?.amount, 25);
  assert.equal(partial.windows.find((window) => window.kind === 'session').usedPercent, 45);
  assert.equal(partial.status, 'unavailable');
  assert.equal(partial.updatedAt, first.updatedAt);
  assert.equal(JSON.stringify(partial).includes('invalidateCachedWindowLabels'), false);
  clock += 60000;
  await runtime.refresh('claude', 'credential-save');
  const expired = runtime.getSnapshot().providers[0];
  assert.equal(expired.status, 'ok');
  assert.equal(expired.balance, null);
  assert.equal(expired.windows.some((window) => window.metric === 'credits'), false);
  webStatus = 200;
  await runtime.refresh('claude', 'credential-save');
  assert.equal(runtime.getSnapshot().providers[0].balance.amount, 25);
  webStatus = 401;
  clock += 10000;
  await runtime.refresh('claude', 'credential-save');
  assert.equal(runtime.getSnapshot().providers[0].balance, null, 'unauthorized Web credentials cannot retain credits');
});

test('an expired Web login retains its identity without degrading healthy accounts; removal retires it', async (t) => {
  const f = fixture();
  let config = { limitProviders: ['claude'], claudeManagedAccounts: f.accounts };
  const runtime = createLimitsRuntime(config, { ...f.deps, resolveConfigSnapshot: () => config });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const first = runtime.getSnapshot();
  assert.equal(first.providers.length, 3);
  config = { ...config, claudeManagedAccounts: f.accounts.map((account) => ({
    ...account, ...first.providers.find((row) => row.accountEmail === `${account.id}@example.com`)
  })) };
  f.failures.set('b', 401);
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const failed = runtime.getSnapshot().providers;
  assert.equal(failed.find((row) => row.accountEmail === 'b@example.com').status, 'unauthorized');
  assert.equal(failed.filter((row) => row.status === 'ok').length, 2);
  config = { ...config, claudeManagedAccounts: config.claudeManagedAccounts.filter((account) => account.id !== 'b') };
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.accountEmail).sort(), ['a@example.com', 'c@example.com']);
});

test('a scoped Web refresh cannot overwrite a different runtime account', async (t) => {
  const f = fixture();
  let config = { limitProviders: ['claude'], claudeManagedAccounts: f.accounts };
  const runtime = createLimitsRuntime(config, { ...f.deps, resolveConfigSnapshot: () => config });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  const before = runtime.getSnapshot().providers;
  config = { ...config, claudeManagedAccounts: f.accounts.map((account) => ({
    ...account, ...before.find((row) => row.accountEmail === `${account.id}@example.com`)
  })) };
  const a = before.find((row) => row.accountEmail === 'a@example.com');
  f.requests.length = 0;
  await runtime.refresh({ provider: 'claude', accountKey: a.accountKey }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers, before);
  assert.equal(f.requests.every((request) => request.id === 'a'), true);
});

test('a timed-out Web account does not discard another account’s result', async () => {
  const f = fixture();
  const fetch = f.deps.fetch;
  f.deps.fetch = (url, init) => init.headers.cookie === 'sessionKey=sk-ant-b'
    ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    : fetch(url, init);
  const summary = await collectLimitsOnce({ limitProviders: ['claude'], claudeManagedAccounts: f.accounts }, { ...f.deps, claudeAccountTimeoutMs: 15 });
  assert.deepEqual(summary.providers.filter((row) => row.status === 'ok').map((row) => row.accountEmail).sort(), ['a@example.com', 'c@example.com']);
});

test('runtime removal still retires a managed Web account while a legacy Web account remains', async (t) => {
  const f = fixture();
  let config = { limitProviders: ['claude'], claudeManagedAccounts: [f.accounts[1]], claudeWebCookie: f.accounts[0].cookie };
  const runtime = createLimitsRuntime(config, { ...f.deps, resolveConfigSnapshot: () => config });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  assert.equal(runtime.getSnapshot().providers.length, 3);
  config = { ...config, claudeManagedAccounts: [] };
  await runtime.refresh({ provider: 'claude' }, 'credential-save');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.accountEmail).sort(), ['a@example.com', 'c@example.com']);
});
