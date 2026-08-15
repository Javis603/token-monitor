'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectLimitsOnce: collectLimitsOnceRaw } = require('../../src/shared/limitCollector');
const { hashKey } = require('../../src/shared/hashKey');
const { aggregateLimits } = require('../../src/shared/limits');
const { goApiIdentity } = require('../../src/shared/opencodeGoApi');

// The Go usage API is a zero-config path: left unstubbed it would read the
// developer's real auth.json and probe opencode.ai, and the ambient key would
// silently add a second account to every fixture. Both are defaulted to "no
// key" so each test opts in to the credentials it actually wants.
const OPENCODE_API_UNCONFIGURED = { status: 'notConfigured', windows: [], identity: '' };
const collectLimitsOnce = (options, deps = {}) => collectLimitsOnceRaw(options, {
  opencodeCollectGoApi: async () => OPENCODE_API_UNCONFIGURED,
  opencodeReadGoApiKey: () => '',
  ...deps
});

test('collectLimitsOnce includes opencode provider from injected Go data', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = {
    status: 'ok',
    identity: 'opencode-go:/tmp/opencode.db',
    windows: [{ kind: 'session', used: 3, limit: 12, usedPercent: 25, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }]
  };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeGo }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.ok(provider, 'opencode provider present');
  assert.strictEqual(provider.status, 'ok');
  assert.strictEqual(provider.source, 'local');
  assert.strictEqual(provider.windows[0].kind, 'session');
  assert.strictEqual(provider.windows[0].source, 'local');
});

test('collectLimitsOnce marks opencode notConfigured when no Go usage', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    { now: () => Date.now(), opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }) }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.ok(provider);
  assert.strictEqual(provider.status, 'notConfigured');
});

test('fetchOpenCodeLimits merges Go(local) windows with Zen(web) balance', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8.3, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [{ kind: 'weekly', used: null, limit: null, usedPercent: 20, resetsAt: new Date(now).toISOString(), windowMinutes: 10080 }], balanceUsd: 5 };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeGo, opencodeFetchGoWeb: async () => ({ status: 'notConfigured', windows: [], workspaceId: '' }), opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'local');
  assert.strictEqual(p.sourceDetail, 'managed');
  assert.strictEqual(p.accountKey, p.webAccountKey);
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').source, 'local');
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').source, 'web');
  assert.strictEqual(p.balanceUsd, 5);                     // Zen prepaid balance is surfaced, not dropped
});

test('mixed OpenCode identity follows the Web account instead of the device-local DB path', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const collect = async (identity) => collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: true },
    {
      now: () => now,
      opencodeCollectGo: () => ({ status: 'ok', identity, windows: [{ kind: 'session', usedPercent: 10 }] }),
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }),
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'same-zen-workspace', windows: [], balanceUsd: 5 })
    }
  );

  const first = (await collect('go:/Users/one/opencode.db')).providers[0];
  const second = (await collect('go:/Users/two/opencode.db')).providers[0];

  assert.equal(first.accountKey, first.webAccountKey);
  assert.equal(second.accountKey, second.webAccountKey);
  assert.equal(first.accountKey, second.accountKey);
  assert.equal(first.windows[0].source, 'local');
});

test('OpenCode Web identity stays stable when Go availability changes for the same workspace', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const collect = async (goStatus) => collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now,
      opencodeFetchGoWeb: async () => ({
        status: goStatus,
        workspaceId: 'shared-workspace',
        windows: goStatus === 'ok' ? [{ kind: 'session', usedPercent: 10 }] : []
      }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'shared-workspace',
        windows: [{ kind: 'weekly', usedPercent: 20 }],
        balanceUsd: 5
      })
    }
  );

  const goAndZenSummary = await collect('ok');
  const zenOnlySummary = await collect('unavailable');
  const goAndZen = goAndZenSummary.providers[0];
  const zenOnly = zenOnlySummary.providers[0];

  assert.equal(goAndZen.webAccountKey, zenOnly.webAccountKey);
  assert.equal(goAndZen.accountKey, zenOnly.accountKey);
  assert.deepEqual(new Set(goAndZen.accountKeyAliases), new Set([
    hashKey('opencode', 'go:shared-workspace'),
    hashKey('opencode', 'zen:shared-workspace')
  ]));
  assert.equal(aggregateLimits([
    { deviceId: 'go-device', limits: goAndZenSummary },
    { deviceId: 'zen-device', limits: zenOnlySummary }
  ], 0, now).providers.length, 1);
});

test('OpenCode Web identity ignores workspace ids from failed probes', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now,
      opencodeFetchGoWeb: async () => ({
        status: 'unavailable',
        workspaceId: 'workspace-failed-go',
        windows: []
      }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'workspace-successful-zen',
        windows: [{ kind: 'weekly', usedPercent: 20 }],
        balanceUsd: 5
      })
    }
  );
  const provider = summary.providers[0];

  assert.equal(provider.accountKey, hashKey('opencode', 'workspace:workspace-successful-zen'));
  assert.deepEqual(new Set(provider.accountKeyAliases), new Set([
    hashKey('opencode', 'go:workspace-successful-zen'),
    hashKey('opencode', 'zen:workspace-successful-zen')
  ]));
  assert.equal(provider.balanceUsd, 5);
});

test('OpenCode Web probes with conflicting successful workspaces do not merge components', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now,
      opencodeFetchGoWeb: async () => ({
        status: 'ok',
        workspaceId: 'workspace-go',
        windows: [{ kind: 'session', usedPercent: 10 }]
      }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'workspace-zen',
        windows: [{ kind: 'weekly', usedPercent: 20 }],
        balanceUsd: 5
      })
    }
  );
  const provider = summary.providers[0];

  assert.equal(provider.accountKey, hashKey('opencode', 'workspace:workspace-go'));
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session']);
  assert.equal(provider.balanceUsd, null);
});

