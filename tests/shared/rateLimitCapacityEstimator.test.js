'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deriveApiEquivalentQuota,
  estimateRateLimitCapacities,
  sampleGroupKey,
  selectQuotaEvidenceStatus
} = require('../../src/shared/quotaEngine');

function sample(percent, tokens, usd, reference, extra = {}) {
  return {
    observedAt: new Date(Date.UTC(2026, 7, 25, 0, percent)).toISOString(),
    provider: 'codex',
    profileId: 'codex-default',
    limitId: 'weekly',
    kind: 'weekly',
    windowMinutes: 10080,
    resetsAt: '2026-09-01T00:00:00.000Z',
    segmentId: 'segment-weekly-a',
    usedPercent: percent,
    observedTotalTokens: tokens,
    pricedTokens: tokens,
    unpricedTokens: 0,
    apiEquivalentCostUsd: usd,
    referenceEquivalentTokens: reference,
    pricingCoverage: 1,
    ...extra
  };
}

test('API-equivalent quota is derived from slope capacity and current used percent', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000),
    sample(20, 2000, 0.2, 4000)
  ]);
  const quota = deriveApiEquivalentQuota(estimate, 40);
  assert.equal(quota.available, true);
  assert.equal(quota.estimated, true);
  assert.ok(Math.abs(quota.capacity - 1) < 1e-12);
  assert.ok(Math.abs(quota.consumed - 0.4) < 1e-12);
  assert.ok(Math.abs(quota.remaining - 0.6) < 1e-12);
  const missing = deriveApiEquivalentQuota({ apiEquivalentUsd: { available: false } }, 40);
  assert.equal(missing.available, false);
  assert.equal(missing.capacity, null);
});

test('two percentage anchors estimate all three full-window capacities', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000),
    sample(20, 2000, 0.2, 4000)
  ]);
  assert.equal(estimate.localTokens.capacity, 10000);
  assert.ok(Math.abs(estimate.apiEquivalentUsd.capacity - 1) < 1e-12);
  assert.equal(estimate.referenceEquivalentTokens.capacity, 20000);
  assert.equal(estimate.pointCount, 2);
  assert.equal(estimate.usedPercentSpan, 10);
  assert.equal(estimate.status, 'preliminary');
  assert.equal(estimate.localTokens.status, 'preliminary');
  assert.equal(estimate.apiEquivalentUsd.status, 'preliminary');
  assert.equal(estimate.referenceEquivalentTokens.status, 'preliminary');
  assert.equal(estimate.method, 'observed-linear-estimate');
});

test('multi-point linear samples become stable while low span stays preliminary', () => {
  const stable = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000), sample(20, 2000, 0.2, 4000), sample(30, 3000, 0.3, 6000)
  ])[0];
  assert.equal(stable.status, 'stable');
  assert.equal(stable.localTokens.status, 'stable');
  assert.equal(stable.apiEquivalentUsd.status, 'stable');
  assert.equal(stable.referenceEquivalentTokens.status, 'stable');
  assert.equal(stable.stability.rSquared, 1);
  assert.equal(stable.stability.normalizedRmse, 0);

  const preliminary = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000), sample(11, 1100, 0.11, 2200), sample(12, 1200, 0.12, 2400)
  ])[0];
  assert.equal(preliminary.status, 'preliminary');
  assert.equal(preliminary.usedPercentSpan, 2);
});

test('nonlinear samples report instability and keep fit diagnostics', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000), sample(20, 4000, 0.4, 8000), sample(30, 4100, 0.41, 8200)
  ]);
  assert.equal(estimate.status, 'unstable');
  assert.ok(estimate.stability.rSquared < 0.98);
  assert.ok(estimate.stability.normalizedRmse > 0.1);
});

test('a nonlinear API-equivalent fit prevents a linear local-token fit from marking the estimate stable', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000),
    sample(20, 2000, 0.8, 4000),
    sample(30, 3000, 0.9, 6000)
  ]);
  assert.equal(estimate.localTokens.rSquared, 1);
  assert.equal(estimate.localTokens.status, 'stable');
  assert.ok(estimate.apiEquivalentUsd.rSquared < 0.98);
  assert.equal(estimate.apiEquivalentUsd.status, 'unstable');
  assert.equal(estimate.referenceEquivalentTokens.status, 'stable');
  assert.equal(estimate.status, 'unstable');
});

