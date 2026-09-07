'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAccountQuotaSummary,
  chooseCapacityCandidate,
  currentCycleSamples,
  deriveQuotaAmounts,
  locallyObservedDelta,
  sameQuotaCycle,
  sameWindow,
  withinCurrentRun
} = require('../../src/shared/quotaEngine');

const RESET = '2026-09-01T00:00:00.000Z';

function sample(percent, tokens, usd, extra = {}) {
  const { at, ...rest } = extra;
  return {
    observedAt: at || new Date(Date.UTC(2026, 7, 25, 0, 0, Number(percent) || 0)).toISOString(),
    provider: 'codex', profileId: 'codex-default', kind: 'weekly', limitId: 'weekly',
    windowMinutes: 10080, resetsAt: RESET, segmentId: 'current',
    usedPercent: percent, observedTotalTokens: tokens, pricedTokens: tokens,
    unpricedTokens: 0, apiEquivalentCostUsd: usd, pricingCoverage: 1,
    snapshotId: 'openai-v1', scopeVersion: 'scope-v1', sampleId: `sample-${percent}`,
    ...rest
  };
}

function estimate(capacity, extra = {}) {
  return {
    provider: 'codex', profileId: 'codex-default', kind: 'weekly', limitId: 'weekly',
    windowMinutes: 10080, windowIdentity: 'weekly|weekly|10080',
    segmentId: extra.segmentId || 'current', scopeVersion: 'scope-v1',
    resetsAt: extra.resetsAt || RESET,
    current: extra.current !== false, lastObservedAt: extra.lastObservedAt || '2026-08-25T01:00:00.000Z',
    apiEquivalentUsd: {
      available: true, capacity, status: extra.status || 'stable',
      method: extra.method || 'observed-linear-estimate',
      cycleBasis: extra.cycleBasis || 'partial', completeness: 'complete',
      snapshotId: 'openai-v1', fitPointCount: 3, fitUsedPercentSpan: 30,
      rSquared: 1, normalizedRmse: 0
    },
    ...extra
  };
}

function liveWindow(extra = {}) {
  return {
    provider: 'codex', profileId: 'codex-default', kind: 'weekly', limitId: 'weekly',
    windowMinutes: 10080, resetsAt: RESET, segmentId: 'current',
    ...extra
  };
}

function weeklySummary(options) {
  return buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default', ...options
  });
}

test('derived amounts preserve the capacity identity at boundary and middle percentages', () => {
  for (const percent of [0, 37.5, 100]) {
    const result = deriveQuotaAmounts(80, percent);
    assert.equal(result.available, true);
    assert.equal(result.consumed + result.remaining, result.capacity);
    assert.equal(result.consumed, 80 * percent / 100);
  }
  assert.equal(deriveQuotaAmounts(0, 20).reason, 'invalid-capacity');
  assert.equal(deriveQuotaAmounts(80, NaN).reason, 'invalid-official-percent');
  assert.equal(deriveQuotaAmounts(80, Infinity).available, false);
  assert.equal(deriveQuotaAmounts(80, 101).available, false);
});

test('local observed API equivalent is a current-window delta, never profile lifetime pricing', () => {
  const rows = [sample(10, 1000, 10), sample(40, 2500, 25)];
  const observed = locallyObservedDelta(rows, liveWindow(), {
    ...estimate(100), firstObservedAt: rows[0].observedAt, lastObservedAt: rows[1].observedAt
  });
  assert.equal(observed.locallyObservedApiEquivalent, 15);
  assert.equal(observed.locallyObservedTokens, 1500);
  assert.notEqual(observed.locallyObservedApiEquivalent, 25);
});

test('missing zero anchor is partial and reports a baseline gap', () => {
  const rows = [sample(20, 2000, 2), sample(40, 5000, 5)];
  const observed = locallyObservedDelta(rows, liveWindow(), {
    ...estimate(10), firstObservedAt: rows[0].observedAt, lastObservedAt: rows[1].observedAt
  });
  assert.equal(observed.locallyObservedApiEquivalent, 3);
  assert.equal(observed.partial, true);
  assert.ok(observed.reasons.includes('accounting-baseline-gap'));
});

