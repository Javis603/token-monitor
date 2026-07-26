'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateLimits,
  mergeCodexTransientWindows,
  normalizeLimitProvider,
  normalizeLimitWindow,
  publicLimits,
  syncLimits
} = require('../../src/shared/limits');
const { collectLimitsOnce } = require('../../src/shared/limitCollector');
const { codexAccountKey } = require('../../src/shared/codexAuth');

function codexProvider(accountKey, accountEmail, remainingPercent, updatedAt) {
  return {
    provider: 'codex',
    accountKey,
    accountName: accountEmail.split('@')[0],
    accountEmail,
    accountLabel: 'Plus',
    status: 'ok',
    source: 'rpc',
    sourceDetail: 'managed',
    updatedAt,
    windows: [
      {
        kind: 'session',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: '2026-06-14T18:00:00.000Z',
        windowMinutes: 300
      }
    ]
  };
}

function mimoProvider(accountKey, accountName, usedPercent, updatedAt) {
  return {
    provider: 'mimo',
    accountKey,
    accountName,
    accountLabel: 'Token Plan',
    status: 'ok',
    source: 'web',
    updatedAt,
    windows: [
      {
        kind: 'billing',
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: '',
        windowMinutes: null
      }
    ]
  };
}

function claudeProvider(accountKey, accountEmail, remainingPercent, updatedAt) {
  return {
    provider: 'claude',
    accountKey,
    accountName: accountEmail.split('@')[0],
    accountEmail,
    accountLabel: 'Max 5x',
    status: 'ok',
    source: 'oauth',
    updatedAt,
    windows: [{
      kind: 'session',
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      resetsAt: '2026-07-25T15:00:00.000Z',
      windowMinutes: 300
    }]
  };
}

test('aggregateLimits keeps distinct Claude accounts and dedupes each one across devices', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-07-25T10:01:00.000Z',
        providers: [
          claudeProvider('sha256:claude-a', 'a@example.com', 18, '2026-07-25T10:00:00.000Z'),
          claudeProvider('sha256:claude-b', 'b@example.com', 72, '2026-07-25T10:01:00.000Z')
        ]
      }
    },
    {
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-07-25T10:05:00.000Z',
        providers: [
          claudeProvider('sha256:claude-a', 'a@example.com', 48, '2026-07-25T10:04:00.000Z'),
          claudeProvider('sha256:claude-b', 'b@example.com', 82, '2026-07-25T10:05:00.000Z')
        ]
      }
    }
  ], 0, Date.parse('2026-07-25T10:06:00.000Z'));

  const providers = aggregate.providers.filter((provider) => provider.provider === 'claude');
  assert.equal(providers.length, 2);
  assert.deepEqual(
    new Set(providers.map((provider) => provider.accountKey)),
    new Set(['sha256:claude-a', 'sha256:claude-b'])
  );
  assert.equal(
    providers.find((provider) => provider.accountKey === 'sha256:claude-a').windows[0].remainingPercent,
    48
  );
  assert.equal(
    providers.find((provider) => provider.accountKey === 'sha256:claude-b').windows[0].remainingPercent,
    82
  );
});

test('aggregateLimits preserves distinct Codex accounts by hashed account key', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-06-14T10:00:00.000Z',
        providers: [
          codexProvider('sha256:codex-a', 'a@example.com', 18, '2026-06-14T10:00:00.000Z'),
          codexProvider('sha256:codex-b', 'b@example.com', 72, '2026-06-14T10:01:00.000Z')
        ]
      }
    }
  ], 0, Date.parse('2026-06-14T10:02:00.000Z'));

  const codexProviders = aggregate.providers.filter((provider) => provider.provider === 'codex');
  assert.equal(codexProviders.length, 2);
  assert.deepEqual(
    new Set(codexProviders.map((provider) => provider.accountKey)),
    new Set(['sha256:codex-a', 'sha256:codex-b'])
  );
  assert.deepEqual(
    new Set(codexProviders.map((provider) => provider.accountEmail)),
    new Set(['a@example.com', 'b@example.com'])
  );
});

test('aggregateLimits preserves same-email Codex workspaces by hashed account key', () => {
  const aggregate = aggregateLimits([{
    deviceId: 'macbook',
    limits: {
      updatedAt: '2026-06-14T10:01:00.000Z',
      providers: [
        codexProvider('sha256:personal', 'member@example.com', 18, '2026-06-14T10:00:00.000Z'),
        codexProvider('sha256:team', 'member@example.com', 72, '2026-06-14T10:01:00.000Z')
      ]
    }
  }], 0, Date.parse('2026-06-14T10:02:00.000Z'));

  const codexProviders = aggregate.providers.filter((provider) => provider.provider === 'codex');
  assert.equal(codexProviders.length, 2);
  assert.deepEqual(
    new Set(codexProviders.map((provider) => provider.accountKey)),
    new Set(['sha256:personal', 'sha256:team'])
  );
});