test('missing pricing, reference, coverage gaps, rollback, and zero span fail closed', () => {
  const missing = estimateRateLimitCapacities([
    sample(10, 1000, null, null, { pricedTokens: 0, unpricedTokens: 1000, pricingCoverage: 0 }),
    sample(20, 2000, null, null, { pricedTokens: 0, unpricedTokens: 2000, pricingCoverage: 0 })
  ])[0];
  assert.equal(missing.localTokens.available, true);
  assert.equal(missing.apiEquivalentUsd.available, false);
  assert.equal(missing.referenceEquivalentTokens.available, false);
  assert.equal(missing.apiEquivalentUsd.status, 'unavailable');
  assert.equal(missing.referenceEquivalentTokens.status, 'unavailable');

  const coverageGap = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000, { pricedTokens: 900, unpricedTokens: 100, pricingCoverage: 0.9 }),
    sample(20, 2000, 0.2, 4000, { pricedTokens: 1800, unpricedTokens: 200, pricingCoverage: 0.9 })
  ])[0];
  assert.equal(coverageGap.apiEquivalentUsd.available, true);
  assert.equal(coverageGap.apiEquivalentUsd.completeness, 'partial');
  assert.equal(coverageGap.apiEquivalentUsd.reason, 'partial-pricing-coverage');
  assert.equal(coverageGap.apiEquivalentUsd.coverage, 0.9);
  assert.equal(coverageGap.referenceEquivalentTokens.available, true);
  assert.equal(coverageGap.referenceEquivalentTokens.completeness, 'partial');

  const rollback = estimateRateLimitCapacities([
    sample(10, 2000, 0.2, 4000), sample(20, 1000, 0.1, 2000)
  ])[0];
  assert.equal(rollback.localTokens.reason, 'cumulative-rollback');
  assert.equal(rollback.localTokens.capacity, null);
  assert.equal(rollback.status, 'unstable');

  const zeroSpan = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000), sample(10, 2000, 0.2, 4000)
  ])[0];
  assert.equal(zeroSpan.localTokens.available, false);
  assert.equal(zeroSpan.localTokens.capacity, null);
});

test('different windows, accounts represented by segments, and profiles never mix', () => {
  const samples = [
    sample(10, 1000, 0.1, 2000),
    sample(20, 2000, 0.2, 4000),
    sample(10, 500, 0.05, 1000, { segmentId: 'segment-weekly-b' }),
    sample(20, 1000, 0.1, 2000, { segmentId: 'segment-weekly-b' }),
    sample(10, 100, 0.01, 200, { limitId: 'session', kind: 'session', windowMinutes: 300, segmentId: 'segment-session' }),
    sample(20, 200, 0.02, 400, { limitId: 'session', kind: 'session', windowMinutes: 300, segmentId: 'segment-session' }),
    sample(10, 300, 0.03, 600, { profileId: 'codex-other', segmentId: 'segment-other' }),
    sample(20, 600, 0.06, 1200, { profileId: 'codex-other', segmentId: 'segment-other' })
  ];
  const estimates = estimateRateLimitCapacities(samples, 'codex-default');
  assert.equal(estimates.length, 3);
  assert.deepEqual(estimates.map((estimate) => estimate.localTokens.capacity).sort((a, b) => a - b), [1000, 5000, 10000]);
  assert.equal(estimates.filter((estimate) => estimate.current).length, 2);
});

test('a contiguous priced suffix after earlier null samples can estimate without using the current cumulative as a fake early point', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(5, 500, null, null, { pricedTokens: 500, unpricedTokens: 0, apiEquivalentCostUsd: null, referenceEquivalentTokens: null, pricingCoverage: null }),
    sample(10, 1000, 0.1, 2000),
    sample(20, 2000, 0.2, 4000),
    sample(30, 3000, 0.3, 6000)
  ]);
  assert.equal(estimate.localTokens.available, true);
  assert.equal(estimate.localTokens.fitPointCount, 4);
  assert.equal(estimate.apiEquivalentUsd.available, true);
  assert.equal(estimate.apiEquivalentUsd.fitPointCount, 3);
  assert.equal(estimate.apiEquivalentUsd.firstFitObservedAt, sample(10, 1000, 0.1, 2000).observedAt);
  assert.equal(estimate.apiEquivalentUsd.completeness, 'complete');
  assert.ok(Math.abs(estimate.apiEquivalentUsd.capacity - 1) < 1e-12);
});

