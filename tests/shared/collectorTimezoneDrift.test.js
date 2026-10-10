'use strict';

// Fixed UTC+8 with no DST. The drift signature below is expressed in absolute
// instants (yesterday evening Beijing time) so the test does not depend on the
// runner's zone beyond the file-level TZ pin.
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectUsageOnce,
  collectorAnchorTrust,
  todayPeriodHasDriftedWindow,
  localTodayKey
} = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');
const { utcOffsetMinutes } = require('../../src/shared/history');

function periodWith(totalTokens) {
  const period = emptyPeriod();
  period.totalTokens = totalTokens;
  period.clients = { claude: totalTokens };
  return period;
}

function anchorFixture(overrides = {}) {
  return {
    dateKey: localTodayKey(),
    utcOffsetMinutes: utcOffsetMinutes(),
    today: periodWith(50),
    month: periodWith(500),
    allTime: periodWith(5000),
    ...overrides
  };
}

function baseOptions(overrides = {}) {
  return {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    collectWslUsage: async () => ({ bundle: { today: null, month: null, allTime: null, detected: [], homes: [] }, detected: [] }),
    ...overrides
  };
}

test('todayPeriodHasDriftedWindow flags sessions that ended before the local midnight', () => {
  // Local 2026-10-10 10:00 Beijing → midnight is 2026-10-09T16:00:00Z.
  const midnightMs = new Date(2026, 9, 10).getTime();

  const drifted = todayPeriodHasDriftedWindow({
    sessions: { s1: { lastUsedAt: '2026-10-09T20:00:00+08:00' } }
  }, midnightMs);
  assert.equal(drifted, true, 'usage from yesterday evening cannot live in a today window cut at this midnight');

  const clean = todayPeriodHasDriftedWindow({
    sessions: { s1: { lastUsedAt: '2026-10-10T09:00:00+08:00' } }
  }, midnightMs);
  assert.equal(clean, false);

  // A session active across midnight has its last activity after the midnight
  // by definition; it must not read as drift.
  const overnight = todayPeriodHasDriftedWindow({
    sessions: { s1: { startedAt: '2026-10-09T23:00:00+08:00', lastUsedAt: '2026-10-10T01:00:00+08:00' } }
  }, midnightMs);
  assert.equal(overnight, false);

  assert.equal(todayPeriodHasDriftedWindow({}, midnightMs), false);
  assert.equal(todayPeriodHasDriftedWindow({ sessions: { s1: { lastUsedAt: '2026-10-09T20:00:00+08:00' } } }, Number.NaN), false);
});

test('an anchor whose offset no longer matches is declined, with unstamped anchors joining it', () => {
  const now = new Date(2026, 9, 10, 10, 0, 0);
  const options = { clients: 'claude', allTimeSince: '2024-01-01', now };
  const anchor = {
    dateKey: '2026-10-10',
    utcOffsetMinutes: utcOffsetMinutes(now),
    today: {}, month: {}, allTime: {},
    configFingerprint: require('../../src/shared/collector').configFingerprint('claude', '2024-01-01'),
    fullScanAt: new Date(now.getTime() - 60_000).toISOString()
  };
  assert.equal(collectorAnchorTrust(anchor, options).capturedAtMs, now.getTime() - 60_000);
  assert.equal(collectorAnchorTrust({ ...anchor, utcOffsetMinutes: utcOffsetMinutes(now) + 1 }, options), null);
  assert.equal(collectorAnchorTrust({ ...anchor, utcOffsetMinutes: undefined }, options), null);
});

test('a drifted anchored tick falls back to the serial full scan and reports the drift', async () => {
  // The subprocess bucketed "today" from a midnight 15 hours behind the device
  // calendar, so the scan carries a session that ended yesterday evening.
  // The clock is pinned so the session stays "before local midnight" on any
  // runner date, not just the day this file was written.
  const now = new Date(2026, 9, 10, 10, 0, 0);
  const flags = [];
  async function stubTokscale({ flags: callFlags }) {
    flags.push(callFlags.join(' '));
    if (callFlags.includes('--today')) {
      return { entries: [{
        client: 'claude', sessionId: 's1', model: 'claude-opus',
        input: 80, output: 0, cost: 0, timestamp: '2026-10-09T20:00:00+08:00'
      }] };
    }
    if (callFlags.includes('--month')) return { entries: [{ client: 'claude', sessionId: 'm1', model: 'claude-opus', input: 800, output: 0, cost: 0 }] };
    return { entries: [{ client: 'claude', sessionId: 'a1', model: 'claude-opus', input: 8000, output: 0, cost: 0 }] };
  }

  const driftReports = [];
  const summary = await collectUsageOnce(baseOptions({
    now,
    todayOnlyAnchor: anchorFixture({ dateKey: localTodayKey(now), utcOffsetMinutes: utcOffsetMinutes(now) }),
    runTokscale: stubTokscale,
    onTodayWindowDrift: (drifted) => driftReports.push(drifted)
  }));

  assert.deepEqual(driftReports, [true]);
  // One anchored --today scan plus the full three-scan fallback — the exact
  // delta identity is dead, so month/allTime are re-read rather than derived.
  assert.equal(flags.filter(value => value.includes('--today')).length, 2);
  assert.ok(flags.some(value => value.includes('--month')));
  assert.equal(summary.month.totalTokens, 800, 'month must come from the fresh scan, not the drifted delta');
  assert.equal(summary.today.totalTokens, 80);
});

test('a clean anchored tick keeps the single-scan delta path and reports no drift', async () => {
  const now = new Date(2026, 9, 10, 10, 0, 0);
  const flags = [];
  async function stubTokscale({ flags: callFlags }) {
    flags.push(callFlags.join(' '));
    return { entries: [{
      client: 'claude', sessionId: 's1', model: 'claude-opus',
      input: 80, output: 0, cost: 0, timestamp: '2026-10-10T09:00:00+08:00'
    }] };
  }

  const driftReports = [];
  const summary = await collectUsageOnce(baseOptions({
    now,
    todayOnlyAnchor: anchorFixture({ dateKey: localTodayKey(now), utcOffsetMinutes: utcOffsetMinutes(now) }),
    runTokscale: stubTokscale,
    onTodayWindowDrift: (drifted) => driftReports.push(drifted)
  }));

  assert.deepEqual(driftReports, [false]);
  assert.equal(flags.length, 1, 'a clean window keeps the one-scan anchored tick');
  assert.equal(summary.today.totalTokens, 80);
  assert.equal(summary.month.totalTokens, 530, 'month = 500 + (80 − 50) via the exact delta');
});
