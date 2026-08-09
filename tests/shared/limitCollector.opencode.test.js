'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectLimitsOnce } = require('../../src/shared/limitCollector');
const { hashKey } = require('../../src/shared/hashKey');
const { aggregateLimits } = require('../../src/shared/limits');

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