test('candidate priority is current full, then compatible history, then current partial', () => {
  const currentPartial = estimate(100, { current: true });
  const historyFull = estimate(200, {
    current: false, method: 'observed-full-cycle', cycleBasis: 'full',
    resetsAt: '2026-08-24T00:00:00.000Z', segmentId: 'history',
    lastObservedAt: '2026-08-24T01:00:00.000Z'
  });
  assert.equal(chooseCapacityCandidate([currentPartial, historyFull], currentPartial).basis, 'compatible-history-full-cycle');
  const currentFull = estimate(150, { method: 'observed-full-cycle', cycleBasis: 'full' });
  assert.equal(chooseCapacityCandidate([currentFull, historyFull], currentFull).basis, 'current-full-cycle');
  const incompatible = { ...historyFull, scopeVersion: 'other-scope' };
  assert.equal(chooseCapacityCandidate([currentPartial, incompatible], currentPartial).basis, 'current-partial-regression');
});

test('summary uses live official percentage and fails closed on invalid observations', () => {
  const rows = [sample(10, 1000, 1), sample(40, 3000, 3)];
  const current = estimate(10, { firstObservedAt: rows[0].observedAt, lastObservedAt: rows[1].observedAt });
  const summary = weeklySummary({
    window: { kind: 'weekly', limitId: 'weekly', windowMinutes: 10080, resetsAt: RESET, usedPercent: 40 },
    samples: rows, estimates: [current]
  });
  assert.equal(summary.locallyObservedApiEquivalent, 2);
  assert.equal(summary.officialUsedPercent, 40);
  assert.equal(summary.estimatedCapacity, 10);
  assert.equal(summary.derivedConsumed, 4);
  assert.equal(summary.derivedRemaining, 6);
  assert.equal(summary.basis, 'current-partial-regression');

  const invalid = weeklySummary({
    window: { kind: 'weekly', limitId: 'weekly', windowMinutes: 10080, resetsAt: RESET, usedPercent: 140 },
    samples: rows, estimates: [current]
  });
  assert.equal(invalid.estimatedCapacity, null);
  assert.ok(invalid.reasons.includes('invalid-official-percent'));
});

test('accounts, windows, pricing and scope remain isolated', () => {
  const base = estimate(10);
  assert.equal(chooseCapacityCandidate([base], { ...base, provider: 'other-client' }).basis, 'unavailable');
  assert.equal(chooseCapacityCandidate([base], { ...base, kind: 'session' }).basis, 'unavailable');
  assert.equal(chooseCapacityCandidate([base], { ...base, scopeVersion: 'other' }).basis, 'unavailable');
  const otherAccount = { ...base, profileId: 'codex-other' };
  assert.equal(chooseCapacityCandidate([base], otherAccount).basis, 'unavailable');
});

test('session and weekly windows stay independent', () => {
  const weekly = [sample(10, 1000, 1), sample(40, 4000, 4)];
  const session = [
    sample(10, 100, 0.1, { kind: 'session', limitId: 'session', windowMinutes: 300, segmentId: 'session-a' }),
    sample(20, 200, 0.2, { kind: 'session', limitId: 'session', windowMinutes: 300, segmentId: 'session-a' })
  ];
  const weeklyEstimate = estimate(10, { firstObservedAt: weekly[0].observedAt, lastObservedAt: weekly[1].observedAt });
  const sessionEstimate = estimate(1, {
    kind: 'session', limitId: 'session', windowMinutes: 300, windowIdentity: 'session|session|300',
    segmentId: 'session-a', firstObservedAt: session[0].observedAt, lastObservedAt: session[1].observedAt
  });
  const weeklySummaryResult = weeklySummary({
    window: { kind: 'weekly', limitId: 'weekly', windowMinutes: 10080, resetsAt: RESET, usedPercent: 40 },
    samples: [...weekly, ...session], estimates: [weeklyEstimate, sessionEstimate]
  });
  const sessionSummary = weeklySummary({
    window: { kind: 'session', limitId: 'session', windowMinutes: 300, resetsAt: RESET, usedPercent: 20 },
    samples: [...weekly, ...session], estimates: [weeklyEstimate, sessionEstimate]
  });
  assert.equal(weeklySummaryResult.locallyObservedApiEquivalent, 3);
  assert.equal(sessionSummary.locallyObservedApiEquivalent, 0.1);
  assert.equal(weeklySummaryResult.windowKind, 'weekly');
  assert.equal(sessionSummary.windowKind, 'session');
});

