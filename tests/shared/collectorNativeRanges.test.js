'use strict';

// Local mode shows Week / Last 7 days / Last 30 days as scanned periods: the
// full tick's windowed scan also reads each past day, and a range is those days
// plus Today. Watch ticks keep the past part and add the fresh Today.

const assert = require('node:assert/strict');
const test = require('node:test');

const collectorPath = require.resolve('../../src/shared/collector');
const { applyProjectRollups, emptyPeriod } = require('../../src/shared/usage');
const { syncPayload } = require('../../src/shared/syncPayload');
const { attachLocalNativeRanges } = require('../../src/electron/syncDisplayStats');
const fixedPeriodRanges = require('../../src/electron/renderer/fixedPeriodRanges');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

// Tuesday at local noon, so the captured calendar cannot straddle a midnight.
const NOW = new Date(2026, 10, 24, 12, 0, 0);
const TODAY = '2026-11-24';

function dayKey(offset) {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function report(rows) {
  return {
    groupBy: 'client,session,model',
    entries: rows.map(([sessionId, input]) => ({
      client: 'claude', sessionId, model: 'claude-sonnet-4-5', input, output: 0, cost: 0
    }))
  };
}

// Today reads 100 on its own session. Past day N reads N on `day-N`, and one
// session spans days 1 and 10 with 1000 each.
function windowReports(windows, { todayInput = 100, drop = null } = {}) {
  const reports = {};
  for (const { name } of windows) {
    if (name === drop) continue;
    if (name === 'today') reports.today = report([['today-session', todayInput]]);
    else if (name === 'month' || name === 'allTime') reports[name] = report([['today-session', todayInput], ['history', 5000]]);
    else {
      const offset = (Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${name.slice(1)}T00:00:00Z`)) / 86_400_000;
      const rows = [[`day-${offset}`, offset]];
      if (offset === 1 || offset === 10) rows.push(['spanning', 1000]);
      reports[name] = report(rows);
    }
  }
  return reports;
}

function baseOptions(extra = {}) {
  return {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'native-ranges-test',
    agentVersion: 'test',
    limitsEnabled: false,
    historyEnabled: false,
    now: NOW,
    nativeRangesEnabled: true,
    weekStartsOn: 1,
    collectWslUsage: async () => ({ bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] }),
    runTokscale: async () => assert.fail('the serial scans must not run'),
    ...extra
  };
}

test('a full tick composes each native range from its past days and Today', async () => {
  const { collectUsageOnce } = freshCollector();
  const summary = await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => windowReports(windows)
  }));

  assert.deepEqual(summary.nativeRangeWindows, {
    yesterday: { start: dayKey(1), end: dayKey(1) },
    week: { start: dayKey(1), end: TODAY },
    last7: { start: dayKey(6), end: TODAY },
    last30: { start: dayKey(29), end: TODAY }
  });
  // Yesterday is its own day alone, without Today.
  assert.equal(summary.nativeRanges.yesterday.totalTokens, 1 + 1000);
  assert.ok(!summary.nativeRanges.yesterday.sessions['claude:today-session']);
  // Monday through Tuesday: Today, day 1 and the spanning session's day 1.
  assert.equal(summary.nativeRanges.week.totalTokens, 100 + 1 + 1000);
  assert.equal(summary.nativeRanges.last7.totalTokens, 100 + (1 + 2 + 3 + 4 + 5 + 6) + 1000);
  assert.equal(summary.nativeRanges.last30.totalTokens, 100 + (29 * 30) / 2 + 2000);
  // A session that spans days is one row with the usage of every day in range.
  assert.equal(summary.nativeRanges.last7.sessions['claude:spanning'].totalTokens, 1000);
  assert.equal(summary.nativeRanges.last30.sessions['claude:spanning'].totalTokens, 2000);
  assert.ok(summary.nativeRanges.last7.sessions['claude:today-session']);
  assert.ok(!summary.nativeRanges.last7.sessions['claude:day-7']);
  // The ranges never change the periods every surface already shows.
  assert.equal(summary.today.totalTokens, 100);
  assert.equal(summary.month.totalTokens, 5100);
});

test('the week follows the configured first day of the week', async () => {
  const { collectUsageOnce } = freshCollector();
  const summary = await collectUsageOnce(baseOptions({
    weekStartsOn: 0,
    runTokscaleWindows: async ({ windows }) => windowReports(windows)
  }));
  assert.deepEqual(summary.nativeRangeWindows.week, { start: dayKey(2), end: TODAY });
  assert.equal(summary.nativeRanges.week.totalTokens, 100 + 1 + 2 + 1000);
});

test('a watch tick adds the fresh Today to the anchored past days', async () => {
  const { collectUsageOnce } = freshCollector();
  let captured = null;
  const full = await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => windowReports(windows),
    onAnchorComputed: (value) => { captured = value; }
  }));
  const anchor = {
    dateKey: TODAY,
    today: captured.windowsPeriods.today,
    month: captured.windowsPeriods.month,
    allTime: captured.windowsPeriods.allTime,
    todayPartitions: captured.todayPartitions,
    nativePastRanges: captured.nativePastRanges
  };

  const flags = [];
  const watch = await collectUsageOnce(baseOptions({
    todayOnlyAnchor: anchor,
    runTokscaleWindows: async () => assert.fail('a watch tick scans only Today'),
    runTokscale: async (input) => {
      flags.push(input.flags);
      return report([['today-session', 300]]);
    }
  }));

  assert.deepEqual(flags, [['--today']]);
  // Only a full tick hands its past days to the session archive.
  assert.equal(full.nativeRangeDays[dayKey(10)].sessions['claude:spanning'].totalTokens, 1000);
  assert.equal(Object.keys(full.nativeRangeDays).length, 29);
  assert.equal(watch.nativeRangeDays, undefined);
  assert.equal(watch.nativeRanges.last7.totalTokens, full.nativeRanges.last7.totalTokens + 200);
  assert.equal(watch.nativeRanges.last7.sessions['claude:today-session'].totalTokens, 300);
  // Today's growth never reaches Yesterday, and its published rows are not the
  // anchor's, which Today's titles and links would otherwise rewrite.
  assert.equal(watch.nativeRanges.yesterday.totalTokens, full.nativeRanges.yesterday.totalTokens);
  const anchored = anchor.nativePastRanges.periods.yesterday;
  assert.notEqual(watch.nativeRanges.yesterday.sessions, anchored.sessions);
  assert.notEqual(watch.nativeRanges.yesterday.sessions['claude:spanning'], anchored.sessions['claude:spanning']);
  assert.deepEqual(watch.nativeRangeWindows, full.nativeRangeWindows);
});

test('a watch tick without anchored past days publishes no native ranges', async () => {
  const { collectUsageOnce } = freshCollector();
  const watch = await collectUsageOnce(baseOptions({
    todayOnlyAnchor: { dateKey: TODAY, today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() },
    runTokscale: async () => report([['today-session', 300]])
  }));
  assert.equal(watch.today.totalTokens, 300);
  assert.equal(watch.nativeRanges, undefined);
});

test('a missing day leaves the ranges on History without failing the tick', async () => {
  const { collectUsageOnce } = freshCollector();
  const summary = await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => windowReports(windows, { drop: `d${dayKey(5)}` })
  }));
  assert.equal(summary.today.totalTokens, 100);
  assert.equal(summary.nativeRanges, undefined);
  assert.equal(summary.nativeRangeWindows, undefined);
});

test('any WSL usage keeps the ranges on History instead of undercounting', async () => {
  const { collectUsageOnce } = freshCollector();
  // Usage from last month only: Last 30 days reaches back to it.
  const wslAllTime = { ...emptyPeriod(), totalTokens: 40, clients: { claude: 40 } };
  const summary = await collectUsageOnce(baseOptions({
    wslScanEnabled: true,
    collectWslUsage: async () => ({ bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: wslAllTime }, detected: [] }),
    runTokscaleWindows: async ({ windows }) => windowReports(windows)
  }));
  assert.equal(summary.month.totalTokens, 5100);
  assert.equal(summary.nativeRanges, undefined);
});

test('collectors that do not show native ranges read no extra days', async () => {
  const { collectUsageOnce } = freshCollector();
  const requested = [];
  const summary = await collectUsageOnce(baseOptions({
    nativeRangesEnabled: false,
    runTokscaleWindows: async ({ windows }) => {
      requested.push(windows.map(({ name }) => name));
      return windowReports(windows);
    }
  }));
  assert.deepEqual(requested, [['today', 'month', 'allTime']]);
  assert.equal(summary.nativeRanges, undefined);
});

test('a session active on past days and Today takes Today\'s fresh title in the ranges', async () => {
  const { collectUsageOnce } = freshCollector();
  const titled = (rows, title) => ({ ...report(rows), sessions: [{ client: 'claude', sessionId: 'spanning', title }] });
  let captured = null;
  await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => {
      const reports = windowReports(windows);
      reports.allTime = titled([['spanning', 2000]], 'Old title');
      return reports;
    },
    onAnchorComputed: (value) => { captured = value; }
  }));
  const watch = await collectUsageOnce(baseOptions({
    todayOnlyAnchor: {
      dateKey: TODAY,
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      todayPartitions: captured.todayPartitions,
      nativePastRanges: captured.nativePastRanges
    },
    runTokscale: async () => titled([['spanning', 50]], 'New title')
  }));
  assert.equal(watch.today.sessions['claude:spanning'].title, 'New title');
  assert.equal(watch.nativeRanges.last7.sessions['claude:spanning'].title, 'New title');
  assert.equal(watch.nativeRanges.last7.sessions['claude:spanning'].totalTokens, 1050);
});

test('native ranges get project rollups and stay off the wire', () => {
  const session = { client: 'claude', sessionId: 's1', totalTokens: 7, projectId: 'p1', projectLabel: 'repo' };
  const summary = {
    deviceId: 'device',
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    nativeRanges: { last7: { ...emptyPeriod(), totalTokens: 7, sessions: { 'claude:s1': session } } },
    nativeRangeWindows: { last7: { start: dayKey(6), end: TODAY } }
  };
  applyProjectRollups(summary);
  assert.equal(summary.nativeRanges.last7.projects.repo.tokens, 7);
  const payload = syncPayload(summary);
  assert.equal(payload.nativeRanges, undefined);
  assert.equal(payload.nativeRangeWindows, undefined);
});

test('local stats expose native ranges as periods with their windows', () => {
  const last7 = { ...emptyPeriod(), totalTokens: 7 };
  const stats = attachLocalNativeRanges({ periods: { today: emptyPeriod() } }, {
    nativeRanges: { last7 },
    nativeRangeWindows: { last7: { start: dayKey(6), end: TODAY } }
  });
  assert.equal(stats.periods.last7, last7);
  assert.ok(stats.periods.today);
  assert.deepEqual(stats.nativeRangeWindows.last7, { start: dayKey(6), end: TODAY });
  const untouched = { periods: { today: emptyPeriod() } };
  assert.equal(attachLocalNativeRanges(untouched, {}).periods.last7, undefined);
});

test('the renderer uses a native range only for the range it would draw', () => {
  const last7 = { ...emptyPeriod(), totalTokens: 7, sessions: {} };
  const stats = {
    periods: { last7 },
    nativeRangeWindows: { last7: { start: dayKey(6), end: TODAY } }
  };
  const snapshot = fixedPeriodRanges.nativeRangeSnapshot('last7', stats, { todayKey: TODAY });
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.native, true);
  assert.equal(snapshot.period, last7);
  // Another day, or a range the collector did not compose, falls back.
  assert.equal(fixedPeriodRanges.nativeRangeSnapshot('last7', stats, { todayKey: dayKey(-1) }), null);
  assert.equal(fixedPeriodRanges.nativeRangeSnapshot('last30', stats, { todayKey: TODAY }), null);
  assert.equal(fixedPeriodRanges.nativeRangeSnapshot('today', stats, { todayKey: TODAY }), null);

  assert.equal(fixedPeriodRanges.supportsBreakdown('last7', 'session', { native: true }), true);
  assert.equal(fixedPeriodRanges.supportsBreakdown('last7', 'project', { native: true }), true);
  assert.equal(fixedPeriodRanges.supportsBreakdown('last7', 'session', {}), false);
});

test('Yesterday is a derived range for the day before today', () => {
  assert.equal(fixedPeriodRanges.normalizeMonthMode('yesterday'), 'yesterday');
  assert.equal(fixedPeriodRanges.slotForSelection('yesterday'), 'month');
  assert.deepEqual(fixedPeriodRanges.rangeForSelection('yesterday', { todayKey: TODAY }), { start: dayKey(1), end: dayKey(1) });
  const yesterday = { ...emptyPeriod(), totalTokens: 3, sessions: {} };
  const stats = { periods: { yesterday }, nativeRangeWindows: { yesterday: { start: dayKey(1), end: dayKey(1) } } };
  assert.equal(fixedPeriodRanges.nativeRangeSnapshot('yesterday', stats, { todayKey: TODAY }).period, yesterday);
  // After midnight the collector's Yesterday is the day before, so it falls back.
  assert.equal(fixedPeriodRanges.nativeRangeSnapshot('yesterday', stats, { todayKey: dayKey(-1) }), null);
  // History draws Yesterday from its own day only, never from the live Today.
  const history = fixedPeriodRanges.fixedPeriodSnapshot('yesterday', {
    historyAvailable: true, todayKey: TODAY, liveTodayKey: TODAY,
    todayPeriod: { ...emptyPeriod(), totalTokens: 100 },
    daily: [{ date: dayKey(1), tokens: 4, cost: 0, perClient: {}, perModel: {} }, { date: TODAY, tokens: 90, cost: 0, perClient: {}, perModel: {} }]
  });
  assert.equal(history.period.totalTokens, 4);
});

function cursorReport(input) {
  return {
    groupBy: 'client,session,model',
    entries: [{ client: 'cursor', sessionId: 'cursor-session', model: 'cursor-fast', input, output: 0, cost: 0 }]
  };
}

// Cursor reads its own cache on its own cadence. Its snapshot carries the same
// days when it came from a windowed read; an older snapshot does not.
function cursorSnapshot({ days = true } = {}) {
  const snapshot = { revision: 1, today: cursorReport(10), month: cursorReport(20), allTime: cursorReport(30), graph: null };
  if (days) {
    snapshot.days = {};
    for (let offset = 1; offset <= 29; offset += 1) snapshot.days[`d${dayKey(offset)}`] = cursorReport(offset === 3 ? 7 : 0);
  }
  return snapshot;
}

test('Cursor days from its snapshot join the native ranges', async () => {
  const { collectUsageOnce } = freshCollector();
  const scanned = [];
  const summary = await collectUsageOnce(baseOptions({
    clients: 'claude,cursor',
    cursorSnapshot: cursorSnapshot(),
    runTokscaleWindows: async ({ clients, windows }) => {
      scanned.push(clients);
      return windowReports(windows);
    }
  }));
  assert.deepEqual(scanned, ['claude']);
  assert.equal(summary.nativeRanges.last7.clients.cursor, 10 + 7);
  assert.equal(summary.nativeRanges.week.clients.cursor, 10);
});

test('a Cursor snapshot without days keeps the ranges on History', async () => {
  const { collectUsageOnce } = freshCollector();
  const summary = await collectUsageOnce(baseOptions({
    clients: 'claude,cursor',
    cursorSnapshot: cursorSnapshot({ days: false }),
    runTokscaleWindows: async ({ windows }) => windowReports(windows)
  }));
  assert.equal(summary.today.clients.cursor, 10);
  assert.equal(summary.nativeRanges, undefined);
});

test('persisted past days are reused after a restart only when they still fit', async () => {
  const { collectUsageOnce } = freshCollector();
  let captured = null;
  await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => windowReports(windows),
    onAnchorComputed: (value) => { captured = value; }
  }));
  // What collector-anchor.json holds after a JSON round trip.
  const persisted = JSON.parse(JSON.stringify(captured.nativePastRanges));
  const anchorWith = (nativePastRanges) => ({
    dateKey: TODAY,
    today: JSON.parse(JSON.stringify(captured.windowsPeriods.today)),
    month: JSON.parse(JSON.stringify(captured.windowsPeriods.month)),
    allTime: JSON.parse(JSON.stringify(captured.windowsPeriods.allTime)),
    nativePastRanges
  });
  const watch = (anchor, extra = {}) => collectUsageOnce(baseOptions({
    todayOnlyAnchor: anchor,
    runTokscale: async () => report([['today-session', 100]]),
    ...extra
  }));

  const restored = await watch(anchorWith(persisted));
  assert.equal(restored.nativeRanges.last30.totalTokens, 100 + (29 * 30) / 2 + 2000);
  // A different first day of the week, or a tampered start, is not reused.
  assert.equal((await watch(anchorWith(persisted), { weekStartsOn: 0 })).nativeRanges, undefined);
  const tampered = { ...persisted, starts: { ...persisted.starts, last7: dayKey(3) } };
  assert.equal((await watch(anchorWith(tampered))).nativeRanges, undefined);
});

test('a native range keeps History Trends and device rows for the same range', () => {
  const native = { status: 'ready', selection: 'last7', native: true, range: { start: dayKey(6), end: TODAY }, period: { totalTokens: 9 } };
  const history = {
    status: 'ready', selection: 'last7', range: { start: dayKey(6), end: TODAY }, summary: { activeDays: 4 }, daily: [{ date: TODAY }],
    period: { totalTokens: 8 }, devices: [{ deviceId: 'local', period: { totalTokens: 8 } }, { deviceId: 'other', period: { totalTokens: 1 } }]
  };
  const merged = fixedPeriodRanges.nativeRangeWithHistory(native, history, 'local');
  assert.equal(merged.native, true);
  assert.equal(merged.period, native.period);
  assert.deepEqual(merged.summary, { activeDays: 4 });
  assert.equal(merged.devices[0].period, native.period);
  assert.equal(merged.devices[1].period.totalTokens, 1);
  // History for another range adds nothing.
  assert.equal(fixedPeriodRanges.nativeRangeWithHistory(native, { ...history, range: { start: dayKey(5), end: TODAY } }, 'local'), native);
  assert.equal(fixedPeriodRanges.nativeRangeWithHistory(native, null, 'local'), native);
});

test('an All Time start inside Last 30 days keeps the ranges on History', async () => {
  const { collectUsageOnce } = freshCollector();
  // WSL and Codex Dots stop at allTimeSince, so their absence proves nothing
  // about the days before it.
  const summary = await collectUsageOnce(baseOptions({
    allTimeSince: dayKey(3),
    runTokscaleWindows: async ({ windows }) => windowReports(windows)
  }));
  assert.equal(summary.today.totalTokens, 100);
  assert.equal(summary.nativeRanges, undefined);
});

test('a collector without native ranges never publishes them from a shared anchor', async () => {
  const { collectUsageOnce } = freshCollector();
  let captured = null;
  await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => windowReports(windows),
    onAnchorComputed: (value) => { captured = value; }
  }));
  const watch = await collectUsageOnce(baseOptions({
    nativeRangesEnabled: false,
    todayOnlyAnchor: {
      dateKey: TODAY,
      today: captured.windowsPeriods.today,
      month: captured.windowsPeriods.month,
      allTime: captured.windowsPeriods.allTime,
      nativePastRanges: captured.nativePastRanges
    },
    runTokscale: async () => report([['today-session', 100]])
  }));
  assert.equal(watch.nativeRanges, undefined);
});

test('live activity observations reach the same session in the native ranges', () => {
  const projection = require('../../src/shared/sessionActivityProjection');
  const observedAt = new Date().toISOString();
  const key = 'claude:live';
  const period = () => ({ ...emptyPeriod(), totalTokens: 5, sessions: { [key]: { client: 'claude', sessionId: 'live', totalTokens: 5 } } });
  const stats = { updatedAt: observedAt, periods: { today: period(), month: period(), allTime: period(), last7: period() } };
  const next = projection.applyActivityPatch(stats, {
    observations: [{ client: 'claude', sessionId: 'live', liveActivity: { state: 'waiting', observedAt } }]
  });
  assert.equal(next.periods.today.sessionActivity[key].state, 'waiting');
  assert.equal(next.periods.last7.sessionActivity[key].state, 'waiting');
});

test('a Today/Month preview keeps the last native ranges until the full result', () => {
  const { createDeviceState } = require('../../src/shared/usage/deviceState');
  const records = [];
  const device = createDeviceState({ envelope: { deviceId: 'd' }, onRecord: (record) => records.push(record) });
  const last7 = { ...emptyPeriod(), totalTokens: 7 };
  const full = (extra) => ({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod(), ...extra });
  device.updateUsage(full({ nativeRanges: { last7 }, nativeRangeWindows: { last7: { start: dayKey(6), end: TODAY } } }));
  device.updateUsage({ today: emptyPeriod(), month: emptyPeriod() }, 'preview');
  assert.equal(device.getSnapshot().nativeRanges.last7.totalTokens, 7);
  // A complete result without ranges (a fallback) drops them.
  device.updateUsage(full({}));
  assert.equal(device.getSnapshot().nativeRanges, undefined);
});

test('device state applies live activity to sessions held in its native ranges', () => {
  const { createDeviceState } = require('../../src/shared/usage/deviceState');
  const observedAt = new Date().toISOString();
  const key = 'claude:live';
  const period = () => ({ ...emptyPeriod(), totalTokens: 5, sessions: { [key]: { client: 'claude', sessionId: 'live', totalTokens: 5 } } });
  const device = createDeviceState({ envelope: { deviceId: 'd' }, onRecord: () => {} });
  device.updateUsage({ updatedAt: observedAt, today: period(), month: period(), allTime: period(), nativeRanges: { last7: period() } });
  assert.equal(device.updateActivity({ observations: [{ client: 'claude', sessionId: 'live', liveActivity: { state: 'waiting', observedAt } }] }), true);
  const snapshot = device.getSnapshot();
  assert.equal(snapshot.today.sessions[key].liveActivity.state, 'waiting');
  assert.equal(snapshot.nativeRanges.last7.sessions[key].liveActivity.state, 'waiting');
  assert.equal(snapshot.nativeRanges.last7.sessionActivity, undefined);
});

test('Yesterday takes a resumed session\'s identity from Today, not its times', async () => {
  const { collectUsageOnce } = freshCollector();
  const yesterdayAt = `${dayKey(1)}T10:00:00.000Z`;
  const todayAt = `${TODAY}T11:00:00.000Z`;
  let captured = null;
  await collectUsageOnce(baseOptions({
    runTokscaleWindows: async ({ windows }) => {
      const reports = windowReports(windows);
      for (const entry of reports[`d${dayKey(1)}`].entries) if (entry.sessionId === 'spanning') entry.lastUsedAt = yesterdayAt;
      return reports;
    },
    onAnchorComputed: (value) => { captured = value; }
  }));
  const anchor = {
    dateKey: TODAY,
    today: captured.windowsPeriods.today,
    month: captured.windowsPeriods.month,
    allTime: captured.windowsPeriods.allTime,
    todayPartitions: captured.todayPartitions,
    nativePastRanges: captured.nativePastRanges
  };
  const watch = await collectUsageOnce(baseOptions({
    todayOnlyAnchor: anchor,
    runTokscaleWindows: async () => assert.fail('a watch tick scans only Today'),
    runTokscale: async () => ({
      groupBy: 'client,session,model',
      entries: [{ client: 'claude', sessionId: 'spanning', model: 'claude-sonnet-4-5', input: 5, output: 0, cost: 0, lastUsedAt: todayAt }]
    })
  }));
  assert.equal(watch.nativeRanges.yesterday.sessions['claude:spanning'].lastUsedAt, yesterdayAt);
  assert.equal(watch.nativeRanges.last7.sessions['claude:spanning'].lastUsedAt, todayAt);
});
