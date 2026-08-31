'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchAntigravityLimits } = require('../../src/shared/limitCollector');

test('fetchAntigravityLimits returns notConfigured when probe says LS not running', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => {
      const err = new Error('not running');
      err.status = 'notConfigured';
      throw err;
    }
  });
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'notConfigured');
  assert.equal(result.windows.length, 0);
});

test('fetchAntigravityLimits maps quota summary to two session and weekly groups', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => ({
      accountPlan: 'Google AI Pro',
      accountEmail: 'a@b.com',
      sourceDetail: 'app',
      windows: [
        { name: 'Gemini 5-hour', kind: 'session', remainingFraction: 0.65, resetTime: '2026-06-03T02:00:00Z', resetDescription: 'Refreshes soon.' },
        { name: 'Gemini weekly', kind: 'weekly', remainingFraction: 0.92, resetTime: '2026-06-09T02:00:00Z' },
        { name: 'Claude/GPT 5-hour', kind: 'session', remainingFraction: 1, resetTime: '2026-06-03T04:00:00Z' },
        { name: 'Claude/GPT weekly', kind: 'weekly', remainingFraction: 1, resetTime: '2026-06-09T04:00:00Z' }
      ]
    })
  });

  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'rpc');
  assert.equal(result.sourceDetail, 'app');
  assert.equal(result.accountLabel, 'Pro');
  assert.equal(result.accountEmail, 'a@b.com');
  assert.deepEqual(result.windows.map((window) => [window.label, window.kind, window.windowMinutes]), [
    ['Gemini 5-hour', 'session', 300],
    ['Gemini weekly', 'weekly', 10_080],
    ['Claude/GPT 5-hour', 'session', 300],
    ['Claude/GPT weekly', 'weekly', 10_080]
  ]);
  assert.deepEqual(result.windows.map((window) => window.remainingPercent), [65, 92, 100, 100]);
  assert.equal(result.windows[0].resetDescription, 'Refreshes soon.');
});

test('fetchAntigravityLimits preserves Antigravity IDE source detail', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => ({
      accountPlan: 'Google AI Pro',
      sourceDetail: 'ide',
      windows: [
        { name: 'Gemini weekly', kind: 'weekly', remainingFraction: 0.8 }
      ]
    })
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.sourceDetail, 'ide');
});

test('fetchAntigravityLimits does not invent session windows for Starter accounts', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => ({
      accountPlan: 'Antigravity Starter Quota',
      accountEmail: 'free@example.com',
      windows: [
        { name: 'Gemini weekly', kind: 'weekly', remainingFraction: 1 },
        { name: 'Claude/GPT weekly', kind: 'weekly', remainingFraction: 1 }
      ]
    })
  });

  assert.equal(result.accountLabel, 'Antigravity Starter Quota');
  assert.deepEqual(result.windows.map((window) => [window.label, window.kind]), [
    ['Gemini weekly', 'weekly'],
    ['Claude/GPT weekly', 'weekly']
  ]);
});

test('fetchAntigravityLimits preserves legacy 3-pool fallback as weekly windows', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => ({
      accountPlan: 'Pro',
      accountEmail: 'a@b.com',
      pools: [
        { name: 'Gemini Pro',   remainingFraction: 0.5, resetTime: '2026-06-03T02:00:00Z' },
        { name: 'Gemini Flash', remainingFraction: 0.9, resetTime: '2026-06-03T01:00:00Z' },
        { name: 'Claude',       remainingFraction: 0.7, resetTime: '2026-06-03T04:00:00Z' }
      ]
    })
  });
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'rpc');
  assert.equal(result.accountLabel, 'Pro');
  assert.deepEqual(result.windows.map((w) => w.label), ['Gemini Pro', 'Gemini Flash', 'Claude']);
  for (const window of result.windows) {
    assert.equal(window.kind, 'weekly');
    assert.equal(window.windowMinutes, null);
  }
  assert.equal(Math.round(result.windows[0].usedPercent), 50);
  assert.equal(Math.round(result.windows[1].usedPercent), 10);
  assert.equal(Math.round(result.windows[2].usedPercent), 30);
});

