'use strict';

const { sameQuotaCycle } = require('./windowIdentity');

const CAPACITY_ESTIMATE_METHOD = 'observed-linear-estimate';
const FULL_CYCLE_ESTIMATE_METHOD = 'observed-full-cycle';
const MIN_STABLE_PERCENT_SPAN = 3;
const STABLE_R_SQUARED = 0.98;
const STABLE_NORMALIZED_RMSE = 0.1;
const COMPLETE_COVERAGE_EPSILON = 1e-9;
// A segment only counts as a directly-observed full cycle when it actually
// spans the whole window. Tolerances stay deliberately small (~2pp): 3% or
// 97% endpoint anchors are never treated as a complete 0% -> 100% cycle.
const FULL_CYCLE_START_MAX_PERCENT = 2;
const FULL_CYCLE_END_MIN_PERCENT = 98;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sampleWindowIdentity(sample) {
  const limitId = String(sample?.limitId || '').trim();
  const kind = String(sample?.kind || '').trim();
  const minutes = finite(sample?.windowMinutes);
  return `${limitId || kind || 'window'}|${kind}|${minutes === null ? '' : minutes}`;
}

function sampleResetGroupToken(sample) {
  const text = String(sample?.resetsAt || '').trim();
  if (!text) return 'reset:none';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return `reset:invalid:${String(sample?.sampleId || '')}:${String(sample?.observedAt || '')}`;
  }
  return `reset:${ms}`;
}

function sampleGroupKey(sample) {
  return [
    String(sample?.provider || ''),
    String(sample?.profileId || ''),
    sampleWindowIdentity(sample),
    String(sample?.scopeVersion || ''),
    String(sample?.segmentId || ''),
    sampleResetGroupToken(sample)
  ].join('|');
}

function sampleStreamKey(sample) {
  return [
    String(sample?.provider || ''),
    String(sample?.profileId || ''),
    sampleWindowIdentity(sample),
    String(sample?.scopeVersion || '')
  ].join('|');
}

function nonDecreasingMetric(previous, current, field) {
  const left = finite(previous?.[field]);
  const right = finite(current?.[field]);
  return left === null || right === null || right >= left;
}

// Older token-derived credentials were identified by the bearer token itself,
// so a token refresh manufactured a new archive segment even though the mapped
// profile, quota reset, percentage and cumulative accounting all continued.
// Join only that demonstrably continuous case at estimation time. Raw samples
// and their segment IDs stay untouched, which preserves the evidence ledger.
function canJoinMappedProfileCycle(previous, current) {
  if (!previous || !current) return false;
  if (!String(previous.profileId || '') || previous.profileId !== current.profileId) return false;
  if (sampleStreamKey(previous) !== sampleStreamKey(current)) return false;
  if (!sameQuotaCycle(previous, current)) return false;
  const previousPercent = finite(previous.usedPercent);
  const currentPercent = finite(current.usedPercent);
  if (previousPercent === null || currentPercent === null || currentPercent < previousPercent) return false;
  return [
    'observedTotalTokens',
    'pricedTokens',
    'unpricedTokens',
    'apiEquivalentCostUsd',
    'referenceEquivalentTokens'
  ].every((field) => nonDecreasingMetric(previous, current, field));
}

function capacitySampleGroups(samplesValue, requestedProfile = '') {
  const archivedGroups = new Map();
  for (const sample of Array.isArray(samplesValue) ? samplesValue : []) {
    if (!sample || typeof sample !== 'object') continue;
    if (requestedProfile && sample.profileId !== requestedProfile) continue;
    const key = sampleGroupKey(sample);
    const rows = archivedGroups.get(key) || [];
    rows.push(sample);
    archivedGroups.set(key, rows);
  }

  const streams = new Map();
  for (const rows of archivedGroups.values()) {
    const sorted = [...rows].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const key = sampleStreamKey(sorted[0]);
    const groups = streams.get(key) || [];
    groups.push(sorted);
    streams.set(key, groups);
  }

  const groups = [];
  for (const streamGroups of streams.values()) {
    const sortedGroups = [...streamGroups].sort((left, right) => (
      Date.parse(left[0]?.observedAt) - Date.parse(right[0]?.observedAt)
    ));
    let joined = [];
    for (const archivedGroup of sortedGroups) {
      const previous = joined.at(-1);
      const first = archivedGroup[0];
      const nonOverlapping = !previous || Date.parse(first.observedAt) >= Date.parse(previous.observedAt);
      if (previous && (!nonOverlapping || !canJoinMappedProfileCycle(previous, first))) {
        groups.push(joined);
        joined = [];
      }
      if (joined.length && finite(joined.at(-1).usedPercent) === finite(first.usedPercent)) {
        // Token-derived segments often meet on the same rounded percentage.
        // Keep the later cumulative watermark so the duplicate boundary does
        // not look like a percent rollback and discard the earlier cycle.
        joined.pop();
      }
      joined.push(...archivedGroup);
    }
    if (joined.length) groups.push(joined);
  }
  return groups;
}

