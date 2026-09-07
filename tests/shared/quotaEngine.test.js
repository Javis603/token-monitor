'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const engine = require('../../src/shared/quotaEngine');

const RESET = '2026-09-01T00:00:00.000Z';
const OLD_RESET = '2026-08-25T00:00:00.000Z';
const SECRETS = [
  'user@example.com',
  'session=secret-cookie',
  'sk-live-secret',
  'C:\\\\Users\\\\me\\\\.codex\\\\auth.json',
  'hello from chat body',
  'sha256:raw-account-key'
];

function sample(provider, profileId, percent, tokens, usd, extra = {}) {
  const { at, kind = 'weekly', ...rest } = extra;
  const minutes = kind === 'session' ? 300 : 10080;
  return {
    observedAt: at || `2026-08-25T00:${String(Math.min(percent, 59)).padStart(2, '0')}:00.000Z`,
    provider,
    profileId,
    kind,
    limitId: kind,
    windowMinutes: minutes,
    resetsAt: RESET,
    segmentId: `${profileId}-${kind}`,
    usedPercent: percent,
    observedTotalTokens: tokens,
    pricedTokens: tokens,
    unpricedTokens: 0,
    apiEquivalentCostUsd: usd,
    pricingCoverage: 1,
    snapshotId: 'public-api-v1',
    scopeVersion: 'scope-v1',
    sampleId: `${profileId}-${kind}-${percent}`,
    ...rest
  };
}

function observationFrom(row, extra = {}) {
  return {
    observedAt: row.observedAt,
    provider: row.provider,
    profileId: row.profileId,
    kind: row.kind,
    limitId: row.limitId,
    windowMinutes: row.windowMinutes,
    resetsAt: row.resetsAt,
    segmentId: row.segmentId,
    usedPercent: row.usedPercent,
    status: 'ok',
    source: 'oauth',
    ...extra
  };
}

function composeWithLowLevelEngine({ provider, profileId, observations, accountingSamples }) {
  const capacityEstimates = engine.estimateRateLimitCapacities(accountingSamples, profileId);
  const latestWindows = new Map();
  for (const row of observations) {
    latestWindows.set(`${row.kind || ''}|${row.limitId || ''}`, row);
  }
  const profileSamples = accountingSamples.filter((row) => row.profileId === profileId);
  const accountQuotaSummaries = [...latestWindows.values()].map((window) => engine.buildAccountQuotaSummary({
    provider,
    profileId,
    window,
    samples: profileSamples,
    estimates: capacityEstimates
  }));
  return { capacityEstimates, accountQuotaSummaries };
}

function assertIdentity(summary) {
  if (summary.estimatedCapacity === null) return;
  assert.equal(summary.derivedConsumed + summary.derivedRemaining, summary.estimatedCapacity);
  assert.equal(summary.derivedConsumed, summary.estimatedCapacity * summary.officialUsedPercent / 100);
}

test('profile snapshot matches the low-level engine composition', () => {
  const accountingSamples = [
    sample('codex', 'codex-default', 10, 1000, 1),
    sample('codex', 'codex-default', 40, 4000, 4),
    sample('codex', 'codex-secondary', 20, 2000, 8, { at: '2026-08-25T00:20:00.000Z' })
  ];
  const observations = accountingSamples.map((row) => observationFrom(row));
  const input = {
    provider: 'codex',
    profileId: 'codex-default',
    observations: observations.filter((row) => row.profileId === 'codex-default'),
    accountingSamples
  };
  const snapshot = engine.buildProfileQuotaSnapshot(input);
  const composed = composeWithLowLevelEngine(input);
  assert.deepEqual(snapshot.capacityEstimates, composed.capacityEstimates);
  assert.deepEqual(snapshot.accountQuotaSummaries, composed.accountQuotaSummaries);
  assert.equal(snapshot.engineVersion, engine.QUOTA_ENGINE_VERSION);
  assert.equal(snapshot.contractVersion, engine.QUOTA_CONTRACT_VERSION);
});