test('rollback and unpriced deltas lower confidence rather than being clamped into facts', () => {
  const rows = [sample(10, 2000, 2), sample(40, 1000, 1, { pricedTokens: 1000, unpricedTokens: 1000 })];
  const summary = weeklySummary({
    window: { kind: 'weekly', limitId: 'weekly', windowMinutes: 10080, resetsAt: RESET, usedPercent: 40 },
    samples: rows, estimates: [estimate(10, { firstObservedAt: rows[0].observedAt, lastObservedAt: rows[1].observedAt })]
  });
  assert.equal(summary.locallyObservedApiEquivalent, null);
  assert.equal(summary.confidence, 'unstable');
  assert.ok(summary.reasons.includes('cumulative-rollback'));
});

// --- cycle identity ---------------------------------------------------------

const OLD_RESET = '2026-08-31T00:00:00.000Z';
const NEW_RESET = '2026-09-07T00:00:00.000Z';

function sealedOldCycle() {
  const rows = [
    sample(0, 0, 0, { at: '2026-08-25T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old' }),
    sample(60, 6000, 60, { at: '2026-08-28T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old' }),
    sample(100, 12000, 100, { at: '2026-08-30T12:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old' })
  ];
  const sealed = estimate(100, {
    method: 'observed-full-cycle', cycleBasis: 'full', resetsAt: OLD_RESET, segmentId: 'old',
    lastObservedAt: rows.at(-1).observedAt, firstObservedAt: rows[0].observedAt
  });
  return { rows, sealed };
}

function newCycleWindow(usedPercent = 0) {
  return {
    kind: 'weekly', limitId: 'weekly', windowMinutes: 10080,
    observedAt: '2026-08-31T00:05:00.000Z', resetsAt: NEW_RESET, segmentId: 'new',
    usedPercent
  };
}

test('a sealed earlier cycle never becomes this cycle’s locally observed amount', () => {
  const { rows, sealed } = sealedOldCycle();
  const summary = weeklySummary({ window: newCycleWindow(0), samples: rows, estimates: [sealed] });
  assert.equal(summary.locallyObservedApiEquivalent, null);
  assert.equal(summary.locallyObservedTokens, null);
  assert.ok(summary.reasons.includes('current-cycle-samples-missing'), summary.reasons.join(','));
  assert.equal(summary.resetAt, NEW_RESET);
  assert.equal(summary.evidence.estimateResetAt, OLD_RESET);
  assert.equal(summary.basis, 'compatible-history-full-cycle');
  assert.equal(summary.capacityFromCurrentCycle, false);
  // History may describe the window size, never this cycle's own confidence.
  assert.equal(summary.confidence, 'preliminary');
  assert.equal(summary.estimatedCapacity, 100);
  // Derived amounts use the LIVE official percentage, not the old cycle's.
  assert.equal(summary.officialUsedPercent, 0);
  assert.equal(summary.derivedConsumed, 0);
  assert.equal(summary.derivedRemaining, 100);
});

test('a sealed earlier cycle supplies capacity only after the live percentage is applied', () => {
  const { rows, sealed } = sealedOldCycle();
  const summary = weeklySummary({ window: newCycleWindow(25), samples: rows, estimates: [sealed] });
  assert.equal(summary.basis, 'compatible-history-full-cycle');
  assert.equal(summary.estimatedCapacity, 100);
  assert.equal(summary.derivedConsumed, 25);
  assert.equal(summary.derivedRemaining, 75);
  assert.equal(summary.locallyObservedApiEquivalent, null);
  assert.equal(summary.derivedConsumed + summary.derivedRemaining, summary.estimatedCapacity);
});

