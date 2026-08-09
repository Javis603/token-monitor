'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAC_WIDGET_SCHEMA_VERSION,
  buildMacWidgetSnapshot,
  isLikelySensitivePathOrUrl,
  macWidgetSnapshotFingerprint,
  resolveWidgetSourceFreshness,
  serializeMacWidgetSnapshot
} = require('../../src/shared/macWidgetSnapshot');
const { aggregateDevices } = require('../../src/shared/usage');

const NOW = '2026-07-17T08:30:00.000Z';

function dailyHistory(count, start = '2026-01-01') {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
    tokens: index + 1,
    cost: (index + 1) / 100
  }));
}

function buildSnapshot(stats, options = {}) {
  return buildMacWidgetSnapshot(stats, {
    history: stats.history || { daily: [], monthly: [], summary: {} },
    ...options
  });
}

function sampleStats() {
  return {
    updatedAt: '2026-07-17T08:25:00.000Z',
    periods: {
      today: {
        totalTokens: 1_200_000,
        costUsd: 1.25,
        clients: { codex: 1_000_000, claude: 200_000 },
        clientCosts: { codex: 1, claude: 0.25 },
        models: { 'gpt-5.6': 900_000, 'MiMo V2 Pro': 300_000 },
        modelCosts: { 'gpt-5.6': 1, 'MiMo V2 Pro': 0.25 }
      },
      month: { totalTokens: 9_000_000, costUsd: 8 },
      allTime: { totalTokens: 20_000_000, costUsd: 16 }
    },
    limits: {
      providers: [{
        provider: 'codex',
        status: 'ok',
        accountEmail: 'private@example.com',
        windows: [{ kind: 'weekly', usedPercent: 35, resetsAt: '2026-07-20T00:00:00Z' }]
      }, { provider: 'claude', status: 'notConfigured', windows: [] }]
    },
    history: {
      daily: [
        { date: '2026-07-15', tokens: 100, cost: 0.1, perClient: { secret: 1 } },
        { date: '2026-07-16', tokens: 200, cost: 0.2 },
        { date: '2026-07-17', tokens: 50, cost: 0.05 }
      ],
      summary: { activeDays: 3, favoriteModel: 'private-model' }
    }
  };
}

function aggregateDevice(deviceId, sourceTime, totalTokens = 42) {
  return {
    deviceId,
    updatedAt: sourceTime,
    receivedAt: sourceTime,
    periods: {
      today: { totalTokens, costUsd: 0.5 },
      month: { totalTokens, costUsd: 0.5 },
      allTime: { totalTokens, costUsd: 0.5 }
    }
  };
}

