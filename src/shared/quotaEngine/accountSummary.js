'use strict';

const {
  FULL_CYCLE_ESTIMATE_METHOD,
  sampleWindowIdentity
} = require('./capacityEstimator');
const {
  RESET_CYCLE_JITTER_MS,
  sameQuotaCycle,
  sameWindow
} = require('./windowIdentity');

const FLOAT_EPSILON = 1e-9;
const BASELINE_PERCENT_EPSILON = 2;
const PERCENT_ROLLBACK_EPSILON = 1e-9;
// Cumulative accounting fields are only allowed to move forward inside one
// quota cycle. A drop larger than this relative tolerance is a real rollback
// (archive rewrite, profile rebind, counter reset), never float noise.
const CUMULATIVE_FIELDS = Object.freeze([
  'apiEquivalentCostUsd',
  'observedTotalTokens',
  'pricedTokens',
  'unpricedTokens'
]);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeText(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function timeMs(value) {
  const ms = Date.parse(safeText(value, 40));
  return Number.isFinite(ms) ? ms : null;
}

function estimatePricingIdentity(estimate) {
  return safeText(estimate?.apiEquivalentUsd?.snapshotId || estimate?.pricingReferenceIdentity, 120);
}

function estimateScopeVersion(estimate) {
  return safeText(estimate?.scopeVersion, 80);
}

// Historical-capacity compatibility: a *different* cycle is allowed, but the
// account, window, billing scope and frozen pricing identity must match, and the
// borrowed cycle must already be sealed as a directly observed full cycle.
function compatibleCapacityEvidence(current, candidate) {
  if (!sameWindow(current, candidate)) return false;
  if (!isFullCycle(candidate)) return false;
  if (estimateScopeVersion(current) !== estimateScopeVersion(candidate)) return false;
  const currentPricing = estimatePricingIdentity(current);
  const candidatePricing = estimatePricingIdentity(candidate);
  return Boolean(currentPricing && candidatePricing && currentPricing === candidatePricing);
}

function deriveQuotaAmounts(capacityValue, usedPercentValue) {
  const capacity = finite(capacityValue);
  const usedPercent = finite(usedPercentValue);
  if (capacity === null || capacity <= 0) {
    return { available: false, reason: 'invalid-capacity', capacity: null, consumed: null, remaining: null, usedPercent };
  }
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
    return { available: false, reason: 'invalid-official-percent', capacity: null, consumed: null, remaining: null, usedPercent: null };
  }
  const consumed = capacity * usedPercent / 100;
  const remaining = capacity - consumed;
  if (![consumed, remaining].every(Number.isFinite) || remaining < -FLOAT_EPSILON * Math.max(1, capacity)) {
    return { available: false, reason: 'invalid-derived-amounts', capacity: null, consumed: null, remaining: null, usedPercent };
  }
  return {
    available: true,
    reason: '',
    capacity,
    consumed,
    remaining: Math.abs(remaining) <= FLOAT_EPSILON * Math.max(1, capacity) ? 0 : remaining,
    usedPercent
  };
}

// A percentage rollback is a cycle boundary, never a point inside one cycle.
// Keep only the run after the last rollback so a successor cycle's samples can
// never be read as this cycle's baseline. `boundaryAt` is the observedAt of the
// first surviving sample, and it is the single boundary that both the sample
// window and the capacity candidate are cut on: letting one side cut while the
// other kept reading would mix pre-rollback evidence into a number advertised
// as current.
function dropSamplesBeforePercentRollback(rows) {
  let cut = 0;
  let previous = null;
  for (let index = 0; index < rows.length; index += 1) {
    const current = finite(rows[index]?.usedPercent);
    if (current === null) continue;
    if (previous !== null && current < previous - PERCENT_ROLLBACK_EPSILON) cut = index;
    previous = current;
  }
  if (cut === 0) return { rows, rolledBack: false, boundaryAt: null };
  return {
    rows: rows.slice(cut),
    rolledBack: true,
    boundaryAt: safeText(rows[cut]?.observedAt, 40) || null
  };
}