test('the new cycle reports collecting with zero, one, and two accounting samples', () => {
  const { rows, sealed } = sealedOldCycle();
  const none = weeklySummary({ window: newCycleWindow(0), samples: rows, estimates: [sealed] });
  assert.equal(none.locallyObservedApiEquivalent, null);
  assert.ok(none.reasons.includes('current-cycle-samples-missing'));

  const first = sample(0, 0, 0, { at: '2026-08-31T00:10:00.000Z', resetsAt: NEW_RESET, segmentId: 'new' });
  const one = weeklySummary({ window: newCycleWindow(5), samples: [...rows, first], estimates: [sealed] });
  assert.equal(one.locallyObservedApiEquivalent, null);
  assert.ok(one.reasons.includes('accounting-baseline-missing'), one.reasons.join(','));

  const second = sample(20, 3000, 30, { at: '2026-08-31T06:00:00.000Z', resetsAt: NEW_RESET, segmentId: 'new' });
  const two = weeklySummary({ window: newCycleWindow(20), samples: [...rows, first, second], estimates: [sealed] });
  assert.equal(two.locallyObservedApiEquivalent, 30);
  assert.equal(two.locallyObservedTokens, 3000);
  assert.equal(two.basis, 'compatible-history-full-cycle');
  assert.equal(two.estimatedCapacity, 100);
  assert.equal(two.derivedConsumed, 20);
});

test('small reset display drift stays one cycle while a successor reset is isolated', () => {
  const { rows, sealed } = sealedOldCycle();
  const drifted = { ...sealed, resetsAt: '2026-08-31T00:01:30.000Z' };
  assert.equal(sameQuotaCycle(liveWindow({ resetsAt: OLD_RESET }), drifted), true);
  assert.equal(sameQuotaCycle(liveWindow({ resetsAt: NEW_RESET }), sealed), false);
  const inCycle = weeklySummary({
    window: { kind: 'weekly', limitId: 'weekly', windowMinutes: 10080, resetsAt: OLD_RESET, segmentId: 'old', usedPercent: 100 },
    samples: rows,
    estimates: [drifted]
  });
  assert.equal(inCycle.locallyObservedApiEquivalent, 100);
  assert.equal(inCycle.basis, 'current-full-cycle');
  assert.equal(inCycle.capacityFromCurrentCycle, true);
});

test('identical windowIdentity with a different reset does not leak observations across cycles', () => {
  const { rows, sealed } = sealedOldCycle();
  const live = liveWindow({ resetsAt: NEW_RESET, segmentId: 'new' });
  assert.equal(sealed.windowIdentity, 'weekly|weekly|10080');
  assert.equal(sameWindow(live, sealed), true);
  assert.equal(sameQuotaCycle(live, sealed), false);
  assert.equal(currentCycleSamples(rows, live, null).rows.length, 0);
  const summary = weeklySummary({ window: newCycleWindow(0), samples: rows, estimates: [sealed] });
  assert.equal(summary.windowIdentity, 'weekly|weekly|10080');
  assert.equal(summary.locallyObservedApiEquivalent, null);
});

test('a percentage rollback inside one window starts a new cycle segment', () => {
  const rows = [
    sample(40, 4000, 40, { at: '2026-08-29T00:00:00.000Z' }),
    sample(10, 1000, 10, { at: '2026-08-30T00:00:00.000Z' }),
    sample(30, 3000, 30, { at: '2026-08-30T06:00:00.000Z' })
  ];
  const observed = locallyObservedDelta(rows, liveWindow(), null);
  assert.equal(observed.locallyObservedApiEquivalent, 20);
  assert.equal(observed.locallyObservedTokens, 2000);
  assert.ok(observed.reasons.includes('cycle-percent-rollback'));
});

// --- adjacent cumulative rollback ------------------------------------------

function rollbackRows(field, values, base = {}) {
  return values.map((value, index) => sample(10 + (index * 10), 1000 + (index * 1000), 1 + index, {
    at: `2026-08-25T0${index}:00:00.000Z`,
    ...base,
    ...(field === 'observedTotalTokens'
      ? { observedTotalTokens: value }
      : field === 'pricedTokens'
        ? { pricedTokens: value, unpricedTokens: 0 }
        : field === 'unpricedTokens'
          ? { pricedTokens: 1000 + (index * 1000), unpricedTokens: value }
          : { apiEquivalentCostUsd: value })
  }));
}