test('fetchOpenCodeLimits surfaces Zen balance even with no usage windows', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 4.5 };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }), opencodeFetchGoWeb: async () => ({ status: 'notConfigured', windows: [], workspaceId: '' }), opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.balanceUsd, 4.5);
  assert.deepStrictEqual(p.windows, []);
});

test('opencode balanceUsd stays null when Zen returns a null balance (not coerced to 0)', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: null };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }), opencodeFetchGoWeb: async () => ({ status: 'notConfigured', windows: [], workspaceId: '' }), opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.balanceUsd, null);
});

test('opencode surfaces a genuine zero balance ($0.00) as 0, not null', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 0 };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }), opencodeFetchGoWeb: async () => ({ status: 'notConfigured', windows: [], workspaceId: '' }), opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.balanceUsd, 0);
});

test('opencode provider balanceUsd is null when Zen reports no balance', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8.3, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeGo }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.balanceUsd, null);
});

test('fetchOpenCodeLimits: Go web windows win over the local estimate', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeLocal = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const fakeGoWeb = { status: 'ok', workspaceId: 'wrk_1', windows: [
    { kind: 'session', used: null, limit: null, usedPercent: 40, resetsAt: new Date(now).toISOString(), windowMinutes: 300 },
    { kind: 'weekly', used: null, limit: null, usedPercent: 50, resetsAt: new Date(now).toISOString(), windowMinutes: 10080 },
    { kind: 'monthly', used: null, limit: null, usedPercent: 60, resetsAt: new Date(now).toISOString(), windowMinutes: 43200 }
  ] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeLocal, opencodeFetchGoWeb: async () => fakeGoWeb, opencodeFetchZen: async () => ({ status: 'notConfigured', windows: [], balanceUsd: null }) }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'web');
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').usedPercent, 40); // web, not local 8
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').source, 'web');
  assert.ok(p.windows.find((w) => w.kind === 'billing'), 'monthly normalizes to billing');
});

test('fetchOpenCodeLimits: local fallback is fail-closed unless explicitly enabled', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  let localCalled = false;
  const fakeGoWeb = { status: 'ok', workspaceId: 'wrk_1', windows: [
    { kind: 'session', used: null, limit: null, usedPercent: 40, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }
  ] };
  const deps = {
    now: () => now,
    opencodeCollectGo: () => {
      localCalled = true;
      return { status: 'ok', identity: 'go:/x', windows: [] };
    },
    opencodeFetchGoWeb: async () => fakeGoWeb,
    opencodeFetchZen: async () => ({ status: 'notConfigured', windows: [], balanceUsd: null })
  };
  const omitted = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    deps
  );
  const disabled = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: false },
    deps
  );
  assert.equal(localCalled, false);
  for (const summary of [omitted, disabled]) {
    const provider = summary.providers.find((entry) => entry.provider === 'opencode');
    assert.equal(provider.status, 'ok');
    assert.equal(provider.source, 'web');
    assert.equal(provider.windows[0].usedPercent, 40);
  }
});

test('fetchOpenCodeLimits: falls back to local estimate when Go web fails', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeLocal = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeLocal, opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }), opencodeFetchZen: async () => ({ status: 'notConfigured', windows: [], balanceUsd: null }) }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'local');
  assert.strictEqual(Object.hasOwn(p, 'webAccountKey'), false);
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').usedPercent, 8);
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').source, 'local');
});

test('fetchOpenCodeLimits: no cookie means no web calls (local only)', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  let webCalled = false;
  const fakeLocal = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeLocal,
      opencodeFetchGoWeb: async () => { webCalled = true; return { status: 'ok', windows: [], workspaceId: '' }; },
      opencodeFetchZen: async () => { webCalled = true; return { status: 'ok', windows: [], balanceUsd: null }; } }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'local');
  assert.strictEqual(webCalled, false);
});

test('fetchOpenCodeLimits: Go web ok + Zen ok shows Go windows and Zen balance', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGoWeb = { status: 'ok', workspaceId: 'wrk_1', windows: [{ kind: 'session', used: null, limit: null, usedPercent: 40, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 9.5 };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }), opencodeFetchGoWeb: async () => fakeGoWeb, opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'web');
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').usedPercent, 40);
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').source, 'web');
  assert.strictEqual(p.balanceUsd, 9.5);
});

test('fetchOpenCodeLimits: Go Web owns overlapping Zen quota windows', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const resetsAt = new Date(now).toISOString();
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now,
      opencodeFetchGoWeb: async () => ({
        status: 'ok',
        workspaceId: 'wrk_1',
        windows: [
          { kind: 'session', usedPercent: 40, resetsAt },
          { kind: 'weekly', usedPercent: 50, resetsAt }
        ]
      }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'wrk_1',
        windows: [
          { kind: 'session', usedPercent: 18, resetsAt },
          { kind: 'weekly', usedPercent: 20, resetsAt },
          { kind: 'monthly', usedPercent: 30, resetsAt }
        ],
        balanceUsd: 9.5
      })
    }
  );
  const provider = summary.providers[0];

  assert.equal(provider.windows.find((window) => window.kind === 'session').usedPercent, 40);
  assert.equal(provider.windows.find((window) => window.kind === 'weekly').usedPercent, 50);
  assert.equal(provider.windows.find((window) => window.kind === 'billing').usedPercent, 30);
  assert.equal(provider.balanceUsd, 9.5);
});

