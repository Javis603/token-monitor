'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  emptyState,
  extractCodexWeeklyObservation,
  observeCodexWeeklyQuota,
  officialCodexUsage
} = require('../../src/shared/codexWeeklyQuotaEstimate');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function observation(overrides = {}) {
  return {
    accountKey: 'account-a',
    resetAt: '2026-08-17T00:00:00.000Z',
    observedAt: '2026-08-12T00:00:00.000Z',
    usedPercent: 30,
    costUsd: 10,
    rawCostUsd: 10,
    tokens: 1_000_000,
    ...overrides
  };
}

function observeSeries(rows, options = {}) {
  let result = { state: emptyState() };
  rows.forEach((row, index) => {
    result = observeCodexWeeklyQuota(result.state, observation({
      observedAt: new Date(Date.UTC(2026, 7, 12, index)).toISOString(),
      ...row
    }), options);
  });
  return result;
}

function activeCycle(result, accountKey = 'account-a') {
  const account = result.state.accounts[accountKey];
  return account.cycles.find((cycle) => cycle.id === account.currentCycleId);
}

test('first boundary is an anchor and three later unit jumps publish the mean', () => {
  const result = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000_000 },
    { usedPercent: 31, costUsd: 10.1, tokens: 1_100_000 },
    { usedPercent: 32, costUsd: 11.3, tokens: 2_300_000 },
    { usedPercent: 33, costUsd: 12.4, tokens: 3_400_000 },
    { usedPercent: 34, costUsd: 13.7, tokens: 4_700_000 }
  ]);
  const cycle = activeCycle(result);
  assert.deepEqual(cycle.samples.map((sample) => sample.status), ['anchor', 'valid', 'valid', 'valid']);
  assert.equal(result.estimate.status, 'ready');
  assert.equal(result.estimate.sampleCount, 3);
  assert.equal(result.estimate.spanPercent, 3);
  assert.ok(Math.abs(result.estimate.estimatedUsd - 120) < 0.000001);
});

test('device usage accumulates while the same account is active even before a percent jump', () => {
  const result = observeSeries([
    { usedPercent: 55, costUsd: 10, rawCostUsd: 10, tokens: 1_000 },
    { usedPercent: 55, costUsd: 11.25, rawCostUsd: 11.25, tokens: 2_000 },
    { usedPercent: 56, costUsd: 12.5, rawCostUsd: 12.5, tokens: 3_000 }
  ]);
  assert.equal(result.estimate.status, 'collecting');
  assert.equal(result.estimate.deviceObservedCostUsd, 2.5);
  assert.equal(result.estimate.deviceObservedTokens, 2_000);
  assert.equal(result.estimate.deviceObservedPercent, 1);
  assert.equal(result.estimate.observedFromZero, false);
});

test('device usage excludes account-switch gaps and restarts from zero after quota reset', () => {
  let result = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000 },
    { usedPercent: 30, costUsd: 11, tokens: 2_000 }
  ]);
  assert.equal(result.estimate.deviceObservedCostUsd, 1);
  result = observeCodexWeeklyQuota(result.state, observation({
    accountKey: 'account-b', costUsd: 20, tokens: 3_000,
    observedAt: '2026-08-12T03:00:00.000Z'
  }));
  result = observeCodexWeeklyQuota(result.state, observation({
    accountKey: 'account-a', costUsd: 25, tokens: 4_000,
    observedAt: '2026-08-12T04:00:00.000Z'
  }));
  assert.equal(result.estimate.deviceObservedCostUsd, 1);
  result = observeCodexWeeklyQuota(result.state, observation({
    accountKey: 'account-a', resetAt: '2026-08-24T00:00:00.000Z', usedPercent: 0,
    costUsd: 26, tokens: 5_000, observedAt: '2026-08-17T00:00:00.000Z'
  }));
  assert.equal(result.estimate.deviceObservedCostUsd, 0);
  assert.equal(result.estimate.observedFromZero, true);
});

test('100 to 99 remaining is recorded as an anchor but never estimated', () => {
  const result = observeSeries([
    { usedPercent: 0, costUsd: 20, tokens: 2_000_000 },
    { usedPercent: 1, costUsd: 20.001, tokens: 2_000_001 }
  ]);
  const sample = activeCycle(result).samples[0];
  assert.equal(sample.status, 'anchor');
  assert.equal(sample.reason, 'initialRoundedBucket');
  assert.equal(sample.beforeRemainingPercent, 100);
  assert.equal(sample.afterRemainingPercent, 99);
  assert.equal(result.estimate.sampleCount, 0);
});

test('a multi-percent jump is rejected, saved, and becomes the next anchor', () => {
  const result = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000_000 },
    { usedPercent: 31, costUsd: 10.1, tokens: 1_100_000 },
    { usedPercent: 40, costUsd: 15, tokens: 6_000_000 },
    { usedPercent: 41, costUsd: 16.2, tokens: 7_200_000 }
  ], { minSampleCount: 1 });
  const cycle = activeCycle(result);
  assert.deepEqual(cycle.samples.map((sample) => sample.status), ['anchor', 'rejected', 'valid']);
  assert.equal(cycle.samples[1].reason, 'nonUnitPercentJump');
  assert.equal(cycle.samples[1].percentDelta, 9);
  assert.equal(cycle.samples[2].beforeRemainingPercent, 60);
  assert.equal(cycle.samples[2].afterRemainingPercent, 59);
  assert.ok(Math.abs(result.estimate.estimatedUsd - 120) < 0.000001);
});

