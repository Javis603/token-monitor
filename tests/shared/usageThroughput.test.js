'use strict';

// tokscale reports throughput per entry as a `performance` block. We keep raw sums —
// timedTokens, timedOutputTokens, timedDurationMs — rather than its pre-divided
// msPer1KTokens, because a ratio cannot be summed: only the components survive merging
// across rows, clients, devices and the today-delta that a watch-triggered scan uses to
// update month/allTime.
//
// timedOutputTokens is the one that has to be built per entry. Coverage is close to
// all-or-nothing per client, so a coverage rebuilt from period totals lets a client that
// reports no durations at all move a different client's rate. Several tests below pin that
// specifically, because the failure is silent: the number stays plausible and just drifts
// with the client mix.

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

// Output tokens per second, the way the renderer derives it.
function speed(p) {
  return p.timedDurationMs > 0 ? p.timedOutputTokens * 1000 / p.timedDurationMs : 0;
}

// What a coverage rebuilt from period totals would produce. Kept here so the tests can
// assert the gap rather than just the right answer.
function speedFromPeriodTotals(p) {
  if (!(p.timedDurationMs > 0) || !(p.totalTokens > 0)) return 0;
  return p.outputTokens * Math.min(1, p.timedTokens / p.totalTokens) * 1000 / p.timedDurationMs;
}

test('throughput is summed from every entry performance block', () => {
  const result = extractUsageFromTokscale({
    entries: [
      tokscaleEntry(),
      tokscaleEntry({ sessionId: 's2', performance: { totalDurationMs: 500, timedTokens: 250, tokenCoverage: 0.25 } })
    ]
  });
  assert.equal(result.timedDurationMs, 1500);
  assert.equal(result.timedTokens, 1150);
  // 40 × 0.9 + 40 × 0.25, each apportioned against its own entry's coverage.
  assert.equal(result.timedOutputTokens, 46);
});

test('an entry without a performance block contributes no throughput', () => {
  const result = extractUsageFromTokscale({ entries: [tokscaleEntry({ performance: undefined })] });
  assert.equal(result.timedDurationMs, 0);
  assert.equal(result.timedTokens, 0);
  assert.equal(result.timedOutputTokens, 0);
  assert.equal(result.outputTokens, 40, 'the rest of the row is still counted');
});

test('a client that reports no durations cannot move a timed client rate', () => {
  // The shape that makes this bite: the untimed client is far less cache-heavy, so a small
  // share of tokens is a large share of output. Modelled on real scans, where Copilot runs
  // ~3.3% output-to-total against Claude's ~0.6%.
  const timed = tokscaleEntry({
    client: 'claude',
    input: 0,
    output: 6_000,
    cacheRead: 994_000,
    cacheWrite: 0,
    performance: { totalDurationMs: 120_000, timedTokens: 1_000_000, tokenCoverage: 1 }
  });
  const untimed = tokscaleEntry({
    client: 'copilot',
    sessionId: 's2',
    input: 0,
    output: 6_600,
    cacheRead: 193_400,
    cacheWrite: 0,
    performance: undefined
  });

  const result = extractUsageFromTokscale({ entries: [timed, untimed] });
  assert.equal(result.outputTokens, 12_600, 'both clients still count toward output');
  assert.equal(result.timedOutputTokens, 6_000, 'only the timed client contributes to the rate');
  assert.equal(speed(result), 50, 'the reading is the timed client true rate');
  // Same inputs through a period-total coverage: 12,600 × (1,000,000 / 1,200,000) over 120 s.
  assert.equal(speedFromPeriodTotals(result), 87.5);
});

test('partial coverage is apportioned per entry rather than rounded to all or nothing', () => {
  const result = extractUsageFromTokscale({
    entries: [tokscaleEntry({
      output: 1_000,
      cacheRead: 99_000,
      input: 0,
      cacheWrite: 0,
      performance: { totalDurationMs: 20_000, timedTokens: 92_650, tokenCoverage: 0.9265 }
    })]
  });
  assert.equal(result.timedOutputTokens, 927, '1000 × 0.9265, rounded');
  assert.equal(result.timedTokens, 92_650);
});

test('tokscale tokenCoverage is preferred over a ratio against our own total', () => {
  // tokscale counts reasoning in its coverage denominator; our totalTokens deliberately does
  // not (it is already inside output). So timedTokens can exceed totalTokens on a
  // reasoning-heavy entry, and a ratio rebuilt here would need clamping to avoid exceeding 1.
  const result = extractUsageFromTokscale({
    entries: [tokscaleEntry({
      input: 0,
      output: 500,
      cacheRead: 99_500,
      cacheWrite: 0,
      reasoning: 4_000,
      performance: { totalDurationMs: 10_000, timedTokens: 104_000, tokenCoverage: 1 }
    })]
  });
  assert.equal(result.totalTokens, 100_000, 'reasoning stays out of totalTokens');
  assert.ok(result.timedTokens > result.totalTokens, 'the entry is the over-100%-raw-coverage case');
  assert.equal(result.timedOutputTokens, 500, 'fully timed means all of the output counts');
});

test('a missing tokenCoverage field falls back to the entry own ratio', () => {
  const result = extractUsageFromTokscale({
    entries: [tokscaleEntry({
      input: 0,
      output: 200,
      cacheRead: 800,
      cacheWrite: 0,
      performance: { totalDurationMs: 5_000, timedTokens: 500 }
    })]
  });
  assert.equal(result.timedOutputTokens, 100, '200 × (500 / 1000)');
});

