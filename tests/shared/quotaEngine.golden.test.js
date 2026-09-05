'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const engine = require('../../src/shared/quotaEngine');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/quota-engine-golden-v1.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// Pick-only projection of the facade output onto the stable public subset the
// golden baseline freezes. It selects fields; it never recomputes an expected
// value. Keep it in sync with the projection used to author the fixture, and
// never let it derive numbers the engine did not already emit.
function projectMetric(metric) {
  return {
    available: metric.available,
    status: metric.status,
    reason: metric.reason,
    method: metric.method === undefined ? null : metric.method,
    cycleBasis: metric.cycleBasis === undefined ? null : metric.cycleBasis,
    pointCount: metric.pointCount,
    fitPointCount: metric.fitPointCount === undefined ? 0 : metric.fitPointCount,
    fitUsedPercentSpan: metric.fitUsedPercentSpan === undefined ? 0 : metric.fitUsedPercentSpan,
    capacity: metric.capacity === undefined ? null : metric.capacity,
    slopePerPercent: metric.slopePerPercent === undefined ? null : metric.slopePerPercent,
    rSquared: metric.rSquared === undefined ? null : metric.rSquared,
    normalizedRmse: metric.normalizedRmse === undefined ? null : metric.normalizedRmse,
    completeness: metric.completeness === undefined ? '' : metric.completeness,
    coverage: metric.coverage === undefined ? null : metric.coverage,
    snapshotId: metric.snapshotId === undefined ? '' : metric.snapshotId
  };
}

function projectEstimate(estimate) {
  return {
    provider: estimate.provider,
    profileId: estimate.profileId,
    windowIdentity: estimate.windowIdentity,
    limitId: estimate.limitId,
    kind: estimate.kind,
    windowMinutes: estimate.windowMinutes === undefined ? null : estimate.windowMinutes,
    resetsAt: estimate.resetsAt,
    scopeVersion: estimate.scopeVersion,
    segmentId: estimate.segmentId,
    current: estimate.current === true,
    method: estimate.method,
    status: estimate.status,
    pointCount: estimate.pointCount,
    usedPercentSpan: estimate.usedPercentSpan,
    fitPointCount: estimate.fitPointCount,
    fitUsedPercentSpan: estimate.fitUsedPercentSpan,
    firstObservedAt: estimate.firstObservedAt,
    lastObservedAt: estimate.lastObservedAt,
    observedCycleTokens: estimate.observedCycleTokens === undefined ? null : estimate.observedCycleTokens,
    observedCycleTokensStatus: estimate.observedCycleTokensStatus,
    gapEvidence: estimate.gapEvidence,
    degradedCycleCount: estimate.degradedCycleCount,
    localTokens: projectMetric(estimate.localTokens),
    apiEquivalentUsd: projectMetric(estimate.apiEquivalentUsd)
  };
}

function projectSummary(summary) {
  return {
    provider: summary.provider,
    profileId: summary.profileId,
    windowKind: summary.windowKind,
    windowIdentity: summary.windowIdentity,
    resetAt: summary.resetAt,
    scopeVersion: summary.scopeVersion,
    pricingReferenceIdentity: summary.pricingReferenceIdentity,
    officialUsedPercent: summary.officialUsedPercent,
    locallyObservedApiEquivalent: summary.locallyObservedApiEquivalent,
    locallyObservedTokens: summary.locallyObservedTokens,
    pricedTokens: summary.pricedTokens,
    unpricedTokens: summary.unpricedTokens,
    pricingCoverage: summary.pricingCoverage,
    observedPartial: summary.observedPartial,
    estimatedCapacity: summary.estimatedCapacity,
    derivedConsumed: summary.derivedConsumed,
    derivedRemaining: summary.derivedRemaining,
    basis: summary.basis,
    capacityFromCurrentCycle: summary.capacityFromCurrentCycle,
    confidence: summary.confidence,
    reasons: summary.reasons,
    evidence: {
      estimateSegmentId: summary.evidence.estimateSegmentId,
      estimateResetAt: summary.evidence.estimateResetAt,
      firstSampleId: summary.evidence.firstSampleId,
      lastSampleId: summary.evidence.lastSampleId,
      pointCount: summary.evidence.pointCount,
      usedPercentSpan: summary.evidence.usedPercentSpan,
      gapCount: summary.evidence.gapCount,
      rSquared: summary.evidence.rSquared,
      normalizedRmse: summary.evidence.normalizedRmse,
      pricingCoverage: summary.evidence.pricingCoverage,
      pricingReferenceIdentity: summary.evidence.pricingReferenceIdentity
    }
  };
}