test('aggregateLimits dedupes same-email Personal and Team workspaces independently across devices', () => {
  const email = 'member@example.com';
  const personalKey = codexAccountKey(email, 'workspace-personal');
  const teamKey = codexAccountKey(email, 'workspace-team');
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-07-24T10:01:00.000Z',
        providers: [
          codexProvider(personalKey, email, 18, '2026-07-24T10:00:00.000Z'),
          codexProvider(teamKey, email, 72, '2026-07-24T10:01:00.000Z')
        ]
      }
    },
    {
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-07-24T10:05:00.000Z',
        providers: [
          codexProvider(personalKey, email, 48, '2026-07-24T10:04:00.000Z'),
          codexProvider(teamKey, email, 82, '2026-07-24T10:05:00.000Z')
        ]
      }
    }
  ], 0, Date.parse('2026-07-24T10:06:00.000Z'));

  const codexProviders = aggregate.providers.filter((provider) => provider.provider === 'codex');
  assert.equal(codexProviders.length, 2);
  assert.deepEqual(
    new Set(codexProviders.map((provider) => provider.accountKey)),
    new Set([personalKey, teamKey])
  );
  assert.equal(
    codexProviders.find((provider) => provider.accountKey === personalKey).windows[0].remainingPercent,
    48
  );
  assert.equal(
    codexProviders.find((provider) => provider.accountKey === teamKey).windows[0].remainingPercent,
    82
  );
  assert.ok(codexProviders.every((provider) => provider.sourceDeviceId === 'desktop'));
});

test('aggregateLimits preserves distinct MiMo accounts by hashed account key', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-07-08T10:00:00.000Z',
        providers: [
          mimoProvider('sha256:mimo-a', 'alpha', 10, '2026-07-08T10:00:00.000Z'),
          mimoProvider('sha256:mimo-b', 'beta', 30, '2026-07-08T10:01:00.000Z')
        ]
      }
    }
  ], 0, Date.parse('2026-07-08T10:02:00.000Z'));

  const mimoProviders = aggregate.providers.filter((provider) => provider.provider === 'mimo');
  assert.equal(mimoProviders.length, 2);
  assert.deepEqual(
    new Set(mimoProviders.map((provider) => provider.accountKey)),
    new Set(['sha256:mimo-a', 'sha256:mimo-b'])
  );
});

test('aggregateLimits preserves distinct OpenRouter accounts and public stats scrub profile identity', () => {
  const providers = ['work', 'personal'].map((accountName, index) => ({
    provider: 'openrouter',
    accountKey: `sha256:openrouter-${index}`,
    accountName,
    accountLabel: accountName,
    status: 'ok',
    source: 'api',
    updatedAt: `2026-07-23T10:0${index}:00.000Z`,
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Account credit',
      used: index + 1,
      limit: 10,
      remaining: 9 - index
    }],
    balance: {
      amount: 9 - index,
      currency: 'USD',
      todaySpend: index + 0.25,
      weekSpend: index + 1.25,
      monthSpend: index + 2.25,
      allTimeSpend: index + 3.25
    }
  }));
  const aggregate = aggregateLimits([{
    deviceId: 'macbook',
    limits: { updatedAt: '2026-07-23T10:02:00.000Z', providers }
  }], 0, Date.parse('2026-07-23T10:03:00.000Z'));
  const openrouter = aggregate.providers.filter((provider) => provider.provider === 'openrouter');
  assert.equal(openrouter.length, 2);
  assert.deepEqual(new Set(openrouter.map((provider) => provider.accountName)), new Set(['work', 'personal']));
  const work = openrouter.find((provider) => provider.accountName === 'work');
  assert.equal(work.balance.amount, 9);
  assert.equal(work.balance.currency, 'USD');
  assert.equal(work.balance.todaySpend, 0.25);
  assert.equal(work.balance.weekSpend, 1.25);
  assert.equal(work.balance.monthSpend, 2.25);
  assert.equal(work.balance.allTimeSpend, 3.25);
  assert.equal(work.windows[0].metric, 'credits');
  assert.equal(work.windows[0].label, 'Account credit');

  const publicPayload = publicLimits({ providers: openrouter });
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'accountKey')));
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'accountName')));
  assert.ok(publicPayload.providers.every((provider) => provider.windows[0].metric === 'credits'));
});