test('builds schema v6 overview, quota, models, activity, trend and presentation', () => {
  const snapshot = buildSnapshot(sampleStats(), {
    now: NOW,
    presentation: {
      defaultPeriod: 'today', currencyCode: 'CNY', currencyRate: 7.1,
      compactNumbers: true, compactTokenUnits: 'localized', showCost: true, locale: 'zh-CN', theme: 'custom'
    }
  });

  assert.equal(snapshot.schemaVersion, MAC_WIDGET_SCHEMA_VERSION);
  assert.equal(MAC_WIDGET_SCHEMA_VERSION, 6);
  assert.deepEqual(snapshot.overview, {
    currentPeriod: 'today', totalTokens: 1_200_000, costUsd: 1.25,
    primaryTool: 'codex', updatedAt: '2026-07-17T08:25:00.000Z'
  });
  assert.equal(snapshot.periods.day.overview.totalTokens, 1_200_000);
  assert.equal(snapshot.periods.month.overview.totalTokens, 9_000_000);
  assert.equal(snapshot.periods.total.overview.totalTokens, 20_000_000);
  assert.deepEqual(snapshot.quota[0].windows[0], {
    kind: 'weekly', metric: null, showMeter: true,
    usedPercent: 35, remainingPercent: 65,
    resetsAt: '2026-07-20T00:00:00.000Z', windowMinutes: null
  });
  assert.deepEqual(snapshot.models.map((model) => [model.displayName, model.totalTokens, model.sharePercent]), [
    ['gpt-5.6', 900_000, 75], ['MiMo V2 Pro', 300_000, 25]
  ]);
  assert.equal(snapshot.activity.activeDays, 3);
  assert.deepEqual(snapshot.activity.days.map((day) => day.intensity), [2, 4, 1]);
  assert.deepEqual(snapshot.activity.days.map((day) => day.totalTokens), [100, 200, 50]);
  assert.deepEqual(snapshot.trend.points.map((point) => point.date), [
    '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14',
    '2026-07-15', '2026-07-16', '2026-07-17'
  ]);
  assert.deepEqual(snapshot.trend.points.map((point) => point.totalTokens), [0, 0, 0, 0, 100, 200, 1_200_000]);
  assert.equal(snapshot.trend.currentTokens, 1_200_000);
  assert.equal(snapshot.trend.peakTokens, 1_200_000);
  assert.deepEqual(snapshot.presentation, {
    currencyCode: 'CNY', currencySymbol: '¥', currencyRate: 7.1,
    numberStyle: 'compact', compactTokenUnits: 'localized', showCost: true, locale: 'zh-CN', theme: 'custom'
  });
  assert.equal(snapshot.status.noData, false);
  assert.equal(snapshot.status.isStale, false);
});

test('allowlists MiMo and DeepSeek balances and ranks numeric quota ahead of status-only rows', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [
      { provider: 'claude', status: 'ok', windows: [] },
      { provider: 'mimo', status: 'ok', balance: { amount: 3.62, currency: 'CNY' }, windows: [] },
      { provider: 'deepseek', status: 'ok', balance: { amount: 9.33, currency: 'USD' }, windows: [] },
      { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 2 }] }
    ] }
  }, { now: NOW });

  assert.deepEqual(snapshot.quota.map((provider) => provider.provider), [
    'codex', 'deepseek', 'mimo', 'claude'
  ]);
  assert.deepEqual(snapshot.quota[1].balance, { amount: 9.33, currency: 'USD' });
  assert.deepEqual(snapshot.quota[2].balance, { amount: 3.62, currency: 'CNY' });
  assert.equal(Object.hasOwn(snapshot.quota[0], 'balance'), false);
  assert.equal(snapshot.quota[0].windows[0].remainingPercent, 2);
});

test('shares the complete provider allowlist and preserves credit window display semantics', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [
      { provider: 'openrouter', status: 'ok', windows: [{ kind: 'billing', metric: 'credits', remaining: 12.5, currency: 'USD', showMeter: false }] },
      { provider: 'thirdparty', status: 'ok', windows: [{ kind: 'weekly', metric: 'unsupported', remainingPercent: 80 }] }
    ] }
  }, { now: NOW });
  const byProvider = new Map(snapshot.quota.map((provider) => [provider.provider, provider]));

  assert.deepEqual(snapshot.quota.map((provider) => provider.provider), ['openrouter', 'thirdparty']);
  assert.deepEqual(byProvider.get('openrouter').windows[0], {
    kind: 'billing', metric: 'credits', showMeter: false,
    usedPercent: null, remainingPercent: null, resetsAt: null, windowMinutes: null,
    remaining: 12.5, currency: 'USD'
  });
  assert.equal(byProvider.get('thirdparty').windows[0].metric, null);
  assert.equal(byProvider.get('thirdparty').windows[0].showMeter, true);
});