// Evidence reaching back across the rollback belongs to the previous run even
// though `resetsAt` never moved: the provider rewound its usage, so whatever
// the old run measured described a counter state that no longer exists.
// Credential rotation and binding upgrades never rewind the percentage, so they
// leave no boundary at all and their evidence keeps stitching normally.
// Unplaceable evidence fails closed — it cannot be proven to be post-rollback.
function withinCurrentRun(estimate, boundaryAt) {
  if (!boundaryAt) return true;
  const boundaryMs = timeMs(boundaryAt);
  if (boundaryMs === null) return true;
  const firstObserved = timeMs(estimate?.firstObservedAt);
  const lastObserved = timeMs(estimate?.lastObservedAt);
  if (lastObserved === null || lastObserved < boundaryMs) return false;
  if (firstObserved === null) return false;
  return firstObserved >= boundaryMs;
}

function currentCycleSamples(samplesValue, live, estimate = null) {
  const expectedPricing = estimatePricingIdentity(estimate);
  const expectedScope = estimateScopeVersion(estimate);
  const rows = (Array.isArray(samplesValue) ? samplesValue : [])
    .filter((sample) => {
      if (!sameQuotaCycle(live, sample)) return false;
      if (expectedScope && safeText(sample.scopeVersion, 80) !== expectedScope) return false;
      if (expectedPricing && safeText(sample.snapshotId, 120) !== expectedPricing) return false;
      return true;
    })
    .sort((left, right) => (timeMs(left.observedAt) ?? 0) - (timeMs(right.observedAt) ?? 0));
  return dropSamplesBeforePercentRollback(rows);
}

function rollbackTolerance(previous) {
  return FLOAT_EPSILON * Math.max(1, Math.abs(previous));
}

// Every adjacent pair is checked, not just the two endpoints: `100 -> 50 -> 200`
// nets positive but the middle drop means the counters were rewritten, so the
// affected field fails closed instead of being reported as growth.
function fieldsWithCumulativeRollback(rows) {
  const rolled = new Set();
  for (const field of CUMULATIVE_FIELDS) {
    let previous = null;
    for (const row of rows) {
      const current = finite(row?.[field]);
      if (current === null) continue;
      if (previous !== null && current < previous - rollbackTolerance(previous)) {
        rolled.add(field);
        break;
      }
      previous = current;
    }
  }
  return rolled;
}

function locallyObservedDelta(samplesValue, live, estimate = null, selection = null) {
  // `selection` lets buildAccountQuotaSummary compute the run boundary once and
  // share it with the capacity candidate instead of cutting the two sides
  // independently.
  const selected = selection || currentCycleSamples(samplesValue, live, estimate);
  const rows = selected.rows;
  const reasons = [];
  if (selected.rolledBack) reasons.push('cycle-percent-rollback');
  const empties = () => ({
    locallyObservedApiEquivalent: null,
    locallyObservedTokens: null,
    pricedTokens: null,
    unpricedTokens: null,
    pricingCoverage: null,
    partial: true,
    firstSampleId: safeText(rows[0]?.sampleId, 80),
    lastSampleId: safeText(rows.at(-1)?.sampleId, 80)
  });
  if (rows.length === 0) {
    // Nothing in THIS cycle yet: an earlier cycle's local increment is not this
    // cycle's record and must never be reported as one.
    return { ...empties(), reasons: [...new Set([...reasons, 'current-cycle-samples-missing'])] };
  }
  if (rows.length < 2) {
    return { ...empties(), reasons: [...new Set([...reasons, 'accounting-baseline-missing'])] };
  }
  const first = rows[0];
  const last = rows.at(-1);
  const rolled = fieldsWithCumulativeRollback(rows);
  const deltas = {};
  for (const field of CUMULATIVE_FIELDS) {
    const start = finite(first[field]);
    const end = finite(last[field]);
    if (rolled.has(field)) {
      deltas[field] = null;
    } else if (start === null || end === null) {
      deltas[field] = null;
      reasons.push(field === 'apiEquivalentCostUsd' ? 'pricing-sample-missing' : 'accounting-sample-missing');
    } else if (end < start - rollbackTolerance(start)) {
      deltas[field] = null;
    } else {
      deltas[field] = Math.max(0, end - start);
    }
  }
  if (rolled.size) reasons.push('cumulative-rollback');
  const firstPercent = finite(first.usedPercent);
  const partial = firstPercent === null || firstPercent > BASELINE_PERCENT_EPSILON;
  if (partial) reasons.push('accounting-baseline-gap');
  const priced = deltas.pricedTokens;
  const unpriced = deltas.unpricedTokens;
  const totalPricable = priced !== null && unpriced !== null ? priced + unpriced : null;
  const pricingCoverage = totalPricable !== null && totalPricable > 0 ? priced / totalPricable : null;
  if (unpriced !== null && unpriced > 0) reasons.push('unpriced-usage');
  return {
    locallyObservedApiEquivalent: deltas.apiEquivalentCostUsd,
    locallyObservedTokens: deltas.observedTotalTokens,
    pricedTokens: priced,
    unpricedTokens: unpriced,
    pricingCoverage,
    partial,
    reasons: [...new Set(reasons)],
    firstSampleId: safeText(first.sampleId, 80),
    lastSampleId: safeText(last.sampleId, 80)
  };
}

