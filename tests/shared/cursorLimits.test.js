'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchCursorLimits } = require('../../src/shared/limitCollector');

test('fetchCursorLimits returns notConfigured when no active account', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => null
  });
  assert.equal(result.provider, 'cursor');
  assert.equal(result.status, 'notConfigured');
  assert.equal(result.windows.length, 0);
});

test('fetchCursorLimits returns unauthorized when probe says so', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'a1', sessionToken: 't', userId: 'u1' }),
    probe: async () => ({ ok: false, error: { kind: 'unauthorized', message: 'HTTP 401' } })
  });
  assert.equal(result.status, 'unauthorized');
});

test('fetchCursorLimits returns ok with Cursor billing dimensions when probe succeeds', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: 't', userId: 'u1' }),
    probe: async () => ({
      ok: true,
      usage: {
        planPercent: 42, autoPercent: 20, apiPercent: 64,
        planUsedUsd: 8.4, planLimitUsd: 20, onDemandUsedUsd: 0, onDemandLimitUsd: 50,
        requestsUsed: 7, requestsLimit: 10,
        billingCycleEnd: '2026-06-01T00:00:00Z', membershipType: 'pro'
      },
      user: { email: 'a@b.com', name: 'Alice', sub: 'u1' }
    })
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'cursor');
  assert.equal(result.source, 'web');
  assert.deepEqual(result.windows.map((window) => window.label), ['Total', 'Auto', 'API', 'Credits']);
  assert.equal(result.windows[0].kind, 'billing');
  assert.equal(result.windows[0].usedPercent, 70);
  assert.equal(result.windows[0].used, 7);
  assert.equal(result.windows[0].limit, 10);
  assert.equal(result.windows[0].resetsAt, '2026-06-01T00:00:00.000Z');
  assert.equal(result.windows[1].usedPercent, 20);
  assert.equal(result.windows[2].usedPercent, 64);
  assert.equal(result.windows[3].usedPercent, 0);
  assert.equal(result.windows[3].showMeter, false);
  assert.equal(result.windows[3].remaining, 50);
  assert.equal(result.windows[3].resetDescription, '');
});

test('fetchCursorLimits prefers account identity over the plan for the account label', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: 't', userId: 'u1' }),
    probe: async () => ({
      ok: true,
      usage: { planPercent: 10, membershipType: 'pro_student' },
      user: { email: 'a@b.com', name: 'Alice', sub: 'u1' }
    })
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.accountLabel, 'a@b.com');
});

test('fetchCursorLimits probes every saved account and uses API email labels', async () => {
  const calls = [];
  const result = await fetchCursorLimits({}, {
    listAccounts: () => [
      { id: 'b', sessionToken: 'tok-b', userId: 'user-b', label: 'work' },
      { id: 'a', sessionToken: 'tok-a', userId: 'user-a', label: 'personal' }
    ],
    probe: async (token) => {
      calls.push(token);
      return {
        ok: true,
        usage: { planPercent: token === 'tok-b' ? 20 : 40, membershipType: 'pro' },
        user: { email: `${token}@example.com`, sub: token }
      };
    }
  });
  assert.deepEqual(calls, ['tok-b', 'tok-a']);
  assert.deepEqual(result.map((provider) => provider.accountLabel), ['tok-b@example.com', 'tok-a@example.com']);
  assert.deepEqual(result.map((provider) => provider.accountEmail), ['tok-b@example.com', 'tok-a@example.com']);
  assert.deepEqual(result.map((provider) => provider.planLabel), ['Pro', 'Pro']);
  assert.equal(new Set(result.map((provider) => provider.accountKey)).size, 2);
});