test('keeps multi-account provider identities stable without exporting account details', () => {
  const stats = {
    limits: { providers: [
      {
        provider: 'codex', accountKey: 'workspace-a', accountEmail: 'a@example.com',
        authPath: '/Users/private/.codex/auth.json', token: 'secret-a', workspaceId: 'private-a',
        status: 'ok', updatedAt: '2026-07-17T08:25:00.000Z',
        windows: [{ kind: 'weekly', remainingPercent: 70 }]
      },
      {
        provider: 'codex', accountKey: 'workspace-b', accountEmail: 'b@example.com',
        authPath: '/Users/private/.codex/auth-b.json', token: 'secret-b', workspaceId: 'private-b',
        status: 'ok', updatedAt: '2026-07-17T08:25:00.000Z',
        windows: [{ kind: 'weekly', remainingPercent: 60 }]
      }
    ]}
  };
  const first = buildSnapshot(stats, { now: NOW });
  stats.limits.providers[0].windows[0].remainingPercent = 65;
  const second = buildSnapshot(stats, { now: NOW });

  assert.deepEqual(first.quota.map((provider) => provider.displayName), ['Codex 1', 'Codex 2']);
  assert.equal(new Set(first.quota.map((provider) => provider.instanceId)).size, 2);
  assert.deepEqual(first.quota.map((provider) => provider.instanceId), second.quota.map((provider) => provider.instanceId));
  for (const privateValue of ['workspace-a', 'workspace-b', 'a@example.com', 'b@example.com', 'auth.json', 'secret-a', 'private-a']) {
    assert.doesNotMatch(JSON.stringify(first), new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('keeps anonymous Provider IDs stable when quota status and values change', () => {
  const stats = {
    limits: { providers: [{
      provider: 'openrouter',
      source: 'api',
      sourceDetail: 'credits',
      status: 'ok',
      balance: { amount: 12.5, currency: 'USD' },
      windows: [{ kind: 'billing', remaining: 12.5 }],
      updatedAt: '2026-07-17T08:25:00.000Z'
    }] }
  };
  const first = buildSnapshot(stats, { now: NOW });
  stats.limits.providers[0].status = 'unavailable';
  stats.limits.providers[0].balance.amount = 3.25;
  stats.limits.providers[0].windows[0].remaining = 3.25;
  stats.limits.providers[0].updatedAt = '2026-07-17T09:25:00.000Z';
  const second = buildSnapshot(stats, { now: NOW });

  assert.equal(first.quota[0].instanceId, 'openrouter-single');
  assert.equal(second.quota[0].instanceId, first.quota[0].instanceId);
  assert.doesNotMatch(JSON.stringify(first), /credits/);
});

test('gives duplicate anonymous Provider rows unique IDs using stable input order', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [
      { provider: 'thirdparty', source: 'api', sourceDetail: 'adapter-a', status: 'ok', windows: [] },
      { provider: 'thirdparty', source: 'api', sourceDetail: 'adapter-a', status: 'ok', windows: [] }
    ] }
  }, { now: NOW });

  assert.deepEqual(snapshot.quota.map((provider) => provider.instanceId), [
    'thirdparty-anonymous-1', 'thirdparty-anonymous-2'
  ]);
  assert.equal(new Set(snapshot.quota.map((provider) => provider.instanceId)).size, 2);
});

test('merges model display-name collisions before calculating shares', () => {
  const snapshot = buildSnapshot({ periods: {
    today: { models: { 'GPT-5.6': 10, 'gpt-5.6': 20 }, modelCosts: { 'GPT-5.6': 1, 'gpt-5.6': 2 } }
  } }, { now: NOW });
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].totalTokens, 30);
  assert.equal(snapshot.models[0].costUsd, 3);
  assert.equal(snapshot.models[0].sharePercent, 100);
  assert.match(snapshot.models[0].id, /^model-/);
});