test('a constant legacy unpriced baseline does not depress a fully-priced interval', () => {
  const legacyUnpriced = 584586;
  const samples = [];
  for (let percent = 10; percent <= 40; percent += 10) {
    const priced = percent * 100;
    samples.push(sample(percent, priced + legacyUnpriced, priced * 0.0001, priced * 2, {
      pricedTokens: priced,
      unpricedTokens: legacyUnpriced,
      pricingCoverage: priced / (priced + legacyUnpriced)
    }));
  }
  const [estimate] = estimateRateLimitCapacities(samples);
  assert.equal(estimate.apiEquivalentUsd.available, true);
  // Interval coverage reflects only THIS fit's newly-priced tokens. A constant
  // legacy unpriced baseline is not an interval gap, so the interval is complete.
  assert.equal(estimate.apiEquivalentUsd.completeness, 'complete');
  assert.ok(Math.abs(estimate.apiEquivalentUsd.coverage - 1) < 1e-9);
  assert.ok(Math.abs(estimate.apiEquivalentUsd.capacity - 1) < 1e-12);
  const quota = deriveApiEquivalentQuota(estimate, 40);
  assert.equal(quota.available, true);
  assert.equal(quota.completeness, 'complete');
});

test('a real interval with growing unpriced tokens is partial and never complete', () => {
  const samples = [];
  for (let percent = 10; percent <= 40; percent += 10) {
    const priced = percent * 100;
    const unpriced = Math.round(percent * 10);
    samples.push(sample(percent, priced + unpriced, priced * 0.0001, priced * 2, {
      pricedTokens: priced,
      unpricedTokens: unpriced,
      pricingCoverage: priced / (priced + unpriced)
    }));
  }
  const [estimate] = estimateRateLimitCapacities(samples);
  assert.equal(estimate.apiEquivalentUsd.available, true);
  assert.equal(estimate.apiEquivalentUsd.completeness, 'partial');
  assert.equal(estimate.apiEquivalentUsd.reason, 'partial-pricing-coverage');
  assert.ok(estimate.apiEquivalentUsd.coverage > 0 && estimate.apiEquivalentUsd.coverage < 1);
  const quota = deriveApiEquivalentQuota(estimate, 40);
  assert.equal(quota.available, true);
  assert.equal(quota.pricedPortion, true);
  assert.equal(quota.completeness, 'partial');
});

test('local token capacity remains visible when API-equivalent samples are missing', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, null, null, { pricedTokens: 0, unpricedTokens: 1000, pricingCoverage: 0 }),
    sample(20, 2000, null, null, { pricedTokens: 0, unpricedTokens: 2000, pricingCoverage: 0 }),
    sample(30, 3000, null, null, { pricedTokens: 0, unpricedTokens: 3000, pricingCoverage: 0 })
  ]);
  assert.equal(estimate.localTokens.available, true);
  assert.equal(estimate.localTokens.capacity, 10000);
  assert.equal(estimate.localTokens.status, 'stable');
  assert.equal(estimate.apiEquivalentUsd.available, false);
  assert.equal(estimate.referenceEquivalentTokens.available, false);
});

test('different price identities are not concatenated into one API-equivalent fit', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000, { snapshotId: 'public-api-v3' }),
    sample(20, 2000, 0.2, 4000, { snapshotId: 'public-api-v3' }),
    sample(30, 3000, 0.3, 6000, { snapshotId: 'public-api-v4' }),
    sample(40, 4000, 0.4, 8000, { snapshotId: 'public-api-v4' })
  ]);
  assert.equal(estimate.apiEquivalentUsd.available, true);
  assert.equal(estimate.apiEquivalentUsd.fitPointCount, 2);
  assert.equal(estimate.apiEquivalentUsd.snapshotId, 'public-api-v4');
  assert.equal(estimate.apiEquivalentUsd.firstFitObservedAt, sample(30, 3000, 0.3, 6000, { snapshotId: 'public-api-v4' }).observedAt);
});

