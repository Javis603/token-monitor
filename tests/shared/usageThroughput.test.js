'use strict';

// tokscale reports throughput per entry as a `performance` block. We keep the raw
// (timedTokens, timedDurationMs) pair rather than its pre-divided msPer1KTokens because a
// ratio cannot be summed: only the components survive merging across rows, clients, devices
// and the today-delta that a watch-triggered scan uses to update month/allTime.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateDevices,
  applyPeriodDelta,
  addPeriodInto,
  emptyPeriod,
  extractUsageFromTokscale,
  mergePeriods,
  normalizeDeviceRecord,
  normalizePeriod
} = require('../../src/shared/usage');
const { syncPayload } = require('../../src/shared/syncPayload');

function period(overrides = {}) {
  return { ...emptyPeriod(), ...overrides };
}

function tokscaleEntry(overrides = {}) {
  return {
    client: 'claude',
    sessionId: 's1',
    model: 'claude-opus-4-8',
    input: 100,
    output: 40,
    cacheRead: 800,
    cacheWrite: 60,
    reasoning: 0,
    messageCount: 2,
    cost: 0.01,
    performance: { msPer1KTokens: 100, totalDurationMs: 1000, timedTokens: 900, sampleCount: 2, tokenCoverage: 0.9 },
    ...overrides
  };
}

test('throughput is summed from every entry performance block', () => {
  const result = extractUsageFromTokscale({
    entries: [
      tokscaleEntry(),
      tokscaleEntry({ sessionId: 's2', performance: { totalDurationMs: 500, timedTokens: 250 } })
    ]
  });
  assert.equal(result.timedDurationMs, 1500);
  assert.equal(result.timedTokens, 1150);
});

test('an entry without a performance block contributes no throughput', () => {
  const result = extractUsageFromTokscale({ entries: [tokscaleEntry({ performance: undefined })] });
  assert.equal(result.timedDurationMs, 0);
  assert.equal(result.timedTokens, 0);
  assert.equal(result.outputTokens, 40, 'the rest of the row is still counted');
});

test('normalizePeriod accepts both spellings and defaults an older payload to zero', () => {
  assert.equal(normalizePeriod({ timedTokens: 900, timedDurationMs: 1000 }).timedDurationMs, 1000);
  assert.equal(normalizePeriod({ timed_tokens: 900, timed_duration_ms: 1000 }).timedTokens, 900);
  const legacy = normalizePeriod({ totalTokens: 5 });
  assert.equal(legacy.timedTokens, 0);
  assert.equal(legacy.timedDurationMs, 0);
});

test('addPeriodInto sums the pair so cross-device throughput divides once at the end', () => {
  const target = period({ timedTokens: 900, timedDurationMs: 1000, outputTokens: 40 });
  addPeriodInto(target, period({ timedTokens: 300, timedDurationMs: 600, outputTokens: 20 }));
  assert.equal(target.timedTokens, 1200);
  assert.equal(target.timedDurationMs, 1600);
  // A device running at 40 tok/s merged with one at 33.3 tok/s is 37.5 tok/s overall — the
  // component sum, not the mean of the two rates (36.7), which is what averaging would give.
  assert.equal(target.outputTokens * 1000 / target.timedDurationMs, 37.5);
});

test('mergePeriods carries throughput across per-client today partitions', () => {
  const merged = mergePeriods(
    period({ timedTokens: 900, timedDurationMs: 1000 }),
    period({ timedTokens: 100, timedDurationMs: 250 })
  );
  assert.equal(merged.timedTokens, 1000);
  assert.equal(merged.timedDurationMs, 1250);
});

test('throughput survives the sync upload and aggregates duration-weighted across devices', () => {
  // buildSyncPayload is spread-and-delete today, so the pair rides along for free. If it ever
  // becomes a field whitelist, the fleet rate would silently drop to the local device's own
  // throughput with nothing else failing — hence a guard on the round trip, not just the math.
  const device = (deviceId, outputTokens, timedDurationMs) => ({
    deviceId,
    hostname: deviceId,
    platform: 'darwin',
    updatedAt: new Date().toISOString(),
    today: period({
      totalTokens: outputTokens * 10,
      outputTokens,
      timedTokens: outputTokens * 10,
      timedDurationMs,
      clients: { claude: outputTokens * 10 }
    }),
    month: emptyPeriod(),
    allTime: emptyPeriod()
  });

  // 40 tok/s over 10 minutes and 20 tok/s over 100 minutes.
  const uploaded = [device('mac', 24_000, 600_000), device('pc', 120_000, 6_000_000)]
    .map((record) => normalizeDeviceRecord(JSON.parse(JSON.stringify(syncPayload(record)))));
  for (const record of uploaded) {
    assert.ok(record.periods.today.timedDurationMs > 0, 'timedDurationMs must survive the upload');
    assert.ok(record.periods.today.timedTokens > 0, 'timedTokens must survive the upload');
  }

  const today = aggregateDevices(uploaded, 0).periods.today;
  assert.equal(today.outputTokens, 144_000);
  assert.equal(today.timedDurationMs, 6_600_000);
  // Duration-weighted (21.8), not the sum of the rates (60) nor their mean (30).
  assert.equal((today.outputTokens * 1000 / today.timedDurationMs).toFixed(1), '21.8');
});

test('applyPeriodDelta updates throughput exactly from a today-only rescan', () => {
  const baseMonth = period({ timedTokens: 5000, timedDurationMs: 9000, outputTokens: 400 });
  const anchorToday = period({ timedTokens: 500, timedDurationMs: 900, outputTokens: 40 });
  const freshToday = period({ timedTokens: 800, timedDurationMs: 1500, outputTokens: 70 });

  const month = applyPeriodDelta(baseMonth, freshToday, anchorToday);
  assert.equal(month.timedTokens, 5300);
  assert.equal(month.timedDurationMs, 9600);
  assert.equal(month.outputTokens, 430);
});

test('applyPeriodDelta never drives throughput negative when the anchor is stale', () => {
  const month = applyPeriodDelta(
    period({ timedTokens: 100, timedDurationMs: 200 }),
    period({ timedTokens: 0, timedDurationMs: 0 }),
    period({ timedTokens: 900, timedDurationMs: 1800 })
  );
  assert.equal(month.timedTokens, 0);
  assert.equal(month.timedDurationMs, 0);
});