test('preserves a zero balance and omits missing, non-finite, or unsupported balances', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [
      { provider: 'deepseek', status: 'ok', balance: { amount: '0', currency: ' cny ' } },
      { provider: 'mimo', status: 'ok', balance: { amount: Infinity, currency: 'CNY' } },
      { provider: 'cursor', status: 'ok', balance: { amount: 4.5, currency: 'EUR' } },
      { provider: 'claude', status: 'ok', balance: { amount: 2.5 } },
      { provider: 'codex', status: 'ok' }
    ] }
  }, { now: NOW });
  const byProvider = new Map(snapshot.quota.map((provider) => [provider.provider, provider]));

  assert.deepEqual(byProvider.get('deepseek').balance, { amount: 0, currency: 'CNY' });
  for (const provider of ['mimo', 'cursor', 'claude', 'codex']) {
    assert.equal(Object.hasOwn(byProvider.get(provider), 'balance'), false);
  }
});

test('pins the legacy top-level mirror to day and keeps every period addressable', () => {
  // The app's own Today/Month/AllTime tab must not reach the snapshot: each
  // widget picks its period through the AppIntent, so anything that tracked the
  // app's tab would rewrite the file and spend a reload budget on a change no
  // widget renders.
  const snapshot = buildSnapshot(sampleStats(), {
    now: NOW,
    presentation: { defaultPeriod: 'month', currencyCode: 'USD' }
  });
  assert.equal(snapshot.overview.currentPeriod, 'today');
  assert.equal(snapshot.overview.totalTokens, 1_200_000);
  assert.equal(snapshot.presentation.defaultPeriod, undefined);
  assert.equal(snapshot.periods.day.overview.totalTokens, 1_200_000);
  assert.equal(snapshot.periods.month.overview.totalTokens, 9_000_000);
  assert.equal(snapshot.periods.total.overview.totalTokens, 20_000_000);
});

test('keeps day, month and total model data independent', () => {
  const stats = sampleStats();
  stats.periods.month.models = { 'month-model': 7_000_000 };
  stats.periods.allTime.models = { 'total-model': 18_000_000 };
  const snapshot = buildSnapshot(stats, { now: NOW });

  assert.deepEqual(snapshot.periods.day.models.map((model) => model.displayName), ['gpt-5.6', 'MiMo V2 Pro']);
  assert.deepEqual(snapshot.periods.month.models.map((model) => model.displayName), ['month-model']);
  assert.deepEqual(snapshot.periods.total.models.map((model) => model.displayName), ['total-model']);
});

test('keeps up to ten provider and model rows for adaptive widget capacity', () => {
  const stats = sampleStats();
  const providerIds = [
    'codex', 'claude', 'cursor', 'antigravity', 'opencode', 'deepseek',
    'minimax', 'mimo', 'grok', 'copilot', 'kiro', 'zai'
  ];
  stats.limits.providers = providerIds.map((provider, index) => ({
    provider,
    status: 'ok',
    windows: [{ kind: 'weekly', usedPercent: index * 10, resetsAt: '2026-07-20T00:00:00Z' }]
  }));
  stats.periods.today.models = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`model-${String(index + 1).padStart(2, '0')}`, 12 - index])
  );

  const snapshot = buildSnapshot(stats, { now: NOW });
  assert.equal(snapshot.quota.length, 10);
  assert.equal(snapshot.models.length, 10);
});

test('keeps real 28, 90, and 180 day activity ranges, caps at 182, and keeps DAY trend at 7 dates', () => {
  for (const count of [28, 90, 180]) {
    const daily = dailyHistory(count);
    const snapshot = buildSnapshot({ history: { daily } }, { now: NOW });
    assert.equal(snapshot.activity.days.length, count);
    assert.equal(snapshot.activity.days[0].date, daily[0].date);
    assert.equal(snapshot.activity.days.at(-1).date, daily.at(-1).date);
    assert.equal(snapshot.trend.points.length, 7);
  }

  const daily = dailyHistory(190, '2025-12-01');
  const snapshot = buildSnapshot({ history: { daily } }, { now: NOW });
  assert.equal(snapshot.activity.days.length, 182);
  assert.equal(snapshot.activity.days[0].date, daily[8].date);
  assert.equal(snapshot.activity.days.at(-1).date, daily.at(-1).date);
  assert.equal(snapshot.trend.points.length, 7);
});