test('a 0% to 100% window is measured directly as an observed full cycle', () => {
  // Slightly nonlinear midpoints: a regression slope would differ from the
  // endpoint delta, but a full cycle is measured directly from the two anchors.
  const [estimate] = estimateRateLimitCapacities([
    sample(0, 0, 0, 0),
    sample(40, 5000, 5, 10000),
    sample(80, 9000, 9, 18000),
    sample(100, 10500, 10.5, 21000)
  ]);
  assert.equal(estimate.status, 'stable');
  assert.equal(estimate.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.cycleBasis, 'full');
  assert.equal(estimate.localTokens.completeness, '');
  assert.equal(estimate.localTokens.capacity, 10500);
  assert.equal(estimate.localTokens.rSquared, 1);
  assert.equal(estimate.apiEquivalentUsd.method, 'observed-full-cycle');
  assert.equal(estimate.apiEquivalentUsd.completeness, 'complete');
  assert.equal(estimate.apiEquivalentUsd.capacity, 10.5);
  assert.equal(estimate.referenceEquivalentTokens.method, 'observed-full-cycle');
  assert.equal(estimate.referenceEquivalentTokens.capacity, 21000);
  const quota = deriveApiEquivalentQuota(estimate, 40);
  assert.equal(quota.available, true);
  assert.equal(quota.cycleComplete, true);
  assert.equal(quota.completeness, 'complete');
  assert.equal(quota.pricedPortion, false);
  assert.ok(Math.abs(quota.capacity - 10.5) < 1e-12);
});

test('partial-cycle runs stay extrapolated and are explicitly labeled as such', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000), sample(20, 2000, 0.2, 4000), sample(30, 3000, 0.3, 6000)
  ]);
  assert.equal(estimate.status, 'stable');
  assert.equal(estimate.method, 'observed-linear-estimate');
  assert.equal(estimate.localTokens.method, 'observed-linear-estimate');
  assert.equal(estimate.localTokens.cycleBasis, 'partial');
  assert.equal(estimate.apiEquivalentUsd.cycleBasis, 'partial');
});

test('a start at 3% is not treated as a full cycle', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(3, 300, 0.3, 600), sample(100, 10000, 10, 20000)
  ]);
  assert.notEqual(estimate.localTokens.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.cycleBasis, 'partial');
});

test('a quota rise without local token growth keeps evidence and lowers confidence', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000),
    sample(20, 1000, 0.1, 2000),
    sample(30, 3000, 0.3, 6000)
  ]);
  assert.equal(estimate.gapEvidence.length, 1);
  assert.equal(estimate.gapEvidence[0].kind, 'quota-rise-without-local-usage');
  assert.equal(estimate.gapEvidence[0].percentFrom, 10);
  assert.equal(estimate.gapEvidence[0].percentTo, 20);
  assert.equal(estimate.gapEvidence[0].tokenDelta, 0);
  assert.equal(estimate.degradedCycleCount, 1);
  // Local tokens still fit, but the rise-without-usage gap caps overall confidence.
  assert.equal(estimate.localTokens.available, true);
  assert.equal(estimate.status, 'unstable');
});

test('a new price identity keeps a prior independently fitted API estimate as an explicit fallback', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(10, 1000, 0.1, 2000, { snapshotId: 'public-api-v3' }),
    sample(20, 2000, 0.2, 4000, { snapshotId: 'public-api-v3' }),
    // This single current-price point must not be mixed into the v3 fit.
    sample(30, 3000, 0.9, 9000, { snapshotId: 'public-api-v4' })
  ]);
  assert.equal(estimate.localTokens.available, true);
  assert.equal(estimate.apiEquivalentUsd.available, false);
  assert.equal(estimate.apiEquivalentUsd.reason, 'pricing-identity-changed');
  assert.equal(estimate.apiEquivalentUsdFallback.available, true);
  assert.equal(estimate.apiEquivalentUsdFallback.historicalPricing, true);
  assert.equal(estimate.apiEquivalentUsdFallback.snapshotId, 'public-api-v3');
  assert.ok(Math.abs(estimate.apiEquivalentUsdFallback.capacity - 1) < 1e-12);
  const quota = deriveApiEquivalentQuota({ apiEquivalentUsd: estimate.apiEquivalentUsdFallback }, 30);
  assert.equal(quota.available, true);
  assert.ok(Math.abs(quota.consumed - 0.3) < 1e-12);
  assert.ok(Math.abs(quota.remaining - 0.7) < 1e-12);
});

