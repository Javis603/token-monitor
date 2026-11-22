'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchAntigravityLimits } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { _quotaSummaryWindows } = require('../../src/shared/providers/antigravity/probe');
const { daily: quotaSummary } = require('../fixtures/antigravityQuotaSummaryArgon.json');

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

test('Antigravity keeps quota failures scoped across endpoint fallbacks and the probe deadline', async (t) => {
  let appStatus = 200;
  let cliStatus = null;
  let cliDiscoveryHangs = false;
  let nowMs = Date.now();
  const probeTimeoutMs = 1000;
  const deps = {
    probeTimeoutMs,
    detectProcessInfos: async () => [
      { pid: 1, kind: 'app', csrfToken: 'app-fixture', desktopRpcPort: 54733 },
      ...(cliStatus === null ? [] : [{
        pid: 2, kind: 'cli', csrfToken: 'cli-fixture', hubPort: cliDiscoveryHangs ? null : 54734
      }])
    ],
    listeningPorts: async (pid) => {
      if (pid === 1) return [54733];
      if (cliDiscoveryHangs) {
        t.mock.timers.tick(probeTimeoutMs);
        return new Promise(() => {});
      }
      return [54735];
    },
    callLs: async ({ method, port, scheme }) => {
      if (scheme === 'https') throw new Error('HTTP-only listener');
      if (method === 'GetUnleashData') return {};
      const status = port === 54733 ? appStatus : port === 54734 ? cliStatus : 503;
      if (method === 'RetrieveUserQuotaSummary') {
        if (status !== 200) throw Object.assign(new Error(`RPC ${status}`), {
          status: status === 401 ? 'unauthorized' : 'unavailable', httpStatus: status
        });
        return { groups: [{ displayName: 'Gemini Models', buckets: [
          { window: 'session', remainingFraction: 0.7 },
          { window: 'weekly', remainingFraction: 0.9 }
        ] }] };
      }
      return { userStatus: { email: port === 54733 ? 'app@example.com' : 'cli@example.com' } };
    }
  };
  const runtime = createLimitsRuntime({ limitProviders: ['antigravity'] }, {
    ...deps,
    now: () => nowMs,
    autoStart: false,
    autoRetry: false
  });
  async function refresh(reason = 'manual') {
    nowMs += 60_000;
    await runtime.refresh({ provider: 'antigravity' }, reason);
    return runtime.getSnapshot().providers;
  }
  try {
    const [first] = await refresh('startup');
    assert.equal(first.status, 'ok');
    assert.deepEqual(first.windows.map(window => window.windowMinutes), [300, 10_080]);
    const assertRetainedDesktop = (rows) => {
      const app = rows.find(row => row.accountKey === first.accountKey);
      assert.equal(app?.status, 'unavailable');
      assert.equal(app.updatedAt, first.updatedAt);
      assert.deepEqual(app.windows, first.windows);
    };

    appStatus = 503;
    assertRetainedDesktop(await refresh());

    cliStatus = 200;
    const cliReading = (await refresh()).find(row => row.sourceDetail === 'cli');
    assert.equal(cliReading?.status, 'ok');
    cliStatus = 401;
    const rows = await refresh();
    assertRetainedDesktop(rows);
    const cli = rows.find(row => row.accountKey === cliReading.accountKey);
    assert.equal(cli?.status, 'unauthorized');
    assert.deepEqual(cli.windows, []);

    appStatus = 401;
    cliDiscoveryHangs = true;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const desktopAfterTimeout = (await refresh()).find(row => row.accountKey === first.accountKey);
    assert.equal(desktopAfterTimeout?.status, 'unauthorized');
    assert.deepEqual(desktopAfterTimeout.windows, []);
  } finally {
    runtime.stop();
  }
});