test('a reset is retained in the old cycle and starts an independent cycle', () => {
  const before = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000_000 },
    { usedPercent: 31, costUsd: 10.1, tokens: 1_100_000 }
  ]);
  const reset = observeCodexWeeklyQuota(before.state, observation({
    resetAt: '2026-08-24T00:00:00.000Z',
    observedAt: '2026-08-17T00:00:01.000Z',
    usedPercent: 0,
    costUsd: 10.2,
    tokens: 1_200_000
  }));
  const account = reset.state.accounts['account-a'];
  assert.equal(account.cycles.length, 2);
  assert.equal(account.cycles[0].samples.at(-1).status, 'reset');
  assert.equal(reset.estimate.status, 'collecting');
  assert.equal(reset.estimate.sampleCount, 0);
});

test('switching away and back requires a fresh boundary before sampling', () => {
  let result = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000_000 },
    { usedPercent: 31, costUsd: 10.1, tokens: 1_100_000 },
    { usedPercent: 32, costUsd: 11.2, tokens: 2_200_000 }
  ], { minSampleCount: 1 });
  result = observeCodexWeeklyQuota(result.state, observation({
    accountKey: 'account-b', usedPercent: 10, costUsd: 12, tokens: 3_000_000,
    observedAt: '2026-08-12T04:00:00.000Z'
  }), { minSampleCount: 1 });
  result = observeCodexWeeklyQuota(result.state, observation({
    usedPercent: 35, costUsd: 12.1, tokens: 3_100_000,
    observedAt: '2026-08-12T05:00:00.000Z'
  }), { minSampleCount: 1 });
  result = observeCodexWeeklyQuota(result.state, observation({
    usedPercent: 36, costUsd: 12.2, tokens: 3_200_000,
    observedAt: '2026-08-12T06:00:00.000Z'
  }), { minSampleCount: 1 });
  assert.equal(activeCycle(result).samples.filter((sample) => sample.status === 'valid').length, 1);
  result = observeCodexWeeklyQuota(result.state, observation({
    usedPercent: 37, costUsd: 13.4, tokens: 4_400_000,
    observedAt: '2026-08-12T07:00:00.000Z'
  }), { minSampleCount: 1 });
  const samples = activeCycle(result).samples;
  assert.equal(samples.at(-1).status, 'valid');
  assert.ok(Math.abs(samples.at(-1).costDeltaUsd - 1.2) < 0.000001);
});

test('persisted sample fields contain account, cycle, percentages, costs, and tokens', () => {
  const result = observeSeries([
    { usedPercent: 30, costUsd: 10, tokens: 1_000_000 },
    { usedPercent: 31, costUsd: 10.1, tokens: 1_100_000 },
    { usedPercent: 32, costUsd: 11.3, tokens: 2_300_000 }
  ], { minSampleCount: 1 });
  const sample = activeCycle(result).samples.at(-1);
  for (const field of [
    'jumpObservedAt', 'accountKey', 'quotaCycleId', 'beforeRemainingPercent',
    'afterRemainingPercent', 'previousCostUsd', 'currentCostUsd', 'costDeltaUsd',
    'previousTokens', 'currentTokens', 'tokenDelta', 'status', 'reason'
  ]) assert.ok(Object.hasOwn(sample, field), field);
});

test('official usage includes only OpenAI Codex sessions and honors quota cost', () => {
  const usage = officialCodexUsage({ periods: { allTime: { sessions: {
    official: { client: 'codex', costUsd: 1, quotaCostUsd: 1.5, providers: { openai: 100 } },
    relay: { client: 'codex', costUsd: 9, providers: { relay: 900 } },
    claude: { client: 'claude', costUsd: 8, providers: { anthropic: 800 } }
  } } } });
  assert.deepEqual(usage, { costUsd: 1.5, rawCostUsd: 1, tokens: 100, reason: null });
});

test('official usage accepts the root allTime shape emitted by local device records', () => {
  const usage = officialCodexUsage({ allTime: { sessions: {
    official: { client: 'codex', costUsd: 1.2, quotaCostUsd: 2.4, providers: { openai: 1234 } }
  } } });
  assert.deepEqual(usage, { costUsd: 2.4, rawCostUsd: 1.2, tokens: 1234, reason: null });
});

test('tokscale quota cost survives extraction and session normalization', () => {
  const period = extractUsageFromTokscale({ entries: [{
    client: 'codex', provider: 'openai', sessionId: 'session-1', model: 'gpt-5.6-sol',
    input: 100, cost: 1, quotaCostUsd: 2.5
  }] });
  assert.equal(period.sessions['codex:session-1'].costUsd, 1);
  assert.equal(period.sessions['codex:session-1'].quotaCostUsd, 2.5);
});

test('extracts the local live Codex account and weekly observation', () => {
  const stats = {
    updatedAt: '2026-08-12T08:00:00.000Z',
    periods: { allTime: { sessions: {
      one: { client: 'codex', costUsd: 1.2, providers: { openai: 1_000_000 } }
    } } },
    limits: { providers: [{
      provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'account-a',
      windows: [{ kind: 'weekly', usedPercent: 42, resetsAt: '2026-08-17T00:00:00Z' }]
    }] }
  };
  const result = extractCodexWeeklyObservation(stats);
  assert.equal(result.observation.accountKey, 'account-a');
  assert.equal(result.observation.usedPercent, 42);
  assert.equal(result.observation.costUsd, 1.2);
});
