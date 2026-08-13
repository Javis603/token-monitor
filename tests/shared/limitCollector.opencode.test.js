'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectLimitsOnce: collectLimitsOnceRaw } = require('../../src/shared/limitCollector');
const { hashKey } = require('../../src/shared/hashKey');
const { aggregateLimits } = require('../../src/shared/limits');

// The Go usage API is a zero-config path: left unstubbed it would read the
// developer's real auth.json and probe opencode.ai. Default it to "no key" so
// each test opts in to the response it actually wants.
const OPENCODE_API_UNCONFIGURED = { status: 'notConfigured', windows: [], identity: '' };
const collectLimitsOnce = (options, deps = {}) => collectLimitsOnceRaw(options, {
  opencodeCollectGoApi: async () => OPENCODE_API_UNCONFIGURED,
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

test('fetchOpenCodeLimits: the usage API outranks the cookie scrape and the local estimate', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1', opencodeLocalLimitsEnabled: true },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeCollectGo: () => goLocalOk,
      opencodeFetchGoWeb: async () => goWebOk,
      opencodeFetchZen: async () => zenNone
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.accountLabel, 'Go');
  // 57 is the API's weekly figure; 11 is what both fallbacks reported.
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

test('fetchOpenCodeLimits: a Zen balance does not downgrade the API source claim', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }),
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 7.5 })
    }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.balanceUsd, 7.5);
  // The cookie still supplies the workspace identity that collapses devices.
  assert.strictEqual(p.accountKey, p.webAccountKey);
});

test('aggregation keeps the API source claim instead of flattening it to Web', async () => {
  // The renderer always reads stats through the device -> aggregate projection,
  // so a source the merge overwrites is a source the user never sees.
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    {
      now: () => now403,
      opencodeCollectGoApi: async () => goApiOk,
      opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }),
      opencodeFetchZen: async () => ({ status: 'ok', workspaceId: 'wrk_1', windows: [], balanceUsd: 7.5 })
    }
  );
  const aggregated = aggregateLimits([{ deviceId: 'dev-1', limits: summary }], 0, now403);
  const p = aggregated.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.source, 'api');
  assert.strictEqual(p.balanceUsd, 7.5);
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
  // One enabled profile means the single-account path, which still auto-detects
  // the local key (that is the zero-config behaviour) but must never reach for
  // the disabled profile's key.
  assert.deepStrictEqual(seen, [undefined]);
  assert.strictEqual(summary.providers.filter((x) => x.provider === 'opencode').length, 1);
});