function samplePricingIdentity(sample) {
  const snapshotId = String(sample?.snapshotId || '').trim();
  const reference = sample?.reference && typeof sample.reference === 'object' && !Array.isArray(sample.reference)
    ? sample.reference
    : {};
  const referenceSnapshot = String(reference.snapshotId || '').trim();
  return [
    snapshotId,
    String(reference.provider || '').trim(),
    String(reference.model || '').trim(),
    String(reference.category || '').trim(),
    referenceSnapshot || snapshotId
  ].join('|');
}

function emptyMetricExtras() {
  return {
    completeness: '',
    coverage: null,
    cumulativeCoverage: null,
    unpricedTokens: null,
    unpricedDelta: null,
    pricedDelta: null,
    fitPointCount: 0,
    fitUsedPercentSpan: 0,
    firstFitObservedAt: '',
    lastFitObservedAt: '',
    snapshotId: ''
  };
}

function unavailableMetric(reason, pointCount, extras = {}) {
  return {
    available: false,
    status: 'unavailable',
    reason,
    pointCount,
    slopePerPercent: null,
    capacity: null,
    rSquared: null,
    normalizedRmse: null,
    ...emptyMetricExtras(),
    ...extras
  };
}

function isLocalTokenSample(sample) {
  const usedPercent = finite(sample?.usedPercent);
  const tokens = finite(sample?.observedTotalTokens);
  return usedPercent !== null && usedPercent >= 0 && usedPercent <= 100
    && tokens !== null && tokens >= 0;
}

function isPricedMetricSample(sample, field) {
  if (!isLocalTokenSample(sample)) return false;
  const value = finite(sample?.[field]);
  const pricedTokens = finite(sample?.pricedTokens);
  const unpricedTokens = finite(sample?.unpricedTokens);
  if (value === null || value < 0) return false;
  if (pricedTokens === null || pricedTokens < 0) return false;
  if (unpricedTokens === null || unpricedTokens < 0) return false;
  const coverage = finite(sample?.pricingCoverage);
  if (coverage !== null && (coverage < 0 || coverage > 1)) return false;
  return true;
}

function percentSpanOf(samples) {
  const percents = (Array.isArray(samples) ? samples : [])
    .map((sample) => finite(sample.usedPercent))
    .filter((value) => value !== null);
  return percents.length ? Math.max(...percents) - Math.min(...percents) : 0;
}

function contiguousBreakReason(previous, current, options = {}) {
  const identityOf = typeof options.identityOf === 'function' ? options.identityOf : null;
  const yOf = typeof options.yOf === 'function' ? options.yOf : () => 0;
  const extrasOf = typeof options.extrasOf === 'function' ? options.extrasOf : () => [];
  if (options.breakOnUnsettled === true && current?.unsettled === true) return 'unsettled';
  if (identityOf && identityOf(previous) !== identityOf(current)) return 'pricing-identity-changed';
  const previousX = finite(previous.usedPercent);
  const currentX = finite(current.usedPercent);
  if (previousX === null || currentX === null || currentX <= previousX) return 'percent-rollback';
  const previousY = finite(yOf(previous));
  const currentY = finite(yOf(current));
  if (previousY === null || currentY === null || currentY < previousY) return 'cumulative-rollback';
  const previousExtras = extrasOf(previous);
  const currentExtras = extrasOf(current);
  if (previousExtras.length !== currentExtras.length) return 'cumulative-rollback';
  for (let index = 0; index < previousExtras.length; index += 1) {
    const previousExtra = finite(previousExtras[index]);
    const currentExtra = finite(currentExtras[index]);
    if (previousExtra === null || currentExtra === null || currentExtra < previousExtra) return 'cumulative-rollback';
  }
  return '';
}