function candidateMetric(estimate) {
  const metric = estimate?.apiEquivalentUsd;
  const capacity = finite(metric?.capacity);
  return metric?.available === true && capacity !== null && capacity > 0 ? metric : null;
}

function isFullCycle(estimate) {
  const metric = candidateMetric(estimate);
  return Boolean(metric && metric.method === FULL_CYCLE_ESTIMATE_METHOD && metric.cycleBasis === 'full');
}

function byLastObservedDesc(left, right) {
  return (timeMs(right?.lastObservedAt) ?? 0) - (timeMs(left?.lastObservedAt) ?? 0);
}

// Priority is explicit and testable:
//   1. a directly observed full cycle inside the CURRENT cycle;
//   2. a sealed, compatible full cycle from an EARLIER cycle (capacity only);
//   3. a partial-cycle regression inside the CURRENT cycle;
//   4. nothing.
// A different cycle can never supply steps 1 or 3, because those describe what
// this machine observed in the cycle that is live right now.
function scopeCompatible(live, estimate) {
  const liveScope = estimateScopeVersion(live);
  const estimateScope = estimateScopeVersion(estimate);
  return !liveScope || !estimateScope || liveScope === estimateScope;
}

function chooseCapacityCandidate(estimatesValue, live, options = {}) {
  const estimates = (Array.isArray(estimatesValue) ? estimatesValue : []).filter((estimate) => sameWindow(estimate, live));
  // `rollbackBoundaryAt` comes from the same sample run the locally observed
  // delta is computed on, so the two can never disagree about where the current
  // run starts. Without a boundary nothing is filtered here and the cycle
  // identity alone decides, which is what a credential rotation needs.
  const boundaryAt = safeText(options.rollbackBoundaryAt, 40) || null;
  // Evidence from before the last rollback is stale for the run that is live
  // now. When it also belongs to this very cycle it cannot be quietly relabelled
  // as an earlier one — `resetsAt` says it is this cycle — so it drops out of
  // every tier. A genuinely different cycle is unaffected and still sizes the
  // window from history; its samples never entered this run's boundary.
  const staleForRun = (estimate) => !withinCurrentRun(estimate, boundaryAt) && sameQuotaCycle(live, estimate);
  const eligible = estimates.filter((estimate) => !staleForRun(estimate));
  const currentCycle = eligible
    .filter((estimate) => sameQuotaCycle(live, estimate))
    .filter((estimate) => scopeCompatible(live, estimate));

  const currentFull = currentCycle.filter(isFullCycle).sort(byLastObservedDesc)[0] || null;
  if (currentFull) return { estimate: currentFull, basis: 'current-full-cycle', fromCurrentRun: true };

  const historicalFull = eligible
    .filter((estimate) => !currentCycle.includes(estimate))
    .filter((estimate) => compatibleCapacityEvidence(live, estimate))
    .sort(byLastObservedDesc)[0] || null;
  if (historicalFull) return { estimate: historicalFull, basis: 'compatible-history-full-cycle', fromCurrentRun: false };

  const currentPartial = currentCycle
    .filter((estimate) => candidateMetric(estimate))
    .sort(byLastObservedDesc)[0] || null;
  if (currentPartial) return { estimate: currentPartial, basis: 'current-partial-regression', fromCurrentRun: true };

  return { estimate: null, basis: 'unavailable', fromCurrentRun: false };
}