test('OpenCode profiles apply Go Web authority independently per account', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const summary = await collectLimitsOnce({
    limitProviders: 'opencode',
    limitsEnabled: true,
    opencodeProfiles: {
      personal: { enabled: true, cookie: 'personal-cookie' },
      work: { enabled: true, cookie: 'work-cookie' }
    }
  }, {
    now: () => now,
    opencodeFetchGoWeb: async (cookie) => ({
      status: 'ok',
      workspaceId: cookie,
      windows: [{ kind: 'session', usedPercent: 40 }]
    }),
    opencodeFetchZen: async (cookie) => ({
      status: 'ok',
      workspaceId: cookie,
      windows: [
        { kind: 'session', usedPercent: 18 },
        { kind: 'weekly', usedPercent: 20 }
      ],
      balanceUsd: 5
    })
  });

  assert.equal(summary.providers.length, 2);
  for (const provider of summary.providers) {
    assert.equal(provider.windows.find((window) => window.kind === 'session').usedPercent, 40);
    assert.equal(provider.windows.find((window) => window.kind === 'weekly').usedPercent, 20);
    assert.equal(provider.balanceUsd, 5);
  }
});

test('fetchOpenCodeLimits: surfaces unauthorized when no source has data', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }), opencodeFetchGoWeb: async () => ({ status: 'unauthorized', windows: [], workspaceId: '' }), opencodeFetchZen: async () => ({ status: 'unauthorized', windows: [], balanceUsd: null }) }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'unauthorized');
  assert.strictEqual(p.source, 'web');
});

test('fetchOpenCodeLimits keeps multi-account identity compatible with old renderers while separating plan labels', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const summary = await collectLimitsOnce({
    limitProviders: 'opencode',
    limitsEnabled: true,
    opencodeProfiles: {
      myPersonal: { enabled: true, cookie: 'personal-cookie' },
      myWork: { enabled: true, cookie: 'work-cookie' }
    }
  }, {
    now: () => now,
    opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }),
    opencodeFetchGoWeb: async (cookie) => cookie === 'work-cookie'
      ? { status: 'ok', workspaceId: 'work', windows: [{ kind: 'session', usedPercent: 20 }] }
      : { status: 'notConfigured', workspaceId: '', windows: [] },
    opencodeFetchZen: async (cookie) => cookie === 'personal-cookie'
      ? { status: 'ok', workspaceId: 'personal', windows: [], balanceUsd: 5 }
      : { status: 'notConfigured', workspaceId: '', windows: [], balanceUsd: null }
  });

  assert.deepStrictEqual(
    summary.providers.map(({ accountName, accountLabel, planLabel }) => ({ accountName, accountLabel, planLabel })),
    [
      { accountName: 'myPersonal', accountLabel: 'myPersonal', planLabel: 'Zen' },
      { accountName: 'myWork', accountLabel: 'myWork', planLabel: 'Go' }
    ]
  );
  assert.equal(summary.providers.every((provider) => provider.webAccountKey === provider.accountKey), true);
  // Renderers from before accountName existed read accountLabel as the row
  // title. New producers must therefore keep the profile name there too.
  assert.deepStrictEqual(
    summary.providers.map((provider, index) => provider.accountLabel || `Account ${index + 1}`),
    ['myPersonal', 'myWork']
  );
});

test('fetchOpenCodeLimits refresh scope probes only the requested profile', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const cookies = [];
  const summary = await collectLimitsOnce({
    limitProviders: 'claude,opencode',
    limitsEnabled: true,
    limitRefreshScope: {
      provider: 'opencode',
      accountKey: 'sha256:work',
      accountName: 'work',
      accountLabel: 'work',
      planLabel: 'Go'
    },
    opencodeProfiles: {
      personal: { enabled: true, cookie: 'personal-cookie' },
      work: { enabled: true, cookie: 'work-cookie' }
    }
  }, {
    now: () => now,
    opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }),
    opencodeFetchGoWeb: async (cookie) => {
      cookies.push(cookie);
      return { status: 'ok', workspaceId: 'work', windows: [{ kind: 'session', usedPercent: 20 }] };
    },
    opencodeFetchZen: async (cookie) => {
      cookies.push(cookie);
      return { status: 'ok', workspaceId: 'work', windows: [], balanceUsd: 5 };
    },
    providerFetchers: {
      claude: async () => { throw new Error('unrelated provider must not refresh'); }
    }
  });

  assert.deepStrictEqual(cookies, ['work-cookie', 'work-cookie']);
  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].provider, 'opencode');
  assert.equal(summary.providers[0].accountName, 'work');
  assert.equal(summary.providers[0].accountLabel, 'work');
  assert.equal(summary.providers[0].planLabel, 'Go');
});

// --- Official Go usage API (issue #403) -------------------------------------

const now403 = Date.UTC(2026, 7, 13, 12, 0, 0);
const apiWindows = [
  { kind: 'session', used: null, limit: null, usedPercent: 0, resetsAt: '2026-08-13T15:11:49.412Z', windowMinutes: 300 },
  { kind: 'weekly', used: null, limit: null, usedPercent: 57, resetsAt: '2026-08-17T00:00:00.412Z', windowMinutes: 10080 },
  { kind: 'monthly', used: null, limit: null, usedPercent: 30, resetsAt: '2026-09-04T11:42:50.412Z', windowMinutes: 43200 }
];
const goApiOk = { status: 'ok', identity: 'go-api:abc123def456', windows: apiWindows };
const goWebOk = {
  status: 'ok',
  workspaceId: 'wrk_1',
  windows: [{ kind: 'weekly', used: null, limit: null, usedPercent: 11, resetsAt: new Date(now403).toISOString(), windowMinutes: 10080 }]
};
const goLocalOk = {
  status: 'ok',
  identity: 'opencode-go:/tmp/opencode.db',
  windows: [{ kind: 'weekly', used: 3.3, limit: 30, usedPercent: 11, resetsAt: new Date(now403).toISOString(), windowMinutes: 10080 }]
};
const zenNone = { status: 'notConfigured', windows: [], balanceUsd: null };