test('Antigravity clears quota only for the account observed on the rejected RPC process', async () => {
  const processFor = (pid) => ({ pid, kind: 'app', csrfToken: `fixture-${pid}`, desktopRpcPort: 54732 + pid });
  let processes = [processFor(1)];
  let statusByPort = new Map();
  let nowMs = Date.now();
  const runtime = createLimitsRuntime({ limitProviders: ['antigravity'] }, {
    autoStart: false, autoRetry: false, now: () => nowMs,
    detectProcessInfos: async () => processes,
    listeningPorts: async processId => [54732 + processId],
    callLs: async ({ method, port }) => {
      if (method === 'GetUnleashData') return {};
      if (method === 'GetUserStatus') return { userStatus: { email: `app-${port}@example.com` } };
      const status = statusByPort.get(port) ?? 200;
      if (status !== 200) {
        throw Object.assign(new Error(`RPC ${status}`), {
          status: status === 401 ? 'unauthorized' : 'unavailable',
          httpStatus: status
        });
      }
      return { groups: quotaSummary.groups };
    }
  });
  async function refresh() {
    nowMs += 60_000;
    await runtime.refresh({ provider: 'antigravity' }, 'manual');
    return runtime.getSnapshot().providers;
  }
  try {
    const [first] = await refresh();
    assert.equal(first.status, 'ok');

    // A process without a known binding rejects authentication: keep the reading.
    processes = [processFor(2)];
    statusByPort = new Map([[54734, 401]]);
    const [retained] = await refresh();
    assert.equal(retained.status, 'unavailable');
    assert.deepEqual(retained.windows, first.windows);

    statusByPort = new Map();
    const second = (await refresh()).find(row => row.status === 'ok');
    assert.notEqual(second.accountKey, first.accountKey);

    // Both processes answer: each rejection stays on the account it replaces.
    processes = [processFor(1), processFor(2)];
    statusByPort = new Map([[54733, 401], [54734, 503]]);
    const rows = await refresh();
    const rejected = rows.find(row => row.accountKey === first.accountKey);
    assert.equal(rejected?.status, 'unauthorized');
    assert.deepEqual(rejected.windows, []);
    const unavailable = rows.find(row => row.accountKey === second.accountKey);
    assert.equal(unavailable?.status, 'unavailable');
    assert.deepEqual(unavailable.windows, second.windows);

  } finally {
    runtime.stop();
  }
});

test('Antigravity commits RPC source bindings only for accepted readings', { timeout: 5000 }, async (t) => {
  let nowMs = Date.now();
  let sourceKey = 'A';
  let failures;
  const accountEmail = 'same@example.com';
  const accounts = [{ id: 'managed', accountEmail, credentials: { accessToken: 'fixture', projectId: 'fixture-project' } }];
  const oauthQuota = { groups: quotaSummary.groups.filter(group => group.displayName === 'Gemini 4 Argon') };
  const oauthStarted = Promise.withResolvers();
  const runtime = createLimitsRuntime({ limitProviders: ['antigravity'] }, {
    autoStart: false, autoRetry: false, now: () => nowMs,
    resolveConfigSnapshot: () => ({ antigravityManagedAccounts: failures ? [] : accounts }),
    fetch: async (url, { signal }) => {
      signal.throwIfAborted();
      if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({}) };
      if (!url.endsWith(':retrieveUserQuotaSummary')) throw new Error(`Unexpected URL ${url}`);
      if (sourceKey === 'B') {
        oauthStarted.resolve();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { ok: true, json: async () => oauthQuota };
    },
    antigravityProbe: async () => {
      if (failures) {
        const sourceFailures = new Map(failures.map(([key, status]) => [key, { source: 'app', error: { status } }]));
        throw Object.assign(new Error('RPC sources failed'), { sourceFailures });
      }
      return {
        accountEmail, sourceDetail: 'app', sourceKey,
        windows: [{ name: 'Gemini 5-hour', kind: 'session', remainingFraction: 0.72 }]
      };
    }
  });
  t.after(() => runtime.stop());
  const refresh = () => runtime.refresh({ provider: 'antigravity' }, 'credential-edit');
  const reading = () => runtime.getSnapshot().providers[0];

  await refresh();
  const first = reading();
  assert.equal(first.windows.length, 2);

  sourceKey = 'B';
  nowMs += 60_000;
  const superseded = refresh();
  await oauthStarted.promise;

  failures = [['A', 'unavailable'], ['B', 'unauthorized']];
  const next = refresh();
  assert.equal((await superseded).superseded, true);
  await next;
  assert.equal(reading().status, 'unavailable');
  assert.equal(reading().updatedAt, first.updatedAt);
  assert.deepEqual(reading().windows, first.windows);

  failures = [['A', 'unauthorized'], ['B', 'unavailable']];
  await refresh();
  assert.equal(reading().status, 'unauthorized');
  assert.deepEqual(reading().windows, []);
});