test('a two-anchor full cycle is stable even without intermediate samples', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(0, 0, 0, 0),
    sample(100, 10000, 10, 20000)
  ]);
  assert.equal(estimate.localTokens.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.status, 'stable');
  assert.equal(estimate.localTokens.capacity, 10000);
  assert.equal(estimate.apiEquivalentUsd.status, 'stable');
  assert.equal(estimate.status, 'stable');
  assert.equal(estimate.observedCycleTokens, 10000);
  assert.equal(estimate.observedCycleTokensStatus, 'available');
});

test('a full cycle with only half the tokens priced stays cycle-complete but pricing-partial', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(0, 0, 0, 0, { pricedTokens: 0, unpricedTokens: 0, pricingCoverage: 1 }),
    sample(100, 1000, 5, 10000, { pricedTokens: 500, unpricedTokens: 500, pricingCoverage: 0.5 })
  ]);
  assert.equal(estimate.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.cycleBasis, 'full');
  assert.equal(estimate.localTokens.completeness, '');
  assert.equal(estimate.localTokens.capacity, 1000);
  assert.equal(estimate.apiEquivalentUsd.method, 'observed-full-cycle');
  assert.equal(estimate.apiEquivalentUsd.cycleBasis, 'full');
  assert.equal(estimate.apiEquivalentUsd.completeness, 'partial');
  assert.equal(estimate.apiEquivalentUsd.reason, 'partial-pricing-coverage');
  assert.equal(estimate.apiEquivalentUsd.coverage, 0.5);
  assert.equal(estimate.apiEquivalentUsd.capacity, 5);
  const quota = deriveApiEquivalentQuota(estimate, 100);
  assert.equal(quota.cycleComplete, true);
  assert.equal(quota.completeness, 'partial');
  assert.equal(quota.pricedPortion, true);
  assert.equal(quota.coverage, 0.5);
  assert.equal(quota.capacity, 5);
});

test('a 0% to 100% cycle with an unobserved local-usage gap is not a clean full cycle', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(0, 0, 0, 0),
    sample(10, 0, 0, 0, { unsettled: true }),
    sample(100, 8000, 8, 16000)
  ]);
  assert.equal(estimate.gapEvidence.length, 1);
  assert.equal(estimate.gapEvidence[0].kind, 'quota-rise-without-local-usage');
  assert.notEqual(estimate.method, 'observed-full-cycle');
  assert.notEqual(estimate.localTokens.method, 'observed-full-cycle');
  assert.equal(estimate.localTokens.cycleBasis, 'partial');
  assert.equal(estimate.localTokens.capacity, 8000);
  assert.equal(estimate.localTokens.status, 'unstable');
  assert.equal(estimate.apiEquivalentUsd.status, 'unstable');
  assert.equal(estimate.status, 'unstable');
  const quota = deriveApiEquivalentQuota(estimate, 100);
  assert.notEqual(quota.cycleComplete, true);
  assert.equal(quota.cycleBasis, 'partial');
  assert.equal(selectQuotaEvidenceStatus(estimate, { provider: 'other-client' }), 'unstable');
  assert.equal(selectQuotaEvidenceStatus(estimate, { provider: 'codex' }), 'unstable');
});

test('observed cycle tokens are the segment increment, not the account cumulative', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(18, 90749705, 9, 18000),
    sample(50, 294194640, 30, 60000)
  ]);
  assert.equal(estimate.observedCycleTokens, 294194640 - 90749705);
  assert.equal(estimate.observedCycleTokensStatus, 'partial-window');
  assert.equal(estimate.lastObservedTotalTokens, undefined);
  assert.notEqual(estimate.observedCycleTokens, 294194640);
});

test('a single-point segment does not treat cumulative account tokens as this-cycle observations', () => {
  const [estimate] = estimateRateLimitCapacities([
    sample(19, 123955402, 12, 24000)
  ]);
  assert.equal(estimate.observedCycleTokens, undefined);
  assert.equal(estimate.observedCycleTokensStatus, 'collecting');
  assert.equal(estimate.lastObservedTotalTokens, undefined);
});