test('fetchOpenCodeLimits: the usage API outranks the local estimate', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeCollectGo: () => goLocalOk
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.accountLabel, 'Go');
  // 57 is the API figure; 11 is what the local estimate reported.
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').usedPercent, 57);
  // windows[].source stays within the two-value wire enum so older hubs keep
  // ranking these above a local estimate.
  assert.deepStrictEqual([...new Set(p.windows.map((w) => w.source))], ['web']);
});

test('fetchOpenCodeLimits: API quota needs no cookie at all', async () => {
  let webCalled = false;
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => { webCalled = true; return goWebOk; },
      opencodeFetchZen: async () => { webCalled = true; return zenNone; }
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(webCalled, false);
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.accountKey, hashKey('opencode', 'go-api:abc123def456'));
  assert.strictEqual(p.windows.length, 3);
});

test('fetchOpenCodeLimits: an account with no Go subscription falls through quietly', async () => {
  // 403 EntitlementError arrives as notConfigured, so the cookie path still wins.
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'notConfigured', windows: [], identity: '' }),
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'web');
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').usedPercent, 11);
});

test('fetchOpenCodeLimits: a stale API key surfaces instead of reading as unconfigured', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'unauthorized', windows: [], identity: '' })
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'unauthorized');
  assert.strictEqual(p.source, 'api');
});

test('an explicitly associated key and cookie give api then web then local', async () => {
  // Both credentials under one profile name is the user asserting they are the
  // same account. Only then may Go quota come from the key while Zen balance
  // and the workspace identity come from the cookie.
  const profiles = { work: { enabled: true, apiKey: 'key-work', cookie: 'sess=work' } };
  const zenOk = { status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 7.5 };

  const healthy = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeProfiles: profiles },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenOk
    }
  );
  const p = healthy.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').usedPercent, 57);
  assert.strictEqual(p.balanceUsd, 7.5);
  assert.strictEqual(p.accountKey, p.webAccountKey);

  // API down: the cookie is a real fallback for Go quota, not only for Zen.
  const degraded = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeProfiles: profiles },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'sourceRateLimited', windows: [], identity: 'go-api:x' }),
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenOk
    }
  );
  const d = degraded.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(d.status, 'ok');
  assert.strictEqual(d.source, 'web');
  assert.strictEqual(d.windows.find((w) => w.kind === 'weekly').usedPercent, 11);
  assert.strictEqual(d.balanceUsd, 7.5);
});

test('aggregation keeps the API source claim instead of flattening it to Web', async () => {
  // The renderer always reads stats through the device -> aggregate projection,
  // so a source the merge overwrites is a source the user never sees.
  // A cookie-only account is never read with the ambient key, so reaching an
  // API-sourced provider that also has a balance takes an explicitly bound
  // profile. Stubbing around that would assert a state production cannot reach.
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work', cookie: 'sess=1' } }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async (d) => {
        assert.strictEqual(d.apiKey, 'key-work');
        return goApiOk;
      },
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }),
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 7.5 })
    }
  );
  const aggregated = aggregateLimits([{ deviceId: 'dev-1', limits: summary }], 0, now403);
  const p = aggregated.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.balanceUsd, 7.5);
});

test('a bound account groups with the same key on a device that has no cookie', async () => {
  // Device A: key only. Device B: same key bound to a cookie. Without the key
  // published as an alias on B, the fleet shows the one account twice.
  const apiOnly = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work' } }
    },
    { now: () => now403, opencodeCollectGoApi: async () => goApiOk }
  );
  const bound = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work', cookie: 'sess=1' } }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 4 })
    }
  );
  const aggregated = aggregateLimits([
    { deviceId: 'api-only', limits: apiOnly },
    { deviceId: 'bound', limits: bound }
  ], 0, now403);
  const merged = aggregated.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(merged.length, 1);
  // And the merged row is identified by the workspace the cookie resolved, not
  // by the key. The Hub picks a merged account's canonical identity by sorting
  // the webAccountKeys it was handed, so a key hash offered as one would win or
  // lose on string order, making an account's identity depend on which devices
  // happen to be online. Only a cookie may offer one.
  const boundProvider = bound.providers.find((x) => x.provider === 'opencode');
  const apiOnlyProvider = apiOnly.providers.find((x) => x.provider === 'opencode');
  assert.ok(!apiOnlyProvider.webAccountKey, 'an API-only row has no workspace identity to offer');
  assert.strictEqual(boundProvider.webAccountKey, hashKey('opencode', 'workspace:wrk_1'));
  assert.strictEqual(merged[0].accountKey, boundProvider.webAccountKey);
});

test('a bound account surfaces an expired cookie instead of the API notConfigured', async () => {
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work', cookie: 'sess=1' } }
    },
    {
      now: () => now403,
      // No Go subscription behind the key: a fall-through, not a failure.
      opencodeCollectGoApi: async () => ({ status: 'notConfigured', windows: [], identity: '' }),
      opencodeFetchGoWeb: async () => ({ status: 'unauthorized', windows: [], workspaceId: '' }),
      opencodeFetchZen: async () => ({ status: 'unauthorized', windows: [], balanceUsd: null })
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'unauthorized');
});

test('a cancelled probe discards the tick instead of publishing a per-account row', async () => {
  // Routing the API probe through the cookie helper put an abort inside a catch
  // that answers with a provider row. Swallowed, the cancelled account would
  // publish a plausible-looking `unavailable` beside the other account's real
  // data; rethrown, the whole provider probe is discarded for this tick.
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: true, apiKey: 'key-work', cookie: 'sess=1' },
        other: { enabled: true, cookie: 'sess=other' }
      }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => { throw abort; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  const rows = summary.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'unavailable');
  // No account identity survives, so nothing is attributed to either profile.
  assert.strictEqual(rows[0].accountName || '', '');
  assert.strictEqual(rows[0].accountKey || '', '');
});