test('aggregateLimits preserves distinct Third-party API accounts while keeping Base URLs off the wire', () => {
  const providers = ['工作', 'personal'].map((accountName, index) => normalizeLimitProvider({
    provider: 'thirdparty',
    accountKey: `sha256:thirdparty-${index}`,
    accountName,
    accountLabel: accountName,
    planLabel: `token-${index}`,
    status: 'ok',
    source: 'api',
    updatedAt: `2026-07-24T10:0${index}:00.000Z`,
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Token quota',
      used: index,
      limit: 50,
      remaining: 50 - index
    }],
    balance: {
      amount: 50 - index,
      currency: 'USD',
      allTimeSpend: index,
      requestCount: index + 10,
      quotaGroup: index === 0 ? 'default' : 'vip',
      expiresAt: '2027-01-15T08:00:00.000Z'
    }
  }));
  const aggregate = aggregateLimits([{
    deviceId: 'macbook',
    limits: { updatedAt: '2026-07-24T10:02:00.000Z', providers }
  }], 0, Date.parse('2026-07-24T10:03:00.000Z'));
  const thirdparty = aggregate.providers.filter((provider) => provider.provider === 'thirdparty');
  assert.equal(thirdparty.length, 2);
  assert.deepEqual(new Set(thirdparty.map((provider) => provider.accountName)), new Set(['工作', 'personal']));
  const work = thirdparty.find((provider) => provider.accountName === '工作');
  assert.equal(work.balance.requestCount, 10);
  assert.equal(work.balance.quotaGroup, 'default');
  assert.equal(work.balance.expiresAt, '2027-01-15T08:00:00.000Z');
  assert.equal(JSON.stringify(thirdparty).includes('http'), false);

  const publicPayload = publicLimits({ providers: thirdparty });
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'accountKey')));
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'accountName')));
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'accountLabel')));
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider, 'planLabel')));
  assert.ok(publicPayload.providers.every((provider) => !Object.hasOwn(provider.balance, 'quotaGroup')));
  assert.ok(publicPayload.providers.every((provider) => Object.hasOwn(provider.balance, 'requestCount')));
});

test('limit provider normalization rejects oversized account text before Unicode normalization', () => {
  const provider = normalizeLimitProvider({
    provider: 'thirdparty',
    accountLabel: 'x'.repeat(257),
    accountName: 'x'.repeat(513),
    status: 'ok',
    source: 'api',
    windows: []
  });
  assert.equal(provider.accountLabel, '');
  assert.equal(provider.accountName, '');
});

test('limit provider normalization strips upstream punctuation while preserving Unicode text', () => {
  const provider = normalizeLimitProvider({
    provider: 'thirdparty',
    accountLabel: 'Coding Plan/Pro',
    accountName: 'Team: Enterprise',
    planLabel: 'Pro (Trial) 工作',
    status: 'ok',
    source: 'api',
    windows: []
  });
  assert.equal(provider.accountLabel, 'Coding PlanPro');
  assert.equal(provider.accountName, 'Team Enterprise');
  assert.equal(provider.planLabel, 'Pro Trial 工作');
});

test('limit provider normalization rejects Unicode emails and embedded endpoint text', () => {
  for (const value of [
    'user＠example.com',
    'Plan https://relay.example/path',
    '前綴 ＨＴＴＰＳ：／／relay.example/path'
  ]) {
    const provider = normalizeLimitProvider({
      provider: 'thirdparty',
      accountLabel: value,
      accountName: value,
      planLabel: value,
      status: 'ok',
      source: 'api',
      windows: []
    });
    assert.equal(provider.accountLabel, '');
    assert.equal(provider.accountName, '');
    assert.equal(provider.planLabel, '');
  }
});

test('publicLimits preserves MiMo plan status while removing account identity', () => {
  const payload = publicLimits({
    providers: [{
      ...mimoProvider('sha256:mimo-a', 'alpha', 0, '2026-07-10T00:00:00.000Z'),
      balance: { amount: 7.51, currency: 'CNY', planStatus: 'expired' }
    }]
  });

  assert.equal(payload.providers[0].balance.planStatus, 'expired');
  assert.equal(Object.hasOwn(payload.providers[0], 'accountKey'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'accountName'), false);
});