test('normalizePeriod accepts both spellings and defaults an older payload to zero', () => {
  assert.equal(normalizePeriod({ timedTokens: 900, timedDurationMs: 1000 }).timedDurationMs, 1000);
  assert.equal(normalizePeriod({ timed_tokens: 900, timed_duration_ms: 1000 }).timedTokens, 900);
  assert.equal(normalizePeriod({ timedOutputTokens: 42 }).timedOutputTokens, 42);
  assert.equal(normalizePeriod({ timed_output_tokens: 42 }).timedOutputTokens, 42);
  const legacy = normalizePeriod({ totalTokens: 5 });
  assert.equal(legacy.timedTokens, 0);
  assert.equal(legacy.timedOutputTokens, 0);
  assert.equal(legacy.timedDurationMs, 0);
});

test('addPeriodInto sums the components so cross-device throughput divides once at the end', () => {
  const target = period({ timedTokens: 900, timedDurationMs: 1000, timedOutputTokens: 40, outputTokens: 40 });
  addPeriodInto(target, period({ timedTokens: 300, timedDurationMs: 600, timedOutputTokens: 20, outputTokens: 20 }));
  assert.equal(target.timedTokens, 1200);
  assert.equal(target.timedOutputTokens, 60);
  assert.equal(target.timedDurationMs, 1600);
  // A device running at 40 tok/s merged with one at 33.3 tok/s is 37.5 tok/s overall — the
  // component sum, not the mean of the two rates (36.7), which is what averaging would give.
  assert.equal(speed(target), 37.5);
});

test('mergePeriods carries throughput across per-client today partitions', () => {
  const merged = mergePeriods(
    period({ timedTokens: 900, timedDurationMs: 1000, timedOutputTokens: 40 }),
    period({ timedTokens: 100, timedDurationMs: 250, timedOutputTokens: 10 })
  );
  assert.equal(merged.timedTokens, 1000);
  assert.equal(merged.timedOutputTokens, 50);
  assert.equal(merged.timedDurationMs, 1250);
});

test('throughput survives the sync upload and aggregates duration-weighted across devices', () => {
  // buildSyncPayload is spread-and-delete today, so the fields ride along for free. If it ever
  // becomes a field whitelist, the fleet rate would silently drop to the local device's own
  // throughput with nothing else failing — hence a guard on the round trip, not just the math.
  const device = (deviceId, outputTokens, timedDurationMs, coverage) => ({
    deviceId,
    hostname: deviceId,
    platform: 'darwin',
    updatedAt: new Date().toISOString(),
    today: period({
      totalTokens: outputTokens * 10,
      outputTokens,
      timedTokens: Math.round(outputTokens * 10 * coverage),
      timedOutputTokens: Math.round(outputTokens * coverage),
      timedDurationMs,
      clients: { claude: outputTokens * 10 }
    }),
    month: emptyPeriod(),
    allTime: emptyPeriod()
  });

  // Deliberately unequal coverage: the mac is fully timed at 40 tok/s over 10 minutes, the pc
  // runs half its work through a client that reports no durations, so only half its output
  // belongs over its 100 minutes of timed work.
  const uploaded = [device('mac', 24_000, 600_000, 1), device('pc', 120_000, 6_000_000, 0.5)]
    .map((record) => normalizeDeviceRecord(JSON.parse(JSON.stringify(syncPayload(record)))));
  for (const record of uploaded) {
    assert.ok(record.periods.today.timedDurationMs > 0, 'timedDurationMs must survive the upload');
    assert.ok(record.periods.today.timedTokens > 0, 'timedTokens must survive the upload');
    assert.ok(record.periods.today.timedOutputTokens > 0, 'timedOutputTokens must survive the upload');
  }

  const today = aggregateDevices(uploaded, 0).periods.today;
  assert.equal(today.outputTokens, 144_000);
  assert.equal(today.timedOutputTokens, 84_000);
  assert.equal(today.timedDurationMs, 6_600_000);
  // Duration-weighted over the timed output only: 12.7 tok/s. Reading the fleet's whole
  // output against the same denominator would claim 21.8.
  assert.equal(speed(today).toFixed(1), '12.7');
});

test('applyPeriodDelta updates throughput exactly from a today-only rescan', () => {
  const baseMonth = period({ timedTokens: 5000, timedOutputTokens: 380, timedDurationMs: 9000, outputTokens: 400 });
  const anchorToday = period({ timedTokens: 500, timedOutputTokens: 38, timedDurationMs: 900, outputTokens: 40 });
  const freshToday = period({ timedTokens: 800, timedOutputTokens: 66, timedDurationMs: 1500, outputTokens: 70 });

  const month = applyPeriodDelta(baseMonth, freshToday, anchorToday);
  assert.equal(month.timedTokens, 5300);
  assert.equal(month.timedOutputTokens, 408);
  assert.equal(month.timedDurationMs, 9600);
  assert.equal(month.outputTokens, 430);
});

test('applyPeriodDelta never drives throughput negative when the anchor is stale', () => {
  const month = applyPeriodDelta(
    period({ timedTokens: 100, timedOutputTokens: 10, timedDurationMs: 200 }),
    period({ timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0 }),
    period({ timedTokens: 900, timedOutputTokens: 90, timedDurationMs: 1800 })
  );
  assert.equal(month.timedTokens, 0);
  assert.equal(month.timedOutputTokens, 0);
  assert.equal(month.timedDurationMs, 0);
});