// Evidence that contradicts itself: the candidate must not be trusted at all.
const UNSTABLE_REASONS = new Set([
  'accounting-baseline-gap', 'cumulative-rollback', 'cycle-percent-rollback',
  'pricing-identity-changed', 'quota-rise-without-local-usage', 'unpriced-usage',
  'observed-exceeds-capacity'
]);
// The local increment simply is not computable yet. Capacity can still be
// shown, but nothing about it has been confirmed by this cycle's own anchors.
const COLLECTING_REASONS = new Set(['accounting-baseline-missing', 'current-cycle-samples-missing']);

function confidenceFor(candidate, basis, observed, reasons) {
  if (!candidate) return 'collecting';
  const metric = candidateMetric(candidate);
  if (!metric) return 'collecting';
  if (reasons.some((reason) => UNSTABLE_REASONS.has(reason))) return 'unstable';
  if (reasons.some((reason) => COLLECTING_REASONS.has(reason))) return 'preliminary';
  if (basis === 'compatible-history-full-cycle') {
    // Capacity size is borrowed from a sealed earlier cycle. It can describe
    // how big this window is, never how trustworthy this cycle's own evidence
    // is, so it must not be advertised as stable.
    return 'preliminary';
  }
  if (basis === 'current-full-cycle') {
    return metric.status === 'stable' && metric.completeness === 'complete' ? 'stable' : 'unstable';
  }
  if (metric.status === 'unstable') return 'unstable';
  if (metric.status === 'stable' && observed.partial !== true && metric.completeness === 'complete') return 'stable';
  return 'preliminary';
}