test('aggregation still refuses to call a local estimate Web', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    { now: () => now403, opencodeCollectGo: () => goLocalOk }
  );
  const aggregated = aggregateLimits([{ deviceId: 'dev-1', limits: summary }], 0, now403);
  assert.strictEqual(aggregated.providers.find((x) => x.provider === 'opencode').source, 'local');
});

test('an API-key profile is probed with its own key, not the local auth.json', async () => {
  const seen = [];
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work' } }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; }
    }
  );
  assert.deepStrictEqual(seen, ['key-work']);
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').usedPercent, 57);
});

test('mixed API-key and cookie profiles each use their own credential', async () => {
  const apiKeys = [];
  const cookies = [];
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: true, apiKey: 'key-work' },
        personal: { enabled: true, cookie: 'sess=personal' }
      }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async (d) => { apiKeys.push(d.apiKey); return goApiOk; },
      opencodeFetchGoWeb: async (cookie) => { cookies.push(cookie); return goWebOk; },
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 3 })
    }
  );
  assert.deepStrictEqual(apiKeys, ['key-work']);
  assert.deepStrictEqual(cookies, ['sess=personal']);

  const rows = summary.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(rows.length, 2);
  const work = rows.find((r) => r.accountName === 'work');
  const personal = rows.find((r) => r.accountName === 'personal');
  assert.strictEqual(work.source, 'api');
  assert.strictEqual(work.planLabel, 'Go');
  // An API key reaches no balance, so this row must not borrow the cookie's.
  assert.strictEqual(work.balanceUsd, null);
  assert.strictEqual(personal.source, 'web');
  assert.strictEqual(personal.balanceUsd, 3);
  assert.notStrictEqual(work.accountKey, personal.accountKey);
});

test('an API profile keeps one identity across a failed refresh', async () => {
  const collect = async (status) => {
    const summary = await collectLimitsOnce(
      {
        limitProviders: 'opencode',
        limitsEnabled: true,
        opencodeProfiles: {
          work: { enabled: true, apiKey: 'key-work' },
          other: { enabled: true, apiKey: 'key-other' }
        }
      },
      {
        now: () => now403,
        opencodeCollectGoApi: async (d) => (d.apiKey === 'key-work'
          ? (status === 'ok' ? goApiOk : { status, windows: [], identity: '' })
          : goApiOk)
      }
    );
    return summary.providers.find((x) => x.accountName === 'work');
  };
  const healthy = await collect('ok');
  const failed = await collect('unauthorized');
  assert.strictEqual(failed.status, 'unauthorized');
  assert.strictEqual(failed.accountKey, healthy.accountKey);
});

test('a disabled API profile never lends its key to another account', async () => {
  const seen = [];
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: false, apiKey: 'key-work' },
        personal: { enabled: true, cookie: 'sess=personal' }
      }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  // The one enabled profile is a cookie account, so no API key is used at all:
  // not the disabled profile's, and not the ambient one either ('' is the
  // caller suppressing the auth.json lookup).
  assert.deepStrictEqual(seen, ['']);
  assert.strictEqual(summary.providers.filter((x) => x.provider === 'opencode').length, 1);
});

test('the ambient API key is never paired with a cookie account', async () => {
  // The locally signed-in OpenCode account and the configured cookie may be
  // different accounts, and nothing can prove otherwise: the usage endpoint
  // returns no workspace id to compare. Publishing account A's quota under
  // account B's workspace identity would also merge it across devices as B.
  let ambientRequested = false;
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=account-b' },
    {
      now: () => now403,
      opencodeCollectGoApi: async (d) => {
        // '' is the caller saying "no API credential"; undefined would mean
        // "go read auth.json", which is the bug this guards.
        if (d.apiKey === undefined) ambientRequested = true;
        return d.apiKey ? goApiOk : { status: 'notConfigured', windows: [], identity: '' };
      },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 8 })
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(ambientRequested, false);
  assert.strictEqual(p.source, 'web');
  // 11 is the cookie account's own figure; 57 belongs to the local account.
  assert.strictEqual(p.windows.find((w) => w.kind === 'weekly').usedPercent, 11);
  assert.strictEqual(p.balanceUsd, 8);
  assert.strictEqual(p.accountKey, p.webAccountKey);
});

test('an explicit API profile still overrides the ambient key', async () => {
  const seen = [];
  await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work' } }
    },
    { now: () => now403, opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; } }
  );
  assert.deepStrictEqual(seen, ['key-work']);
});

test('zero configuration still reads the ambient key', async () => {
  const seen = [];
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'ambient-key',
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; }
    }
  );
  assert.deepStrictEqual(seen, ['ambient-key']);
  assert.strictEqual(summary.providers.find((x) => x.provider === 'opencode').source, 'api');
});

test('a single API account keeps its identity when the probe fails', async () => {
  const collect = async (result) => (await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'key-work' } }
    },
    { now: () => now403, opencodeCollectGoApi: async () => result }
  )).providers.find((x) => x.provider === 'opencode');

  const healthy = await collect(goApiOk);
  const failed = await collect({ status: 'unauthorized', windows: [], identity: goApiOk.identity });
  assert.strictEqual(failed.status, 'unauthorized');
  assert.strictEqual(failed.accountKey, healthy.accountKey);
  assert.notStrictEqual(failed.accountKey, '');
});