test('fetchAntigravityLimits maps unauthorized errors', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => {
      const err = new Error('401');
      err.status = 'unauthorized';
      throw err;
    }
  });
  assert.equal(result.status, 'unauthorized');
});

test('fetchAntigravityLimits refreshes all enabled OAuth accounts and keeps per-account errors', async () => {
  const accounts = [
    {
      id: 'one',
      accountEmail: 'one@example.com',
      enabled: true,
      credentials: {
        accessToken: 'token-one',
        refreshToken: 'refresh-one',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-one'
      }
    },
    {
      id: 'two',
      accountEmail: 'two@example.com',
      enabled: true,
      credentials: {
        accessToken: 'token-two',
        refreshToken: 'refresh-two',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-two'
      }
    },
    {
      id: 'disabled',
      accountEmail: 'disabled@example.com',
      enabled: false,
      credentials: { accessToken: 'never-used' }
    }
  ];
  const requestedTokens = [];
  const result = await fetchAntigravityLimits({ antigravityManagedAccounts: accounts }, {
    antigravityProbe: async () => {
      const error = new Error('not running');
      error.status = 'notConfigured';
      throw error;
    },
    fetch: async (url, init) => {
      const token = init.headers.authorization.replace('Bearer ', '');
      requestedTokens.push(token);
      if (token === 'token-two') return { ok: false, status: 401, json: async () => ({ error: 'expired' }) };
      if (url.endsWith(':loadCodeAssist')) {
        return { ok: true, status: 200, json: async () => ({ currentTier: { id: 'standard-tier' } }) };
      }
      if (url.endsWith(':fetchAvailableModels')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: {
              'gemini-2.5-pro': {
                displayName: 'Gemini Pro',
                quotaInfo: { remainingFraction: 0.6, resetTime: '2026-09-01T00:00:00Z' }
              }
            }
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((provider) => [provider.accountEmail, provider.status, provider.source]), [
    ['one@example.com', 'ok', 'oauth'],
    ['two@example.com', 'unauthorized', 'oauth']
  ]);
  assert.equal(requestedTokens.includes('never-used'), false);
  assert.equal(result[0].windows[0].label, 'Gemini Pro');
  assert.equal(result[0].windows[0].remainingPercent, 60);
});

test('fetchAntigravityLimits replaces the matching OAuth account with the live RPC snapshot', async () => {
  const result = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'same-account',
      accountEmail: 'Same@Example.com',
      enabled: true,
      credentials: {
        accessToken: 'token-same',
        refreshToken: 'refresh-same',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-same'
      }
    }]
  }, {
    antigravityProbe: async () => ({
      accountPlan: 'Google AI Pro',
      accountEmail: 'same@example.com',
      sourceDetail: 'app',
      windows: [
        { name: 'Gemini weekly', kind: 'weekly', remainingFraction: 0.73 }
      ]
    }),
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return { ok: true, status: 200, json: async () => ({ currentTier: { id: 'standard-tier' } }) };
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{
              displayName: 'Gemini Models',
              buckets: [{ displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.41 }]
            }]
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].accountEmail, 'same@example.com');
  assert.equal(result[0].source, 'rpc');
  assert.equal(result[0].sourceDetail, 'app');
  assert.equal(result[0].windows[0].remainingPercent, 73);
});

test('fetchAntigravityLimits keeps the OAuth plan when quota data is unavailable', async () => {
  const result = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'one',
      accountEmail: 'one@example.com',
      accountKey: 'account-key',
      enabled: true,
      credentials: {
        accessToken: 'token-one',
        refreshToken: 'refresh-one',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-one'
      }
    }]
  }, {
    antigravityProbe: async () => {
      const error = new Error('not running');
      error.status = 'notConfigured';
      throw error;
    },
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return { ok: true, status: 200, json: async () => ({ currentTier: { id: 'standard-tier' } }) };
      }
      if (url.endsWith(':fetchAvailableModels') || url.endsWith(':retrieveUserQuota')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { message: 'The caller does not have permission' } })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].accountEmail, 'one@example.com');
  assert.equal(result[0].accountLabel, 'Paid');
  assert.equal(result[0].status, 'unavailable');
  assert.deepEqual(result[0].windows, []);
});
