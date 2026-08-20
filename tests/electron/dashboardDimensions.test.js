'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  hasClientModel, sumField, rankedEntries, filterDaily, drillRows, crossMatrix,
  resolveRange, sliceDaily, groupDaily, previousRange, windowSummary, compareSummary,
  weekdayTotals, filterWeekday, utcWeekday,
  compactDashboardSessions, filterSessions, hourTotals, slotTotals, weekdayHourGrid, usagePortrait
} = require('../../src/electron/renderer/dashboardDimensions');

test('previousRange is the equal-length window immediately before', () => {
  assert.deepEqual(previousRange({ start: '2026-06-01', end: '2026-06-07' }), {
    start: '2026-05-25', end: '2026-05-31'
  });
  assert.deepEqual(previousRange({ start: '2026-06-07', end: '2026-06-07' }), {
    start: '2026-06-06', end: '2026-06-06'
  });
});

test('windowSummary and compareSummary describe a sliced window', () => {
  const summary = windowSummary(daily, { endKey: '2026-06-02' });
  assert.equal(summary.totalTokens, 60);
  assert.equal(summary.totalCost, 6);
  assert.equal(summary.activeDays, 2);
  assert.equal(summary.favoriteModel, 'opus');
  assert.equal(summary.currentStreak, 2);
  assert.equal(summary.outputTokPerSec, 0);
  assert.equal(summary.outputTokens, 0);
  const vsEmpty = compareSummary(summary, windowSummary([]));
  assert.equal(vsEmpty.totalTokens.ratio, null);
  assert.equal(vsEmpty.totalTokens.delta, 60);
  const vsSame = compareSummary(summary, summary);
  assert.equal(vsSame.totalTokens.ratio, 0);
  const vsHalf = compareSummary(summary, { totalTokens: 30, totalCost: 3 });
  assert.equal(vsHalf.totalTokens.ratio, 1);
});

test('windowSummary divides timed output by duration at the display boundary', () => {
  const summary = windowSummary([
    { date: '2026-06-01', tokens: 10, timedOutputTokens: 40, timedDurationMs: 1000 },
    { date: '2026-06-02', tokens: 20, timedOutputTokens: 80, timedDurationMs: 3000 }
  ], { endKey: '2026-06-02' });
  assert.equal(summary.outputTokPerSec, 30);
});

test('windowSummary sums output tokens from the day row or per-client fallback', () => {
  const summary = windowSummary([
    { date: '2026-06-01', tokens: 10, outputTokens: 4 },
    { date: '2026-06-02', tokens: 20, perClient: { claude: { outputTokens: 7 }, cursor: { outputTokens: 2 } } }
  ]);
  assert.equal(summary.outputTokens, 13);
});

test('weekdayTotals follows the locale week start', () => {
  const mondayFirst = weekdayTotals(daily, { firstDay: 1 });
  assert.deepEqual(mondayFirst.map((row) => [row.weekday, row.tokens]), [
    [1, 40], [2, 20], [3, 0], [4, 0], [5, 0], [6, 0], [0, 0]
  ]);
  assert.equal(filterWeekday(daily, 1)[0].date, '2026-06-01');
  assert.equal(filterWeekday(daily, null).length, 2);
  assert.equal(utcWeekday('2026-06-01'), 1);
});

test('resolveRange and sliceDaily use a calendar window, not a record count', () => {
  const rows = [
    { date: '2026-05-01', tokens: 1 },
    { date: '2026-06-01', tokens: 2 },
    { date: '2026-06-07', tokens: 3 }
  ];
  assert.deepEqual(resolveRange('7', { todayKey: '2026-06-07' }), {
    start: '2026-06-01', end: '2026-06-07', preset: '7'
  });
  assert.deepEqual(sliceDaily(rows, resolveRange('7', { todayKey: '2026-06-07' })).map((row) => row.date), [
    '2026-06-01', '2026-06-07'
  ]);
  assert.deepEqual(resolveRange('custom', { customStart: '2026-06-07', customEnd: '2026-06-01' }), {
    start: '2026-06-01', end: '2026-06-07', preset: 'custom'
  });
  assert.equal(resolveRange('all', { todayKey: '2026-06-07', daily: rows }).start, '2026-05-01');
});