function selectLatestValidRun(samples, isValid, options = {}) {
  const rows = Array.isArray(samples) ? samples : [];
  if (!rows.length) return { samples: [], stopReason: 'insufficient-percent-span' };
  let end = rows.length - 1;
  while (end >= 0 && !isValid(rows[end])) end -= 1;
  if (end < 0) return { samples: [], stopReason: 'metric-unavailable' };
  let start = end;
  let stopReason = '';
  while (start > 0) {
    const previous = rows[start - 1];
    const current = rows[start];
    if (!isValid(previous)) {
      stopReason = 'earlier-samples-unpriced';
      break;
    }
    const reason = contiguousBreakReason(previous, current, options);
    if (reason) {
      stopReason = reason;
      break;
    }
    start -= 1;
  }
  return {
    samples: rows.slice(start, end + 1),
    stopReason
  };
}

function regressPoints(points) {
  if (points.some((point) => point.x === null || point.y === null || point.y < 0)) {
    return unavailableMetric('metric-unavailable', points.length);
  }
  const distinct = new Set(points.map((point) => point.x));
  if (points.length < 2 || distinct.size < 2) {
    return unavailableMetric('insufficient-percent-span', points.length);
  }
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x <= points[index - 1].x) {
      return unavailableMetric('percent-rollback', points.length);
    }
    if (points[index].y < points[index - 1].y) {
      return unavailableMetric('cumulative-rollback', points.length);
    }
  }

  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (const point of points) {
    covariance += (point.x - xMean) * (point.y - yMean);
    xVariance += (point.x - xMean) ** 2;
    yVariance += (point.y - yMean) ** 2;
  }
  if (!(xVariance > 0)) return unavailableMetric('zero-percent-span', points.length);
  const slope = covariance / xVariance;
  const capacity = slope * 100;
  if (!(slope > 0) || !Number.isFinite(capacity) || capacity <= 0) {
    return unavailableMetric('invalid-capacity', points.length);
  }
  const intercept = yMean - (slope * xMean);
  let squaredError = 0;
  for (const point of points) {
    const residual = point.y - (intercept + (slope * point.x));
    squaredError += residual ** 2;
  }
  const rSquared = yVariance > 0 ? Math.max(0, Math.min(1, 1 - (squaredError / yVariance))) : null;
  const observedSpan = points.at(-1).y - points[0].y;
  const rmse = Math.sqrt(squaredError / points.length);
  const normalizedRmse = observedSpan > 0 ? rmse / observedSpan : null;
  return {
    available: true,
    reason: '',
    pointCount: points.length,
    slopePerPercent: slope,
    capacity,
    rSquared,
    normalizedRmse,
    ...emptyMetricExtras(),
    fitPointCount: points.length
  };
}

function coverageFromRun(run) {
  if (!run.length) {
    return {
      completeness: '',
      coverage: null,
      unpricedTokens: null,
      unpricedDelta: null,
      pricedDelta: null
    };
  }
  const first = run[0];
  const last = run.at(-1);
  const pricedStart = finite(first.pricedTokens);
  const pricedEnd = finite(last.pricedTokens);
  const unpricedStart = finite(first.unpricedTokens);
  const unpricedEnd = finite(last.unpricedTokens);
  const pricedDelta = pricedStart === null || pricedEnd === null ? null : pricedEnd - pricedStart;
  const unpricedDelta = unpricedStart === null || unpricedEnd === null ? null : unpricedEnd - unpricedStart;
  // Interval coverage describes THIS fit's newly-observed tokens, not the
  // historical cumulative baseline carried in the archive. A large legacy
  // unpriced baseline must not permanently depress an otherwise clean interval,
  // so completeness is judged on the interval delta alone. The cumulative
  // coverage is kept as separate observational metadata and never promoted to
  // the current interval's coverage.
  const cumulativeCoverage = finite(last.pricingCoverage);
  const intervalTokens = pricedDelta !== null && unpricedDelta !== null ? pricedDelta + unpricedDelta : null;
  const intervalCoverage = intervalTokens !== null && intervalTokens > 0 ? pricedDelta / intervalTokens : null;
  const complete = pricedDelta !== null && unpricedDelta !== null
    && pricedDelta > 0
    && unpricedDelta === 0
    && (intervalCoverage === null || intervalCoverage >= 1 - COMPLETE_COVERAGE_EPSILON);
  return {
    completeness: complete ? 'complete' : 'partial',
    coverage: intervalCoverage,
    cumulativeCoverage,
    unpricedTokens: finite(last.unpricedTokens),
    unpricedDelta,
    pricedDelta
  };
}

