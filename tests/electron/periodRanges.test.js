'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dailyRowsForSelection,
  currentDayKey,
  deriveRangeSnapshot,
  derivePeriod,
  displayLabel,
  effectiveSelection,
  mergePeriods,
  normalizeDateRange,
  normalizeMode,
  rangeForSelection,
  rangeSummary,
  supportsBreakdown,
  weekStartsOn
} = require('../../src/electron/renderer/periodRanges');

const daily = [
  {
    date: '2026-08-05', tokens: 10, cost: 1, activeTimeMs: 100,
    perClient: { codex: { tokens: 10, cost: 1 } },
    perModel: { 'gpt-5': { tokens: 10, cost: 1 } }
  },
  {
    date: '2026-08-06', tokens: 20, cost: 2, activeTimeMs: 200,
    perClient: { claude: { tokens: 20, cost: 2 } },
    perModel: { opus: { tokens: 20, cost: 2 } }
  },
  {
    date: '2026-08-10', tokens: 30, cost: 3, activeTimeMs: 300,
    perClient: { codex: { tokens: 30, cost: 3 } },
    perModel: { 'gpt-5': { tokens: 30, cost: 3 } }
  },
  {
    date: '2026-08-11', tokens: 1, cost: 0.1, activeTimeMs: 400,
    perClient: { codex: { tokens: 1, cost: 0.1, messages: 2 } },
    perModel: { 'gpt-5': { tokens: 1, cost: 0.1 } }
  }
];

const nativeToday = {
  totalTokens: 40,
  costUsd: 4,
  capabilities: { tokenComponents: true, clientModels: true },
  clients: { codex: 25, claude: 15 },
  clientCosts: { codex: 2.5, claude: 1.5 },
  models: { 'gpt-5': 25, opus: 15 },
  modelCosts: { 'gpt-5': 2.5, opus: 1.5 }
};

test('period range modes stay inside their three fixed selector families', () => {
  assert.equal(normalizeMode('today', 'last7'), 'today');
  assert.equal(normalizeMode('month', 'week'), 'week');
  assert.equal(normalizeMode('month', 'last7'), 'last7');
  assert.equal(normalizeMode('month', 'range'), 'month');
  assert.equal(normalizeMode('allTime', 'range'), 'range');
  assert.equal(displayLabel('week'), 'WEEK');
  assert.equal(displayLabel('last7'), '7D');
  assert.equal(displayLabel('range'), 'RANGE');
});

test('derived choices fail closed to native periods when history is disabled', () => {
  assert.equal(effectiveSelection('month', { periodMonthMode: 'week' }, { historyEnabled: false }), 'month');
  assert.equal(effectiveSelection('month', { periodMonthMode: 'last30' }, { historyEnabled: false }), 'month');
  assert.equal(effectiveSelection('allTime', { periodTotalMode: 'range' }, { historyEnabled: false }), 'allTime');
  assert.equal(effectiveSelection('month', { periodMonthMode: 'last7' }, { historyEnabled: true }), 'last7');
});

test('derived ranges keep navigation visible but do not expose unsupported detail rows', () => {
  for (const selection of ['week', 'last7', 'last30', 'range']) {
    assert.equal(supportsBreakdown(selection, 'device'), true);
    assert.equal(supportsBreakdown(selection, 'tool'), true);
    assert.equal(supportsBreakdown(selection, 'model'), true);
    assert.equal(supportsBreakdown(selection, 'project'), false);
    assert.equal(supportsBreakdown(selection, 'session'), false);
  }
  assert.equal(supportsBreakdown('month', 'project'), true);
  assert.equal(supportsBreakdown('allTime', 'session'), true);
});

test('this week follows the locale first day and ends today', () => {
  assert.equal(weekStartsOn('en-US'), 0);
  assert.equal(weekStartsOn('en-GB'), 1);
  assert.deepEqual(rangeForSelection('week', { todayKey: '2026-08-11', locale: 'en-US' }), {
    start: '2026-08-09',
    end: '2026-08-11'
  });
  assert.deepEqual(rangeForSelection('week', { todayKey: '2026-08-11', locale: 'en-GB' }), {
    start: '2026-08-10',
    end: '2026-08-11'
  });
});

