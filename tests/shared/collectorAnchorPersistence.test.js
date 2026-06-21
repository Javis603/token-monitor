'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configFingerprint,
  collectUsageOnce,
  localTodayKey
} = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

test('configFingerprint normalizes clients and includes allTimeSince', () => {
  const a = configFingerprint('claude, codex', '2024-01-01');
  const b = configFingerprint('claude,codex', '2024-01-01');
  // whitespace-normalised to the same value
  assert.equal(a, b, 'whitespace should be normalized');
  assert.match(a, /^claude,codex\|2024-01-01$/);

  const c = configFingerprint('claude', '2024-01-01');
  assert.notEqual(a, c, 'different clients should differ');

  const d = configFingerprint('claude,codex', '2024-06-01');
  assert.notEqual(a, d, 'different allTimeSince should differ');
});

test('configFingerprint handles undefined and empty clients', () => {
  const a = configFingerprint(undefined, '2024-01-01');
  assert.equal(a, '|2024-01-01', 'undefined clients should produce empty string before pipe');

  const b = configFingerprint('', '2024-01-01');
  assert.equal(b, '|2024-01-01', 'empty clients should produce same as undefined');

  const c = configFingerprint('claude', undefined);
  assert.match(c, /\|undefined$/, 'undefined allTimeSince produces string "undefined"');
});

test('anchored tick with valid anchor runs todayOnly scan and derives month/allTime', async () => {
  const dateKey = localTodayKey();

  // Establish a baseline anchor from a "previous full scan"
  const anchorToday = emptyPeriod();
  anchorToday.totalTokens = 50;
  anchorToday.clients = { claude: 50 };

  const anchorMonth = emptyPeriod();
  anchorMonth.totalTokens = 500;
  anchorMonth.clients = { claude: 500 };

  const anchorAllTime = emptyPeriod();
  anchorAllTime.totalTokens = 5000;
  anchorAllTime.clients = { claude: 5000 };

  const anchor = { dateKey, today: anchorToday, month: anchorMonth, allTime: anchorAllTime };

  // Stub tokscale to return a delta: today jumped from 50 to 130
  let tokscaleCalls = 0;
  async function stubTokscale() {
    tokscaleCalls += 1;
    return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus', input: 80, output: 0, cost: 0 }] };
  }

  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    todayOnlyAnchor: anchor,
    wslAnchor: emptyWslBundle(),
    runTokscale: stubTokscale,
    collectWslUsage: async () => emptyWslBundle()
  });

  // Only one tokscale call (--today), not three
  assert.equal(tokscaleCalls, 1, 'anchored tick must only run one tokscale scan');

  // today = 80 (from stub; anchor was 50)
  assert.equal(summary.today.totalTokens, 80, 'today should come from fresh scan');

  // month = anchor month 500 + (today 80 - anchor today 50) = 530
  assert.equal(summary.month.totalTokens, 530, 'month should be derived via applyPeriodDelta');

  // allTime = anchor allTime 5000 + (today 80 - anchor today 50) = 5030
  assert.equal(summary.allTime.totalTokens, 5030, 'allTime should be derived via applyPeriodDelta');
});

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}
