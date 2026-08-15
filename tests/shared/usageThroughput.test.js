'use strict';

// tokscale reports throughput per entry as a `performance` block. We keep raw sums —
// timedTokens, timedOutputTokens, timedDurationMs — rather than its pre-divided
// msPer1KTokens, because a ratio cannot be summed: only the components survive merging
// across rows, clients, devices and the today-delta that a watch-triggered scan uses to
// update month/allTime.
//
// timedOutputTokens is the one that has to be built per entry: an entry contributes its output
// exactly when it contributes its duration. Whole clients report no durations at all, so
// anything rebuilt from period totals lets one of them put its output on another client's clock.
// Several tests below pin that specifically, because the failure is silent — the number stays
// plausible and just drifts with the client mix.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateDevices,
  applyPeriodDelta,
  addPeriodInto,
  emptyPeriod,
  extractUsageBundleFromTokscale,
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
  // Both entries carried a duration, so both contribute their whole output.
  assert.equal(result.timedOutputTokens, 80);
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

test('a partly timed entry contributes its whole output and stays an integer', () => {
  // tokscale would report tokenCoverage 0.9265 here, and this deliberately does not scale by
  // it. Output is 1% of this entry's tokens while the untimed remainder is 7,350 — over seven
  // times the entry's entire output — so the untimed part is cache, not generation. Scaling
  // would discount output that was almost certainly timed, and would make the field a ratio
  // instead of a counter.
  const result = extractUsageFromTokscale({
    entries: [tokscaleEntry({
      output: 1_000,
      cacheRead: 99_000,
      input: 0,
      cacheWrite: 0,
      performance: { totalDurationMs: 20_000, timedTokens: 92_650, tokenCoverage: 0.9265 }
    })]
  });
  assert.equal(result.timedOutputTokens, 1_000);
  assert.ok(Number.isInteger(result.timedOutputTokens), 'a counter, not an apportionment');
  assert.equal(result.timedTokens, 92_650);
});

test('normalizePeriod accepts both spellings and defaults an older payload to zero', () => {
  assert.equal(normalizePeriod({ timedTokens: 900, timedDurationMs: 1000 }).timedDurationMs, 1000);
  assert.equal(normalizePeriod({ timed_tokens: 900, timed_duration_ms: 1000 }).timedTokens, 900);
  // outputTokens rides along in any real payload, and the cap below needs it present.
  assert.equal(normalizePeriod({ outputTokens: 50, timedOutputTokens: 42 }).timedOutputTokens, 42);
  assert.equal(normalizePeriod({ output_tokens: 50, timed_output_tokens: 42 }).timedOutputTokens, 42);
  const legacy = normalizePeriod({ totalTokens: 5 });
  assert.equal(legacy.timedTokens, 0);
  assert.equal(legacy.timedOutputTokens, 0);
  assert.equal(legacy.timedDurationMs, 0);
  assert.equal(legacy.capabilities.tokenComponents, false);
  assert.equal(legacy.unclassifiedTokens, 5);
  assert.equal(normalizePeriod({
    totalTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0
  }).capabilities.tokenComponents, true);
});

test('normalizePeriod preserves known native components beside an explicit unknown remainder', () => {
  const period = normalizePeriod({
    totalTokens: 100,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 10,
    capabilities: { tokenComponents: false },
    clients: { codex: 100 },
    clientCacheReads: { codex: 60 },
    clientCacheWrites: { codex: 10 },
    clientOutputs: { codex: 20 },
    clientUnclassifiedTokens: { codex: 10 },
    models: { 'gpt-5': 100 },
    modelCacheReads: { 'gpt-5': 60 },
    modelCacheWrites: { 'gpt-5': 10 },
    modelOutputs: { 'gpt-5': 20 },
    modelUnclassifiedTokens: { 'gpt-5': 10 }
  });

  assert.equal(period.capabilities.tokenComponents, false);
  assert.equal(period.cacheReadTokens, 60);
  assert.equal(period.outputTokens, 20);
  assert.equal(period.unclassifiedTokens, 10);
  assert.equal(period.clientUnclassifiedTokens.codex, 10);
  assert.equal(period.modelUnclassifiedTokens['gpt-5'], 10);
});