test('last 7 days means today plus the previous six local date keys', () => {
  assert.deepEqual(rangeForSelection('last7', { todayKey: '2026-08-11' }), {
    start: '2026-08-05',
    end: '2026-08-11'
  });
  assert.deepEqual(
    dailyRowsForSelection(daily, { selection: 'last7', todayKey: '2026-08-11', nativeToday })
      .map((row) => row.date),
    ['2026-08-05', '2026-08-06', '2026-08-10', '2026-08-11']
  );
});

test('remote device ranges advance only with a reliable device calendar', () => {
  const now = new Date('2026-08-11T16:30:00.000Z');
  assert.equal(currentDayKey({ today: {
    key: '2026-08-11',
    endsAt: '2026-08-11T16:00:00.000Z',
    timeZone: 'Asia/Hong_Kong'
  } }, now), '2026-08-12');
  assert.equal(currentDayKey({ today: {
    key: '2026-08-11',
    endsAt: '2026-08-12T00:00:00.000Z'
  } }, new Date('2026-08-11T20:00:00.000Z')), '2026-08-11');
  assert.equal(currentDayKey({ today: {
    key: '2026-08-10',
    endsAt: '2026-08-11T00:00:00.000Z'
  } }, now), '');
});

test('offline device does not patch an expired today snapshot onto the next local day', () => {
  const snapshot = deriveRangeSnapshot([{
    periodWindows: { today: {
      key: '2026-08-11',
      endsAt: '2026-08-11T16:00:00.000Z',
      timeZone: 'Asia/Hong_Kong'
    } },
    history: { daily: [{
      date: '2026-08-11', tokens: 100, cost: 1,
      capabilities: { tokenComponents: true, clientModels: true }
    }] },
    nativeToday: {
      totalTokens: 100,
      costUsd: 1,
      capabilities: { tokenComponents: true, clientModels: true }
    }
  }], {
    status: 'ready',
    selection: 'last7',
    now: new Date('2026-08-11T16:30:00.000Z')
  });

  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.period.totalTokens, 100);
  assert.deepEqual(snapshot.daily.map((row) => [row.date, row.tokens]), [['2026-08-11', 100]]);
});

test('expired legacy device calendar fails closed instead of switching to UTC', () => {
  const snapshot = deriveRangeSnapshot([{
    periodWindows: { today: {
      key: '2026-08-11',
      endsAt: '2026-08-11T16:00:00.000Z'
    } },
    history: { daily: [{ date: '2026-08-11', tokens: 100 }] },
    nativeToday: { totalTokens: 100 }
  }], {
    status: 'ready',
    selection: 'last7',
    now: new Date('2026-08-11T16:30:00.000Z')
  });

  assert.deepEqual(snapshot, {
    status: 'unavailable',
    period: null,
    daily: [],
    summary: null
  });
});

test('derived periods patch today from live stats and retain client/model attribution', () => {
  const period = derivePeriod(daily, {
    selection: 'last7',
    todayKey: '2026-08-11',
    nativeToday
  });
  assert.equal(period.totalTokens, 100);
  assert.equal(period.costUsd, 10);
  assert.deepEqual(period.clients, { codex: 65, claude: 35 });
  assert.deepEqual(period.clientCosts, { codex: 6.5, claude: 3.5 });
  assert.deepEqual(period.models, { 'gpt-5': 65, opus: 35 });
  assert.deepEqual(period.modelCosts, { 'gpt-5': 6.5, opus: 3.5 });
  assert.deepEqual(period.sessions, {});
  assert.deepEqual(period.projects, {});
});