test('publicLimits preserves a bounded window detail for shared quota composition', () => {
  const payload = publicLimits({
    providers: [{
      provider: 'kimi',
      status: 'ok',
      source: 'web',
      windows: [{
        kind: 'billing',
        metric: 'provider-private-value',
        usedPercent: 16.12,
        detail: 'Kimi 11.12% · Code 5%\n'
      }]
    }]
  });

  assert.equal(payload.providers[0].windows[0].detail, 'Kimi 11.12% · Code 5%');
  assert.equal(Object.hasOwn(payload.providers[0].windows[0], 'metric'), false);
});

test('aggregateLimits merges the same Codex account across devices and keeps distinct ones', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-06-14T10:01:00.000Z',
        providers: [
          codexProvider('sha256:codex-a', 'a@example.com', 18, '2026-06-14T10:00:00.000Z'),
          codexProvider('sha256:codex-b', 'b@example.com', 72, '2026-06-14T10:01:00.000Z')
        ]
      }
    },
    {
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-06-14T10:05:00.000Z',
        providers: [
          codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:05:00.000Z'),
          codexProvider('sha256:codex-c', 'c@example.com', 30, '2026-06-14T10:03:00.000Z')
        ]
      }
    }
  ], 0, Date.parse('2026-06-14T10:06:00.000Z'));

  const codexProviders = aggregate.providers.filter((provider) => provider.provider === 'codex');
  assert.deepEqual(
    new Set(codexProviders.map((provider) => provider.accountKey)),
    new Set(['sha256:codex-a', 'sha256:codex-b', 'sha256:codex-c'])
  );
  // The account both devices report merges into one, keeping the freshest snapshot.
  const accountA = codexProviders.find((provider) => provider.accountKey === 'sha256:codex-a');
  assert.equal(accountA.windows[0].remainingPercent, 50);
  assert.equal(accountA.sourceDeviceId, 'desktop');
});

test('aggregateLimits keeps Codex quota windows over a newer empty transient snapshot', () => {
  const withWindows = codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z');
  const emptyTransient = {
    ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z'),
    windows: []
  };
  const aggregate = aggregateLimits([
    {
      deviceId: 'macbook',
      limits: {
        updatedAt: '2026-06-14T10:00:00.000Z',
        providers: [withWindows]
      }
    },
    {
      deviceId: 'desktop',
      limits: {
        updatedAt: '2026-06-14T10:05:00.000Z',
        providers: [emptyTransient]
      }
    }
  ], 0, Date.parse('2026-06-14T10:06:00.000Z'));

  const accountA = aggregate.providers.find((provider) => provider.accountKey === 'sha256:codex-a');
  assert.equal(accountA.sourceDeviceId, 'macbook');
  assert.equal(accountA.windows.length, 1);
  assert.equal(accountA.windows[0].remainingPercent, 50);
});

test('aggregateLimits prefers a fresh notConfigured state over stale configured Codex quota', () => {
  const staleProvider = codexProvider(
    'sha256:codex-a',
    'a@example.com',
    41,
    '2026-07-08T13:04:49.000Z'
  );
  const aggregate = aggregateLimits([
    {
      deviceId: 'old-device-id',
      stale: true,
      limits: {
        updatedAt: '2026-07-08T13:04:49.000Z',
        providers: [staleProvider]
      }
    },
    {
      deviceId: 'current-device-id',
      stale: false,
      limits: {
        updatedAt: '2026-07-10T02:55:17.000Z',
        providers: [{
          provider: 'codex',
          status: 'notConfigured',
          updatedAt: '2026-07-10T02:55:17.000Z',
          windows: []
        }]
      }
    }
  ], 10 * 60 * 1000, Date.parse('2026-07-10T03:00:00.000Z'));

  const codexProviders = aggregate.providers.filter((provider) => provider.provider === 'codex');
  assert.equal(codexProviders.length, 1);
  assert.equal(codexProviders[0].status, 'notConfigured');
  assert.equal(codexProviders[0].sourceDeviceId, 'current-device-id');
  assert.equal(codexProviders[0].stale, false);
  assert.deepEqual(codexProviders[0].windows, []);
});

test('aggregateLimits still exposes stale configured Codex quota when no fresh observation exists', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'offline-device',
      stale: true,
      limits: {
        updatedAt: '2026-07-08T13:04:49.000Z',
        providers: [codexProvider(
          'sha256:codex-a',
          'a@example.com',
          41,
          '2026-07-08T13:04:49.000Z'
        )]
      }
    }
  ], 10 * 60 * 1000, Date.parse('2026-07-10T03:00:00.000Z'));

  assert.equal(aggregate.providers.length, 1);
  assert.equal(aggregate.providers[0].status, 'ok');
  assert.equal(aggregate.providers[0].stale, true);
  assert.equal(aggregate.providers[0].windows[0].remainingPercent, 41);
});