test('normalization caps timedOutputTokens at the output it claims to have timed', () => {
  // The collector cannot break this — output is gated whole or not at all — but the hub and the
  // Worker normalize whatever an agent posts, and this value divides straight into a headline
  // tok/s. Without the cap a single malformed record sets the fleet rate arbitrarily high.
  const capped = normalizePeriod({ outputTokens: 100, timedOutputTokens: 5_000, timedDurationMs: 1_000 });
  assert.equal(capped.timedOutputTokens, 100);
  assert.equal(capped.timedOutputTokens * 1000 / capped.timedDurationMs, 100, 'bounded at all-output-was-timed');
  // A legitimate fully-timed period is untouched, and so is a partly timed one.
  assert.equal(normalizePeriod({ outputTokens: 100, timedOutputTokens: 100 }).timedOutputTokens, 100);
  assert.equal(normalizePeriod({ outputTokens: 100, timedOutputTokens: 60 }).timedOutputTokens, 60);
  // A payload carrying no output at all cannot smuggle throughput in either.
  assert.equal(normalizePeriod({ timedOutputTokens: 5_000 }).timedOutputTokens, 0);
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
    period({ timedTokens: 900, timedDurationMs: 1000, outputTokens: 40, timedOutputTokens: 40 }),
    period({ timedTokens: 100, timedDurationMs: 250, outputTokens: 10, timedOutputTokens: 10 })
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

test('a watch tick covering two clients at once partitions their throughput separately', () => {
  // Two tools active together are unioned into one tokscale call, and the bundle splits the
  // rows back into per-client partitions. Each row carries its own coverage, so the split is
  // exactly equivalent to having scanned them separately — which is what lets a later tick
  // replace one of those partitions without disturbing the other.
  const row = (client, output, timedTokens, totalDurationMs) => tokscaleEntry({
    client,
    sessionId: `${client}-1`,
    input: 0,
    output,
    cacheRead: output * 100,
    cacheWrite: 0,
    performance: { totalDurationMs, timedTokens, tokenCoverage: 1 }
  });
  const claude = row('claude', 6_000, 606_000, 120_000);
  const codex = row('codex', 3_000, 303_000, 120_000);

  const bundle = extractUsageBundleFromTokscale({ entries: [claude, codex] });
  assert.deepEqual(Object.keys(bundle.byClient).sort(), ['claude', 'codex']);
  assert.equal(speed(bundle.byClient.claude), 50, 'each partition keeps its own throughput');
  assert.equal(speed(bundle.byClient.codex), 25);

  const unioned = mergePeriods(...Object.values(bundle.byClient));
  const separate = mergePeriods(
    extractUsageFromTokscale({ entries: [claude] }),
    extractUsageFromTokscale({ entries: [codex] })
  );
  assert.equal(unioned.timedOutputTokens, separate.timedOutputTokens);
  assert.equal(unioned.timedDurationMs, separate.timedDurationMs);
  // Concurrent tools sum their busy time rather than sharing a wall clock, so the combined
  // reading is duration-weighted across them (37.5), not the sum of their rates (75).
  assert.equal(speed(unioned), 37.5);
});

test('an unattributed fallback period reads as no throughput data, never NaN', () => {
  // A tokscale payload whose rows cannot be parsed falls back to a period built from top-level
  // totals, which carries none of the throughput fields. Both addPeriodInto call sites
  // normalize first, so those gaps become 0 instead of poisoning a merge.
  const fallback = extractUsageFromTokscale({ totalOutput: 12_345, totalInput: 100, totalCost: 1 });
  const timed = extractUsageFromTokscale({ entries: [tokscaleEntry()] });
  const merged = mergePeriods(fallback, timed);
  for (const field of ['totalTokens', 'outputTokens', 'timedTokens', 'timedOutputTokens', 'timedDurationMs']) {
    assert.ok(Number.isFinite(merged[field]), `${field} must stay finite, got ${merged[field]}`);
  }
  assert.equal(merged.timedOutputTokens, timed.timedOutputTokens, 'the fallback adds no phantom throughput');
  assert.equal(normalizePeriod(fallback).timedOutputTokens, 0);
});

test('aggregate fallback component provenance survives normalization and warm deltas', () => {
  const exactBase = extractUsageFromTokscale({ entries: [tokscaleEntry()] });
  const exactAnchor = extractUsageFromTokscale({ entries: [tokscaleEntry()] });
  const aggregateFallback = extractUsageFromTokscale({ totalTokens: 200, totalCost: 2 });

  assert.equal(normalizePeriod(aggregateFallback).capabilities.tokenComponents, false);
  assert.equal(normalizePeriod(aggregateFallback).unclassifiedTokens, 200);
  assert.equal(
    applyPeriodDelta(exactBase, aggregateFallback, exactAnchor).capabilities.tokenComponents,
    false
  );
});

test('a targeted watch tick lands on the same throughput as a full rescan', () => {
  // The live path is not a whole-fleet rescan: a watch event maps a changed file to one client
  // and rescans only that client's --today partition, which is then merged back over the other
  // clients' retained partitions. The per-entry gate is what makes that safe — each
  // partition already carries its own correctly weighted share, so an untimed client sitting in
  // a stale partition cannot move the rate, and the targeted result has to equal the full one.
  const claude = (output, timedTokens, totalDurationMs) => tokscaleEntry({
    client: 'claude',
    input: 0,
    output,
    cacheRead: output * 100,
    cacheWrite: 0,
    performance: { totalDurationMs, timedTokens, tokenCoverage: 1 }
  });
  const copilot = tokscaleEntry({ client: 'copilot', sessionId: 'p1', input: 0, output: 6_600, cacheRead: 198_000, cacheWrite: 0, performance: undefined });

  const copilotPartition = extractUsageFromTokscale({ entries: [copilot] });
  const olderMonthOnly = extractUsageFromTokscale({ entries: [claude(50_000, 5_050_000, 1_000_000)] });

  const todayBefore = mergePeriods(extractUsageFromTokscale({ entries: [claude(6_000, 606_000, 120_000)] }), copilotPartition);
  const monthBefore = mergePeriods(todayBefore, olderMonthOnly);

  // Watch tick: only claude is rescanned, copilot's partition is reused untouched.
  const claudeAfter = extractUsageFromTokscale({ entries: [claude(6_450, 651_450, 129_000)] });
  const todayTargeted = mergePeriods(claudeAfter, copilotPartition);
  const monthTargeted = applyPeriodDelta(monthBefore, todayTargeted, todayBefore);

  const todayFull = mergePeriods(claudeAfter, copilotPartition);
  const monthFull = mergePeriods(todayFull, olderMonthOnly);

  assert.equal(todayTargeted.timedOutputTokens, todayFull.timedOutputTokens);
  assert.equal(todayTargeted.timedDurationMs, todayFull.timedDurationMs);
  assert.equal(monthTargeted.timedOutputTokens.toFixed(6), monthFull.timedOutputTokens.toFixed(6));
  assert.equal(monthTargeted.timedDurationMs, monthFull.timedDurationMs);

  // Claude's real throughput never changed, so neither may the reading — even though the merged
  // period's totals did. A coverage rebuilt from those totals would drift on every tick.
  assert.equal(speed(todayBefore), 50);
  assert.equal(speed(todayTargeted), 50);
  assert.equal(speedFromPeriodTotals(todayBefore).toFixed(2), '78.50');
  assert.equal(speedFromPeriodTotals(todayTargeted).toFixed(2), '76.98');
});

// A session spanning midnight is the only case where the delta path and a full rescan can
// disagree, because a full `--month` scan folds that session's messages from both days into one
// tokscale entry and re-gates it as a whole. These two pin where the line falls, since the
// field's contract rests on it.
function crossDaySession({ output, timedTokens, total, tokenCoverage, totalDurationMs }) {
  return tokscaleEntry({
    client: 'claude',
    sessionId: 'spans-midnight',
    input: 0,
    output,
    cacheRead: total - output,
    cacheWrite: 0,
    performance: { totalDurationMs, timedTokens, tokenCoverage }
  });
}
const throughputOf = (entry) => extractUsageFromTokscale({ entries: [entry] }).timedOutputTokens;

test('a session spanning midnight is exact under the delta while it keeps reporting durations', () => {
  // The realistic regime, and the reason the gate beats an apportionment: a partly timed entry
  // stays partly timed as it grows, so the gate holds on both sides and the sum is exact —
  // even though tokscale's coverage moves (0.9965 → 0.9965 → 0.9965 only by construction here;
  // real sessions drift within a narrow band and would break an apportionment, not a gate).
  const yesterday = crossDaySession({ output: 500, timedTokens: 996_500, total: 1_000_000, tokenCoverage: 0.9965, totalDurationMs: 10_000 });
  const todayOnly = crossDaySession({ output: 90, timedTokens: 8_100_000, total: 9_000_000, tokenCoverage: 0.9, totalDurationMs: 2_000 });
  const wholeSession = crossDaySession({ output: 590, timedTokens: 9_096_500, total: 10_000_000, tokenCoverage: 0.9097, totalDurationMs: 12_000 });

  assert.equal(throughputOf(yesterday) + throughputOf(todayOnly), throughputOf(wholeSession));
  assert.equal(throughputOf(wholeSession), 590, 'the whole session is timed, so all of its output counts');
});

test('a session that stops reporting durations diverges by a bounded, self-correcting amount', () => {
  // The adversarial regime: the client stops emitting durations partway through one session, so
  // a full rescan still gates the combined entry on the durations it kept from the first half
  // and picks up the later output too. Documented rather than engineered around — closing it
  // needs a per-message timed-output counter from tokscale, and rescanning month on every watch
  // tick would give back exactly the saving targeted partitions were introduced for.
  const yesterday = crossDaySession({ output: 500, timedTokens: 1_000, total: 1_000, tokenCoverage: 1, totalDurationMs: 10_000 });
  const todayOnly = crossDaySession({ output: 90, timedTokens: 0, total: 9_000, tokenCoverage: 0, totalDurationMs: 0 });
  const wholeSession = crossDaySession({ output: 590, timedTokens: 1_000, total: 10_000, tokenCoverage: 0.1, totalDurationMs: 10_000 });

  const viaDelta = throughputOf(yesterday) + throughputOf(todayOnly);
  const viaFullScan = throughputOf(wholeSession);
  assert.equal(viaDelta, 500);
  assert.equal(viaFullScan, 590);
  // Under-, not over-reporting, and by the later output alone — 18%, where scaling by coverage
  // would have repriced the whole entry and landed on 59, an 8.5x gap. The next full scan
  // reconciles either way, so the divergence is bounded by one anchor interval.
  assert.ok(viaDelta < viaFullScan);
  assert.equal(viaFullScan - viaDelta, 90);
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
