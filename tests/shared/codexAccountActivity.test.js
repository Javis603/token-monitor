'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { emptyPeriod } = require('../../src/shared/usage');
const { createCodexAccountActivity } = require('../../src/electron/codexAccountActivity');
const {
  normalizeAccountActivity,
  selectAccountActivity,
  applyAccountActivityToStats: applyAccountActivityToStatsRaw,
  projectAccountActivityToHistory
} = require('../../src/shared/providers/codex/accountActivity');
const { localDayKey } = require('../../src/shared/history');

function applyAccountActivityToStats(stats, snapshot, since, deviceId = '', singleAccount = true, nowMs = Date.parse('2026-09-27T04:10:00Z')) {
  return applyAccountActivityToStatsRaw(stats, snapshot, since, deviceId, singleAccount, nowMs);
}

function activity(total = 67_570, date = '2026-02-22') {
  return { codexAccountActivity: {
    status: 'available', source: 'codex-app-server',
    fetchedAt: '2026-09-27T04:00:00Z', lifetimeTokens: total,
    dailyUsageBuckets: [{ startDate: date, tokens: total }]
  } };
}

function stats() {
  const allTime = emptyPeriod();
  allTime.totalTokens = 31_930;
  allTime.clients = { codex: 29_930, claude: 2_000 };
  allTime.cacheReadTokens = 20_000;
  allTime.clientCacheReads = { codex: 20_000 };
  allTime.unclassifiedTokens = 11_930;
  allTime.clientUnclassifiedTokens = { codex: 9_930, claude: 2_000 };
  const today = emptyPeriod();
  today.totalTokens = 100;
  today.clients = { codex: 100 };
  return { periods: { allTime, today, month: today } };
}

test('account total replaces local Codex without summing the two sources or changing local dates', () => {
  const original = stats();
  const snapshot = normalizeAccountActivity(activity(), 'account-a');
  const shown = applyAccountActivityToStats(original, snapshot, '2024-01-01');
  assert.equal(shown.periods.allTime.totalTokens, 69_570);
  assert.equal(shown.periods.allTime.clients.codex, 67_570);
  assert.equal(shown.periods.allTime.clients.claude, 2_000);
  assert.equal(shown.periods.today.totalTokens, 100);
  assert.equal(shown.periods.month.totalTokens, 100);
  assert.equal(original.periods.allTime.totalTokens, 31_930);
  assert.equal(shown.codexAccountActivity.status, 'applied');
  assert.equal(shown.codexAccountActivity.unallocatedTokens, undefined);
});

test('dashboard history uses verified account days once and keeps local-only evidence local', () => {
  const raw = activity(300, '2026-09-26');
  raw.codexAccountActivity.fetchedAt = '2026-09-28T00:00:00Z';
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-26', tokens: 100 },
    { startDate: '2026-09-27', tokens: 100 },
    { startDate: '2026-09-28', tokens: 100 }
  ];
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const history = {
    daily: [
      { date: '2026-09-26', tokens: 50, cost: 2, activeTimeMs: 60_000, perClient: { codex: { tokens: 40, cost: 1 }, claude: { tokens: 10, cost: 1 } }, perModel: { local: { tokens: 50 } } },
      { date: '2026-09-28', tokens: 25, cost: 3, activeTimeMs: 120_000, perClient: { codex: { tokens: 20, cost: 2 }, claude: { tokens: 5, cost: 1 } }, perModel: { local: { tokens: 25 } } }
    ],
    monthly: [{ month: '2026-09', tokens: 75, cost: 5, perClient: { codex: { tokens: 60, cost: 3 }, claude: { tokens: 15, cost: 2 } } }],
    summary: { totalTokens: 75, totalCost: 5, activeDays: 2, currentStreak: 1, peakDayTokens: 50, activeTimeMs: 180_000, favoriteModel: 'local', messages: 4 }
  };
  const presented = { periods: { allTime: { totalTokens: 315 } }, codexAccountActivity: { status: 'applied', source: 'codex-app-server', fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens } };
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.equal(projected.summary.totalTokens, 315);
  assert.equal(projected.summary.activeDays, 3);
  assert.equal(projected.summary.currentStreak, 3);
  assert.equal(projected.summary.longestStreak, 3);
  assert.equal(projected.summary.peakDayTokens, 110);
  assert.equal(projected.summary.activeTimeMs, 180_000);
  assert.equal(projected.summary.totalCost, 5);
  assert.equal(projected.summary.favoriteModel, 'local');
  assert.deepEqual(projected.daily.map((day) => [day.date, day.tokens]), [['2026-09-26', 110], ['2026-09-27', 100], ['2026-09-28', 105]]);
  assert.equal(projected.daily[0].perClient.codex.tokens, 100);
  assert.equal(projected.daily[0].perModel.local.tokens, 50);
  assert.equal(projected.monthly[0].tokens, 315);
  assert.equal(projected.monthly[0].perClient.codex.tokens, 300);
  assert.equal(history.daily[0].tokens, 50);
  assert.equal(projected.codexAccountActivity.status, 'applied');
});