test('mergeCodexTransientWindows keeps recent Codex windows when the same account reads empty', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [{
      ...codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z'),
      planLabel: 'Plus'
    }]
  };
  const current = {
    updatedAt: '2026-06-14T10:05:00.000Z',
    providers: [
      {
        ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z'),
        planLabel: '',
        windows: []
      }
    ]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:05:00.000Z'));

  assert.equal(merged.updatedAt, '2026-06-14T10:05:00.000Z');
  assert.equal(merged.providers.length, 1);
  assert.equal(merged.providers[0].windows.length, 1);
  assert.equal(merged.providers[0].windows[0].remainingPercent, 50);
  assert.equal(merged.providers[0].planLabel, 'Plus');
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:00:00.000Z');
});

test('mergeCodexTransientWindows keeps recent Codex windows across a transient read error', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z')]
  };
  const current = {
    updatedAt: '2026-06-14T10:05:00.000Z',
    providers: [{
      ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z'),
      status: 'unavailable',
      windows: []
    }]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:05:00.000Z'));

  assert.equal(merged.providers[0].status, 'ok');
  assert.equal(merged.providers[0].windows[0].remainingPercent, 50);
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:00:00.000Z');
});

test('mergeCodexTransientWindows does not hide a real Codex sign-out', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z')]
  };
  const current = {
    updatedAt: '2026-06-14T10:05:00.000Z',
    providers: [{
      ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z'),
      status: 'notConfigured',
      windows: []
    }]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:05:00.000Z'));

  assert.equal(merged.providers[0].status, 'notConfigured');
  assert.deepEqual(merged.providers[0].windows, []);
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:05:00.000Z');
});

test('mergeCodexTransientWindows accepts a successful quota increase within the same reset window', () => {
  const previousProvider = codexProvider('sha256:codex-a', 'a@example.com', 99, '2026-06-14T10:00:00.000Z');
  const currentProvider = codexProvider('sha256:codex-a', 'a@example.com', 100, '2026-06-14T10:05:00.000Z');
  const merged = mergeCodexTransientWindows(
    { updatedAt: previousProvider.updatedAt, providers: [previousProvider] },
    { updatedAt: currentProvider.updatedAt, providers: [currentProvider] },
    Date.parse('2026-06-14T10:05:00.000Z')
  );

  assert.equal(merged.providers[0].windows[0].remainingPercent, 100);
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:05:00.000Z');
});

test('mergeCodexTransientWindows accepts a successful reset-target change before the previous reset', () => {
  const previousProvider = codexProvider('sha256:codex-a', 'a@example.com', 97, '2026-06-14T10:00:00.000Z');
  const currentProvider = codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z');
  currentProvider.windows[0].resetsAt = '2026-06-14T10:10:00.000Z';
  const merged = mergeCodexTransientWindows(
    { updatedAt: previousProvider.updatedAt, providers: [previousProvider] },
    { updatedAt: currentProvider.updatedAt, providers: [currentProvider] },
    Date.parse('2026-06-14T10:05:00.000Z')
  );

  assert.equal(merged.providers[0].windows[0].remainingPercent, 0);
  assert.equal(merged.providers[0].windows[0].resetsAt, '2026-06-14T10:10:00.000Z');
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:05:00.000Z');
});

test('mergeCodexTransientWindows does not backfill missing windows into a successful non-empty snapshot', () => {
  const previousProvider = codexProvider('sha256:codex-a', 'a@example.com', 97, '2026-06-14T10:00:00.000Z');
  previousProvider.windows.push({
    kind: 'weekly',
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: '2026-06-20T00:00:00.000Z',
    windowMinutes: 10_080
  });
  const currentProvider = codexProvider('sha256:codex-a', 'a@example.com', 96, '2026-06-14T10:05:00.000Z');
  const merged = mergeCodexTransientWindows(
    { updatedAt: previousProvider.updatedAt, providers: [previousProvider] },
    { updatedAt: currentProvider.updatedAt, providers: [currentProvider] },
    Date.parse('2026-06-14T10:05:00.000Z')
  );

  assert.deepEqual(merged.providers[0].windows.map((window) => window.kind), ['session']);
  assert.equal(merged.providers[0].windows[0].remainingPercent, 96);
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:05:00.000Z');
});