test('a mid-sequence token rollback fails closed instead of netting to growth', () => {
  const rows = rollbackRows('observedTotalTokens', [100, 50, 200]);
  const observed = locallyObservedDelta(rows, liveWindow(), null);
  assert.equal(observed.locallyObservedTokens, null);
  assert.equal(observed.locallyObservedApiEquivalent, 2);
  assert.ok(observed.reasons.includes('cumulative-rollback'));
});

test('a mid-sequence API-equivalent rollback fails closed', () => {
  const rows = rollbackRows('apiEquivalentCostUsd', [1, 0.5, 2]);
  const observed = locallyObservedDelta(rows, liveWindow(), null);
  assert.equal(observed.locallyObservedApiEquivalent, null);
  assert.equal(observed.locallyObservedTokens, 2000);
  assert.ok(observed.reasons.includes('cumulative-rollback'));
});

test('priced and unpriced mid-sequence rollbacks fail closed', () => {
  const priced = locallyObservedDelta(rollbackRows('pricedTokens', [100, 50, 200]), liveWindow(), null);
  assert.equal(priced.pricedTokens, null);
  assert.equal(priced.pricingCoverage, null);
  assert.ok(priced.reasons.includes('cumulative-rollback'));

  const unpriced = locallyObservedDelta(rollbackRows('unpricedTokens', [10, 4, 20]), liveWindow(), null);
  assert.equal(unpriced.unpricedTokens, null);
  assert.ok(unpriced.reasons.includes('cumulative-rollback'));
});

test('monotonic sequences still produce the endpoint delta and coverage', () => {
  const rows = [
    sample(10, 1000, 1, { at: '2026-08-25T00:00:00.000Z', pricedTokens: 800, unpricedTokens: 200 }),
    sample(30, 3000, 3, { at: '2026-08-25T03:00:00.000Z', pricedTokens: 2400, unpricedTokens: 600 }),
    sample(50, 5000, 5, { at: '2026-08-25T06:00:00.000Z', pricedTokens: 4000, unpricedTokens: 1000 })
  ];
  const observed = locallyObservedDelta(rows, liveWindow(), null);
  assert.equal(observed.locallyObservedApiEquivalent, 4);
  assert.equal(observed.locallyObservedTokens, 4000);
  assert.equal(observed.pricedTokens, 3200);
  assert.equal(observed.unpricedTokens, 800);
  assert.equal(observed.pricingCoverage, 0.8);
  assert.equal(observed.reasons.includes('cumulative-rollback'), false);
});

// --- percentage rollback vs. the current capacity run -----------------------
// `resetsAt` alone is not a run identity: a provider can rewind its used
// percentage inside one reset cycle (a re-roll, a refund, an archive rewrite).
// Everything the old run measured then describes a counter state that no longer
// exists, so the capacity candidate has to be cut on the same boundary the
// sample window is cut on.

const ROLLBACK_RESET = '2026-09-01T00:00:00.000Z';
const T1 = '2026-08-29T00:00:00.000Z';
const T2 = '2026-08-29T12:00:00.000Z';
const T3 = '2026-08-30T00:00:00.000Z';
const T4 = '2026-08-30T06:00:00.000Z';
const T5 = '2026-08-30T12:00:00.000Z';

function rollbackWindow(usedPercent, extra = {}) {
  return {
    provider: 'codex', profileId: 'codex-default', kind: 'weekly', limitId: 'weekly',
    windowMinutes: 10080, resetsAt: ROLLBACK_RESET, segmentId: 'run-b', observedAt: T5,
    usedPercent, ...extra
  };
}

// Old run: climbs to 100% and is sealed as a directly observed full cycle.
// Then the provider rewinds to 20% and the archive opens run-b.
function rollbackScenario() {
  const rows = [
    sample(0, 0, 0, { at: T1, resetsAt: ROLLBACK_RESET, segmentId: 'run-a', snapshotId: 'openai-v1' }),
    sample(60, 6000, 60, { at: T2, resetsAt: ROLLBACK_RESET, segmentId: 'run-a', snapshotId: 'openai-v1' }),
    sample(100, 12000, 120, { at: T3, resetsAt: ROLLBACK_RESET, segmentId: 'run-a', snapshotId: 'openai-v1' }),
    sample(20, 2000, 20, { at: T4, resetsAt: ROLLBACK_RESET, segmentId: 'run-b', snapshotId: 'openai-v1' }),
    sample(35, 3500, 35, { at: T5, resetsAt: ROLLBACK_RESET, segmentId: 'run-b', snapshotId: 'openai-v1' })
  ];
  const oldFull = estimate(120, {
    method: 'observed-full-cycle', cycleBasis: 'full', segmentId: 'run-a',
    resetsAt: ROLLBACK_RESET, current: false,
    firstObservedAt: T1, lastObservedAt: T3
  });
  return { rows, oldFull };
}