test('multiple Codex profiles compute through the same facade without crossing accounts', () => {
  const rows = [
    sample('codex', 'codex-default', 10, 1000, 1, { snapshotId: 'openai-v1' }),
    sample('codex', 'codex-default', 30, 3000, 3, { snapshotId: 'openai-v1', at: '2026-08-25T00:30:00.000Z' }),
    sample('codex', 'codex-secondary', 10, 2000, 4, { snapshotId: 'openai-alt-v1' }),
    sample('codex', 'codex-secondary', 50, 10000, 20, { snapshotId: 'openai-alt-v1', at: '2026-08-25T00:50:00.000Z' }),
    sample('codex', 'codex-primary', 10, 800, 2, { snapshotId: 'openai-v1' }),
    sample('codex', 'codex-primary', 40, 3200, 8, { snapshotId: 'openai-v1', at: '2026-08-25T00:40:00.000Z' }),
    sample('codex', 'codex-other', 15, 400, 1, { snapshotId: 'openai-v1', at: '2026-08-25T00:15:00.000Z' }),
    sample('codex', 'codex-other', 25, 800, 2, { snapshotId: 'openai-v1', at: '2026-08-25T00:25:00.000Z' }),
    sample('codex', 'codex-primary', 10, 100, 2, {
      kind: 'session', snapshotId: 'openai-v1', at: '2026-08-25T01:10:00.000Z'
    }),
    sample('codex', 'codex-primary', 20, 200, 4, {
      kind: 'session', snapshotId: 'openai-v1', at: '2026-08-25T01:20:00.000Z'
    })
  ];
  const snapshots = [
    ['codex', 'codex-default'],
    ['codex', 'codex-secondary'],
    ['codex', 'codex-primary'],
    ['codex', 'codex-other']
  ].map(([provider, profileId]) => engine.buildProfileQuotaSnapshot({
    provider,
    profileId,
    observations: rows.filter((row) => row.profileId === profileId).map((row) => observationFrom(row)),
    accountingSamples: rows
  }));
  const [codex, secondary, primary, other] = snapshots;
  const weekly = (snapshot) => snapshot.accountQuotaSummaries.find((row) => row.windowKind === 'weekly');
  assert.equal(weekly(codex).locallyObservedApiEquivalent, 2);
  assert.equal(weekly(secondary).locallyObservedApiEquivalent, 16);
  assert.equal(weekly(primary).locallyObservedApiEquivalent, 6);
  assert.equal(weekly(other).locallyObservedApiEquivalent, 1);
  assert.equal(primary.accountQuotaSummaries.find((row) => row.windowKind === 'session').locallyObservedApiEquivalent, 2);
  assert.equal(weekly(codex).provider, 'codex');
  assert.equal(weekly(secondary).provider, 'codex');
  assert.equal(weekly(primary).profileId, 'codex-primary');
  assert.equal(weekly(other).profileId, 'codex-other');
  assert.notEqual(weekly(primary).locallyObservedApiEquivalent, weekly(other).locallyObservedApiEquivalent);
  assert.equal(codex.capacityEstimates.every((row) => row.profileId === 'codex-default'), true);
  assert.equal(secondary.capacityEstimates.every((row) => row.profileId === 'codex-secondary'), true);
});

test('reset jitter stays in-cycle while a successor reset and percent rollback keep current isolation', () => {
  const drifted = '2026-09-01T00:01:30.000Z';
  const successor = '2026-09-08T00:00:00.000Z';
  assert.equal(engine.resetTimesClose(RESET, drifted), true);
  assert.equal(engine.sameQuotaCycle(
    { provider: 'codex', profileId: 'codex-default', kind: 'weekly', resetsAt: RESET },
    { provider: 'codex', profileId: 'codex-default', kind: 'weekly', resetsAt: drifted }
  ), true);
  assert.equal(engine.sameQuotaCycle(
    { provider: 'codex', profileId: 'codex-default', kind: 'weekly', resetsAt: RESET },
    { provider: 'codex', profileId: 'codex-default', kind: 'weekly', resetsAt: successor }
  ), false);
  assert.equal(engine.isSuccessorQuotaCycle(
    { resetsAt: RESET, usedPercent: 40, observedAt: '2026-08-31T23:59:00.000Z' },
    { resetsAt: successor, usedPercent: 0, observedAt: '2026-09-01T00:05:00.000Z' }
  ), true);

  const history = [
    sample('codex', 'codex-default', 0, 0, 0, {
      at: '2026-08-20T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old'
    }),
    sample('codex', 'codex-default', 100, 10000, 100, {
      at: '2026-08-24T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old'
    })
  ];
  const current = [
    sample('codex', 'codex-default', 10, 1000, 10, { at: '2026-08-25T01:00:00.000Z', segmentId: 'new' }),
    sample('codex', 'codex-default', 40, 4000, 40, { at: '2026-08-25T02:00:00.000Z', segmentId: 'new' })
  ];
  const rolled = [
    sample('codex', 'codex-default', 80, 8000, 80, { at: '2026-08-25T03:00:00.000Z', segmentId: 'run-a' }),
    sample('codex', 'codex-default', 20, 2000, 20, { at: '2026-08-25T04:00:00.000Z', segmentId: 'run-b' }),
    sample('codex', 'codex-default', 30, 3000, 30, { at: '2026-08-25T05:00:00.000Z', segmentId: 'run-b' })
  ];
  const successorSnapshot = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(current[1])],
    accountingSamples: [...history, ...current]
  });
  const weekly = successorSnapshot.accountQuotaSummaries[0];
  assert.equal(weekly.locallyObservedApiEquivalent, 30);
  assert.notEqual(weekly.locallyObservedApiEquivalent, 100);
  assert.equal(weekly.resetAt, RESET);

  const rollbackSnapshot = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(rolled[2])],
    accountingSamples: rolled
  });
  const rollbackWeekly = rollbackSnapshot.accountQuotaSummaries[0];
  assert.equal(rollbackWeekly.locallyObservedApiEquivalent, 10);
  assert.ok(rollbackWeekly.reasons.includes('cycle-percent-rollback'));
  assert.notEqual(rollbackWeekly.basis, 'current-full-cycle');
});