test('derived periods retain cache/output and client-to-model dimensions when history supports them', () => {
  const history = [{
    date: '2026-08-10',
    tokens: 100,
    cost: 5,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    capabilities: { tokenComponents: true, clientModels: true },
    perClient: {
      codex: {
        tokens: 100, cost: 5, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20
      }
    },
    perModel: {
      'gpt-5': {
        tokens: 100, cost: 5, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20
      }
    },
    perClientModel: { codex: { 'gpt-5': { tokens: 100, cost: 5 } } }
  }];
  const period = derivePeriod(history, {
    selection: 'last7',
    todayKey: '2026-08-11',
    // An incomplete day elsewhere in the retained archive must not suppress
    // the exact rows selected here.
    capabilities: { tokenComponents: false, clientModels: false }
  });
  assert.deepEqual(period.capabilities, { tokenComponents: true, clientModels: true });
  assert.equal(period.cacheReadTokens, 60);
  assert.equal(period.clientCacheReads.codex, 60);
  assert.equal(period.modelOutputs['gpt-5'], 20);
  assert.deepEqual(period.clientModels, { codex: { 'gpt-5': 100 } });
  assert.deepEqual(period.clientModelCosts, { codex: { 'gpt-5': 5 } });
});

test('derived periods mark legacy token components unavailable instead of treating missing fields as exact zero', () => {
  const period = derivePeriod(daily, {
    selection: 'last7',
    todayKey: '2026-08-11',
    nativeToday,
    capabilities: { clientModels: true }
  });
  assert.deepEqual(period.capabilities, { tokenComponents: false, clientModels: false });
});

test('legacy native today does not upgrade missing token components to exact zero', () => {
  const period = derivePeriod([], {
    selection: 'last7',
    todayKey: '2026-08-11',
    nativeToday: {
      totalTokens: 100,
      clients: { codex: 100 },
      models: { 'gpt-5': 100 }
    }
  });

  assert.deepEqual(period.capabilities, { tokenComponents: false, clientModels: false });
  assert.equal(period.totalTokens, 100);
  assert.equal(period.unclassifiedTokens, 100);
  assert.equal(period.clientUnclassifiedTokens.codex, 100);
  assert.equal(period.modelUnclassifiedTokens['gpt-5'], 100);
  assert.equal(period.cacheReadTokens, 0);
  assert.equal(period.outputTokens, 0);
});

test('derived capabilities require every selected history row to be explicitly complete', () => {
  const period = derivePeriod([
    {
      date: '2026-08-10', tokens: 10, cost: 1,
      capabilities: { tokenComponents: true, clientModels: true }
    },
    {
      date: '2026-08-11', tokens: 20, cost: 2,
      capabilities: { tokenComponents: false, clientModels: true }
    }
  ], {
    selection: 'last7',
    todayKey: '2026-08-11',
    capabilities: { tokenComponents: true, clientModels: true }
  });

  assert.deepEqual(period.capabilities, { tokenComponents: false, clientModels: true });
});

test('derived periods preserve classified components and isolate the unavailable remainder', () => {
  const period = derivePeriod([{
    date: '2026-08-10', tokens: 100, cost: 5,
    cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 20,
    unclassifiedTokens: 10,
    capabilities: { tokenComponents: false, clientModels: true },
    perClient: {
      codex: {
        tokens: 100, cost: 5, cacheReadTokens: 30, cacheWriteTokens: 0,
        outputTokens: 20, unclassifiedTokens: 10
      }
    },
    perModel: {
      'gpt-5': {
        tokens: 100, cost: 5, cacheReadTokens: 30, cacheWriteTokens: 0,
        outputTokens: 20, unclassifiedTokens: 10
      }
    }
  }], {
    selection: 'last7',
    todayKey: '2026-08-11'
  });

  assert.equal(period.unclassifiedTokens, 10);
  assert.equal(period.clientUnclassifiedTokens.codex, 10);
  assert.equal(period.modelUnclassifiedTokens['gpt-5'], 10);
  assert.equal(period.cacheReadTokens, 30);
  assert.equal(period.outputTokens, 20);
});