test('groupDaily rolls days into locale weeks and calendar months', () => {
  const rows = [
    {
      date: '2026-06-01', tokens: 10, cost: 1, messages: 1,
      perClient: { claude: { tokens: 10, cost: 1, messages: 1 } },
      perModel: { opus: { tokens: 10, cost: 1 } },
      perClientModel: { claude: { opus: { tokens: 10, cost: 1, messages: 1 } } }
    },
    {
      date: '2026-06-02', tokens: 5, cost: 0.5, messages: 1,
      perClient: { claude: { tokens: 5, cost: 0.5, messages: 1 } },
      perModel: { opus: { tokens: 5, cost: 0.5 } },
      perClientModel: { claude: { opus: { tokens: 5, cost: 0.5, messages: 1 } } }
    },
    {
      date: '2026-06-08', tokens: 1, cost: 0.2, messages: 1,
      perClient: { codex: { tokens: 1, cost: 0.2, messages: 1 } },
      perModel: { gpt: { tokens: 1, cost: 0.2 } },
      perClientModel: { codex: { gpt: { tokens: 1, cost: 0.2, messages: 1 } } }
    }
  ];
  const weeks = groupDaily(rows, { period: 'week', weekStartsOn: 1 });
  assert.deepEqual(weeks.map((row) => [row.date, row.endDate, row.tokens]), [
    ['2026-06-01', '2026-06-02', 15],
    ['2026-06-08', '2026-06-08', 1]
  ]);
  assert.equal(weeks[0].perClient.claude.tokens, 15);
  assert.equal(weeks[0].perClientModel.claude.opus.tokens, 15);
  const months = groupDaily(rows, { period: 'month' });
  assert.equal(months.length, 1);
  assert.equal(months[0].date, '2026-06');
  assert.equal(months[0].tokens, 16);
  const sundayWeeks = groupDaily(rows.slice(0, 2), { period: 'week', weekStartsOn: 0 });
  assert.equal(sundayWeeks[0].date, '2026-05-31');
});


const daily = [
  {
    date: '2026-06-01',
    tokens: 40,
    cost: 4,
    perClient: { claude: { tokens: 30, cost: 3 }, codex: { tokens: 10, cost: 1 } },
    perModel: { opus: { tokens: 30, cost: 3 }, gpt: { tokens: 10, cost: 1 } },
    perClientModel: {
      claude: { opus: { tokens: 30, cost: 3, messages: 2 } },
      codex: { gpt: { tokens: 10, cost: 1, messages: 1 } }
    }
  },
  {
    date: '2026-06-02',
    tokens: 20,
    cost: 2,
    perClient: { claude: { tokens: 20, cost: 2 } },
    perModel: { sonnet: { tokens: 20, cost: 2 } },
    perClientModel: {
      claude: { sonnet: { tokens: 20, cost: 2, messages: 1 } }
    }
  }
];

test('hasClientModel is true only when a nested cell exists', () => {
  assert.equal(hasClientModel(daily), true);
  assert.equal(hasClientModel([{ perClient: { claude: { tokens: 1 } } }]), false);
  assert.equal(hasClientModel([]), false);
});

test('sumField and rankedEntries order by the selected metric', () => {
  const clients = sumField(daily, 'perClient', 'tokens');
  assert.equal(clients.claude.tokens, 50);
  assert.equal(clients.codex.cost, 1);
  assert.deepEqual(rankedEntries(clients, 'tokens').map((row) => row.key), ['claude', 'codex']);
  const models = sumField([{ perModel: { cheap: { tokens: 100, cost: 0.1 }, dear: { tokens: 10, cost: 9 } } }], 'perModel', 'cost');
  assert.deepEqual(rankedEntries(models, 'cost').map((row) => row.key), ['dear', 'cheap']);
});

