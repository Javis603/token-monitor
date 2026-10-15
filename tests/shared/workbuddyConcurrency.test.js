'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchWorkbuddyLimits, workbuddyAccountKey } = require('../../src/shared/providers/workbuddy/limits');
const { providerPhysicalBoundMs } = require('../../src/shared/limits/collector');

const turn = () => new Promise((resolve) => setImmediate(resolve));
const quota = () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {
  Accounts: [{ Status: 0, CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 70 }]
} }) });
const accounts = (count) => Array.from({ length: count }, (_, index) => {
  const account = { id: `user-${index}`, userId: `user-${index}`, realm: index % 2 ? 'ai' : 'cn',
    domain: index % 2 ? 'www.workbuddy.ai' : 'www.codebuddy.cn', enabled: true };
  return { ...account, accountKey: workbuddyAccountKey(account) };
});

test('WorkBuddy bounds mixed managed/local credential and quota work to four accounts', async () => {
  const managed = accounts(8);
  const locals = accounts(11).slice(8).map((account) => ({ ...account, authenticated: true }));
  let active = 0;
  let peak = 0;
  const operation = async (result) => {
    active += 1;
    peak = Math.max(peak, active);
    try { await turn(); return result; } finally { active -= 1; }
  };
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed,
    workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: locals }, { env: {},
    resolveWorkbuddyManagedCredential: async () => operation({ accessToken: 'fixture' }),
    fetch: async () => operation(quota()), workbuddyFetch: async () => operation(quota()) });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(rows.map((row) => row.accountKey), [...managed, ...locals].map((account) => account.accountKey));
  assert.ok(rows.every((row) => row.status === 'ok'));
});

test('WorkBuddy keeps unauthorized billing, refresh and retry within the same four account slots', async () => {
  const managed = accounts(9);
  let active = 0;
  let peak = 0;
  const refreshed = [];
  const operation = async (result) => {
    active += 1;
    peak = Math.max(peak, active);
    try { await turn(); return result; } finally { active -= 1; }
  };
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {},
    resolveWorkbuddyManagedCredential: async (account, { forceRefresh }) => {
      if (forceRefresh) refreshed.push(account.id);
      return operation({ accessToken: `${account.id}:${forceRefresh ? 'new' : 'old'}` });
    }, fetch: async (_, init) => operation(init.headers.Authorization.endsWith(':old')
      ? { ok: false, status: 401, json: async () => ({}) } : quota()) });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(new Set(refreshed).size, managed.length);
  assert.deepEqual(rows.map((row) => row.accountKey), managed.map((account) => account.accountKey));
  assert.ok(rows.every((row) => row.status === 'ok'));
});

for (const phase of ['credential', 'quota']) {
  test(`WorkBuddy cancellation during ${phase} skips queued operations but returns every identity`, async () => {
    const managed = accounts(10);
    const locals = accounts(13).slice(10).map((account) => ({ ...account, authenticated: true }));
    const controller = new AbortController();
    const calls = [];
    const signals = [];
    let localCalls = 0;
    const pending = fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed,
      workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: locals }, { env: {}, signal: controller.signal,
      resolveWorkbuddyManagedCredential: async (account, { signal }) => {
        calls.push(account.id);
        if (phase === 'credential') { signals.push(signal); return new Promise(() => {}); }
        return { accessToken: account.id };
      }, fetch: async (_, init) => { signals.push(init.signal); return new Promise(() => {}); },
      workbuddyFetch: async () => { localCalls += 1; return quota(); } });
    await turn();
    controller.abort();
    const rows = await pending;
    assert.equal(calls.length, 4);
    assert.equal(signals.length, 4);
    assert.equal(localCalls, 0);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.deepEqual(rows.map((row) => row.accountKey), [...managed, ...locals].map((account) => account.accountKey));
    assert.ok(rows.every((row) => row.status === 'unavailable'));
  });
}

test('WorkBuddy already-canceled batches do not resolve credentials or send quota requests', async () => {
  const managed = accounts(9);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {}, signal: controller.signal,
    resolveWorkbuddyManagedCredential: async () => { calls += 1; }, fetch: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(rows.length, managed.length);
  assert.ok(rows.every((row) => row.status === 'unavailable'));
});

