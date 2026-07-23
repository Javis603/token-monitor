'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectLimitsOnce } = require('../../src/shared/limitCollector');

test('collectLimitsOnce includes opencode provider from injected Go data', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = {
    status: 'ok',
    identity: 'opencode-go:/tmp/opencode.db',
    windows: [{ kind: 'session', used: 3, limit: 12, usedPercent: 25, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }]
  };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeGo }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.ok(provider, 'opencode provider present');
  assert.strictEqual(provider.status, 'ok');
  assert.strictEqual(provider.source, 'local');
  assert.strictEqual(provider.windows[0].kind, 'session');
});

test('collectLimitsOnce marks opencode notConfigured when no Go usage', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
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
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => fakeGo, opencodeFetchGoWeb: async () => ({ status: 'notConfigured', windows: [], workspaceId: '' }), opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.ok(p.windows.some((w) => w.kind === 'session'));  // from Go
  assert.ok(p.windows.some((w) => w.kind === 'weekly'));   // from Zen
  assert.strictEqual(p.balanceUsd, 5);                     // Zen prepaid balance is surfaced, not dropped
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
    { limitProviders: 'opencode', limitsEnabled: true },
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
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => fakeLocal, opencodeFetchGoWeb: async () => fakeGoWeb, opencodeFetchZen: async () => ({ status: 'notConfigured', windows: [], balanceUsd: null }) }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'web');
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').usedPercent, 40); // web, not local 8
  assert.ok(p.windows.find((w) => w.kind === 'billing'), 'monthly normalizes to billing');
});

test('fetchOpenCodeLimits: falls back to local estimate when Go web fails', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeLocal = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => fakeLocal, opencodeFetchGoWeb: async () => ({ status: 'unavailable', windows: [], workspaceId: '' }), opencodeFetchZen: async () => ({ status: 'notConfigured', windows: [], balanceUsd: null }) }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.source, 'local');
  assert.strictEqual(p.windows.find((w) => w.kind === 'session').usedPercent, 8);
});

test('fetchOpenCodeLimits: no cookie means no web calls (local only)', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  let webCalled = false;
  const fakeLocal = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
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