test('filterDaily slices a client×model cell without dropping the day', () => {
  const claude = filterDaily(daily, { client: 'claude' });
  assert.equal(claude[0].tokens, 30);
  assert.deepEqual(Object.keys(claude[0].perModel), ['opus']);
  assert.equal(claude[1].tokens, 20);
  const opus = filterDaily(daily, { model: 'opus' });
  assert.equal(opus[0].tokens, 30);
  assert.equal(opus[1].tokens, 0);
  const cell = filterDaily(daily, { client: 'claude', model: 'opus' });
  assert.equal(cell[0].tokens, 30);
  assert.equal(cell[1].tokens, 0);
});

test('filterDaily falls back to 1D stacks when perClientModel is missing', () => {
  const rows = filterDaily([{
    tokens: 40,
    perClient: { claude: { tokens: 30, cost: 3 }, codex: { tokens: 10, cost: 1 } },
    perModel: { opus: { tokens: 40, cost: 4 } }
  }], { client: 'claude' });
  assert.equal(rows[0].tokens, 30);
  assert.deepEqual(Object.keys(rows[0].perClient), ['claude']);
});

test('drillRows and crossMatrix project the nested totals', () => {
  assert.deepEqual(drillRows(daily, { dimension: 'client', key: 'claude', metric: 'tokens' }).map((row) => row.key), ['opus', 'sonnet']);
  assert.deepEqual(drillRows(daily, { dimension: 'model', key: 'gpt', metric: 'cost' }).map((row) => [row.key, row.value]), [['codex', 1]]);
  const matrix = crossMatrix(daily, { metric: 'tokens', maxRows: 8, maxCols: 8 });
  assert.deepEqual(matrix.rowKeys, ['claude', 'codex']);
  assert.deepEqual(matrix.colKeys, ['opus', 'sonnet', 'gpt']);
  assert.equal(matrix.grid[0][0], 30);
  assert.equal(matrix.grid[1][2], 10);
  assert.equal(matrix.grand, 60);
  const clipped = crossMatrix(daily, { metric: 'tokens', maxRows: 1, maxCols: 1 });
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.shown, 30);
});