test('dashboard account history leaves unverified scope and ambiguous local days untouched', () => {
  const snapshot = normalizeAccountActivity(activity(100, '2026-09-28'), 'account-a');
  const history = { daily: [{ date: '2026-09-28', tokens: 20 }], monthly: [], summary: { totalTokens: 20 } };
  const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: { status: 'applied', source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens } };
  assert.equal(projectAccountActivityToHistory(history, snapshot, { ...presented, codexAccountActivity: { status: 'scope-unverified' } }), history);
  assert.equal(projectAccountActivityToHistory(history, snapshot, presented), history);
});

test('stale account history preserves the locally verified streaks', () => {
  const raw = activity(100, '2026-09-28');
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-27', tokens: 50 },
    { startDate: '2026-09-28', tokens: 50 }
  ];
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const history = {
    daily: [{ date: '2026-09-28', tokens: 20, perClient: { codex: { tokens: 20 } } }],
    monthly: [{ month: '2026-09', tokens: 20, perClient: { codex: { tokens: 20 } } }],
    summary: { currentStreak: 1, longestStreak: 1 }
  };
  const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: {
    status: 'stale', source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens
  } };
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.equal(projected.summary.currentStreak, 1);
  assert.equal(projected.summary.longestStreak, 1);
});

test('applied account Dashboard days use the account UTC boundary while stale days stay local', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const nowMs = Date.parse('2026-10-02T00:30:00Z');
    assert.equal(localDayKey(new Date(nowMs)), '2026-10-01');
    const raw = activity(100, '2026-10-01');
    raw.codexAccountActivity.dailyUsageBuckets = [
      { startDate: '2026-10-01', tokens: 50 },
      { startDate: '2026-10-02', tokens: 50 }
    ];
    const snapshot = normalizeAccountActivity(raw, 'account-a');
    const history = {
      daily: [{ date: '2026-10-01', tokens: 10, perClient: { codex: { tokens: 10 } } }],
      monthly: [{ month: '2026-10', tokens: 10, perClient: { codex: { tokens: 10 } } }],
      summary: { currentStreak: 1, longestStreak: 1 }
    };
    const account = { source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens };
    const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: { ...account, status: 'applied' } };
    const applied = projectAccountActivityToHistory(history, snapshot, presented, { nowMs });
    assert.deepEqual(applied.daily.map((row) => row.date), ['2026-10-01', '2026-10-02']);
    assert.equal(applied.summary.currentStreak, 2);
    const stale = projectAccountActivityToHistory(history, snapshot, {
      ...presented, codexAccountActivity: { ...account, status: 'stale' }
    }, { nowMs });
    assert.deepEqual(stale.daily.map((row) => row.date), ['2026-10-01']);
    const overridden = projectAccountActivityToHistory(history, snapshot, presented, { nowMs, todayKey: '2026-10-01' });
    assert.deepEqual(overridden.daily.map((row) => row.date), ['2026-10-01']);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('account activity exposes a streak through yesterday without changing local history', () => {
  const raw = activity(67_570, '2026-09-25');
  raw.codexAccountActivity.fetchedAt = '2026-09-28T00:00:00Z';
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-25', tokens: 20_000 },
    { startDate: '2026-09-26', tokens: 20_000 },
    { startDate: '2026-09-27', tokens: 27_570 }
  ];
  const shown = applyAccountActivityToStats(stats(), normalizeAccountActivity(raw, 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-28T00:10:00Z'));
  assert.equal(shown.codexAccountActivity.currentStreak, 3);
  assert.equal(shown.historyPreview, undefined);
  raw.codexAccountActivity.dailyUsageBuckets[1].tokens = 0;
  raw.codexAccountActivity.dailyUsageBuckets[2].tokens += 20_000;
  const gap = applyAccountActivityToStats(stats(), normalizeAccountActivity(raw, 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-28T00:10:00Z'));
  assert.equal(gap.codexAccountActivity.currentStreak, 1);
});

test('incomplete daily buckets and a later requested start date cannot be advertised as account-wide', () => {
  const incomplete = activity();
  incomplete.codexAccountActivity.dailyUsageBuckets[0].tokens -= 1;
  const partial = normalizeAccountActivity(incomplete, 'account-a');
  assert.equal(partial.dailyCoverageComplete, false);
  assert.equal(applyAccountActivityToStats(stats(), partial, '2024-01-01').codexAccountActivity.status, 'range-unverified');
  const late = applyAccountActivityToStats(stats(), normalizeAccountActivity(activity(), 'account-a'), '2026-03-01');
  assert.equal(late.periods.allTime.totalTokens, 31_930);
  assert.equal(late.codexAccountActivity.status, 'range-unverified');
});

test('a second device with unverified Codex account prevents overlapping aggregation', () => {
  const aggregate = stats();
  aggregate.devices = [
    { deviceId: 'this-pc', periods: { allTime: { clients: { codex: 29_930 } } } },
    { deviceId: 'other-pc', periods: { allTime: { clients: { codex: 500 } } } }
  ];
  const shown = applyAccountActivityToStats(aggregate, normalizeAccountActivity(activity(), 'account-a'), '2024-01-01', 'this-pc');
  assert.equal(shown.periods.allTime.totalTokens, 31_930);
  assert.equal(shown.codexAccountActivity.status, 'scope-unverified');
});

test('local Codex above account total does not leak conflicting All Time details', () => {
  const aggregate = stats();
  aggregate.allTimeSessionsView = { 'codex:old': { client: 'codex', totalTokens: 29_930 } };
  aggregate.periods.allTime.models = { 'gpt-old': 29_930 };
  aggregate.periods.allTime.sessions = aggregate.allTimeSessionsView;
  const shown = applyAccountActivityToStats(aggregate, normalizeAccountActivity(activity(20_000), 'account-a'), '2024-01-01');
  assert.equal(shown.periods.allTime.clients.codex, 20_000);
  assert.equal(shown.periods.allTime.totalTokens, 22_000);
  assert.equal(shown.codexAccountActivity.status, 'conflict');
  assert.deepEqual(shown.periods.allTime.models, {});
  assert.deepEqual(shown.periods.allTime.sessions, {});
  assert.equal(shown.allTimeSessionsView, undefined);
});

test('an old account reading is visibly stale while remaining the last known total', () => {
  const shown = applyAccountActivityToStats(stats(), normalizeAccountActivity(activity(), 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-27T05:10:00Z'));
  assert.equal(shown.periods.allTime.clients.codex, 67_570);
  assert.equal(shown.codexAccountActivity.status, 'stale');
  assert.equal(shown.codexAccountActivity.fetchedAt, '2026-09-27T04:00:00.000Z');
});

test('lower subsequent readings are held until a new verified account total arrives', () => {
  const earlier = normalizeAccountActivity(activity(), 'account-a');
  const lowerRaw = activity(60_000);
  lowerRaw.codexAccountActivity.fetchedAt = '2026-09-27T05:00:00Z';
  const selected = selectAccountActivity(earlier, normalizeAccountActivity(lowerRaw, 'account-a'));
  assert.equal(selected.conflict, true);
  assert.equal(selected.snapshot.lifetimeTokens, 67_570);
  const corrected = selectAccountActivity(earlier, normalizeAccountActivity(lowerRaw, 'account-a'), { correctionConfirmed: true });
  assert.equal(corrected.conflict, false);
  assert.equal(corrected.snapshot.lifetimeTokens, 60_000);
});

test('a repeated lower account reading can correct a persisted total', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let current = activity();
  let reads = 0;
  const options = {
    filePath,
    readIdentity: () => ({ accountKey: 'account-a' }),
    readActivity: async () => { reads += 1; return current; }
  };
  try {
    await createCodexAccountActivity(options).refresh();
    current = activity(60_000);
    current.codexAccountActivity.fetchedAt = '2026-09-27T05:00:00Z';
    const restarted = createCodexAccountActivity(options);
    await restarted.refresh();
    assert.equal(reads, 3);
    assert.equal(restarted.snapshot().lifetimeTokens, 60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('account snapshot persists and is isolated from a later login', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let accountKey = 'account-a';
  const options = { filePath, readIdentity: () => ({ accountKey }), readActivity: async () => activity() };
  try {
    const first = createCodexAccountActivity(options);
    await first.refresh();
    assert.equal(first.snapshot().lifetimeTokens, 67_570);
    const restarted = createCodexAccountActivity(options);
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
    accountKey = 'account-b';
    assert.equal(restarted.snapshot(), null);
    await restarted.refresh();
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
    assert.equal(restarted.multipleAccounts(), true);
    assert.equal(applyAccountActivityToStats(stats(), restarted.snapshot(), '2024-01-01', '', !restarted.multipleAccounts())
      .codexAccountActivity.status, 'scope-unverified');
    accountKey = 'account-a';
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed activity read after account switch still blocks later mixed history', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let accountKey = 'account-a';
  let fail = false;
  const options = {
    filePath,
    readIdentity: () => ({ accountKey }),
    readActivity: async () => { if (fail) throw new Error('offline'); return activity(); }
  };
  try {
    await createCodexAccountActivity(options).refresh();
    accountKey = 'account-b';
    fail = true;
    const switched = createCodexAccountActivity(options);
    await switched.refresh();
    accountKey = 'account-a';
    const restarted = createCodexAccountActivity(options);
    assert.equal(restarted.multipleAccounts(), true);
    assert.equal(applyAccountActivityToStats(stats(), restarted.snapshot(), '2024-01-01', '', !restarted.multipleAccounts())
      .codexAccountActivity.status, 'scope-unverified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persisted bucket cannot crash snapshot reading', () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, accounts: { 'account-a': {
      source: 'codex-app-server', fetchedAt: '2026-09-27T04:00:00Z', lifetimeTokens: 1,
      dailyUsageBuckets: [null]
    } } }));
    const reader = createCodexAccountActivity({ filePath, readIdentity: () => ({ accountKey: 'account-a' }) });
    assert.equal(reader.snapshot(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