function projectSnapshot(snapshot) {
  return {
    engineVersion: snapshot.engineVersion,
    contractVersion: snapshot.contractVersion,
    capacityEstimates: snapshot.capacityEstimates.map(projectEstimate),
    accountQuotaSummaries: snapshot.accountQuotaSummaries.map(projectSummary)
  };
}

// This is an independent behavioural baseline, not a parity check against the
// current low-level composition: inputs and expected outputs are frozen
// literals in the fixture. If this test fails, either the fixture was authored
// wrong or the engine's observable behaviour genuinely changed — decide which
// before touching either side, and never regenerate expected at runtime.
for (const entry of fixture.cases) {
  test(`golden v1: ${entry.name}`, () => {
    const snapshot = engine.buildProfileQuotaSnapshot(entry.input);
    assert.deepEqual(projectSnapshot(snapshot), entry.expected);

    for (const summary of entry.expected.accountQuotaSummaries) {
      if (summary.estimatedCapacity === null) continue;
      assert.equal(summary.derivedConsumed + summary.derivedRemaining, summary.estimatedCapacity);
      assert.equal(summary.derivedConsumed, summary.estimatedCapacity * summary.officialUsedPercent / 100);
    }
  });
}

test('golden v1: fixture covers the required provider, window and pricing scenarios', () => {
  const names = fixture.cases.map((entry) => entry.name);
  assert.deepEqual(names, [
    'codex-weekly-current-partial-cycle',
    'codex-session-and-weekly-kept-separate',
    'codex-weekly-full-cycle',
    'codex-successor-reset-and-jitter-boundary',
    'codex-partial-pricing-coverage',
    'codex-unknown-model-fails-closed',
    'codex-snapshot-migration'
  ]);

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  // The fixture must stay synthetic and desensitized: no identities, credentials
  // or local paths may sneak into the behavioural baseline. ('token' as a bare
  // substring is not checked: legitimate public fields like observedTotalTokens
  // contain it.)
  for (const forbidden of ['accountKey', 'cookie', 'email', '@', 'Users\\', '\\\\wsl', 'authorization', 'bearer', 'sk-']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }

  // This PR prices Codex only: every frozen estimate is a codex row.
  const allProviders = fixture.cases.flatMap((entry) => entry.expected.capacityEstimates.map((row) => row.provider));
  assert.ok(allProviders.length > 0);
  assert.equal(allProviders.every((provider) => provider === 'codex'), true);

  // Output ordering is part of the frozen contract: capacity estimates come
  // back sorted by last observed time, summaries follow the observation order.
  for (const entry of fixture.cases) {
    const observed = entry.expected.capacityEstimates.map((row) => Date.parse(row.lastObservedAt));
    assert.deepEqual(observed, [...observed].sort((left, right) => left - right), entry.name);
  }
});

test('golden v1: reset jitter and successor reset cycle boundaries stay as fixed', () => {
  assert.equal(engine.QUOTA_ENGINE_VERSION, fixture.engineVersion);
  assert.equal(engine.QUOTA_CONTRACT_VERSION, fixture.contractVersion);
  assert.equal(engine.RESET_CYCLE_JITTER_MS, 2 * 60 * 1000);

  const [jitterLive, jitterCandidate] = fixture.cycleIdentityChecks.resetJitterSameCycle;
  assert.equal(engine.resetTimesClose(jitterLive, jitterCandidate), true);
  assert.equal(engine.sameQuotaCycle(
    { provider: 'codex', profileId: 'codex-cycle', kind: 'weekly', resetsAt: jitterLive },
    { provider: 'codex', profileId: 'codex-cycle', kind: 'weekly', resetsAt: jitterCandidate }
  ), true);

  const [successorLive, successorReset] = fixture.cycleIdentityChecks.successorDifferentCycle;
  assert.equal(engine.resetTimesClose(successorLive, successorReset), false);
  assert.equal(engine.sameQuotaCycle(
    { provider: 'codex', profileId: 'codex-cycle', kind: 'weekly', resetsAt: successorLive },
    { provider: 'codex', profileId: 'codex-cycle', kind: 'weekly', resetsAt: successorReset }
  ), false);
  assert.equal(engine.isSuccessorQuotaCycle(
    { resetsAt: successorLive, usedPercent: 40, observedAt: '2026-08-31T23:59:00.000Z' },
    { resetsAt: successorReset, usedPercent: 0, observedAt: '2026-09-01T00:05:00.000Z' }
  ), true);
});