test('Antigravity keeps the previous account read when a process switches accounts', async () => {
  let suffix = '';
  let rpcStatus = 200;
  let nowMs = Date.now();
  const runtime = createLimitsRuntime({ limitProviders: ['antigravity'] }, {
    autoStart: false, autoRetry: false, now: () => nowMs,
    detectProcessInfos: async () => [{ pid: 2, kind: 'app', csrfToken: 'fixture', desktopRpcPort: 54734 }],
    listeningPorts: async () => [54734],
    callLs: async ({ method, port }) => {
      if (method === 'GetUnleashData') return {};
      if (method === 'GetUserStatus') return { userStatus: { email: `app-${port}${suffix}@example.com` } };
      if (rpcStatus !== 200) throw Object.assign(new Error('RPC 401'), { status: 'unauthorized', httpStatus: 401 });
      return { groups: quotaSummary.groups };
    }
  });
  async function refresh() {
    nowMs += 60_000;
    await runtime.refresh({ provider: 'antigravity' }, 'manual');
    return runtime.getSnapshot().providers;
  }
  try {
    const [first] = await refresh();
    assert.equal(first.status, 'ok');

    // The same process signs into another account.
    suffix = '-b';
    const second = (await refresh()).find(row => row.status === 'ok');
    assert.notEqual(second.accountKey, first.accountKey);

    // A rejection belongs to the account the process serves now, not the previous one.
    rpcStatus = 401;
    const rows = await refresh();
    const previous = rows.find(row => row.accountKey === first.accountKey);
    assert.equal(previous?.status, 'unavailable');
    assert.deepEqual(previous.windows, first.windows);
    const switched = rows.find(row => row.accountKey === second.accountKey);
    assert.equal(switched?.status, 'unauthorized');
    assert.deepEqual(switched.windows, []);
  } finally {
    runtime.stop();
  }
});

test('Antigravity keeps new service-named quota groups and their periods together through normalization', async () => {
  const buckets = [
    { window: 'weekly', remainingFraction: 0.6 },
    { window: 'session', remainingFraction: 0.4 },
    { window: 'daily', remainingFraction: 0.8 }
  ];
  const result = await fetchAntigravityLimits({}, {
    detectProcessInfo: async () => ({ pid: 1, csrfToken: 'test-token' }),
    listeningPorts: async () => [54733],
    callLs: async ({ method }) => method === 'RetrieveUserQuotaSummary' ? {
      groups: [
        { displayName: 'Gemini 5 Ultra', buckets },
        ...quotaSummary.groups
      ]
    } : {}
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map(window => window.label), [
    'Gemini 5-hour', 'Gemini weekly',
    'Gemini 4 Argon weekly',
    'Claude/GPT 5-hour', 'Claude/GPT weekly',
    'Gemini 5 Ultra 5-hour', 'Gemini 5 Ultra weekly'
  ]);
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

test('fetchAntigravityLimits keeps managed accounts with missing credentials actionable', async () => {
  const result = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'missing-credential',
      accountEmail: 'missing@example.com',
      enabled: true,
      credentials: null
    }]
  }, {
    antigravityProbe: async () => {
      const error = new Error('not running');
      error.status = 'notConfigured';
      throw error;
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].accountEmail, 'missing@example.com');
  assert.equal(result[0].status, 'unauthorized');
});

test('fetchAntigravityLimits marks Google verification as an actionable account state', async () => {
  const result = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'verify-account',
      accountEmail: 'verify@example.com',
      enabled: true,
      credentials: {
        accessToken: 'access',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-1'
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
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'To continue, verify your account at https://accounts.google.com/signin/continue?token=private'
            }
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'unauthorized');
  assert.equal(result[0].actionRequired, 'accountVerification');
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

test('fetchAntigravityLimits does not replace healthy OAuth quota when local RPC returns empty windows', async () => {
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
    // An empty local snapshot must leave the usable OAuth quota in place.
    antigravityProbe: async () => ({
      accountPlan: 'Google AI Pro',
      accountEmail: 'same@example.com',
      sourceDetail: 'app',
      windows: []
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
  assert.equal(result[0].source, 'oauth');
  assert.equal(result[0].status, 'ok');
  assert.equal(result[0].windows[0].remainingPercent, 41);
});

test('fetchAntigravityLimits replaces grouped OAuth quota with a healthier grouped RPC snapshot', async () => {
  // When both local RPC and OAuth return grouped windows, the live local result
  // (localIsHealthy && localHasGrouped) should win — it is more real-time.
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
        { name: 'Session', kind: 'session', remainingFraction: 0.55 },
        { name: 'Weekly', kind: 'weekly', remainingFraction: 0.80 }
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
              buckets: [
                { displayName: '5-Hour Limit', window: 'session', remainingFraction: 0.30 },
                { displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.60 }
              ]
            }]
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].accountEmail, 'same@example.com');
  // Local RPC wins because it is healthy and also has grouped windows.
  assert.equal(result[0].source, 'rpc');
  assert.equal(result[0].windows.some((w) => w.windowMinutes === 300), true);
  assert.equal(result[0].windows[0].remainingPercent, 55); // remainingFraction: 0.55 → remainingPercent: 55
});