test('a same-reset percentage rollback stops the old full cycle from being the current capacity', () => {
  const { rows, oldFull } = rollbackScenario();
  const newPartial = estimate(150, {
    segmentId: 'run-b', resetsAt: ROLLBACK_RESET, current: true,
    firstObservedAt: T4, lastObservedAt: T5
  });

  // Sanity: resetsAt never moved, so cycle identity alone cannot separate the runs.
  assert.equal(sameQuotaCycle(rollbackWindow(35), oldFull), true);

  const selection = currentCycleSamples(rows, rollbackWindow(35), newPartial);
  assert.equal(selection.boundaryAt, T4, 'the boundary is the first sample of the run after the rewind');

  const picked = chooseCapacityCandidate([oldFull, newPartial], rollbackWindow(35), {
    rollbackBoundaryAt: selection.boundaryAt
  });
  assert.notEqual(picked.basis, 'current-full-cycle', 'the pre-rollback full cycle must not be current');
  assert.equal(picked.estimate, newPartial);
  assert.equal(picked.basis, 'current-partial-regression');
  assert.equal(picked.fromCurrentRun, true);
  assert.equal(withinCurrentRun(oldFull, selection.boundaryAt), false);

  const summary = buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default',
    window: rollbackWindow(35), samples: rows, estimates: [oldFull, newPartial]
  });
  // The current run is run-b only: 20% -> 35%, so $15 observed, never the old run's $120.
  assert.equal(summary.locallyObservedApiEquivalent, 15);
  assert.equal(summary.basis, 'current-partial-regression');
  assert.equal(summary.capacityFromCurrentCycle, true);
});

test('the new run takes the capacity over once it has observed its own full cycle', () => {
  // run-b rewinds to zero and then climbs all the way back, so it earns a
  // directly observed full cycle of its own with a clean baseline.
  const rows = [
    sample(0, 0, 0, { at: T1, resetsAt: ROLLBACK_RESET, segmentId: 'run-a' }),
    sample(100, 12000, 120, { at: T3, resetsAt: ROLLBACK_RESET, segmentId: 'run-a' }),
    sample(0, 0, 0, { at: T4, resetsAt: ROLLBACK_RESET, segmentId: 'run-b' }),
    sample(50, 3000, 30, { at: '2026-08-30T09:00:00.000Z', resetsAt: ROLLBACK_RESET, segmentId: 'run-b' }),
    sample(100, 6000, 60, { at: T5, resetsAt: ROLLBACK_RESET, segmentId: 'run-b' })
  ];
  const oldFull = estimate(120, {
    method: 'observed-full-cycle', cycleBasis: 'full', segmentId: 'run-a',
    resetsAt: ROLLBACK_RESET, current: false, firstObservedAt: T1, lastObservedAt: T3
  });
  const newFull = estimate(60, {
    method: 'observed-full-cycle', cycleBasis: 'full', segmentId: 'run-b',
    resetsAt: ROLLBACK_RESET, current: true, firstObservedAt: T4, lastObservedAt: T5
  });
  const summary = buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default',
    window: rollbackWindow(100), samples: rows, estimates: [oldFull, newFull]
  });

  assert.equal(summary.basis, 'current-full-cycle');
  assert.equal(summary.estimatedCapacity, 60, 'the new run’s own capacity, never the old run’s 120');
  assert.equal(summary.capacityFromCurrentCycle, true);
  // The new run owns a real baseline again, so the baseline gap is gone.
  assert.equal(summary.reasons.includes('accounting-baseline-gap'), false);
  // The cycle still carries the rewind caveat, so it is pinned as unstable —
  // deliberately conservative, and never the old run's confident-but-stale read.
  assert.ok(summary.reasons.includes('cycle-percent-rollback'));
  assert.equal(summary.confidence, 'unstable');
});