test('WorkBuddy isolates credential and billing failures without dropping or reordering queued accounts', async () => {
  const managed = accounts(13);
  const resolved = [];
  const rows = await fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {},
    resolveWorkbuddyManagedCredential: async (account) => {
      resolved.push(account.id);
      await turn();
      if (account.id === 'user-1') throw Object.assign(new Error('fixture'), { status: 'notConfigured' });
      if (account.id === 'user-5') throw new Error('fixture');
      return { accessToken: account.id };
    }, fetch: async (_, init) => {
      await turn();
      return init.headers.Authorization === 'Bearer user-8'
        ? { ok: false, status: 429, json: async () => ({}) } : quota();
    } });
  assert.equal(new Set(resolved).size, managed.length);
  assert.deepEqual(rows.map((row) => row.accountKey), managed.map((account) => account.accountKey));
  assert.deepEqual(rows.map((row) => row.status), managed.map((_, index) =>
    index === 1 ? 'notConfigured' : index === 5 ? 'unavailable' : index === 8 ? 'sourceRateLimited' : 'ok'));
});

test('WorkBuddy shares the provider budget across waves so stalled first accounts cannot starve later ones', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const managed = accounts(12);
  const budgetMs = providerPhysicalBoundMs('workbuddy');
  const controller = new AbortController();
  const resolved = [];
  const firstSignals = [];
  const pending = fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {}, signal: controller.signal,
    workbuddyFetchTimeoutMs: budgetMs * 2,
    resolveWorkbuddyManagedCredential: async (account, { signal }) => {
      resolved.push(account.id);
      if (Number(account.id.slice(5)) < 4) { firstSignals.push(signal); return new Promise(() => {}); }
      return { accessToken: account.id };
    }, fetch: async (_, init) => {
      if (init.headers.Authorization === 'Bearer user-11') {
        await new Promise((resolve) => setTimeout(resolve, budgetMs / 3 - 1));
      }
      return quota();
    } });
  try {
    await turn();
    assert.equal(resolved.length, 4);
    t.mock.timers.tick(budgetMs / 3);
    await turn();
    assert.ok(firstSignals.every((signal) => signal.aborted));
    assert.equal(resolved.length, managed.length);
    t.mock.timers.tick(budgetMs / 3 - 1);
    await turn();
    const rows = await pending;
    assert.equal(Date.now(), budgetMs * 2 / 3 - 1);
    assert.deepEqual(rows.map((row) => row.status), [...Array(4).fill('unavailable'), ...Array(8).fill('ok')]);
  } finally { controller.abort(); await pending; }
});

test('WorkBuddy account budgets cover resolve, unauthorized quota, refresh and retry together', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const managed = accounts(8);
  const controller = new AbortController();
  const resolved = [];
  const refreshed = [];
  const pending = fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {}, signal: controller.signal,
    providerPhysicalBounds: { workbuddy: 120 }, workbuddyFetchTimeoutMs: 1000,
    resolveWorkbuddyManagedCredential: async (account, { forceRefresh }) => {
      if (forceRefresh) refreshed.push(account.id);
      else resolved.push(account.id);
      if (Number(account.id.slice(5)) < 4) await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: `${account.id}:${forceRefresh ? 'new' : 'old'}` };
    }, fetch: async (_, init) => {
      const token = init.headers.Authorization;
      if (/user-[0-3]:/.test(token)) await new Promise((resolve) => setTimeout(resolve, 20));
      return token.endsWith(':old') && /user-[0-3]:/.test(token)
        ? { ok: false, status: 401, json: async () => ({}) } : quota();
    } });
  try {
    await turn();
    assert.equal(resolved.length, 4);
    for (let tick = 0; tick < 3; tick += 1) { t.mock.timers.tick(20); await turn(); }
    assert.equal(refreshed.length, 4);
    assert.equal(resolved.length, managed.length);
    const rows = await pending;
    assert.equal(Date.now(), 60);
    assert.deepEqual(rows.map((row) => row.status), [...Array(4).fill('unavailable'), ...Array(4).fill('ok')]);
  } finally { controller.abort(); await pending; }
});

test('WorkBuddy exhausted provider budgets skip queued work and reject late credential results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(performance, 'now', () => Date.now());
  const managed = accounts(12);
  const calls = [];
  let requests = 0;
  let finishCredentials;
  const credentials = new Promise((resolve) => { finishCredentials = resolve; });
  const pending = fetchWorkbuddyLimits({ workbuddyManagedAccounts: managed }, { env: {},
    providerPhysicalBounds: { workbuddy: 120 }, workbuddyFetchTimeoutMs: 1000,
    resolveWorkbuddyManagedCredential: async (account) => { calls.push(account.id); return credentials; },
    fetch: async () => { requests += 1; return quota(); } });
  await turn();
  t.mock.timers.tick(120);
  await turn();
  finishCredentials({ accessToken: 'late' });
  await turn();
  const rows = await pending;
  assert.equal(calls.length, 4);
  assert.equal(requests, 0);
  assert.deepEqual(rows.map((row) => row.accountKey), managed.map((account) => account.accountKey));
  assert.ok(rows.every((row) => row.status === 'unavailable'));
});