function attachRunMetadata(metric, run, extras = {}) {
  const first = run[0] || {};
  const last = run.at(-1) || {};
  return {
    ...metric,
    ...extras,
    fitPointCount: run.length,
    fitUsedPercentSpan: percentSpanOf(run),
    firstFitObservedAt: String(first.observedAt || ''),
    lastFitObservedAt: String(last.observedAt || ''),
    snapshotId: String(last.snapshotId || first.snapshotId || '')
  };
}

// A full cycle is measured directly from its endpoint anchors rather than
// extrapolated through a regression slope: when the same real window is observed
// from a near-zero start to a near-full stop with no rollback, capacity is simply
// the cumulative metric growth across the whole window.
function fullCycleDirectCapacity(run, yOf) {
  if (!Array.isArray(run) || run.length < 2) return null;
  const first = run[0];
  const last = run.at(-1);
  const firstPercent = finite(first.usedPercent);
  const lastPercent = finite(last.usedPercent);
  if (firstPercent === null || lastPercent === null) return null;
  if (firstPercent > FULL_CYCLE_START_MAX_PERCENT) return null;
  if (lastPercent < FULL_CYCLE_END_MIN_PERCENT) return null;
  const firstValue = finite(yOf(first));
  const lastValue = finite(yOf(last));
  if (firstValue === null || lastValue === null) return null;
  if (lastValue <= firstValue) return null;
  const capacity = lastValue - firstValue;
  return Number.isFinite(capacity) && capacity > 0 ? capacity : null;
}

// Stable, desensitized evidence that a quota can cover a rise in used% without
// any local token growth (e.g. consumption from the web or another device, or an
// unattributed other entrance). Such a span is never a clean full-cycle claim and
// lowers overall confidence instead.
function cycleGapEvidence(samples) {
  const rows = (Array.isArray(samples) ? samples : [])
    .slice()
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const evidence = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const previousPercent = finite(previous.usedPercent);
    const currentPercent = finite(current.usedPercent);
    const previousTokens = finite(previous.observedTotalTokens);
    const currentTokens = finite(current.observedTotalTokens);
    if (previousPercent === null || currentPercent === null) continue;
    if (currentPercent <= previousPercent) continue;
    if (previousTokens === null || currentTokens === null || currentTokens > previousTokens) continue;
    evidence.push({
      kind: 'quota-rise-without-local-usage',
      observedAt: String(current.observedAt || ''),
      percentFrom: previousPercent,
      percentTo: currentPercent,
      tokenDelta: currentTokens - previousTokens
    });
  }
  return evidence;
}

function emptyRunCoverage() {
  return {
    completeness: '',
    coverage: null,
    cumulativeCoverage: null,
    unpricedTokens: null,
    unpricedDelta: null,
    pricedDelta: null
  };
}

function pricedPartialReason(priced, coverage) {
  return priced && coverage.completeness === 'partial' ? 'partial-pricing-coverage' : '';
}

function metricCompleteness(priced, coverage) {
  // Cycle observation and price coverage are independent. A full 0% -> 100%
  // window can still have only a priced portion; local tokens must not inherit
  // a pricing completeness flag at all.
  if (!priced) return '';
  return coverage.completeness === 'complete' || coverage.completeness === 'partial'
    ? coverage.completeness
    : '';
}