test('a credential rotation with monotonic percentages keeps stitching evidence together', () => {
  // Same reset, same percentages climbing, but the binding changed underneath
  // (credential rotation / binding upgrade). Nothing was rewound, so there is
  // no boundary and the evidence must not be discarded.
  const rows = [
    sample(10, 1000, 10, { at: T1, resetsAt: ROLLBACK_RESET, segmentId: 'run-a|binding-one' }),
    sample(30, 3000, 30, { at: T2, resetsAt: ROLLBACK_RESET, segmentId: 'run-a|binding-two' }),
    sample(50, 5000, 50, { at: T3, resetsAt: ROLLBACK_RESET, segmentId: 'run-a|binding-three' })
  ];
  const rotated = estimate(100, {
    resetsAt: ROLLBACK_RESET, segmentId: 'run-a|binding-three', current: true,
    firstObservedAt: T1, lastObservedAt: T3
  });
  const selection = currentCycleSamples(rows, rollbackWindow(50), rotated);
  assert.equal(selection.rolledBack, false, 'a rotation is not a rollback');
  assert.equal(selection.boundaryAt, null);
  assert.equal(selection.rows.length, 3, 'all three samples still count');

  const summary = buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default',
    window: rollbackWindow(50), samples: rows, estimates: [rotated]
  });
  assert.equal(summary.locallyObservedApiEquivalent, 40);
  assert.equal(summary.basis, 'current-partial-regression');
  // A straddling-but-unrewound estimate stays in the current run.
  assert.equal(withinCurrentRun(rotated, null), true);
});

test('a real reset change still isolates the old cycle completely', () => {
  const { rows, oldFull } = rollbackScenario();
  const live = {
    provider: 'codex', profileId: 'codex-default', kind: 'weekly', limitId: 'weekly',
    windowMinutes: 10080, resetsAt: '2026-09-08T00:00:00.000Z', segmentId: 'run-c',
    observedAt: '2026-09-01T00:05:00.000Z', usedPercent: 5
  };
  const summary = buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default',
    window: live, samples: rows, estimates: [oldFull]
  });
  assert.equal(sameQuotaCycle(live, oldFull), false);
  assert.equal(summary.locallyObservedApiEquivalent, null);
  assert.ok(summary.reasons.includes('current-cycle-samples-missing'));
  assert.equal(summary.basis, 'compatible-history-full-cycle');
  assert.equal(summary.capacityFromCurrentCycle, false);
  assert.equal(summary.confidence, 'preliminary');
});

test('a cumulative and percentage rollback together produce no negative usage and no borrowed capacity', () => {
  // run-b rewinds the percentage AND its cumulative counters, the shape that
  // used to yield a negative delta while still showing the old run's capacity.
  const rows = [
    sample(0, 0, 0, { at: T1, resetsAt: ROLLBACK_RESET, segmentId: 'run-a' }),
    sample(100, 12000, 120, { at: T3, resetsAt: ROLLBACK_RESET, segmentId: 'run-a' }),
    sample(20, 9000, 90, { at: T4, resetsAt: ROLLBACK_RESET, segmentId: 'run-b' }),
    sample(30, 7000, 70, { at: T5, resetsAt: ROLLBACK_RESET, segmentId: 'run-b' })
  ];
  const oldFull = estimate(120, {
    method: 'observed-full-cycle', cycleBasis: 'full', segmentId: 'run-a',
    resetsAt: ROLLBACK_RESET, current: false, firstObservedAt: T1, lastObservedAt: T3
  });
  const summary = buildAccountQuotaSummary({
    provider: 'codex', profileId: 'codex-default',
    window: rollbackWindow(30), samples: rows, estimates: [oldFull]
  });

  // No negative usage: the rewound counter is reported as unknown, not as -20.
  assert.equal(summary.locallyObservedApiEquivalent, null);
  assert.equal(summary.locallyObservedTokens, null);
  assert.equal(summary.estimatedCapacity === null || summary.estimatedCapacity >= 0, true);
  assert.ok(summary.reasons.includes('cumulative-rollback'));
  assert.ok(summary.reasons.includes('cycle-percent-rollback'));

  // And no borrowed capacity presented as this run's own: the old full cycle is
  // demoted to clearly-labelled history, never current or stable.
  assert.notEqual(summary.basis, 'current-full-cycle');
  assert.notEqual(summary.basis, 'current-partial-regression');
  assert.equal(summary.capacityFromCurrentCycle, false);
  assert.notEqual(summary.confidence, 'stable');
});