test('token-rotation segments mapped to one Profile and reset estimate as one cycle', () => {
  const estimates = estimateRateLimitCapacities([
    sample(0, 1000, 1, 2000, { provider: 'other-client', profileId: 'codex-secondary', segmentId: 'token-a' }),
    sample(20, 3000, 3, 6000, { provider: 'other-client', profileId: 'codex-secondary', segmentId: 'token-a' }),
    sample(20, 3000, 3, 6000, { provider: 'other-client', profileId: 'codex-secondary', segmentId: 'token-b' }),
    sample(40, 5000, 5, 10000, { provider: 'other-client', profileId: 'codex-secondary', segmentId: 'token-b' })
  ]);

  assert.equal(estimates.length, 1);
  assert.equal(estimates[0].pointCount, 3);
  assert.equal(estimates[0].segmentId, 'token-b');
  assert.equal(estimates[0].apiEquivalentUsd.capacity, 10);
  assert.equal(estimates[0].current, true);
});

test('Profile, reset and rollback boundaries still prevent cross-segment joining', () => {
  const estimates = estimateRateLimitCapacities([
    sample(20, 2000, 2, 4000, {
      observedAt: '2026-08-25T00:00:00.000Z', provider: 'other-client', profileId: 'codex-secondary', segmentId: 'a'
    }),
    sample(30, 3000, 3, 6000, {
      observedAt: '2026-08-25T00:01:00.000Z', provider: 'other-client', profileId: 'codex-other', segmentId: 'b'
    }),
    sample(40, 4000, 4, 8000, {
      observedAt: '2026-08-25T00:02:00.000Z', provider: 'other-client', profileId: 'codex-secondary', segmentId: 'c',
      resetsAt: '2026-09-08T00:00:00.000Z'
    }),
    sample(10, 5000, 5, 10000, {
      observedAt: '2026-08-25T00:03:00.000Z', provider: 'other-client', profileId: 'codex-secondary', segmentId: 'd',
      resetsAt: '2026-09-08T00:00:00.000Z'
    })
  ]);

  assert.equal(estimates.length, 4);
  assert.equal(estimates.filter((estimate) => estimate.current).length, 2);
});

test('the same segment id with two resetsAt values does not share a fit group', () => {
  const first = sample(10, 1000, 1, 2000, {
    segmentId: 'shared-segment',
    resetsAt: '2026-09-01T00:00:00.000Z'
  });
  const second = sample(20, 2000, 2, 4000, {
    segmentId: 'shared-segment',
    resetsAt: '2026-09-08T00:00:00.000Z',
    observedAt: '2026-08-25T01:00:00.000Z'
  });
  assert.notEqual(sampleGroupKey(first), sampleGroupKey(second));
  const estimates = estimateRateLimitCapacities([first, second]);
  assert.equal(estimates.length, 2);
});

test('observedCycleTokens ignores tokens from before a percent rollback or unsettled break', () => {
  const [rollback] = estimateRateLimitCapacities([
    sample(10, 1000, 1, 2000, { observedAt: '2026-08-25T01:00:00.000Z' }),
    sample(40, 4000, 4, 8000, { observedAt: '2026-08-25T02:00:00.000Z' }),
    sample(20, 4200, 4.2, 8400, { observedAt: '2026-08-25T03:00:00.000Z' }),
    sample(30, 5200, 5.2, 10400, { observedAt: '2026-08-25T04:00:00.000Z' })
  ]);
  assert.equal(rollback.observedCycleTokens, 1000);
  assert.notEqual(rollback.observedCycleTokens, 4200);

  const [unsettled] = estimateRateLimitCapacities([
    sample(10, 1000, 1, 2000, { observedAt: '2026-08-25T01:00:00.000Z' }),
    sample(20, 2000, 2, 4000, { observedAt: '2026-08-25T02:00:00.000Z', unsettled: true }),
    sample(30, 3500, 3.5, 7000, { observedAt: '2026-08-25T03:00:00.000Z' })
  ]);
  assert.equal(unsettled.observedCycleTokens, 1500);
  assert.notEqual(unsettled.observedCycleTokens, 2500);
});