test('builds a local seven-day Widget trend from live usage without double counting history', () => {
  const now = new Date(2026, 7, 6, 12, 0, 0);
  const stats = {
    periods: {
      today: { totalTokens: 99, costUsd: 0.9 },
      month: { totalTokens: 200, costUsd: 2, models: { monthModel: 200 } },
      allTime: { totalTokens: 300, costUsd: 3, models: { totalModel: 300 } }
    },
    history: { daily: [
      { date: '2026-08-01', tokens: 210, cost: 2.1 },
      { date: '2026-08-05', tokens: 123, cost: 1.5 }
    ] }
  };
  const snapshot = buildSnapshot(stats, { now });

  assert.deepEqual(snapshot.periods.day.trend.points.map((point) => point.date), [
    '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03',
    '2026-08-04', '2026-08-05', '2026-08-06'
  ]);
  assert.deepEqual(snapshot.periods.day.trend.points.map((point) => point.totalTokens), [0, 210, 0, 0, 0, 123, 99]);

  const liveOnly = buildSnapshot({ periods: { today: { totalTokens: 99, costUsd: 0.9 } } }, { now });
  assert.deepEqual(liveOnly.periods.day.trend.points.map((point) => point.totalTokens), [0, 0, 0, 0, 0, 0, 99]);
  assert.equal(snapshot.periods.month.trend.points.length, 2);
  assert.equal(snapshot.periods.total.trend.points.length, 2);
  assert.equal(snapshot.periods.month.models[0].sharePercent, 100);
  assert.equal(snapshot.periods.total.models[0].sharePercent, 100);
});

test('accepts only real UTC calendar dates and lets the last duplicate date win', () => {
  const snapshot = buildSnapshot({ history: { daily: [
    { date: '2026-03-01', tokens: 10, cost: 1 },
    { date: '2026-02-29', tokens: 99, cost: 9.9 },
    { date: '2026-04-31', tokens: 99, cost: 9.9 },
    { date: '2026-02-28', tokens: 1, cost: 0.1 },
    { date: '2024-02-29', tokens: 4, cost: 0.4 },
    { date: '2026-02-28', tokens: 8, cost: 0.8 },
    { date: '2026-01-01T00:00:00Z', tokens: 99, cost: 9.9 }
  ] } }, { now: '2026-03-01T12:00:00.000Z' });

  assert.deepEqual(snapshot.activity.days.map((day) => day.date), [
    '2024-02-29', '2026-02-28', '2026-03-01'
  ]);
  assert.deepEqual(snapshot.trend.points.find((point) => point.date === '2026-02-28'), {
    date: '2026-02-28', totalTokens: 8, costUsd: 0.8
  });
});

test('returns a complete empty schema and stale status for missing or old data', () => {
  const empty = buildSnapshot({}, { now: NOW });
  assert.equal(empty.schemaVersion, 6);
  assert.equal(empty.overview.totalTokens, 0);
  assert.equal(empty.periods.day.overview.totalTokens, 0);
  assert.equal(empty.periods.month.overview.totalTokens, 0);
  assert.equal(empty.periods.total.overview.totalTokens, 0);
  assert.deepEqual(empty.quota, []);
  assert.deepEqual(empty.models, []);
  assert.equal(empty.status.noData, true);

  const stale = buildSnapshot({ updatedAt: '2026-07-17T07:00:00Z' }, { now: NOW });
  assert.equal(stale.status.isStale, true);
  assert.equal(stale.status.dataAgeSeconds, 5400);
});