// Shared metric builder: a run that truly spans the whole window is measured
// directly (full-cycle); anything else is extrapolated through linear regression
// and is explicitly marked as a partial-cycle estimate. An unobserved quota
// gap keeps the endpoint increment but is never a clean full-cycle claim.
function buildFitMetric(run, yOf, coverage, options = {}) {
  const priced = options.priced === true;
  const hasCycleGap = options.hasCycleGap === true;
  if (priced && !(coverage.pricedDelta > 0)) {
    return unavailableMetric('insufficient-priced-delta', run.length, attachRunMetadata(coverage, run));
  }
  const direct = fullCycleDirectCapacity(run, yOf);
  if (direct !== null) {
    const clean = !hasCycleGap;
    const reason = !clean
      ? 'quota-rise-without-local-usage'
      : pricedPartialReason(priced, coverage);
    return attachRunMetadata({
      available: true,
      method: clean ? FULL_CYCLE_ESTIMATE_METHOD : CAPACITY_ESTIMATE_METHOD,
      cycleBasis: clean ? 'full' : 'partial',
      reason,
      pointCount: run.length,
      slopePerPercent: direct / 100,
      capacity: direct,
      rSquared: clean ? 1 : null,
      normalizedRmse: clean ? 0 : null,
      ...emptyMetricExtras(),
      ...coverage,
      completeness: metricCompleteness(priced, coverage),
      fitPointCount: run.length
    }, run);
  }
  const points = run.map((sample) => ({ x: finite(sample.usedPercent), y: yOf(sample) }));
  const fitted = regressPoints(points);
  if (!fitted.available) {
    return attachRunMetadata({ ...fitted, ...coverage, method: CAPACITY_ESTIMATE_METHOD, cycleBasis: 'partial' }, run);
  }
  return attachRunMetadata({
    ...fitted,
    ...coverage,
    completeness: metricCompleteness(priced, coverage),
    method: CAPACITY_ESTIMATE_METHOD,
    cycleBasis: 'partial',
    reason: hasCycleGap ? 'quota-rise-without-local-usage' : pricedPartialReason(priced, coverage)
  }, run);
}

function estimateLocalTokens(samples, options = {}) {
  const selected = selectLatestValidRun(samples, isLocalTokenSample, {
    yOf: (sample) => sample.observedTotalTokens
  });
  const run = selected.samples;
  if (run.length < 2) {
    const reason = selected.stopReason === 'percent-rollback' || selected.stopReason === 'cumulative-rollback'
      ? selected.stopReason
      : 'insufficient-percent-span';
    return unavailableMetric(reason, run.length, attachRunMetadata(emptyRunCoverage(), run));
  }
  return buildFitMetric(
    run,
    (sample) => finite(sample.observedTotalTokens),
    emptyRunCoverage(),
    { hasCycleGap: options.hasCycleGap === true }
  );
}

function estimatePricedMetric(samples, field, options = {}) {
  const selected = selectLatestValidRun(samples, (sample) => isPricedMetricSample(sample, field), {
    identityOf: samplePricingIdentity,
    yOf: (sample) => sample[field],
    extrasOf: (sample) => [sample.pricedTokens, sample.unpricedTokens]
  });
  return fitPricedMetricRun(selected.samples, field, selected.stopReason, options);
}

function fitPricedMetricRun(run, field, stopReason = '', options = {}) {
  const coverage = coverageFromRun(run);
  if (run.length < 2) {
    const reason = stopReason === 'percent-rollback'
      || stopReason === 'cumulative-rollback'
      || stopReason === 'pricing-identity-changed'
      ? stopReason
      : (stopReason || 'insufficient-percent-span');
    return unavailableMetric(reason, run.length, attachRunMetadata({
      ...coverage,
      completeness: ''
    }, run));
  }
  return buildFitMetric(run, (sample) => finite(sample[field]), coverage, {
    priced: true,
    hasCycleGap: options.hasCycleGap === true
  });
}