test('mergeCodexTransientWindows does not guess an identity when multiple previous Codex accounts are eligible', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [
      codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z'),
      codexProvider('sha256:codex-b', 'b@example.com', 75, '2026-06-14T10:00:00.000Z')
    ]
  };
  const current = {
    updatedAt: '2026-06-14T10:05:00.000Z',
    providers: [{ provider: 'codex', status: 'unavailable', updatedAt: '2026-06-14T10:05:00.000Z', windows: [] }]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:05:00.000Z'));

  assert.equal(merged.providers[0].status, 'unavailable');
  assert.equal(merged.providers[0].accountKey, '');
  assert.deepEqual(merged.providers[0].windows, []);
});

test('mergeCodexTransientWindows rejects conflicting account key and email matches', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [
      codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z'),
      codexProvider('sha256:codex-b', 'b@example.com', 75, '2026-06-14T10:00:00.000Z')
    ]
  };
  const current = {
    updatedAt: '2026-06-14T10:05:00.000Z',
    providers: [{
      ...codexProvider('sha256:codex-a', 'b@example.com', 0, '2026-06-14T10:05:00.000Z'),
      status: 'unavailable',
      windows: []
    }]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:05:00.000Z'));

  assert.equal(merged.providers[0].status, 'unavailable');
  assert.deepEqual(merged.providers[0].windows, []);
});

test('mergeCodexTransientWindows keeps the effective successful summary timestamp during retention', () => {
  const previousProvider = codexProvider('sha256:codex-a', 'a@example.com', 50, '');
  const first = mergeCodexTransientWindows(
    { updatedAt: '2026-06-14T10:00:00.000Z', providers: [previousProvider] },
    {
      updatedAt: '2026-06-14T10:05:00.000Z',
      providers: [{
        ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:05:00.000Z'),
        status: 'unavailable',
        windows: []
      }]
    },
    Date.parse('2026-06-14T10:05:00.000Z')
  );

  assert.equal(first.providers[0].updatedAt, '2026-06-14T10:00:00.000Z');

  const expired = mergeCodexTransientWindows(
    first,
    {
      updatedAt: '2026-06-14T10:11:00.000Z',
      providers: [{
        ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:11:00.000Z'),
        status: 'unavailable',
        windows: []
      }]
    },
    Date.parse('2026-06-14T10:11:00.000Z')
  );

  assert.equal(expired.providers[0].status, 'unavailable');
  assert.deepEqual(expired.providers[0].windows, []);
});

test('mergeCodexTransientWindows stops keeping old Codex windows after retention expires', () => {
  const previous = {
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [codexProvider('sha256:codex-a', 'a@example.com', 50, '2026-06-14T10:00:00.000Z')]
  };
  const current = {
    updatedAt: '2026-06-14T10:12:00.000Z',
    providers: [
      {
        ...codexProvider('sha256:codex-a', 'a@example.com', 0, '2026-06-14T10:12:00.000Z'),
        windows: []
      }
    ]
  };

  const merged = mergeCodexTransientWindows(previous, current, Date.parse('2026-06-14T10:12:00.000Z'), 10 * 60 * 1000);

  assert.equal(merged.providers[0].windows.length, 0);
  assert.equal(merged.providers[0].updatedAt, '2026-06-14T10:12:00.000Z');
});

test('syncLimits carries Codex account identity and legacy plan label to the authenticated hub', () => {
  const payload = syncLimits({
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [
      {
        ...codexProvider('sha256:codex-a', 'a@example.com', 18, '2026-06-14T10:00:00.000Z'),
        workspaceKind: 'personal',
        resetCredits: {
          availableCount: 2,
          nextExpiresAt: '2026-07-18T23:00:00Z',
          expirations: [
            '2026-07-18T23:00:00Z',
            '2026-07-19T01:00:00Z'
          ]
        }
      }
    ]
  });

  assert.equal(payload.providers.length, 1);
  assert.equal(payload.providers[0].provider, 'codex');
  assert.equal(payload.providers[0].accountKey, 'sha256:codex-a');
  assert.equal(payload.providers[0].accountName, 'a');
  assert.equal(payload.providers[0].accountEmail, 'a@example.com');
  assert.equal(payload.providers[0].accountLabel, 'Plus');
  assert.equal(payload.providers[0].planLabel, '');
  assert.equal(payload.providers[0].workspaceKind, 'personal');
  assert.deepEqual(payload.providers[0].resetCredits, {
    availableCount: 2,
    nextExpiresAt: '2026-07-18T23:00:00.000Z',
    expirations: [
      '2026-07-18T23:00:00.000Z',
      '2026-07-19T01:00:00.000Z'
    ]
  });
});