test('the auto-detected account is tracked alongside a configured one', async () => {
  // Two rows, because nothing can prove the locally signed-in account is the
  // account behind the cookie. Folding them would publish one account's quota
  // under the other's identity; hiding the ambient one would drop the
  // zero-config path the moment anything is configured. A user who knows they
  // are one account says so by saving the key under that account's name.
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, cookie: 'sess=work' } }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'ambient-key',
      opencodeCollectGoApi: async (d) => (d.apiKey === 'ambient-key'
        ? goApiOk
        : { status: 'notConfigured', windows: [], identity: '' }),
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 6 })
    }
  );
  const rows = summary.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(rows.length, 2);
  const auto = rows.find((r) => r.source === 'api');
  const cookieAccount = rows.find((r) => r.source === 'web');
  assert.strictEqual(auto.windows.find((w) => w.kind === 'weekly').usedPercent, 57);
  assert.strictEqual(auto.balanceUsd, null);
  assert.strictEqual(cookieAccount.windows.find((w) => w.kind === 'weekly').usedPercent, 11);
  assert.strictEqual(cookieAccount.balanceUsd, 6);
  assert.notStrictEqual(auto.accountKey, cookieAccount.accountKey);
});

test('binding the ambient key into an account stops tracking it separately', async () => {
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, apiKey: 'ambient-key', cookie: 'sess=work' } }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'ambient-key',
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 6 })
    }
  );
  const rows = summary.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'api');
  assert.strictEqual(rows[0].balanceUsd, 6);
});

test('disabling every account still leaves the auto-detected one', async () => {
  const seen = [];
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: false, apiKey: 'key-work' },
        personal: { enabled: false, cookie: 'sess=personal' }
      }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'ambient-key',
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; }
    }
  );
  assert.deepStrictEqual(seen, ['ambient-key']);
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'api');
});

test('a runtime cancellation of a bound account is not published as a row', async () => {
  // Same shape LimitsRuntime actually uses: a plain Error, recognised through
  // the aborted signal rather than the error name.
  const controller = new AbortController();
  const superseded = new Error('superseded');
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: true, apiKey: 'key-work', cookie: 'sess=1' },
        other: { enabled: true, cookie: 'sess=other' }
      }
    },
    {
      now: () => now403,
      signal: controller.signal,
      opencodeCollectGoApi: async () => { controller.abort(superseded); throw superseded; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  const rows = summary.providers.filter((x) => x.provider === 'opencode');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'unavailable');
  assert.strictEqual(rows[0].accountName || '', '');
});

test('a cancelled Go subscription is not papered over by the local estimate', async () => {
  // 403 is the server's authoritative "this account has no Go plan". The local
  // DB cannot tell a cancelled subscription from a current one, so it would
  // keep deriving quota from the rows the old subscription left behind.
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'notConfigured', entitled: false, windows: [], identity: '' }),
      opencodeCollectGo: () => goLocalOk
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'notConfigured');
  assert.deepStrictEqual(p.windows, []);
});

test('a missing key still leaves room for the local estimate', async () => {
  // No credential at all carries no entitlement claim, so the estimate stands.
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeLocalLimitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'notConfigured', windows: [], identity: '' }),
      opencodeCollectGo: () => goLocalOk
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'local');
});

test('a profile referencing the auto-detected key resolves it live', async () => {
  // The reference is stored, not the key, so the current key is read on every
  // tick instead of going stale behind a snapshot.
  const seen = [];
  const collect = async (ambient) => collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: {
          enabled: true,
          useAmbientKey: true,
          ambientKeyIdentity: goApiIdentity('key-one'),
          cookie: 'sess=work'
        }
      }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => ambient,
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 9 })
    }
  );

  const before = await collect('key-one');
  const after = await collect('key-one');
  assert.deepStrictEqual(seen, ['key-one', 'key-one']);
  // A cookie pins the workspace identity, so re-reading the key each tick does
  // not make the account look like a different one.
  const id = (s) => s.providers.find((x) => x.provider === 'opencode').accountKey;
  assert.strictEqual(id(before), id(after));

  const p = after.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.balanceUsd, 9);
  // Only one row: claiming the key removes the separate auto-detected account.
  assert.strictEqual(after.providers.filter((x) => x.provider === 'opencode').length, 1);
});

// The API's own `notConfigured` is ranked below a cookie failure so an expired
// cookie still wins, but on an account with no cookie there is nothing to lose
// to, and it is the true answer. Falling through to the literal told the user to
// sign in again about a workspace that simply has no Go plan.
test('an API-only account with no Go plan reports notConfigured, not unauthorized', async () => {
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        // Two accounts, so this runs the multi-account path.
        work: { enabled: true, apiKey: 'sk-work' },
        personal: { enabled: true, cookie: 'sess=personal' }
      }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => ({ status: 'notConfigured', entitled: false, windows: [], identity: 'go-api:work' }),
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 3 })
    }
  );
  const work = summary.providers.find((p) => p.provider === 'opencode' && p.accountName === 'work');
  assert.ok(work, 'the API-only account should still be listed');
  assert.strictEqual(work.status, 'notConfigured');
});

// A scope always comes from an action on a stored account, and the auto-detected
// entry is not one. Matching it by name would let a user who happens to name an
// account the same string scope a refresh onto both.
test('a scoped refresh never selects the auto-detected account', async () => {
  const probed = [];
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      limitRefreshScope: { provider: 'opencode', accountName: 'default (auto)' },
      opencodeProfiles: { 'default (auto)': { enabled: true, cookie: 'sess=named' } }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'sk-ambient',
      opencodeCollectGoApi: async (d) => { probed.push(d.apiKey); return goApiOk; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 3 })
    }
  );
  // Only the stored cookie account is refreshed. The ambient key shares its name
  // but is never probed, so the scope cannot fan out onto it.
  assert.deepStrictEqual(probed, []);
  const rows = summary.providers.filter((p) => p.provider === 'opencode');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'web');
});

