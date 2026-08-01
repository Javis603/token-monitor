'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAC_WIDGET_SCHEMA_VERSION,
  buildMacWidgetSnapshot,
  macWidgetSnapshotFingerprint,
  serializeMacWidgetSnapshot
} = require('../../src/shared/macWidgetSnapshot');

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

test('builds schema v5 overview, quota, models, activity, trend and presentation', () => {
  const snapshot = buildSnapshot(sampleStats(), {
    now: NOW,
    presentation: {
      defaultPeriod: 'today', currencyCode: 'CNY', currencyRate: 7.1,
      compactNumbers: true, showCost: true, locale: 'zh-CN', theme: 'custom'
    }
  });

  assert.equal(snapshot.schemaVersion, MAC_WIDGET_SCHEMA_VERSION);
  assert.equal(MAC_WIDGET_SCHEMA_VERSION, 5);
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
  assert.equal(snapshot.trend.currentTokens, 50);
  assert.equal(snapshot.trend.peakTokens, 200);
  assert.deepEqual(snapshot.presentation, {
    defaultPeriod: 'today', currencyCode: 'CNY', currencySymbol: '¥', currencyRate: 7.1,
    numberStyle: 'compact', showCost: true, locale: 'zh-CN', theme: 'custom'
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

test('chooses the configured period without duplicating aggregation logic', () => {
  const snapshot = buildSnapshot(sampleStats(), {
    now: NOW,
    presentation: { defaultPeriod: 'month' }
  });
  assert.equal(snapshot.overview.currentPeriod, 'month');
  assert.equal(snapshot.overview.totalTokens, 9_000_000);
  assert.equal(snapshot.periods.day.overview.totalTokens, 1_200_000);
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

test('keeps real 28, 90, and 180 day activity ranges, caps at 182, and leaves trend at 28', () => {
  for (const count of [28, 90, 180]) {
    const daily = dailyHistory(count);
    const snapshot = buildSnapshot({ history: { daily } }, { now: NOW });
    assert.equal(snapshot.activity.days.length, count);
    assert.equal(snapshot.activity.days[0].date, daily[0].date);
    assert.equal(snapshot.activity.days.at(-1).date, daily.at(-1).date);
    assert.equal(snapshot.trend.points.length, 28);
  }

  const daily = dailyHistory(190, '2025-12-01');
  const snapshot = buildSnapshot({ history: { daily } }, { now: NOW });
  assert.equal(snapshot.activity.days.length, 182);
  assert.equal(snapshot.activity.days[0].date, daily[8].date);
  assert.equal(snapshot.activity.days.at(-1).date, daily.at(-1).date);
  assert.equal(snapshot.trend.points.length, 28);
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
  ] } }, { now: NOW });

  assert.deepEqual(snapshot.activity.days.map((day) => day.date), [
    '2024-02-29', '2026-02-28', '2026-03-01'
  ]);
  assert.deepEqual(snapshot.trend.points.find((point) => point.date === '2026-02-28'), {
    date: '2026-02-28', totalTokens: 8, costUsd: 0.8
  });
});

test('returns a complete empty schema and stale status for missing or old data', () => {
  const empty = buildSnapshot({}, { now: NOW });
  assert.equal(empty.schemaVersion, 5);
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
  assert.equal(parsed.schemaVersion, 5);
  assert.deepEqual(parsed.quota.find((provider) => provider.provider === 'mimo').balance, {
    amount: 3.62,
    currency: 'CNY'
  });
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
    presentation: { defaultPeriod: 'month' }
  });
  assert.notEqual(macWidgetSnapshotFingerprint(first), macWidgetSnapshotFingerprint(presentationChange));
});