function pricingRuns(samples, field) {
  const runs = [];
  let run = [];
  const options = {
    identityOf: samplePricingIdentity,
    yOf: (sample) => sample[field],
    extrasOf: (sample) => [sample.pricedTokens, sample.unpricedTokens]
  };
  for (const sample of samples) {
    if (!isPricedMetricSample(sample, field)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const previous = run.at(-1);
    if (previous && contiguousBreakReason(previous, sample, options)) {
      runs.push(run);
      run = [];
    }
    run.push(sample);
  }
  if (run.length) runs.push(run);
  return runs;
}

// A public-price snapshot is part of the regression identity. When the latest
// snapshot has only one point, retain the prior complete run as an explicitly
// historical display fallback rather than blending price bases or hiding it.
function estimatePreviousPricingMetric(samples, field, currentMetric, options = {}) {
  if (currentMetric?.available === true || currentMetric?.reason !== 'pricing-identity-changed') return null;
  const runs = pricingRuns(samples, field);
  const latest = runs.at(-1);
  const latestIdentity = latest?.length ? samplePricingIdentity(latest.at(-1)) : '';
  for (let index = runs.length - 2; index >= 0; index -= 1) {
    const candidateRun = runs[index];
    if (!candidateRun.length || samplePricingIdentity(candidateRun.at(-1)) === latestIdentity) continue;
    const fitted = fitPricedMetricRun(candidateRun, field, '', options);
    if (fitted.available) return { ...fitted, historicalPricing: true };
  }
  return null;
}

function metricEvidenceStatus(metric, pointCount, usedPercentSpan, options = {}) {
  if (!metric.available) return 'unavailable';
  // An unobserved quota gap is never a high-confidence measurement, including
  // when the endpoints still happen to sit near 0% and 100%.
  if (options.hasCycleGap === true) return 'unstable';
  // A directly-observed full cycle is a complete-window measurement of the two
  // endpoint anchors, not a sparse slope fit: it is inherently the most reliable
  // basis regardless of how many intermediate samples were recorded.
  if (metric.method === FULL_CYCLE_ESTIMATE_METHOD) return 'stable';
  if (pointCount === 2 || usedPercentSpan < MIN_STABLE_PERCENT_SPAN) return 'preliminary';
  if (
    pointCount >= 3
    && metric.rSquared !== null
    && metric.rSquared >= STABLE_R_SQUARED
    && metric.normalizedRmse !== null
    && metric.normalizedRmse <= STABLE_NORMALIZED_RMSE
  ) return 'stable';
  return 'unstable';
}

function withEvidenceStatus(metric, pointCount, usedPercentSpan, options = {}) {
  return {
    ...metric,
    status: metricEvidenceStatus(metric, pointCount, usedPercentSpan, options)
  };
}

function overallEvidenceStatus(metrics, gapEvidence = []) {
  const available = metrics.filter((metric) => metric.available);
  if (!available.length) return 'unstable';
  const rank = { unstable: 0, preliminary: 1, stable: 2 };
  const worst = available.reduce((current, metric) => (
    rank[metric.status] < rank[current] ? metric.status : current
  ), 'stable');
  // A quota rise that is not backed by local token/cost growth is never a clean,
  // high-confidence claim: cap the overall state at unstable.
  if (Array.isArray(gapEvidence) && gapEvidence.length) return 'unstable';
  return worst;
}

function groupHasCycleGap(samples, evidence) {
  if (Array.isArray(evidence) && evidence.length) return true;
  return (Array.isArray(samples) ? samples : []).some((sample) => sample?.unsettled === true);
}

// Segment increment only. The last sample's cumulative profile tokens are an
// account-lifetime watermark and must never be labeled as this-cycle usage.
function cycleObservedTokens(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  if (rows.length < 2) {
    return {
      observedCycleTokens: null,
      observedCycleTokensStatus: rows.length === 1 ? 'collecting' : 'unavailable'
    };
  }
  let previousTokens = finite(rows[0].observedTotalTokens);
  if (previousTokens === null) {
    return { observedCycleTokens: null, observedCycleTokensStatus: 'unavailable' };
  }
  for (let index = 1; index < rows.length; index += 1) {
    const currentTokens = finite(rows[index].observedTotalTokens);
    if (currentTokens === null || currentTokens < previousTokens) {
      return { observedCycleTokens: null, observedCycleTokensStatus: 'unavailable' };
    }
    previousTokens = currentTokens;
  }
  const firstTokens = finite(rows[0].observedTotalTokens);
  const lastTokens = finite(rows.at(-1).observedTotalTokens);
  const firstPercent = finite(rows[0].usedPercent);
  const startedNearZero = firstPercent !== null && firstPercent <= FULL_CYCLE_START_MAX_PERCENT;
  return {
    observedCycleTokens: lastTokens - firstTokens,
    observedCycleTokensStatus: startedNearZero ? 'available' : 'partial-window'
  };
}

function estimateCapacityGroup(rawSamples) {
  const samples = [...rawSamples].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const first = samples[0] || {};
  const last = samples.at(-1) || first;
  const usedPercentSpan = percentSpanOf(samples);
  const gapEvidence = cycleGapEvidence(samples);
  const hasCycleGap = groupHasCycleGap(samples, gapEvidence);
  const fitOptions = { hasCycleGap };
  const localFit = estimateLocalTokens(samples, fitOptions);
  const apiFit = estimatePricedMetric(samples, 'apiEquivalentCostUsd', fitOptions);
  const apiFallbackFit = estimatePreviousPricingMetric(samples, 'apiEquivalentCostUsd', apiFit, fitOptions);
  const referenceFit = estimatePricedMetric(samples, 'referenceEquivalentTokens', fitOptions);
  const localTokens = withEvidenceStatus(localFit, localFit.fitPointCount || localFit.pointCount, localFit.fitUsedPercentSpan, fitOptions);
  const apiEquivalentUsd = withEvidenceStatus(apiFit, apiFit.fitPointCount || apiFit.pointCount, apiFit.fitUsedPercentSpan, fitOptions);
  const apiEquivalentUsdFallback = apiFallbackFit
    ? withEvidenceStatus(apiFallbackFit, apiFallbackFit.fitPointCount || apiFallbackFit.pointCount, apiFallbackFit.fitUsedPercentSpan, fitOptions)
    : null;
  const referenceEquivalentTokens = withEvidenceStatus(
    referenceFit,
    referenceFit.fitPointCount || referenceFit.pointCount,
    referenceFit.fitUsedPercentSpan,
    fitOptions
  );
  // Observed cycle totals must describe the same contiguous run the fit kept.
  // Pre-rollback / pre-unsettled tokens stay in the raw group for audit but
  // are not this run's observed cycle usage.
  const currentRun = selectLatestValidRun(samples, isLocalTokenSample, {
    yOf: (sample) => sample.observedTotalTokens,
    breakOnUnsettled: true
  }).samples;
  const observed = cycleObservedTokens(currentRun);
  return {
    method: localTokens.method === FULL_CYCLE_ESTIMATE_METHOD
      || (localTokens.available !== true && apiEquivalentUsd.method === FULL_CYCLE_ESTIMATE_METHOD)
      ? FULL_CYCLE_ESTIMATE_METHOD
      : CAPACITY_ESTIMATE_METHOD,
    gapEvidence,
    degradedCycleCount: gapEvidence.length,
    observedCycleTokensStatus: observed.observedCycleTokensStatus,
    ...(observed.observedCycleTokens !== null ? { observedCycleTokens: observed.observedCycleTokens } : {}),
    provider: String(first.provider || ''),
    profileId: String(first.profileId || ''),
    windowIdentity: sampleWindowIdentity(first),
    limitId: String(first.limitId || ''),
    kind: String(first.kind || ''),
    ...(finite(first.windowMinutes) !== null ? { windowMinutes: first.windowMinutes } : {}),
    resetsAt: String(first.resetsAt || ''),
    scopeVersion: String(first.scopeVersion || ''),
    // A logical cycle may span legacy token-derived segment IDs. Associate the
    // estimate with the latest raw segment while retaining every raw sample.
    segmentId: String(last.segmentId || ''),
    pointCount: samples.length,
    usedPercentSpan,
    fitPointCount: apiEquivalentUsd.fitPointCount || localTokens.fitPointCount || 0,
    fitUsedPercentSpan: apiEquivalentUsd.fitUsedPercentSpan || localTokens.fitUsedPercentSpan || 0,
    firstObservedAt: String(samples[0]?.observedAt || ''),
    lastObservedAt: String(samples.at(-1)?.observedAt || ''),
    firstFitObservedAt: apiEquivalentUsd.firstFitObservedAt || localTokens.firstFitObservedAt || '',
    lastFitObservedAt: apiEquivalentUsd.lastFitObservedAt || localTokens.lastFitObservedAt || '',
    status: overallEvidenceStatus([localTokens, apiEquivalentUsd, referenceEquivalentTokens], gapEvidence),
    stability: {
      rSquared: localTokens.rSquared,
      normalizedRmse: localTokens.normalizedRmse,
      stableRSquaredThreshold: STABLE_R_SQUARED,
      stableNormalizedRmseThreshold: STABLE_NORMALIZED_RMSE,
      stablePercentSpanThreshold: MIN_STABLE_PERCENT_SPAN
    },
    localTokens,
    apiEquivalentUsd,
    ...(apiEquivalentUsdFallback ? { apiEquivalentUsdFallback } : {}),
    referenceEquivalentTokens
  };
}

function deriveCapacityQuota(metric, currentUsedPercent) {
  const capacity = finite(metric?.capacity);
  const coverage = finite(metric?.coverage);
  const completeness = metric?.completeness === 'complete' || metric?.completeness === 'partial'
    ? metric.completeness
    : '';
  const method = metric?.method;
  const cycleBasis = metric?.cycleBasis;
  const cycleComplete = method === FULL_CYCLE_ESTIMATE_METHOD && cycleBasis !== 'partial';
  const base = {
    available: metric?.available === true && capacity !== null && capacity > 0,
    estimated: true,
    pricedPortion: completeness === 'partial',
    completeness,
    ...(method && typeof method === 'string' ? { method } : {}),
    ...(cycleBasis === 'full' || cycleBasis === 'partial' ? { cycleBasis } : {}),
    ...(cycleComplete ? { cycleComplete: true } : {}),
    coverage,
    capacity: capacity !== null && capacity > 0 ? capacity : null,
    consumed: null,
    remaining: null,
    usedPercent: finite(currentUsedPercent)
  };
  if (!base.available) return base;
  const usedPercent = finite(currentUsedPercent);
  if (usedPercent === null) return base;
  const clamped = Math.max(0, Math.min(100, usedPercent));
  base.consumed = capacity * (clamped / 100);
  base.remaining = Math.max(0, capacity - base.consumed);
  base.usedPercent = clamped;
  return base;
}

function deriveApiEquivalentQuota(estimate, currentUsedPercent) {
  return deriveCapacityQuota(estimate?.apiEquivalentUsd, currentUsedPercent);
}

function estimateHasCycleGap(estimate) {
  return (Array.isArray(estimate?.gapEvidence) && estimate.gapEvidence.length > 0)
    || Number(estimate?.degradedCycleCount || 0) > 0;
}

// Shared badge selection so a quota gap cannot surface as "stable" on one
// provider and a warning on another.
function selectQuotaEvidenceStatus(estimate, options = {}) {
  if (options.usesPreviousPricing === true) return 'previous-pricing';
  const hasGap = estimateHasCycleGap(estimate);
  if (hasGap) return 'unstable';
  const metric = estimate?.apiEquivalentUsd?.available === true
    ? estimate.apiEquivalentUsd
    : estimate?.localTokens;
  if (['preliminary', 'stable', 'unstable', 'unavailable'].includes(metric?.status)) return metric.status;
  if (['preliminary', 'stable', 'unstable', 'unavailable'].includes(estimate?.status)) return estimate.status;
  return 'unavailable';
}

function estimateRateLimitCapacities(samplesValue, profileId = '') {
  const requestedProfile = String(profileId || '').trim();
  const estimates = capacitySampleGroups(samplesValue, requestedProfile).map(estimateCapacityGroup)
    .sort((left, right) => Date.parse(left.lastObservedAt) - Date.parse(right.lastObservedAt));
  const latestByWindow = new Map();
  for (const estimate of estimates) {
    const key = `${estimate.provider}|${estimate.profileId}|${estimate.windowIdentity}`;
    latestByWindow.set(key, estimate);
  }
  return estimates.map((estimate) => ({
    ...estimate,
    current: latestByWindow.get(`${estimate.provider}|${estimate.profileId}|${estimate.windowIdentity}`) === estimate
  }));
}

module.exports = {
  CAPACITY_ESTIMATE_METHOD,
  COMPLETE_COVERAGE_EPSILON,
  FULL_CYCLE_END_MIN_PERCENT,
  FULL_CYCLE_ESTIMATE_METHOD,
  FULL_CYCLE_START_MAX_PERCENT,
  MIN_STABLE_PERCENT_SPAN,
  STABLE_NORMALIZED_RMSE,
  STABLE_R_SQUARED,
  cycleGapEvidence,
  cycleObservedTokens,
  canJoinMappedProfileCycle,
  deriveCapacityQuota,
  deriveApiEquivalentQuota,
  estimateCapacityGroup,
  estimateHasCycleGap,
  estimateRateLimitCapacities,
  fullCycleDirectCapacity,
  sampleGroupKey,
  samplePricingIdentity,
  sampleWindowIdentity,
  selectLatestValidRun,
  selectQuotaEvidenceStatus
};