test('unknown models, unpriced cacheWrite categories, and pricing identity changes fail closed', () => {
  const pricedUnknown = engine.priceTokenComponents({
    totalTokens: 20,
    models: { 'not-a-real-model': 20 },
    tokenComponents: { 'not-a-real-model': { input: 20, complete: true } }
  }, { provider: 'codex', snapshot: engine.DEFAULT_API_PRICING_SNAPSHOT });
  assert.equal(pricedUnknown.pricedTokens, 0);
  assert.equal(pricedUnknown.unpricedTokens, 20);

  // A model with no cacheWrite column ("-" in the official table) keeps that
  // category unpriced instead of borrowing another category's rate.
  const cacheWrite = engine.priceTokenComponents({
    totalTokens: 1000,
    models: { 'gpt-5.3-codex': 1000 },
    tokenComponents: { 'gpt-5.3-codex': { cacheWrite: 1000 } }
  }, { provider: 'codex', snapshot: engine.DEFAULT_API_PRICING_SNAPSHOT });
  assert.equal(cacheWrite.pricedTokens, 0);
  assert.equal(cacheWrite.unpricedTokens, 1000);
  assert.equal(cacheWrite.lineItems.find((row) => row.reason === 'category-unpriced').amountUsd, null);

  const rows = [
    sample('codex', 'codex-default', 10, 1000, 1, { snapshotId: 'openai-v1', at: '2026-08-25T00:10:00.000Z' }),
    sample('codex', 'codex-default', 40, 4000, 4, { snapshotId: 'openai-v2', at: '2026-08-25T00:40:00.000Z' })
  ];
  const snapshot = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(rows[1])],
    accountingSamples: rows
  });
  const weekly = snapshot.accountQuotaSummaries[0];
  const estimate = snapshot.capacityEstimates.find((row) => row.kind === 'weekly');
  assert.equal(estimate.apiEquivalentUsd.available, false);
  assert.equal(estimate.apiEquivalentUsd.reason, 'pricing-identity-changed');
  assert.equal(weekly.locallyObservedApiEquivalent, null);
});