test('publicLimits strips Codex account identity fields', () => {
  const payload = publicLimits({
    updatedAt: '2026-06-14T10:00:00.000Z',
    providers: [
      {
        ...codexProvider('sha256:codex-a', 'a@example.com', 18, '2026-06-14T10:00:00.000Z'),
        workspaceKind: 'personal'
      }
    ]
  });

  assert.equal(payload.providers.length, 1);
  assert.equal(payload.providers[0].provider, 'codex');
  assert.equal(Object.hasOwn(payload.providers[0], 'accountKey'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'accountName'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'accountEmail'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'accountLabel'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'planLabel'), false);
  assert.equal(Object.hasOwn(payload.providers[0], 'workspaceKind'), false);
});

test('OpenCode sync keeps the legacy profile label and explicit plan while public stats scrub both', () => {
  const limits = {
    providers: [{
      provider: 'opencode',
      accountKey: 'sha256:opencode-work',
      accountName: 'work',
      accountLabel: 'work',
      planLabel: 'Go',
      status: 'ok',
      source: 'web',
      updatedAt: '2026-07-20T00:00:00.000Z',
      windows: []
    }]
  };

  const synced = syncLimits(limits).providers[0];
  assert.equal(synced.accountName, 'work');
  assert.equal(synced.accountLabel, 'work');
  assert.equal(synced.planLabel, 'Go');

  const publicProvider = publicLimits(limits).providers[0];
  assert.equal(Object.hasOwn(publicProvider, 'accountName'), false);
  assert.equal(Object.hasOwn(publicProvider, 'accountLabel'), false);
  assert.equal(Object.hasOwn(publicProvider, 'planLabel'), false);
});

test('collectLimitsOnce flattens multiple providers returned by a provider fetcher', async () => {
  const summary = await collectLimitsOnce({ limitProviders: 'codex' }, {
    now: () => Date.parse('2026-06-14T10:02:00.000Z'),
    providerFetchers: {
      codex: async () => [
        codexProvider('sha256:codex-a', 'a@example.com', 18, '2026-06-14T10:00:00.000Z'),
        codexProvider('sha256:codex-b', 'b@example.com', 72, '2026-06-14T10:01:00.000Z')
      ]
    }
  });

  assert.equal(summary.providers.length, 2);
  assert.deepEqual(
    new Set(summary.providers.map((provider) => provider.accountKey)),
    new Set(['sha256:codex-a', 'sha256:codex-b'])
  );
});

// Regression guard for the renderer's localProviderStatus(): a sync-mode account
// card (DeepSeek/Minimax/Grok) must read the local device's RAW limits from
// stats.devices, not stats.limits.providers. This test pins the root cause:
// aggregateLimits collapses a local `unauthorized` row out in favor of a remote
// `ok`, so the local row is GONE from the aggregate. If the card read the
// aggregate, an invalid local key would be validated by the remote ok and the
// UI would falsely report "Linked".
function apikeyProvider(name, accountKey, status, updatedAt) {
  return {
    provider: name,
    accountKey,
    accountLabel: 'Plan',
    status,
    source: 'api',
    updatedAt,
    windows: []
  };
}

test('aggregateLimits drops a local unauthorized row when a remote device has ok (deepseek/minimax/grok collapse by name)', () => {
  const aggregate = aggregateLimits([
    {
      deviceId: 'this-mac',
      limits: {
        updatedAt: '2026-06-24T10:00:00.000Z',
        providers: [apikeyProvider('minimax', 'sha256:local-bad-key', 'unauthorized', '2026-06-24T10:00:00.000Z')]
      }
    },
    {
      deviceId: 'office-pc',
      limits: {
        updatedAt: '2026-06-24T10:01:00.000Z',
        providers: [apikeyProvider('minimax', 'sha256:remote-good-key', 'ok', '2026-06-24T10:01:00.000Z')]
      }
    }
  ], 0, Date.parse('2026-06-24T10:02:00.000Z'));

  const minimaxRows = aggregate.providers.filter((provider) => provider.provider === 'minimax');
  assert.equal(minimaxRows.length, 1);
  // The local unauthorized row is gone; only the remote ok survives.
  assert.equal(minimaxRows[0].status, 'ok');
  assert.equal(minimaxRows[0].sourceDeviceId, 'office-pc');
  assert.equal(minimaxRows[0].accountKey, 'sha256:remote-good-key');
});