test('derives Widget freshness from real Hub device sources instead of aggregate updatedAt', () => {
  const now = Date.parse('2026-07-17T10:00:00.000Z');
  const oldStats = aggregateDevices([
    aggregateDevice('old', '2026-07-17T09:00:00.000Z')
  ], 20 * 60 * 1000, now);
  const mixedStats = aggregateDevices([
    aggregateDevice('old', '2026-07-17T09:00:00.000Z'),
    aggregateDevice('new', '2026-07-17T09:55:00.000Z')
  ], 20 * 60 * 1000, now);
  const allStaleStats = aggregateDevices([
    aggregateDevice('old-a', '2026-07-17T09:00:00.000Z'),
    aggregateDevice('old-b', '2026-07-17T09:10:00.000Z')
  ], 20 * 60 * 1000, now);

  assert.equal(oldStats.devices[0].stale, true);
  assert.equal(resolveWidgetSourceFreshness(oldStats, new Date(now)).sourceUpdatedAt, '2026-07-17T09:00:00.000Z');
  const oldSnapshot = buildSnapshot(oldStats, { now: '2026-07-17T10:00:00.000Z' });
  assert.equal(oldSnapshot.status.sourceStale, true);
  assert.equal(oldSnapshot.status.isStale, true);
  assert.equal(oldSnapshot.status.sourceUpdatedAt, '2026-07-17T09:00:00.000Z');
  assert.equal(oldSnapshot.overview.updatedAt, '2026-07-17T09:00:00.000Z');

  const mixedSnapshot = buildSnapshot(mixedStats, { now: '2026-07-17T10:00:00.000Z' });
  assert.equal(mixedSnapshot.status.sourceStale, false);
  assert.equal(mixedSnapshot.status.isStale, false);
  assert.equal(mixedSnapshot.status.sourceUpdatedAt, '2026-07-17T09:55:00.000Z');
  assert.equal(mixedSnapshot.overview.updatedAt, '2026-07-17T09:55:00.000Z');

  const allStaleSnapshot = buildSnapshot(allStaleStats, { now: '2026-07-17T10:00:00.000Z' });
  assert.equal(allStaleSnapshot.status.sourceStale, true);
  assert.equal(allStaleSnapshot.status.isStale, true);
});

test('normalizes invalid values, statuses, names, and percentages', () => {
  const snapshot = buildSnapshot({
    periods: { today: {
      totalTokens: Infinity,
      costUsd: -1,
      models: { '/Users/person/private.db': 50, 'safe-model': 25, 'person@example.com': 10 }
    } },
    limits: { providers: [{ provider: 'claude', status: 'internalState', windows: [
      { kind: 'session', usedPercent: 150, remainingPercent: -10, windowMinutes: -5 },
      { kind: 'unknown', usedPercent: 10 }
    ] }] }
  }, { now: NOW });
  assert.equal(snapshot.overview.totalTokens, 0);
  assert.deepEqual(snapshot.models.map((model) => model.displayName), ['safe-model']);
  assert.equal(snapshot.quota[0].status, 'error');
  assert.deepEqual(snapshot.quota[0].windows[0], {
    kind: 'session', metric: null, showMeter: true,
    usedPercent: 100, remainingPercent: 0, resetsAt: null, windowMinutes: 0
  });
});

test('rejects path, URL, control-character, email, and overlong Widget labels', () => {
  for (const value of [
    '\\\\server\\share', '/Users/private/model', 'file:///private/model',
    'https://internal.example/model', '~/private/model', '../private/model',
    './private/model', 'model\u0000name', 'user@example.com', 'x'.repeat(81)
  ]) {
    assert.equal(isLikelySensitivePathOrUrl(value), true, value);
  }
  assert.equal(isLikelySensitivePathOrUrl('organization/model'), false);
  assert.equal(isLikelySensitivePathOrUrl('provider/model-name'), false);
});

test('normalizes negative or invalid activity totals to zero', () => {
  const snapshot = buildSnapshot({ history: { daily: [
    { date: '2026-07-15', tokens: -10 },
    { date: '2026-07-16', tokens: 'invalid' },
    { date: '2026-07-17', tokens: 37_400_000 }
  ] } }, { now: NOW });

  assert.deepEqual(snapshot.activity.days.map((day) => day.totalTokens), [0, 0, 37_400_000]);
});

