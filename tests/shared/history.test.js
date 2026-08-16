'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sumTokens, num, parseGraphResult, computeIntensities, localDayKey,
  computeStreaks, monthlyRollup, normalizeHistory, mergeHistories
} = require('../../src/shared/history');

function graphFromDays(days) {
  return {
    timeMetrics: {
      totalActiveTimeMs: days.reduce((sum, d) => sum + (d.activeTimeMs || 0), 0),
      longestContinuousMs: 1234,
      maxConcurrentSessions: 2,
      sessionCount: days.length
    },
    contributions: days.map((d) => ({
      date: d.date,
      activeTimeMs: d.activeTimeMs,
      clients: [{ client: d.client || 'claude', modelId: d.model || 'opus', providerId: 'p',
        tokens: { input: d.tokens || 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: d.cost || 0, messages: d.messages || 0 }]
    }))
  };
}

test('num coerces finite numbers and strings, else 0', () => {
  assert.equal(num(5), 5);
  assert.equal(num('12'), 12);
  assert.equal(num('$1,234'), 1234);
  assert.equal(num('nope'), 0);
  assert.equal(num(NaN), 0);
  assert.equal(num(undefined), 0);
});

test('sumTokens adds the additive components and excludes reasoning', () => {
  const b = { input: 10, output: 20, cacheRead: 100, cacheWrite: 5, reasoning: 999 };
  assert.equal(sumTokens(b), 135);
  assert.equal(sumTokens({}), 0);
  assert.equal(sumTokens(null), 0);
});

const SAMPLE = {
  summary: { totalTokens: 1, clients: ['claude', 'codex'], models: [] },
  contributions: [
    {
      date: '2026-06-06',
      totals: { tokens: 9999, cost: 1.5, messages: 4 },
      intensity: 3,
      activeTimeMs: 3600000,
      clients: [
        { client: 'claude', modelId: 'opus', providerId: 'anthropic',
          tokens: { input: 5, output: 20, cacheRead: 4, cacheWrite: 1, reasoning: 7 }, cost: 1.0, messages: 3 },
        { client: 'codex', modelId: 'gpt', providerId: 'openai',
          tokens: { input: 2, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0 }, cost: 0.5, messages: 1 }
      ]
    }
  ]
};

test('parseGraphResult folds client rows into perClient/perModel and derives day totals', () => {
  const { contributions } = parseGraphResult(SAMPLE);
  assert.equal(contributions.length, 1);
  const day = contributions[0];
  assert.equal(day.date, '2026-06-06');
  // day.tokens is derived from perClient (reasoning excluded), NOT totals.tokens
  assert.equal(day.tokens, 40);
  assert.equal(day.cost, 1.5);
  assert.equal(day.messages, 4);
  assert.equal(day.activeTimeMs, 3600000);
  assert.equal(day.cacheReadTokens, 6);
  assert.equal(day.cacheWriteTokens, 2);
  assert.equal(day.outputTokens, 25);
  assert.equal(day.unclassifiedTokens, 0);
  assert.equal(day.tokenComponentsAvailable, true);
  assert.deepEqual(day.perClient.claude, {
    tokens: 30, cost: 1.0, messages: 3,
    unclassifiedTokens: 0,
    cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 20
  });
  assert.deepEqual(day.perClient.codex, {
    tokens: 10, cost: 0.5, messages: 1,
    unclassifiedTokens: 0,
    cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5
  });
  assert.deepEqual(day.perModel.opus, {
    tokens: 30, cost: 1.0,
    unclassifiedTokens: 0,
    cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 20
  });
  assert.deepEqual(day.perModel.gpt, {
    tokens: 10, cost: 0.5,
    unclassifiedTokens: 0,
    cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5
  });
});

test('parseGraphResult is defensive about missing/garbage input', () => {
  assert.deepEqual(parseGraphResult(null), { contributions: [] });
  assert.deepEqual(parseGraphResult({}), { contributions: [] });
  assert.deepEqual(parseGraphResult({ contributions: 'x' }), { contributions: [] });
  const out = parseGraphResult({ contributions: [{ date: '2026-01-01' }] });
  assert.deepEqual(out.contributions[0], {
    date: '2026-01-01', tokens: 0, cost: 0, messages: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 0,
    tokenComponentsAvailable: true,
    activeTimeMs: 0, perClient: {}, perModel: {}
  });
});

test('computeIntensities keeps legacy cost intensity and exposes explicit metrics', () => {
  const days = [
    { date: 'a', tokens: 0, cost: 0 },
    { date: 'b', tokens: 100, cost: 1 },
    { date: 'c', tokens: 50, cost: 4 },
    { date: 'd', tokens: 25, cost: 0.2 }
  ];
  const out = computeIntensities(days);
  assert.deepEqual(out.map((d) => d.tokenIntensity), [0, 4, 3, 2]);
  assert.deepEqual(out.map((d) => d.costIntensity), [0, 2, 4, 1]);
  assert.deepEqual(out.map((d) => d.intensity), [0, 2, 4, 1]);
  // returns the same array reference, mutated in place
  assert.equal(out, days);
});

test('computeIntensities handles token-only and cost-only data independently', () => {
  const tokenOnly = computeIntensities([
    { date: 'a', tokens: 0, cost: 0 },
    { date: 'b', tokens: 10, cost: 0 }
  ]);
  assert.deepEqual(tokenOnly.map((d) => d.tokenIntensity), [0, 4]);
  assert.deepEqual(tokenOnly.map((d) => d.costIntensity), [0, 0]);
  assert.deepEqual(tokenOnly.map((d) => d.intensity), [0, 0]);

  const costOnly = computeIntensities([
    { date: 'a', tokens: 0, cost: 0 },
    { date: 'b', tokens: 0, cost: 10 }
  ]);
  assert.deepEqual(costOnly.map((d) => d.tokenIntensity), [0, 0]);
  assert.deepEqual(costOnly.map((d) => d.costIntensity), [0, 4]);
  assert.deepEqual(costOnly.map((d) => d.intensity), [0, 4]);
});

test('computeIntensities sets all-zero when no tokens and no cost', () => {
  const days = [{ date: 'a', tokens: 0, cost: 0 }, { date: 'b', tokens: 0, cost: 0 }];
  const out = computeIntensities(days);
  assert.deepEqual(out.map((d) => d.intensity), [0, 0]);
  assert.deepEqual(out.map((d) => d.tokenIntensity), [0, 0]);
  assert.deepEqual(out.map((d) => d.costIntensity), [0, 0]);
});

test('computeStreaks counts the run ending at todayKey', () => {
  const days = [
    { date: '2026-06-03', tokens: 5 },
    { date: '2026-06-04', tokens: 5 },
    { date: '2026-06-05', tokens: 0 },   // gap
    { date: '2026-06-06', tokens: 5 },
    { date: '2026-06-07', tokens: 5 }
  ];
  assert.deepEqual(computeStreaks(days, '2026-06-07'), { currentStreak: 2, longestStreak: 2 });
});

test('computeStreaks current=0 when today is inactive', () => {
  const days = [{ date: '2026-06-06', tokens: 5 }];
  assert.deepEqual(computeStreaks(days, '2026-06-07'), { currentStreak: 0, longestStreak: 1 });
});

test('computeStreaks handles empty', () => {
  assert.deepEqual(computeStreaks([], '2026-06-07'), { currentStreak: 0, longestStreak: 0 });
});

test('monthlyRollup sums tokens/cost and merges perClient/perModel by month', () => {
  const days = [
    { date: '2026-05-30', tokens: 10, cost: 1, messages: 2,
      perClient: { claude: { tokens: 10, cost: 1, messages: 2 } },
      perModel: { opus: { tokens: 10, cost: 1 } } },
    { date: '2026-06-01', tokens: 5, cost: 0.5, messages: 1,
      perClient: { claude: { tokens: 5, cost: 0.5, messages: 1 } },
      perModel: { opus: { tokens: 5, cost: 0.5 } } },
    { date: '2026-06-02', tokens: 7, cost: 0.7, messages: 1,
      perClient: { codex: { tokens: 7, cost: 0.7, messages: 1 } },
      perModel: { gpt: { tokens: 7, cost: 0.7 } } }
  ];
  const out = monthlyRollup(days);
  assert.equal(out.length, 2);
  assert.equal(out[0].month, '2026-05');
  assert.equal(out[1].month, '2026-06');
  assert.equal(out[1].tokens, 12);
  assert.deepEqual(out[1].perClient.claude, { tokens: 5, cost: 0.5, messages: 1 });
  assert.deepEqual(out[1].perClient.codex, { tokens: 7, cost: 0.7, messages: 1 });
  assert.deepEqual(out[1].perModel.opus, { tokens: 5, cost: 0.5 });
});

test('normalizeHistory caps daily but keeps monthly/summary full', () => {
  const graph = graphFromDays([
    { date: '2024-01-01', tokens: 100, cost: 5, model: 'opus', messages: 1, activeTimeMs: 60000 },  // old
    { date: '2026-06-06', tokens: 10, cost: 1, model: 'sonnet', messages: 2, activeTimeMs: 120000 },
    { date: '2026-06-07', tokens: 30, cost: 3, model: 'opus', messages: 2, activeTimeMs: 180000 }
  ]);
  const h = normalizeHistory(parseGraphResult(graph), { capDays: 30, todayKey: '2026-06-07' });

  // daily: old day dropped by the 30-day cap, recent two kept, asc
  assert.deepEqual(h.daily.map((d) => d.date), ['2026-06-06', '2026-06-07']);
  assert.equal(h.daily[1].intensity, 4); // highest cost day
  assert.equal(h.daily[1].activeTimeMs, 180000);

  // monthly: uncapped -> includes 2024-01
  assert.deepEqual(h.monthly.map((m) => m.month), ['2024-01', '2026-06']);
  assert.equal(h.monthly[1].activeTimeMs, 300000);

  // summary: lifetime figures from the full set
  assert.equal(h.summary.totalTokens, 140);
  assert.equal(h.summary.totalCost, 9);
  assert.equal(h.summary.activeDays, 3);
  assert.equal(h.summary.peakDayTokens, 100);
  assert.equal(h.summary.messages, 5);
  assert.equal(h.summary.favoriteModel, 'opus'); // 100 + 30 tokens
  assert.equal(h.summary.currentStreak, 2);      // 06-06 & 06-07 consecutive, ending today
  assert.equal(h.summary.longestStreak, 2);      // 06-06,06-07
  assert.equal(h.summary.activeTimeMs, 360000);
  assert.deepEqual(h.summary.timeMetrics, {
    totalActiveTimeMs: 360000,
    longestContinuousMs: 1234,
    maxConcurrentSessions: 2,
    sessionCount: 3
  });
});

test('normalizeHistory tolerates empty', () => {
  const h = normalizeHistory({ contributions: [] }, { todayKey: '2026-06-07' });
  assert.deepEqual(h.daily, []);
  assert.deepEqual(h.monthly, []);
  assert.equal(h.summary.totalTokens, 0);
  assert.equal(h.summary.favoriteModel, '');
});

test('mergeHistories sums daily across devices and recomputes derived fields', () => {
  const dev1 = normalizeHistory(parseGraphResult(graphFromDays([
    { date: '2026-06-06', tokens: 10, cost: 1, model: 'opus', client: 'claude', messages: 1, activeTimeMs: 60000 },
    { date: '2026-06-07', tokens: 20, cost: 2, model: 'opus', client: 'claude', messages: 1, activeTimeMs: 120000 }
  ])), { todayKey: '2026-06-07' });
  const dev2 = normalizeHistory(parseGraphResult(graphFromDays([
    { date: '2026-06-07', tokens: 5, cost: 0.5, model: 'gpt', client: 'codex', messages: 1, activeTimeMs: 30000 }
  ])), { todayKey: '2026-06-07' });

  const m = mergeHistories([dev1, dev2], { todayKey: '2026-06-07' });

  assert.deepEqual(m.daily.map((d) => d.date), ['2026-06-06', '2026-06-07']);
  const d7 = m.daily.find((d) => d.date === '2026-06-07');
  assert.equal(d7.tokens, 25);                         // 20 + 5
  assert.equal(d7.activeTimeMs, 150000);                // 120000 + 30000
  assert.deepEqual(d7.perClient.claude, { tokens: 20, cost: 2, messages: 1 });
  assert.deepEqual(d7.perClient.codex, { tokens: 5, cost: 0.5, messages: 1 });
  assert.equal(d7.intensity, 4);                       // highest-cost merged day
  assert.equal(m.summary.totalTokens, 35);
  assert.equal(m.summary.currentStreak, 2);
  assert.equal(m.summary.peakDayTokens, 25);
  assert.equal(m.summary.activeTimeMs, 210000);
});

test('mergeHistories preserves known components beside legacy unclassified usage', () => {
  const exact = {
    daily: [{
      date: '2026-06-07',
      tokens: 100,
      cost: 1,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      outputTokens: 20,
      unclassifiedTokens: 0,
      tokenComponentsAvailable: true,
      perClient: { claude: {
        tokens: 100, cost: 1, messages: 1,
        cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20,
        unclassifiedTokens: 0
      } },
      perModel: { opus: {
        tokens: 100, cost: 1,
        cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20,
        unclassifiedTokens: 0
      } }
    }],
    monthly: [{ month: '2026-06', tokens: 100, cost: 1, perClient: {}, perModel: {} }],
    summary: {}
  };
  const legacy = {
    daily: [{
      date: '2026-06-07',
      tokens: 50,
      cost: 0.5,
      perClient: { claude: { tokens: 50, cost: 0.5, messages: 1 } },
      perModel: { opus: { tokens: 50, cost: 0.5 } }
    }],
    monthly: [{ month: '2026-06', tokens: 50, cost: 0.5, perClient: {}, perModel: {} }],
    summary: {}
  };

  const merged = mergeHistories([exact, legacy], { todayKey: '2026-06-07' });
  const day = merged.daily[0];

  assert.equal(day.tokens, 150);
  assert.equal(day.cacheReadTokens, 60);
  assert.equal(day.cacheWriteTokens, 10);
  assert.equal(day.outputTokens, 20);
  assert.equal(day.unclassifiedTokens, 50);
  assert.equal(day.tokenComponentsAvailable, false);
  assert.equal(day.perClient.claude.cacheReadTokens, 60);
  assert.equal(day.perClient.claude.unclassifiedTokens, 50);
  assert.equal(day.perModel.opus.outputTokens, 20);
  assert.equal(day.perModel.opus.unclassifiedTokens, 50);
});

test('mergeHistories handles empty list', () => {
  const m = mergeHistories([], { todayKey: '2026-06-07' });
  assert.deepEqual(m.daily, []);
  assert.deepEqual(m.monthly, []);
  assert.equal(m.summary.totalTokens, 0);
});

// A formatter smoke test: it derives `expected` the same way localDayKey() does, so it
// pins the zero-padded shape and nothing about which calendar the key belongs to. The
// local-vs-UTC behaviour is covered in historyDayBoundary.test.js, which fixes the
// timezone and the instant so the two calendars actually disagree.
test('localDayKey renders a zero-padded calendar day', () => {
  const at = new Date('2026-06-07T23:30:00.000Z');
  const expected = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  assert.equal(localDayKey(at), expected);
  assert.match(localDayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

// aggregateHistory() calls mergeHistories() with no todayKey, so the default decides the
// rolling window and the streak walk for every widget, hub and Worker read. Contributions
// are keyed by local day, so a UTC default drops the current local day east of UTC and
// starts the streak walk on an empty day west of it.
test('mergeHistories defaults todayKey to the local day', () => {
  const history = {
    daily: [{ date: localDayKey(), tokens: 10, cost: 1, perClient: {}, perModel: {} }],
    monthly: [],
    summary: {}
  };
  const defaulted = mergeHistories([history]);
  assert.deepEqual(defaulted.daily.map((d) => d.date), [localDayKey()]);
  assert.equal(defaulted.summary.currentStreak, 1);
  assert.deepEqual(defaulted, mergeHistories([history], { todayKey: localDayKey() }));
});

test('normalizeHistory defaults todayKey to the local day', () => {
  const graph = parseGraphResult(graphFromDays([{ date: localDayKey(), tokens: 10, cost: 1, messages: 1 }]));
  assert.deepEqual(normalizeHistory(graph).daily.map((d) => d.date), [localDayKey()]);
  assert.deepEqual(normalizeHistory(graph), normalizeHistory(graph, { todayKey: localDayKey() }));
});

const {
  coerceHistory, deviceHistoryRevision, historyPreview, historyRevision
} = require('../../src/shared/history');

test('mergeHistories re-caps stale device daily rows without losing lifetime totals', () => {
  const history = {
    daily: [
      { date: '2025-05-01', tokens: 100, cost: 5, perClient: {}, perModel: {} },
      { date: '2026-06-07', tokens: 10, cost: 1, perClient: {}, perModel: {} }
    ],
    monthly: [
      { month: '2025-05', tokens: 100, cost: 5, perClient: {}, perModel: {} },
      { month: '2026-06', tokens: 10, cost: 1, perClient: {}, perModel: {} }
    ],
    summary: {}
  };
  const merged = mergeHistories([history], { todayKey: '2026-06-07', capDays: 370 });
  assert.deepEqual(merged.daily.map((day) => day.date), ['2026-06-07']);
  assert.equal(merged.summary.activeDays, 1);
  assert.equal(merged.summary.peakDayTokens, 10);
  assert.equal(merged.summary.totalTokens, 110);
});

test('historyRevision is key-order stable and tracks breakdown changes', () => {
  const first = { daily: [{ date: '2026-06-07', tokens: 10, perClient: { codex: { tokens: 10 } } }], monthly: [], summary: { totalTokens: 10 } };
  const reordered = { summary: { totalTokens: 10 }, monthly: [], daily: [{ perClient: { codex: { tokens: 10 } }, tokens: 10, date: '2026-06-07' }] };
  const changed = { ...first, daily: [{ date: '2026-06-07', tokens: 10, perClient: { claude: { tokens: 10 } } }] };
  assert.equal(historyRevision(first), historyRevision(reordered));
  assert.notEqual(historyRevision(first), historyRevision(changed));
});

test('deviceHistoryRevision tracks device identity and explicit History state', () => {
  const history = { daily: [{ date: '2026-06-07', tokens: 10 }], monthly: [], summary: {} };
  const first = deviceHistoryRevision([
    { deviceId: 'mac', history },
    { deviceId: 'pc', history: null }
  ]);
  assert.equal(first, deviceHistoryRevision([
    { deviceId: 'pc', history: null },
    { deviceId: 'mac', history }
  ]));
  assert.notEqual(first, deviceHistoryRevision([
    { deviceId: 'mac', history: null },
    { deviceId: 'pc', history }
  ]));
  assert.notEqual(
    deviceHistoryRevision([{ deviceId: 'mac' }]),
    deviceHistoryRevision([{ deviceId: 'mac', history: null }])
  );
  assert.notEqual(
    deviceHistoryRevision([{ deviceId: 'mac', historyAvailable: false, history: null }]),
    deviceHistoryRevision([{ deviceId: 'mac', historyAvailable: true, history }])
  );
});

test('coerceHistory normalizes shape and drops garbage', () => {
  assert.deepEqual(coerceHistory(null), { daily: [], monthly: [], summary: {} });
  assert.deepEqual(coerceHistory({ daily: 'x' }), { daily: [], monthly: [], summary: {} });
  const ok = { daily: [{ date: '2026-06-07', tokens: 1 }], monthly: [{ month: '2026-06', tokens: 1 }], summary: { totalTokens: 1 } };
  assert.deepEqual(coerceHistory(ok), ok);
});

test('historyPreview keeps recent totals only (no per-client)', () => {
  const daily = [];
  for (let i = 1; i <= 40; i++) {
    const date = `2026-06-${String(i).padStart(2, '0')}`;
    daily.push({ date, tokens: i, cost: i / 10, activeTimeMs: i * 1000, intensity: 1, perClient: { claude: { tokens: i } }, perModel: {} });
  }
  const history = { daily, monthly: [{ month: '2026-05', tokens: 9, cost: 1, perClient: { claude: { tokens: 9 } } }],
    summary: { totalTokens: 100 } };
  const p = historyPreview(history, { dailyDays: 30, monthlyMonths: 12 });
  assert.equal(p.daily.length, 30);                 // last 30 of 40
  assert.equal(p.daily[0].date, '2026-06-11');      // 40 - 30 + 1 = 11th
  assert.deepEqual(p.daily[29], { date: '2026-06-40', tokens: 40, cost: 4, activeTimeMs: 40000 });
  assert.equal(p.daily[0].perClient, undefined);    // stripped
  assert.deepEqual(p.monthly[0], { month: '2026-05', tokens: 9, cost: 1, activeTimeMs: 0 });
  assert.deepEqual(p.summary, { totalTokens: 100 });
});

test('historyPreview defaults to the compact 30-day daily window', () => {
  const history = {
    daily: Array.from({ length: 31 }, (_, index) => ({
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      tokens: index + 1
    })),
    monthly: [],
    summary: {}
  };
  const preview = historyPreview(history);
  assert.equal(preview.daily.length, 30);
  assert.equal(preview.daily[0].date, '2026-07-02');
});