test('the sample window and the capacity candidate are cut on the same boundary', () => {
  const { rows, oldFull } = rollbackScenario();
  const selection = currentCycleSamples(rows, rollbackWindow(35), oldFull);
  const observed = locallyObservedDelta(rows, rollbackWindow(35), oldFull, selection);
  const picked = chooseCapacityCandidate([oldFull], rollbackWindow(35), {
    rollbackBoundaryAt: selection.boundaryAt
  });
  // Both sides agree the current run starts at T4. With the old full cycle
  // dropped as stale, the new run has no capacity evidence of its own yet, so
  // the honest answer is "not estimable" rather than the old run's number.
  assert.equal(observed.firstSampleId, `sample-${20}`);
  assert.equal(picked.estimate, null);
  assert.equal(picked.basis, 'unavailable');
  assert.equal(picked.fromCurrentRun, false);
  // Passing the selection in must not change the delta.
  assert.deepEqual(
    locallyObservedDelta(rows, rollbackWindow(35), oldFull).locallyObservedApiEquivalent,
    observed.locallyObservedApiEquivalent
  );
});

test('sample(100) is parseable and ordered after 0 and 50', () => {
  const zero = Date.parse(sample(0, 0, 0).observedAt);
  const mid = Date.parse(sample(50, 0, 0).observedAt);
  const full = Date.parse(sample(100, 0, 0).observedAt);
  assert.equal(Number.isNaN(full), false);
  assert.ok(zero < mid);
  assert.ok(mid < full);
});

test('withinCurrentRun fail-closes on an unparseable boundary and on invalid estimate times', () => {
  const current = estimate(100, {
    firstObservedAt: '2026-08-25T04:00:00.000Z',
    lastObservedAt: '2026-08-25T05:00:00.000Z'
  });
  assert.equal(withinCurrentRun(current, null), true);
  assert.equal(withinCurrentRun(current, ''), true);
  assert.equal(withinCurrentRun(current, 'not-a-date'), false);
  assert.equal(withinCurrentRun(current, '2026-08-25T04:30:00.000Z'), false);
  assert.equal(withinCurrentRun(current, '2026-08-25T03:00:00.000Z'), true);
  assert.equal(withinCurrentRun({
    ...current,
    firstObservedAt: 'not-a-date',
    lastObservedAt: '2026-08-25T05:00:00.000Z'
  }, '2026-08-25T03:00:00.000Z'), false);
  assert.equal(withinCurrentRun({
    ...current,
    firstObservedAt: '2026-08-25T04:00:00.000Z',
    lastObservedAt: 'bad'
  }, '2026-08-25T03:00:00.000Z'), false);
});

test('production segment ids keep cycle identity and fail closed on one-sided resets', () => {
  const first = 'sha256:abc|session|2026-09-05T12:00:00.000Z|snap-1';
  const successor = 'sha256:abc|session|2026-09-05T17:00:00.000Z|snap-1';
  const bound = `${first}|binding-one`;
  const rebound = `${first}|binding-two`;
  assert.equal(sameQuotaCycle(
    liveWindow({ segmentId: bound, resetsAt: '' }),
    liveWindow({ segmentId: rebound, resetsAt: '' })
  ), true);
  assert.equal(sameQuotaCycle(
    liveWindow({ segmentId: first, resetsAt: '' }),
    liveWindow({ segmentId: successor, resetsAt: '' })
  ), false);
  assert.equal(sameQuotaCycle(
    liveWindow({ segmentId: first, resetsAt: RESET }),
    liveWindow({ segmentId: first, resetsAt: '' })
  ), false);
  assert.equal(sameQuotaCycle(
    liveWindow({ segmentId: first, resetsAt: 'not-a-date' }),
    liveWindow({ segmentId: first, resetsAt: 'not-a-date' })
  ), false);
});