test('keeps missing percentages absent instead of coercing them to zero or one hundred', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [{
      provider: 'codex',
      status: 'ok',
      windows: [
        { kind: 'session', usedPercent: null, remainingPercent: null },
        { kind: 'weekly', usedPercent: '', remainingPercent: undefined }
      ]
    }] }
  }, { now: NOW });

  assert.equal(snapshot.quota[0].windows[0].usedPercent, null);
  assert.equal(snapshot.quota[0].windows[0].remainingPercent, null);
  assert.equal(snapshot.quota[0].windows[1].usedPercent, null);
  assert.equal(snapshot.quota[0].windows[1].remainingPercent, null);
});

test('uses explicit allowlists so secrets, identities and raw history never enter App Group', () => {
  const sensitive = [
    'sk-private-api-key', 'session-cookie-value', 'private@example.com',
    'private prompt contents', 'conversation transcript', '/Users/person/private.db'
  ];
  const stats = sampleStats();
  Object.assign(stats, {
    apiKey: sensitive[0], cookie: sensitive[1], prompt: sensitive[3],
    conversation: sensitive[4], credentialPath: sensitive[5]
  });
  stats.periods.today.sessions = { secret: { prompt: sensitive[3] } };
  stats.history.daily[0].prompt = sensitive[3];
  stats.limits.providers[0].token = sensitive[0];
  stats.limits.providers[0].cookie = sensitive[1];
  stats.limits.providers.push({
    provider: 'mimo',
    status: 'ok',
    accountEmail: sensitive[2],
    windows: [],
    balance: {
      amount: 3.62,
      currency: 'CNY',
      apiKey: sensitive[0],
      cookie: sensitive[1],
      accountEmail: sensitive[2],
      rawResponse: { prompt: sensitive[3], path: sensitive[5] }
    }
  });

  const serialized = serializeMacWidgetSnapshot(stats, { now: NOW, history: stats.history });
  for (const value of sensitive) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.endsWith('\n'), true);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.schemaVersion, 6);
  assert.deepEqual(parsed.quota.find((provider) => provider.provider === 'mimo').balance, {
    amount: 3.62,
    currency: 'CNY'
  });
});

test('keeps diagnostics, health, subscriptions, sync failures and sensitive fields out of the Widget Snapshot', () => {
  const stats = sampleStats();
  Object.assign(stats, {
    clientHealth: { status: 'degraded', sourcePath: '/Users/person/client.json' },
    diagnostics: { findings: [{ code: 'sync-failed', detail: 'private diagnostic' }] },
    sourcePaths: ['/Users/person/private.db'],
    selfSync: { failureStage: 'upload', exitCode: 17, detailCode: 'private-detail' },
    subscriptions: [{ id: 'subscription-record', price: 12, period: 'monthly', accountId: 'account-private' }],
    subscriptionsUpdatedAt: '2026-07-17T08:29:00.000Z',
    credentials: { token: 'credential-private' },
    cookies: ['cookie-private'],
    emails: ['private@example.com'],
    prompts: ['private prompt'],
    rawSessions: [{ sessionId: 'session-private' }],
    absolutePath: '/Users/person/private.db'
  });
  stats.devices = [{
    clientHealth: { status: 'ok' },
    diagnostics: { findings: ['finding-private'] },
    sourcePath: '/Users/person/source.json',
    selfSync: { failureStage: 'collect', exitCode: 2, detailCode: 'detail-private' },
    subscriptions: stats.subscriptions
  }];

  const serialized = serializeMacWidgetSnapshot(stats, { now: NOW, history: stats.history });
  const parsed = JSON.parse(serialized);
  const keys = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      visit(child);
    }
  };
  visit(parsed);
  for (const key of [
    'clientHealth', 'diagnostics', 'findings', 'sourcePath', 'sourcePaths',
    'failureStage', 'exitCode', 'detailCode', 'subscriptions', 'subscriptionsUpdatedAt',
    'price', 'period', 'accountId', 'credentials', 'cookie', 'cookies', 'emails',
    'prompts', 'rawSessions', 'absolutePath'
  ]) {
    assert.equal(keys.has(key), false, key);
  }
  for (const value of [
    'private diagnostic', 'finding-private', 'private-detail', 'subscription-record',
    'account-private', 'credential-private', 'cookie-private', 'private prompt',
    'session-private', '/Users/person/private.db'
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
});