test('derived amounts keep the capacity identity and unavailable states fail closed', () => {
  for (const percent of [0, 37.5, 100]) {
    const derived = engine.deriveQuotaAmounts(80, percent);
    assert.equal(derived.available, true);
    assert.equal(derived.consumed + derived.remaining, derived.capacity);
    assert.equal(derived.consumed, 80 * percent / 100);
  }
  assert.equal(engine.deriveQuotaAmounts(0, 20).reason, 'invalid-capacity');
  assert.equal(engine.deriveQuotaAmounts(-4, 20).reason, 'invalid-capacity');
  assert.equal(engine.deriveQuotaAmounts(Number.NaN, 20).reason, 'invalid-capacity');
  assert.equal(engine.deriveQuotaAmounts(80, 101).reason, 'invalid-official-percent');
  assert.equal(engine.deriveQuotaAmounts(80, -1).reason, 'invalid-official-percent');

  const rows = [
    sample('codex', 'codex-default', 10, 1000, 1, { at: '2026-08-25T00:10:00.000Z' }),
    sample('codex', 'codex-default', 40, 4000, 4, { at: '2026-08-25T00:40:00.000Z' })
  ];
  const mid = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(rows[1])],
    accountingSamples: rows
  }).accountQuotaSummaries[0];
  assertIdentity(mid);
  assert.equal(mid.officialUsedPercent, 40);

  const invalid = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(rows[1], { usedPercent: 140 })],
    accountingSamples: rows
  }).accountQuotaSummaries[0];
  assert.equal(invalid.estimatedCapacity, null);
  assert.ok(invalid.reasons.includes('invalid-official-percent'));

  const overflowRows = [
    sample('codex', 'codex-default', 0, 0, 0, {
      at: '2026-08-18T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old'
    }),
    sample('codex', 'codex-default', 100, 1000, 10, {
      at: '2026-08-24T00:00:00.000Z', resetsAt: OLD_RESET, segmentId: 'old'
    }),
    sample('codex', 'codex-default', 10, 1000, 1, { at: '2026-08-25T00:10:00.000Z', segmentId: 'new' }),
    sample('codex', 'codex-default', 40, 50000, 80, { at: '2026-08-25T00:40:00.000Z', segmentId: 'new' })
  ];
  const overflow = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [observationFrom(overflowRows[3], { usedPercent: 40 })],
    accountingSamples: overflowRows
  }).accountQuotaSummaries[0];
  assert.equal(overflow.locallyObservedApiEquivalent, 79);
  assert.equal(overflow.estimatedCapacity, null);
  assert.ok(overflow.reasons.includes('observed-exceeds-capacity'));
});

test('engine snapshot drops raw identity and credentials from contract inputs', () => {
  const rows = [
    sample('codex', 'codex-default', 10, 1000, 1, {
      email: SECRETS[0],
      cookie: SECRETS[1],
      token: SECRETS[2],
      authPath: SECRETS[3],
      message: SECRETS[4],
      accountKey: SECRETS[5]
    }),
    sample('codex', 'codex-default', 40, 4000, 4, {
      at: '2026-08-25T00:40:00.000Z',
      email: SECRETS[0],
      accountKey: SECRETS[5]
    })
  ];
  const snapshot = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: rows.map((row) => observationFrom(row, {
      email: SECRETS[0],
      cookie: SECRETS[1],
      token: SECRETS[2],
      authPath: SECRETS[3],
      message: SECRETS[4],
      accountKey: SECRETS[5]
    })),
    accountingSamples: rows
  });
  const snapshotText = JSON.stringify(snapshot);
  for (const secret of SECRETS) assert.equal(snapshotText.includes(secret), false, secret);
  assert.equal(snapshot.accountQuotaSummaries[0].officialUsedPercent, 40);
  assert.equal(snapshot.accountQuotaSummaries[0].locallyObservedApiEquivalent, 3);
});

test('latest window observation is max parseable observedAt, not array order', () => {
  const early = observationFrom(sample('codex', 'codex-default', 10, 1000, 10, {
    at: '2026-08-25T01:00:00.000Z'
  }));
  const late = observationFrom(sample('codex', 'codex-default', 40, 4000, 40, {
    at: '2026-08-25T03:00:00.000Z'
  }));
  const invalid = { ...late, observedAt: 'not-a-date', usedPercent: 99 };
  const reversed = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [late, invalid, early],
    accountingSamples: []
  });
  assert.equal(reversed.accountQuotaSummaries[0].officialUsedPercent, 40);
  const none = engine.buildProfileQuotaSnapshot({
    provider: 'codex',
    profileId: 'codex-default',
    observations: [invalid, { ...early, observedAt: 'also-bad' }],
    accountingSamples: []
  });
  assert.equal(none.accountQuotaSummaries.length, 0);
});

test('cycleSegmentId strips only a trailing binding suffix from production ids', () => {
  const production = 'sha256:abcdef0123456789|session|2026-09-05T12:00:00.000Z|snap-1';
  assert.equal(engine.cycleSegmentId({ segmentId: `${production}|binding-one` }), production);
  assert.equal(engine.cycleSegmentId({ segmentId: production }), production);
  assert.notEqual(
    engine.cycleSegmentId({ segmentId: production }),
    engine.cycleSegmentId({
      segmentId: 'sha256:abcdef0123456789|session|2026-09-05T17:00:00.000Z|snap-1'
    })
  );
});