// A machine may be signed in to an account whose quota the user does not want
// reported. Only the unclaimed row is suppressed: once an account has claimed
// the key it is that account's credential and follows that account's own switch,
// exactly as a cookie does.
test('the auto-detected account can be switched off without touching claimed keys', async () => {
  const collect = async (opencodeAmbientEnabled, opencodeProfiles) => collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeAmbientEnabled, opencodeProfiles },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'sk-ambient',
      // Honours the key it is handed, the way the real one does: a stub that
      // answers regardless would report success for a key the collector never
      // resolved, which is exactly what this test is checking it does not do.
      opencodeCollectGoApi: async (d) => (d.apiKey ? goApiOk : OPENCODE_API_UNCONFIGURED),
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 1 })
    }
  );
  const rows = (summary) => summary.providers.filter((p) => p.provider === 'opencode');

  const on = rows(await collect(true, {}));
  assert.strictEqual(on.length, 1);
  assert.strictEqual(on[0].status, 'ok');
  // Switched off, the provider is still listed (it is a selected provider) but
  // has nothing behind it: the key is never read.
  const off = rows(await collect(false, {}));
  assert.strictEqual(off.length, 1);
  assert.strictEqual(off[0].status, 'notConfigured');
  assert.strictEqual(off[0].windows.length, 0);

  // Claimed by an account: the switch above no longer applies to it.
  const claimed = {
    work: {
      enabled: true,
      useAmbientKey: true,
      ambientKeyIdentity: goApiIdentity('sk-ambient'),
      cookie: 'sess=work'
    }
  };
  const claimedRows = rows(await collect(false, claimed));
  assert.strictEqual(claimedRows.length, 1);
  assert.strictEqual(claimedRows[0].accountName, 'work');
});

// The reference names the account that was signed in when it was bound. The
// usage API returns no workspace id, so a key that has since changed cannot be
// told apart from another account's key, and pairing it with this account's
// cookie would publish that account's quota under this workspace's identity.
test('a bound reference stops resolving when the machine key changes', async () => {
  const seen = [];
  const collect = async (ambient) => collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: {
          enabled: true,
          useAmbientKey: true,
          ambientKeyIdentity: goApiIdentity('key-one'),
          cookie: 'sess=work'
        }
      }
    },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => ambient,
      opencodeCollectGoApi: async (d) => { seen.push(d.apiKey); return goApiOk; },
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 9 })
    }
  );

  const bound = await collect('key-one');
  assert.deepStrictEqual(seen, ['key-one']);
  assert.strictEqual(bound.providers.filter((x) => x.provider === 'opencode').length, 1);

  const rotated = await collect('key-two');
  const rows = rotated.providers.filter((x) => x.provider === 'opencode');
  // Two rows: the bound account falls back to what its cookie alone answers, and
  // the new key comes back as its own auto-detected account for the user to
  // place deliberately rather than being adopted by the account it is not.
  assert.strictEqual(rows.length, 2);
  const bound2 = rows.find((r) => r.accountName === 'work');
  const detected = rows.find((r) => r.accountName !== 'work');
  assert.ok(bound2 && detected, 'both the bound account and the detected key should be listed');
  // The bound row is answered by its cookie, not by the key it no longer owns.
  assert.strictEqual(bound2.source, 'web');
  assert.strictEqual(detected.accountKey, hashKey('opencode', goApiIdentity('key-two')));
  assert.strictEqual(detected.source, 'api');
});

// A machine that resolves to exactly one OpenCode account still has an account
// with a name. Left off, its card read "Account 1", and enabling a second
// account did not repair it until a restart: a scoped refresh only rebuilds the
// account it targets, so the nameless record survived beside the named new one.
test('a single OpenCode account is published under its own name', async () => {
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { work: { enabled: true, cookie: 'sess=1' } }
    },
    {
      now: () => now403,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 2 })
    }
  );
  const rows = summary.providers.filter((p) => p.provider === 'opencode');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].accountName, 'work');
});

// The zero-config account is named too, and its name survives the wire's own
// name normalization: the previous "default (auto)" lost its brackets there and
// reached the card as "default auto".
test('the auto-detected account is published under a name that survives normalization', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    {
      now: () => now403,
      opencodeReadGoApiKey: () => 'sk-ambient',
      opencodeCollectGoApi: async () => goApiOk
    }
  );
  const row = summary.providers.find((p) => p.provider === 'opencode');
  assert.strictEqual(row.accountName, 'Auto-detected');
});

test('an account holding only a key identifies itself by that key', async () => {
  // The single unified profile path has to give a key-only account the same
  // identity the cookie path gives a workspace, or the two devices holding that
  // key never group.
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: true, apiKey: 'key-work' },
        other: { enabled: true, cookie: 'sess=other' }
      }
    },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  const work = summary.providers.find((x) => x.accountName === 'work');
  assert.strictEqual(work.source, 'api');
  assert.strictEqual(work.accountKey, hashKey('opencode', goApiIdentity('key-work')));
  assert.strictEqual(work.balanceUsd, null);
});