test('fetchAntigravityLimits unshifts local RPC when account does not match managed OAuth accounts', async () => {
  const result = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'oauth-account',
      accountEmail: 'oauth@example.com',
      enabled: true,
      credentials: {
        accessToken: 'token-oauth',
        refreshToken: 'refresh-oauth',
        expiresAt: Date.now() + 3600_000,
        clientId: 'client',
        clientSecret: 'secret',
        projectId: 'project-oauth'
      }
    }]
  }, {
    antigravityProbe: async () => ({
      accountPlan: 'Google AI Pro',
      accountEmail: 'local@example.com',
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

  assert.equal(result.length, 2);
  assert.equal(result[0].accountEmail, 'local@example.com');
  assert.equal(result[0].source, 'rpc');
  assert.equal(result[1].accountEmail, 'oauth@example.com');
  assert.equal(result[1].source, 'oauth');
});

test('fetchAntigravityLimits returns unauthorized when probe throws unauthorized status', async () => {
  const result = await fetchAntigravityLimits({}, {
    antigravityProbe: async () => {
      const err = new Error('missing CSRF token');
      err.status = 'unauthorized';
      throw err;
    }
  });
  assert.equal(result.provider, 'antigravity');
  assert.equal(result.status, 'unauthorized');
  assert.equal(result.windows.length, 0);
});

test('fetchAntigravityLimits keeps OAuth-only groups when service names share a long prefix', async () => {
  const group = (suffix, remainingFraction) => ({
    displayName: `Claude 5 Experimental Models ${suffix}`,
    buckets: [{ window: 'session', remainingFraction }]
  });
  const localGroup = group('Alpha', 0.28);
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
        { name: 'Gemini 5-hour', kind: 'session', remainingFraction: 0.90 },
        { name: 'Gemini weekly', kind: 'weekly', remainingFraction: 0.95 },
        { name: 'Claude/GPT 5-hour', kind: 'session', remainingFraction: null, showMeter: false },
        { name: 'Claude/GPT weekly', kind: 'weekly', remainingFraction: 0 },
        ..._quotaSummaryWindows({ groups: [localGroup] })
      ]
    }),
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return { ok: true, status: 200, json: async () => ({ paidTier: { id: 'g1-pro-tier' } }) };
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.80 },
                  { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.85 }
                ]
              },
              {
                displayName: 'Claude and GPT models',
                buckets: [
                  { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, disabled: true },
                  { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0 }
                ]
              },
              {
                displayName: 'Gemini 4 Argon',
                buckets: [
                  {
                    bucketId: 'gemini-argon-wtu-weekly',
                    displayName: 'Gemini 4 Argon Weekly Limit',
                    window: 'weekly',
                    remainingFraction: 0.74,
                    resetTime: '2026-10-23T00:33:37Z'
                  }
                ]
              },
              group('Alpha', 0.10),
              group('Beta', 0.74)
            ]
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'rpc');
  assert.deepEqual(result[0].windows.slice(0, 5).map((window) => [window.label, window.kind, window.remainingPercent, window.showMeter]), [
    ['Gemini 5-hour', 'session', 90, true],
    ['Gemini weekly', 'weekly', 95, true],
    ['Gemini 4 Argon weekly', 'weekly', 74, true],
    ['Claude/GPT 5-hour', 'session', null, false],
    ['Claude/GPT weekly', 'weekly', 0, true]
  ]);
  const extra = result[0].windows.slice(5);
  assert.deepEqual(extra.map(window => window.remainingPercent), [28, 74]);
  assert.ok(extra.every(({ label }) => label.endsWith(' 5-hour') && label.length <= 32));
  assert.notEqual(extra[0].label, extra[1].label);
});