test('the local device raw limits still carry the unauthorized row the aggregate dropped', () => {
  // This is the data the renderer's localDeviceLimitsProviders() reads. It proves
  // the local unauthorized survives in stats.devices[..].limits.providers even
  // though aggregateLimits removed it from stats.limits.providers.
  const thisMac = {
    deviceId: 'this-mac',
    limits: {
      updatedAt: '2026-06-24T10:00:00.000Z',
      providers: [apikeyProvider('grok', 'sha256:local-bad-key', 'unauthorized', '2026-06-24T10:00:00.000Z')]
    }
  };
  const officePc = {
    deviceId: 'office-pc',
    limits: {
      updatedAt: '2026-06-24T10:01:00.000Z',
      providers: [apikeyProvider('grok', 'sha256:remote-good-key', 'ok', '2026-06-24T10:01:00.000Z')]
    }
  };

  // Aggregate: only remote ok.
  const aggregate = aggregateLimits([thisMac, officePc], 0, Date.parse('2026-06-24T10:02:00.000Z'));
  assert.equal(aggregate.providers.filter((provider) => provider.provider === 'grok').length, 1);

  // Raw local device limits: the unauthorized row is still here, so a card that
  // reads stats.devices (not stats.limits.providers) will correctly surface
  // 'unauthorized' for the local credential.
  const localGrok = thisMac.limits.providers.find((provider) => provider.provider === 'grok');
  assert.equal(localGrok.status, 'unauthorized');
  assert.equal(localGrok.accountKey, 'sha256:local-bad-key');
});

test('normalizeLimitWindow normalizes the window currency', () => {
  assert.equal(normalizeLimitWindow({ kind: 'billing', currency: ' cny ' }).currency, 'CNY');
  assert.equal(normalizeLimitWindow({ kind: 'billing', currency: 'usd' }).currency, 'USD');
  assert.equal(normalizeLimitWindow({ kind: 'billing', currency: 'verylongcurrencycode' }).currency, 'VERYLONG');
  assert.equal(normalizeLimitWindow({ kind: 'billing', currency: '   ' }).currency, null);
  assert.equal(normalizeLimitWindow({ kind: 'billing' }).currency, null);
});

test('normalizeLimitProvider restores a balance window for pre-credits-window devices', () => {
  // An older device posts DeepSeek as a balance with no windows at all.
  const legacy = normalizeLimitProvider({
    provider: 'deepseek',
    accountKey: 'ds1',
    status: 'ok',
    source: 'api',
    updatedAt: '2026-07-26T00:00:00.000Z',
    windows: [],
    balance: { amount: 4, currency: 'CNY', monthSpend: 6 }
  });

  assert.equal(legacy.windows.length, 1);
  assert.equal(legacy.windows[0].metric, 'credits');
  assert.equal(legacy.windows[0].label, 'Balance');
  assert.equal(legacy.windows[0].remaining, 4);
  assert.equal(legacy.windows[0].currency, 'CNY');
  // Only the amount is restored — no percentage is invented on the wire.
  assert.equal(legacy.windows[0].usedPercent, null);
  assert.equal(legacy.windows[0].remainingPercent, null);
});

test('normalizeLimitProvider never duplicates an existing credits window', () => {
  const current = normalizeLimitProvider({
    provider: 'thirdparty',
    accountKey: 'tp1',
    status: 'ok',
    updatedAt: '2026-07-26T00:00:00.000Z',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Token quota', remaining: 12.5 }],
    balance: { amount: 12.5, currency: 'USD' }
  });

  assert.equal(current.windows.length, 1);
  assert.equal(current.windows[0].label, 'Token quota');
});

test('normalizeLimitProvider leaves percentage-only providers alone', () => {
  const claude = normalizeLimitProvider({
    provider: 'claude',
    accountKey: 'c1',
    status: 'ok',
    updatedAt: '2026-07-26T00:00:00.000Z',
    windows: [{ kind: 'session', usedPercent: 8 }]
  });

  assert.equal(claude.windows.length, 1);
  assert.equal(claude.windows[0].metric, undefined);
});

test('normalizeLimitProvider keeps a restored balance behind the MiMo token plan', () => {
  const mimo = normalizeLimitProvider({
    provider: 'mimo',
    accountKey: 'm1',
    status: 'ok',
    updatedAt: '2026-07-26T00:00:00.000Z',
    windows: [{ kind: 'billing', label: 'Token Plan', used: 22, limit: 100 }],
    balance: { amount: 12.5, currency: 'CNY' }
  });

  assert.deepEqual(mimo.windows.map((window) => window.label), ['Token Plan', 'Balance']);
});