test('period aggregation preserves per-device range results and rejects prototype keys', () => {
  const unsafe = JSON.parse('{"__proto__":{"tokens":5,"cost":1},"codex":{"tokens":10,"cost":2}}');
  const first = derivePeriod([{
    date: '2026-08-11', tokens: 15, cost: 3,
    capabilities: { tokenComponents: true, clientModels: true },
    perClient: unsafe,
    perModel: {},
    perClientModel: {}
  }], {
    selection: 'last7', todayKey: '2026-08-11',
    capabilities: { tokenComponents: true, clientModels: true }
  });
  const merged = mergePeriods([first, {
    ...first,
    totalTokens: 2,
    costUsd: 0.5,
    clients: { claude: 2 },
    clientCosts: { claude: 0.5 }
  }]);
  assert.equal(Object.prototype.tokens, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(first.clients, '__proto__'), true);
  assert.equal(merged.totalTokens, 17);
  assert.equal(merged.clients.__proto__, 5);
  assert.equal(merged.clients.codex, 10);
  assert.equal(merged.clients.claude, 2);
});

test('custom ranges are inclusive and reject malformed or reversed dates', () => {
  assert.deepEqual(normalizeDateRange('2026-08-06', '2026-08-10'), {
    start: '2026-08-06',
    end: '2026-08-10'
  });
  assert.equal(normalizeDateRange('2026-08-10', '2026-08-06'), null);
  assert.equal(normalizeDateRange('2026-02-30', '2026-08-06'), null);
  const period = derivePeriod(daily, {
    selection: 'range',
    todayKey: '2026-08-11',
    rangeStart: '2026-08-06',
    rangeEnd: '2026-08-10',
    nativeToday
  });
  assert.equal(period.totalTokens, 50);
  assert.equal(period.costUsd, 5);
});

test('derived snapshots never turn unavailable full history into a preview-sized zero', () => {
  const snapshot = deriveRangeSnapshot([{
    history: { daily },
    periodWindows: { today: { timeZone: 'Asia/Hong_Kong' } }
  }], {
    status: 'unavailable',
    selection: 'range',
    rangeStart: '2026-03-01',
    rangeEnd: '2026-03-31'
  });

  assert.deepEqual(snapshot, {
    status: 'unavailable',
    period: null,
    daily: [],
    summary: null
  });
});

test('cross-timezone derived snapshots use the same selected rows for headline and Trends', () => {
  const now = new Date('2026-08-11T16:30:00.000Z');
  const snapshot = deriveRangeSnapshot([
    {
      periodWindows: { today: { timeZone: 'Asia/Taipei' } },
      history: { daily: [
        { date: '2026-08-06', tokens: 6 },
        { date: '2026-08-12', tokens: 12 }
      ] }
    },
    {
      periodWindows: { today: { timeZone: 'America/New_York' } },
      history: { daily: [
        { date: '2026-08-05', tokens: 5 },
        { date: '2026-08-11', tokens: 11 }
      ] }
    }
  ], {
    status: 'ready',
    selection: 'last7',
    locale: 'en-US',
    now
  });

  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.period.totalTokens, 34);
  assert.equal(snapshot.daily.reduce((sum, row) => sum + row.tokens, 0), snapshot.period.totalTokens);
  assert.deepEqual(snapshot.daily.map((row) => row.date), [
    '2026-08-05', '2026-08-06', '2026-08-11', '2026-08-12'
  ]);
  assert.equal(snapshot.summary.activeDays, 4);
  assert.equal(snapshot.summary.peakDayTokens, 12);
});

test('range summaries describe only selected daily rows', () => {
  assert.deepEqual(rangeSummary(daily, {
    selection: 'range',
    todayKey: '2026-08-11',
    rangeStart: '2026-08-10',
    rangeEnd: '2026-08-11',
    nativeToday
  }), {
    activeDays: 2,
    currentStreak: 2,
    activeTimeMs: 700,
    peakDayTokens: 40
  });
});