function buildAccountQuotaSummary({ provider, profileId, window, samples, estimates } = {}) {
  const liveWindow = window && typeof window === 'object' ? window : {};
  const windowProbe = {
    provider: safeText(provider, 48),
    profileId: safeText(profileId, 80),
    kind: safeText(liveWindow.kind, 32),
    limitId: safeText(liveWindow.limitId, 128),
    windowMinutes: finite(liveWindow.windowMinutes),
    resetsAt: safeText(liveWindow.resetsAt, 40),
    segmentId: safeText(liveWindow.segmentId, 240),
    observedAt: safeText(liveWindow.observedAt, 40)
  };
  const matching = (Array.isArray(estimates) ? estimates : []).filter((estimate) => sameWindow(estimate, windowProbe));
  const currentCycleEstimates = matching.filter((estimate) => sameQuotaCycle(windowProbe, estimate));
  const current = currentCycleEstimates.find((estimate) => (
    estimate.current === true
    && (!windowProbe.limitId || safeText(estimate.limitId) === windowProbe.limitId)
  )) || currentCycleEstimates.slice().sort(byLastObservedDesc)[0] || null;
  // Scope and pricing identity do not change with the quota cycle, so the most
  // recent window-compatible estimate is the best available description of the
  // identity this window is currently recorded under.
  const identitySource = current || matching.slice().sort(byLastObservedDesc)[0] || null;
  const live = {
    ...windowProbe,
    scopeVersion: estimateScopeVersion(identitySource),
    pricingReferenceIdentity: estimatePricingIdentity(identitySource)
  };

  // Locally observed amounts may only come from the cycle that is live now. The
  // sample selection is computed once so the capacity candidate is cut on the
  // same rollback boundary instead of deriving its own.
  const selection = currentCycleSamples(samples, live, current);
  const observed = locallyObservedDelta(samples, live, current, selection);
  const selected = chooseCapacityCandidate(matching, live, {
    rollbackBoundaryAt: selection.boundaryAt
  });
  // A same-`resetsAt` rollback makes the previous run a different run while the
  // cycle clock stays put, so "current" now needs both: the live cycle *and* the
  // run after the last percentage rollback.
  const capacityFromCurrentCycle = Boolean(
    selected.estimate && selected.fromCurrentRun === true && sameQuotaCycle(live, selected.estimate)
  );
  // Defensive: a current-cycle basis is only honest when the selected estimate
  // really belongs to the live cycle.
  const basis = derivedAvailableBasis(selected.basis, capacityFromCurrentCycle);
  const reasons = [...observed.reasons];
  if (!current) reasons.push('current-window-samples-missing');
  if (Array.isArray(current?.gapEvidence) && current.gapEvidence.length) reasons.push('quota-rise-without-local-usage');
  if (basis === 'compatible-history-full-cycle') reasons.push('capacity-from-history-cycle');
  const metric = candidateMetric(selected.estimate);
  let derived = deriveQuotaAmounts(metric?.capacity, finite(liveWindow.usedPercent));
  if (metric && observed.locallyObservedApiEquivalent !== null
    && observed.locallyObservedApiEquivalent > metric.capacity * (1 + FLOAT_EPSILON)) {
    reasons.push('observed-exceeds-capacity');
    derived = { available: false, reason: 'observed-exceeds-capacity', capacity: null, consumed: null, remaining: null, usedPercent: finite(liveWindow.usedPercent) };
  }
  if (!derived.available && derived.reason) reasons.push(derived.reason);
  if (!selected.estimate) reasons.push('compatible-capacity-evidence-missing');
  const uniqueReasons = [...new Set(reasons)];
  const finalBasis = derived.available ? basis : 'unavailable';
  return {
    provider: windowProbe.provider,
    profileId: windowProbe.profileId,
    windowKind: windowProbe.kind,
    windowIdentity: current?.windowIdentity || sampleWindowIdentity(windowProbe),
    resetAt: windowProbe.resetsAt,
    scopeVersion: estimateScopeVersion(identitySource),
    pricingReferenceIdentity: estimatePricingIdentity(identitySource),
    officialUsedPercent: finite(liveWindow.usedPercent),
    locallyObservedApiEquivalent: observed.locallyObservedApiEquivalent,
    locallyObservedTokens: observed.locallyObservedTokens,
    pricedTokens: observed.pricedTokens,
    unpricedTokens: observed.unpricedTokens,
    pricingCoverage: observed.pricingCoverage,
    observedPartial: observed.partial,
    estimatedCapacity: derived.capacity,
    derivedConsumed: derived.consumed,
    derivedRemaining: derived.remaining,
    basis: finalBasis,
    capacityFromCurrentCycle,
    confidence: confidenceFor(derived.available ? selected.estimate : null, finalBasis, observed, uniqueReasons),
    reasons: uniqueReasons,
    evidence: {
      estimateSegmentId: safeText(selected.estimate?.segmentId, 240),
      estimateResetAt: safeText(selected.estimate?.resetsAt, 40),
      firstSampleId: observed.firstSampleId,
      lastSampleId: observed.lastSampleId,
      pointCount: finite(selected.estimate?.apiEquivalentUsd?.fitPointCount ?? selected.estimate?.pointCount),
      usedPercentSpan: finite(selected.estimate?.apiEquivalentUsd?.fitUsedPercentSpan ?? selected.estimate?.usedPercentSpan),
      gapCount: Array.isArray(current?.gapEvidence) ? current.gapEvidence.length : 0,
      rSquared: finite(selected.estimate?.apiEquivalentUsd?.rSquared),
      normalizedRmse: finite(selected.estimate?.apiEquivalentUsd?.normalizedRmse),
      pricingCoverage: finite(selected.estimate?.apiEquivalentUsd?.coverage),
      pricingReferenceIdentity: estimatePricingIdentity(selected.estimate)
    }
  };
}

function derivedAvailableBasis(basis, capacityFromCurrentCycle) {
  if (basis === 'current-full-cycle' || basis === 'current-partial-regression') {
    return capacityFromCurrentCycle ? basis : 'unavailable';
  }
  return basis;
}

module.exports = {
  BASELINE_PERCENT_EPSILON,
  RESET_CYCLE_JITTER_MS,
  buildAccountQuotaSummary,
  chooseCapacityCandidate,
  compatibleCapacityEvidence,
  currentCycleSamples,
  deriveQuotaAmounts,
  dropSamplesBeforePercentRollback,
  locallyObservedDelta,
  sameQuotaCycle,
  sameWindow,
  withinCurrentRun
};