function localIso(year, month, day, hour, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

test('compactDashboardSessions keeps timestamped sessions and caps the newest', () => {
  const rows = compactDashboardSessions([{
    deviceId: 'd1',
    today: {
      sessions: {
        a: {
          client: 'claude', sessionId: 'a',
          startedAt: localIso(2026, 6, 1, 9), lastUsedAt: localIso(2026, 6, 1, 11),
          totalTokens: 30, costUsd: 3, models: { opus: 30 }
        },
        b: { client: 'codex', sessionId: 'b', totalTokens: 10 }
      }
    },
    month: {
      sessions: {
        a: {
          client: 'claude', sessionId: 'a',
          startedAt: localIso(2026, 6, 1, 8), lastUsedAt: localIso(2026, 6, 1, 11),
          totalTokens: 40, costUsd: 4, models: { opus: 40 }
        }
      }
    }
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, 40);
  assert.equal(rows[0].client, 'claude');
  const many = {};
  for (let i = 0; i < 5; i += 1) {
    many[`s${i}`] = {
      client: 'claude', sessionId: `s${i}`,
      startedAt: localIso(2026, 6, 1, i), lastUsedAt: localIso(2026, 6, 1, i),
      totalTokens: i + 1
    };
  }
  assert.equal(compactDashboardSessions([{ today: { sessions: many } }], { limit: 3 }).length, 3);
});

test('hourTotals smears a session across local hours and respects the range', () => {
  const session = {
    client: 'claude',
    startedAt: localIso(2026, 6, 1, 9),
    lastUsedAt: localIso(2026, 6, 1, 11),
    tokens: 30,
    cost: 3,
    models: { opus: 20, sonnet: 10 }
  };
  const hours = hourTotals([session], { range: { start: '2026-06-01', end: '2026-06-01' } });
  assert.equal(hours[9].tokens, 10);
  assert.equal(hours[10].tokens, 10);
  assert.equal(hours[11].tokens, 10);
  const slots = slotTotals(hours);
  assert.equal(slots.find((slot) => slot.id === 'morning').tokens, 30);
  const outside = hourTotals([session], { range: { start: '2026-06-02', end: '2026-06-02' } });
  assert.equal(outside.reduce((sum, row) => sum + row.tokens, 0), 0);
  const opus = filterSessions([session], { model: 'opus' });
  assert.equal(opus[0].tokens, 20);
  assert.equal(opus[0].cost, 2);
});

test('a long session is capped at twelve hours', () => {
  const hours = hourTotals([{
    startedAt: localIso(2026, 6, 1, 0),
    lastUsedAt: localIso(2026, 6, 1, 14),
    tokens: 140
  }], { range: { start: '2026-06-01', end: '2026-06-01' } });
  assert.equal(hours[0].tokens, 0);
  assert.equal(hours[1].tokens, 0);
  assert.ok(hours[2].tokens > 0);
  assert.ok(hours[14].tokens > 0);
  assert.equal(Number(hours.reduce((sum, row) => sum + row.tokens, 0).toFixed(6)), 140);
});

test('weekdayHourGrid follows the locale week start', () => {
  const at = new Date(2026, 5, 1, 22, 0, 0);
  const weekday = at.getDay();
  const grid = weekdayHourGrid([{
    startedAt: at.toISOString(),
    tokens: 8
  }], { range: { start: '2026-06-01', end: '2026-06-01' }, firstDay: 1 });
  assert.deepEqual(grid.map((row) => row.weekday), [1, 2, 3, 4, 5, 6, 0]);
  const row = grid.find((entry) => entry.weekday === weekday);
  assert.equal(row.hours[22].tokens, 8);
});

test('usagePortrait classifies time, tool focus, and model catalog', () => {
  const days = [{
    date: '2026-06-01', tokens: 80, cost: 8,
    perClient: { cursor: { tokens: 80, cost: 8 } },
    perModel: { grok: { tokens: 80, cost: 8 } }
  }];
  const sessions = [{
    client: 'cursor',
    startedAt: localIso(2026, 6, 1, 22),
    lastUsedAt: localIso(2026, 6, 1, 23),
    tokens: 80,
    cost: 8,
    models: { grok: 80 }
  }];
  const portrait = usagePortrait(days, sessions, { range: { start: '2026-06-01', end: '2026-06-01' } });
  assert.equal(portrait.time, 'evening');
  assert.equal(portrait.focus, 'specialist');
  assert.equal(portrait.catalog, 'loyal');
  assert.equal(portrait.topTool, 'cursor');
  assert.equal(portrait.topModel, 'grok');
  assert.equal(portrait.rhythm, 'weekday');
  assert.equal(portrait.combo, 'officeEvening');
  assert.deepEqual(portrait.tagKeys, [
    'tag.time.evening', 'tag.catalog.loyal', 'tag.rhythm.weekday', 'tag.combo.officeEvening'
  ]);
  const mixed = usagePortrait([{
    date: '2026-06-01', tokens: 100, cost: 10,
    perClient: { cursor: { tokens: 40 }, claude: { tokens: 30 }, codex: { tokens: 20 }, gemini: { tokens: 10 } },
    perModel: { a: { tokens: 20 }, b: { tokens: 18 }, c: { tokens: 16 }, d: { tokens: 14 }, e: { tokens: 12 }, f: { tokens: 10 }, g: { tokens: 10 } }
  }], [], { range: { start: '2026-06-01', end: '2026-06-01' } });
  assert.equal(mixed.time, 'unknown');
  assert.equal(mixed.focus, 'explorer');
  assert.equal(mixed.catalog, 'hopper');
  assert.equal(mixed.combo, 'restless');
  assert.equal(usagePortrait([], []).empty, true);
});