test('fetchCursorLimits keys the same Cursor API subject identically across different local stores', async () => {
  const probe = async () => ({
    ok: true,
    usage: { planPercent: 10, membershipType: 'free' },
    user: { email: 'same@example.com', sub: 'user_canonical' }
  });
  const first = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'anon-local-a', sessionToken: 'token-a', userId: null }),
    probe
  });
  const second = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'anon-local-b', sessionToken: 'token-b', userId: null }),
    probe
  });

  assert.equal(first.accountKey, second.accountKey);
  assert.equal(first.accountEmail, 'same@example.com');
});

test('fetchCursorLimits keeps prefixed API subjects stable across a failed probe fallback', async () => {
  const account = { id: 'user_canonical', sessionToken: 'token', userId: 'user_canonical' };
  const success = await fetchCursorLimits({}, {
    readActiveAccount: () => account,
    probe: async () => ({
      ok: true,
      usage: { planPercent: 10, membershipType: 'free' },
      user: { email: 'same@example.com', sub: 'auth0|user_canonical' }
    })
  });
  const unauthorized = await fetchCursorLimits({}, {
    readActiveAccount: () => account,
    probe: async () => ({ ok: false, error: { kind: 'unauthorized', message: 'HTTP 401' } })
  });

  assert.equal(success.accountKey, unauthorized.accountKey);
});

test('fetchCursorLimits keeps opaque local fallback identities distinct when no canonical user id is available', async () => {
  const result = await fetchCursorLimits({}, {
    listAccounts: () => [
      { id: 'anon-local-a', sessionToken: 'token-a', userId: null },
      { id: 'anon-local-b', sessionToken: 'token-b', userId: null }
    ],
    probe: async () => ({ ok: false, error: { kind: 'unauthorized', message: 'HTTP 401' } })
  });

  assert.equal(result.length, 2);
  assert.equal(new Set(result.map((provider) => provider.accountKey)).size, 2);
});

test('fetchCursorLimits probes only enabled Cursor accounts', async () => {
  const calls = [];
  const deps = {
    listAccounts: () => [
      { id: 'work', sessionToken: 'tok-work', userId: 'user-work' },
      { id: 'personal', sessionToken: 'tok-personal', userId: 'user-personal' }
    ],
    probe: async (token) => {
      calls.push(token);
      return {
        ok: true,
        usage: { planPercent: 10, membershipType: 'pro' },
        user: { email: `${token}@example.com`, sub: token }
      };
    }
  };

  const result = await fetchCursorLimits({ cursorDisabledAccountIds: ['work'] }, deps);
  assert.deepEqual(calls, ['tok-personal']);
  assert.equal(result.accountLabel, 'tok-personal@example.com');

  calls.length = 0;
  const disabled = await fetchCursorLimits({ cursorDisabledAccountIds: ['work', 'personal'] }, deps);
  assert.equal(disabled.status, 'notConfigured');
  assert.deepEqual(calls, []);
});

test('fetchCursorLimits includes team pool when Cursor reports pooled usage', async () => {
  const result = await fetchCursorLimits({}, {
    readActiveAccount: () => ({ id: 'acct-1', sessionToken: 't', userId: 'u1' }),
    probe: async () => ({
      ok: true,
      usage: {
        planPercent: 73.84,
        planUsedUsd: 73.84,
        planLimitUsd: 100,
        planRemainingUsd: 26.16,
        teamPooledPercent: 45.25,
        teamPooledUsedUsd: 127251.35,
        teamPooledLimitUsd: 281220,
        teamPooledRemainingUsd: 153968.65,
        billingCycleEnd: '2026-06-01T00:00:00Z',
        membershipType: 'enterprise',
        hasTeamPooledUsage: true
      },
      user: { email: 'a@b.com', name: 'Alice', sub: 'u1' }
    })
  });

  const pool = result.windows.find((window) => window.label === 'Team pool');
  assert.ok(pool);
  assert.equal(pool.kind, 'billing');
  assert.equal(pool.usedPercent, 45.25);
  assert.equal(pool.used, 127251.35);
  assert.equal(pool.limit, 281220);
  assert.equal(pool.remaining, 153968.65);
});