// A failing credential must name itself. The row's `source` is shown as the
// provenance tag beside the account, so an expired API key that reports `web`
// sends the user to re-copy a cookie that is fine.
test('a failed API probe reports API provenance whether or not other accounts exist', async () => {
  const now = Date.UTC(2026, 7, 1, 12, 0, 0);
  const collect = async (profiles) => collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeProfiles: profiles },
    {
      now: () => now,
      opencodeCollectGoApi: async () => ({ status: 'unauthorized', windows: [], identity: 'go-api:work' }),
      opencodeFetchGoWeb: async () => ({
        status: 'ok',
        workspaceId: 'wrk_personal',
        windows: [{ kind: 'session', used: 1, limit: 10, usedPercent: 10, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }]
      }),
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_personal', windows: [], balanceUsd: 4 })
    }
  );

  const alone = await collect({ work: { enabled: true, apiKey: 'sk-work' } });
  const solo = alone.providers.find((p) => p.provider === 'opencode');
  assert.strictEqual(solo.status, 'unauthorized');
  assert.strictEqual(solo.source, 'api');

  // The same account, the same failure, with a second account configured. How
  // many accounts exist cannot change which credential failed.
  const together = await collect({
    work: { enabled: true, apiKey: 'sk-work' },
    personal: { enabled: true, cookie: 'sess=personal' }
  });
  const work = together.providers.find((p) => p.provider === 'opencode' && p.accountName === 'work');
  assert.strictEqual(work.status, 'unauthorized');
  assert.strictEqual(work.source, 'api');

  // A cookie account that fails still reports Web, so this is not a blanket
  // relabel of every multi-account failure.
  const cookieFail = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        work: { enabled: true, apiKey: 'sk-work' },
        personal: { enabled: true, cookie: 'sess=personal' }
      }
    },
    {
      now: () => now,
      opencodeCollectGoApi: async () => ({ status: 'unauthorized', windows: [], identity: 'go-api:work' }),
      opencodeFetchGoWeb: async () => ({ status: 'unauthorized', windows: [] }),
      opencodeFetchZen: async () => ({ status: 'unauthorized', windows: [] })
    }
  );
  const personal = cookieFail.providers.find((p) => p.provider === 'opencode' && p.accountName === 'personal');
  assert.strictEqual(personal.status, 'unauthorized');
  assert.strictEqual(personal.source, 'web');
});

// Supplemental windows fill kinds the Go source did not answer. The guard used
// to compare against the go-page scrape alone, so it only held while that scrape
// was the Go source: whenever the usage API answered and the scrape did not, the
// account reported one window kind twice, from two sources and with two
// different numbers. Go quota resolves api → web → local, so the comparison has
// to be against whatever was actually taken.
test('opencode drops a supplemental window whose kind the usage API answered', async () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: { mine: { enabled: true, cookie: 'sess=1', apiKey: 'sk-mine' } }
    },
    {
      now: () => now,
      opencodeCollectGoApi: async () => ({
        status: 'ok',
        identity: 'go-api:mine',
        entitled: true,
        windows: [
          { kind: 'session', usedPercent: 40, windowMinutes: 300 },
          { kind: 'weekly', usedPercent: 55, windowMinutes: 10080 }
        ]
      }),
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: 'wrk_1' }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'wrk_1',
        balanceUsd: 7.5,
        windows: [
          { kind: 'session', usedPercent: 11, windowMinutes: 300 },
          { kind: 'weekly', usedPercent: 12, windowMinutes: 10080 }
        ]
      })
    }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.strictEqual(provider.status, 'ok');
  assert.deepStrictEqual(
    provider.windows.map((window) => `${window.kind}:${window.usedPercent}`),
    ['session:40', 'weekly:55']
  );
  // The cookie is still what produced the balance.
  assert.strictEqual(provider.balanceUsd, 7.5);
});

// Same guard for the local estimate, which is the other Go source the previous
// comparison did not cover, and had the gap before the usage API existed.
test('opencode drops a supplemental window whose kind the local estimate answered', async () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);
  const summary = await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeLocalLimitsEnabled: true,
      opencodeCookie: 'sess=1'
    },
    {
      now: () => now,
      opencodeCollectGo: () => ({
        status: 'ok',
        identity: 'go:/x',
        windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8.3, windowMinutes: 300 }]
      }),
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: 'wrk_1' }),
      opencodeFetchZen: async () => ({
        status: 'ok',
        workspaceId: 'wrk_1',
        balanceUsd: 3,
        windows: [
          { kind: 'session', usedPercent: 90, windowMinutes: 300 },
          { kind: 'weekly', usedPercent: 20, windowMinutes: 10080 }
        ]
      })
    }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.deepStrictEqual(
    provider.windows.map((window) => `${window.kind}:${window.usedPercent}:${window.source}`),
    ['session:8.3:local', 'weekly:20:web']
  );
});

// The widget injects one transport so provider calls follow the OS proxy; a
// probe that rebuilds its deps without carrying `fetch` silently drops back to
// the global fetch, which no source-level guard would catch. The collector
// wraps the injected transport before handing it on, so this asserts the call
// actually lands there rather than comparing identities. Both the single- and
// multi-account paths are checked because they build those deps separately.
test('every OpenCode web probe receives the injected transport', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  let landed = 0;
  const injected = async () => {
    landed += 1;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  };
  const seen = [];
  const record = (label) => async (cookie, deps = {}) => {
    const before = landed;
    if (typeof deps.fetch === 'function') await deps.fetch('https://transport.test/probe');
    seen.push(`${label}:${cookie}:${landed > before ? 'injected' : 'MISSING'}`);
    return { status: 'notConfigured', windows: [], workspaceId: '', balanceUsd: null };
  };

  await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'single-cookie' },
    {
      now: () => now,
      fetch: injected,
      opencodeFetchGoWeb: record('go'),
      opencodeFetchZen: record('zen')
    }
  );
  // Two enabled profiles on purpose: one would stay on the single-account path
  // (`multiAccountMode` is `cookies.length > 1`), leaving the per-profile deps
  // this regression is about unexercised.
  await collectLimitsOnce(
    {
      limitProviders: 'opencode',
      limitsEnabled: true,
      opencodeProfiles: {
        personal: { enabled: true, cookie: 'personal-cookie' },
        work: { enabled: true, cookie: 'work-cookie' }
      }
    },
    {
      now: () => now,
      fetch: injected,
      opencodeFetchGoWeb: record('go'),
      opencodeFetchZen: record('zen')
    }
  );

  assert.deepStrictEqual(seen.sort(), [
    'go:personal-cookie:injected',
    'go:single-cookie:injected',
    'go:work-cookie:injected',
    'zen:personal-cookie:injected',
    'zen:single-cookie:injected',
    'zen:work-cookie:injected'
  ]);
});
