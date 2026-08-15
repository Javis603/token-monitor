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
    { usedPercent: 41, costUsd: 16.2, tokens: 7_200_000 },
    { usedPercent: 42, costUsd: 17.4, tokens: 8_400_000 }
  ], { minSampleCount: 1 });
  const cycle = activeCycle(result);
  assert.deepEqual(cycle.samples.map((sample) => sample.status), ['anchor', 'rejected', 'anchor', 'valid']);
  assert.equal(cycle.samples[1].reason, 'nonUnitPercentJump');
  assert.equal(cycle.samples[1].percentDelta, 9);
  assert.equal(cycle.samples[2].beforeRemainingPercent, 60);
  assert.equal(cycle.samples[2].afterRemainingPercent, 59);
  assert.equal(cycle.samples[3].beforeRemainingPercent, 59);
  assert.equal(cycle.samples[3].afterRemainingPercent, 58);
  assert.ok(Math.abs(result.estimate.estimatedUsd - 120) < 0.000001);
});

test('counter regressions stay in one segment and endpoint netting cancels the rebound', () => {
  const result = observeSeries([
    { usedPercent: 30, costUsd: 100, rawCostUsd: 100, tokens: 10_000 },
    { usedPercent: 31, costUsd: 100.1, rawCostUsd: 100.1, tokens: 10_100 },
    { usedPercent: 32, costUsd: 99.1, rawCostUsd: 99.1, tokens: 9_100 },
    { usedPercent: 33, costUsd: 102.5, rawCostUsd: 102.5, tokens: 12_500 },
    { usedPercent: 34, costUsd: 103.7, rawCostUsd: 103.7, tokens: 13_700 }
  ], { minSampleCount: 1 });
  const cycle = activeCycle(result);
  assert.equal(cycle.segments.length, 1);
  assert.equal(cycle.samples.filter((sample) => sample.status === 'anomaly').length, 1);
  assert.equal(cycle.samples.find((sample) => sample.status === 'anomaly').costDeltaUsd, -1);
  assert.equal(result.estimate.spanPercent, 3);
  assert.ok(Math.abs(result.estimate.observedCostUsd - 3.6) < 0.000001);
  assert.ok(Math.abs(result.estimate.estimatedUsd - 120) < 0.000001);
  assert.ok(Math.abs(result.estimate.deviceObservedCostUsd - 3.7) < 0.000001);
});

test('version 1 state migrates without losing its estimate or device usage', () => {
  const latest = observation({ usedPercent: 34, costUsd: 13.7, tokens: 4_700_000 });
  const oldState = {
    version: 1,
    activeAccountKey: 'account-a',
    accounts: {
      'account-a': {
        currentCycleId: 'old-cycle',
        cycles: [{
          id: 'old-cycle',
          resetAt: latest.resetAt,
          latest,
          observationStartedAt: latest.observedAt,
          observedFromZero: false,
          deviceObservedCostUsd: 3.7,
          deviceObservedRawCostUsd: 3.7,
          deviceObservedTokens: 3_700_000,
          deviceObservedPercent: 4,
          samples: [
            {
              jumpObservedAt: '2026-08-12T01:00:00.000Z', accountKey: 'account-a',
              quotaCycleId: 'old-cycle', beforeRemainingPercent: 69,
              afterRemainingPercent: 68, percentDelta: 1, previousCostUsd: 10.1,
              currentCostUsd: 11.3, costDeltaUsd: 1.2, previousTokens: 1_100_000,
              currentTokens: 2_300_000, tokenDelta: 1_200_000, status: 'valid', reason: ''
            },
            {
              jumpObservedAt: '2026-08-12T02:00:00.000Z', accountKey: 'account-a',
              quotaCycleId: 'old-cycle', beforeRemainingPercent: 68,
              afterRemainingPercent: 67, percentDelta: 1, previousCostUsd: 11.3,
              currentCostUsd: 12.4, costDeltaUsd: 1.1, previousTokens: 2_300_000,
              currentTokens: 3_400_000, tokenDelta: 1_100_000, status: 'valid', reason: ''
            }
          ]
        }]
      }
    }
  };
  const result = observeCodexWeeklyQuota(oldState, latest, { minSampleCount: 1 });
  assert.equal(result.state.version, 2);
  assert.ok(Math.abs(result.estimate.estimatedUsd - 115) < 0.000001);
  assert.equal(result.estimate.deviceObservedCostUsd, 3.7);
  assert.equal(result.estimate.deviceObservedTokens, 3_700_000);
});

test('persisted samples and segments stay within their per-cycle bounds', () => {
  const anomalyRows = [{ usedPercent: 30, costUsd: 1_000, tokens: 10_000 }];
  for (let index = 1; index <= 205; index += 1) {
    anomalyRows.push({ usedPercent: 30, costUsd: 1_000 - index, tokens: 10_000 - index });
  }
  const anomalyResult = observeSeries(anomalyRows);
  assert.equal(activeCycle(anomalyResult).samples.length, 200);

  const jumpRows = [{ usedPercent: 0, costUsd: 0, tokens: 0 }];
  for (let index = 1; index <= 40; index += 1) {
    jumpRows.push({ usedPercent: index * 2, costUsd: index, tokens: index * 1_000 });
  }
  const jumpResult = observeSeries(jumpRows);
  assert.ok(activeCycle(jumpResult).segments.length <= 32);
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