test('provider status summarizes configuration and login requirements without identity', () => {
  const snapshot = buildSnapshot({
    limits: { providers: [
      { provider: 'codex', status: 'unauthorized', accountKey: 'private-key' },
      { provider: 'claude', status: 'notConfigured' }
    ] }
  }, { now: NOW });
  assert.equal(snapshot.status.providerConfigured, true);
  assert.equal(snapshot.status.providerNeedsLogin, true);
  assert.equal(JSON.stringify(snapshot).includes('private-key'), false);
});

test('fingerprints business content while ignoring snapshot clock fields', () => {
  const stats = sampleStats();
  const first = buildSnapshot(stats, { now: '2026-07-17T08:30:00Z' });
  const later = buildSnapshot(stats, { now: '2026-07-17T09:30:00Z' });
  assert.equal(macWidgetSnapshotFingerprint(first), macWidgetSnapshotFingerprint(later));

  const tokenChange = structuredClone(stats);
  tokenChange.periods.today.totalTokens += 1;
  assert.notEqual(
    macWidgetSnapshotFingerprint(first),
    macWidgetSnapshotFingerprint(buildSnapshot(tokenChange, { now: NOW }))
  );

  const limitsChange = structuredClone(stats);
  limitsChange.limits.providers[0].windows[0].usedPercent = 36;
  assert.notEqual(
    macWidgetSnapshotFingerprint(first),
    macWidgetSnapshotFingerprint(buildSnapshot(limitsChange, { now: NOW }))
  );

  const presentationChange = buildSnapshot(stats, {
    now: NOW,
    presentation: { currencyCode: 'CNY', currencyRate: 7.1 }
  });
  assert.notEqual(macWidgetSnapshotFingerprint(first), macWidgetSnapshotFingerprint(presentationChange));

  // The app's period tab is the one presentation input the widget cannot
  // render, so it must not reach the fingerprint: every switch would otherwise
  // rewrite the snapshot and spend a WidgetKit reload on nothing.
  const periodTabChange = buildSnapshot(stats, {
    now: NOW,
    presentation: { defaultPeriod: 'month' }
  });
  assert.equal(macWidgetSnapshotFingerprint(first), macWidgetSnapshotFingerprint(periodTabChange));
});

// The snapshot re-declares the supported UI locales as a literal instead of
// importing them, and an unrecognized one silently degrades to 'auto' — so a
// newly added language would reach the widget with the wrong number and unit
// formatting and nothing would fail. AGENTS.md's "Adding a UI locale" checklist
// is guard-test enforced everywhere else; this keeps the widget on that list.
test('the Widget presentation accepts exactly the shipped UI locales', () => {
  const { LANGUAGE_OPTIONS } = require('../../src/electron/renderer/i18n');
  const stats = sampleStats();

  for (const { value } of LANGUAGE_OPTIONS) {
    const snapshot = buildSnapshot(stats, { now: NOW, presentation: { locale: value } });
    assert.equal(snapshot.presentation.locale, value, `locale ${value} should survive`);
  }

  for (const unsupported of ['de', 'zh', 'en-US', '', 'auto ']) {
    const snapshot = buildSnapshot(stats, { now: NOW, presentation: { locale: unsupported } });
    assert.equal(snapshot.presentation.locale, 'auto');
  }
});
