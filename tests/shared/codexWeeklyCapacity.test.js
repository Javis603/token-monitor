'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachCodexWeeklyCapacityEstimates,
  emptyCodexWeeklyCapacityArchive,
  observeCodexWeeklyCapacity,
  weeklyCapacityEstimateForProvider
} = require('../../src/shared/codexWeeklyCapacity');

function codexProvider(accountKey, usedPercent, resetsAt = '2026-09-05T00:00:00.000Z') {
  return {
    provider: 'codex',
    accountKey,
    status: 'ok',
    source: 'oauth',
    sourceDetail: 'live',
    windows: [{ kind: 'weekly', usedPercent, windowMinutes: 10080, resetsAt }]
  };
}

function device(accountKey, tokens, usedPercent, resetsAt) {
  return {
    periods: { allTime: { clients: { codex: tokens } } },
    limits: { providers: [codexProvider(accountKey, usedPercent, resetsAt)] }
  };
}

function observe(archive, record, minute) {
  return observeCodexWeeklyCapacity(archive, record, {
    nowMs: Date.parse('2026-08-29T00:00:00.000Z') + minute * 60_000
  }).archive;
}

test('estimates weekly capacity from account-attributed local token deltas', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10), 0);
  archive = observe(archive, device('account-a', 2_000, 20), 1);

  const preliminary = weeklyCapacityEstimateForProvider(archive, codexProvider('account-a', 20));
  assert.equal(preliminary.status, 'preliminary');
  assert.equal(preliminary.capacityTokens, 10_000);
  assert.equal(preliminary.sampleCount, 2);

  archive = observe(archive, device('account-a', 3_000, 30), 2);
  const stable = weeklyCapacityEstimateForProvider(archive, codexProvider('account-a', 30));
  assert.equal(stable.status, 'stable');
  assert.equal(stable.capacityTokens, 10_000);
  assert.equal(stable.rSquared, 1);
  assert.equal(stable.scope, 'local-device');
  assert.equal(stable.method, 'local-linear-estimate');
});

test('account switches start a new attribution segment instead of charging the inactive account', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10), 0);
  archive = observe(archive, device('account-a', 2_000, 20), 1);
  archive = observe(archive, device('account-b', 3_000, 5), 2);
  archive = observe(archive, device('account-b', 4_000, 15), 3);
  archive = observe(archive, device('account-a', 5_000, 30), 4);
  archive = observe(archive, device('account-a', 6_000, 40), 5);

  const accountA = archive.accounts.find((account) => account.accountKey === 'account-a');
  const accountB = archive.accounts.find((account) => account.accountKey === 'account-b');
  assert.equal(accountA.attributedTokens, 2_000);
  assert.equal(accountB.attributedTokens, 1_000);
  assert.equal(accountA.streams[0].segments.length, 2);
  assert.equal(weeklyCapacityEstimateForProvider(archive, codexProvider('account-a', 40)).capacityTokens, 10_000);
  assert.equal(weeklyCapacityEstimateForProvider(archive, codexProvider('account-b', 15)).capacityTokens, 10_000);
});

test('quota rollback and successor reset isolate the new weekly cycle', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 80, '2026-08-29T01:00:00.000Z'), 0);
  archive = observe(archive, device('account-a', 1_500, 85, '2026-08-29T01:00:00.000Z'), 1);
  archive = observe(archive, device('account-a', 2_000, 90, '2026-08-29T01:00:00.000Z'), 2);
  archive = observe(archive, device('account-a', 3_000, 5, '2026-09-05T01:00:00.000Z'), 3);

  const collecting = weeklyCapacityEstimateForProvider(
    archive,
    codexProvider('account-a', 5, '2026-09-05T01:00:00.000Z')
  );
  assert.equal(collecting.status, 'collecting');
  assert.equal(collecting.sampleCount, 1);

  archive = observe(archive, device('account-a', 3_500, 10, '2026-09-05T01:00:00.000Z'), 4);
  archive = observe(archive, device('account-a', 4_000, 15, '2026-09-05T01:00:00.000Z'), 5);
  const nextCycle = weeklyCapacityEstimateForProvider(
    archive,
    codexProvider('account-a', 15, '2026-09-05T01:00:00.000Z')
  );
  assert.equal(nextCycle.status, 'stable');
  assert.equal(nextCycle.capacityTokens, 10_000);
  assert.equal(nextCycle.previousCapacityTokens, 10_000);
  assert.equal(nextCycle.capacityChangePercent, 0);
});

test('missing quota percentages and token totals do not become zero-valued evidence', () => {
  const missingPercent = device('account-a', 1_000, null);
  let result = observeCodexWeeklyCapacity(emptyCodexWeeklyCapacityArchive(), missingPercent, {
    nowMs: Date.parse('2026-08-29T00:00:00.000Z')
  });
  assert.equal(result.archive.accounts[0].streams.length, 0);
  assert.equal(weeklyCapacityEstimateForProvider(result.archive, codexProvider('account-a', null)), null);

  const missingTokens = device('account-a', null, 10);
  result = observeCodexWeeklyCapacity(emptyCodexWeeklyCapacityArchive(), missingTokens, {
    nowMs: Date.parse('2026-08-29T00:00:00.000Z')
  });
  assert.equal(result.archive.accounts.length, 0);
});

test('a current provider reset never receives an estimate from an older cycle', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10, '2026-09-05T00:00:00.000Z'), 0);
  archive = observe(archive, device('account-a', 2_000, 20, '2026-09-05T00:00:00.000Z'), 1);
  assert.equal(
    weeklyCapacityEstimateForProvider(
      archive,
      codexProvider('account-a', 1, '2026-09-12T00:00:00.000Z')
    ),
    null
  );
});

test('same-percent usage refresh settles the current anchor without adding fake points', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10), 0);
  archive = observe(archive, device('account-a', 1_500, 10), 1);
  const segment = archive.accounts[0].streams[0].segments[0];
  assert.equal(segment.samples.length, 1);
  assert.equal(segment.samples[0].accountTokens, 500);
});

test('a percentage increase without local token growth fails closed', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10), 0);
  archive = observe(archive, device('account-a', 1_000, 20), 1);
  const estimate = weeklyCapacityEstimateForProvider(archive, codexProvider('account-a', 20));
  assert.equal(estimate.status, 'unavailable');
  assert.equal(estimate.reason, 'unattributed-usage');
  assert.equal(Object.hasOwn(estimate, 'capacityTokens'), false);
});

test('ambiguous live accounts and managed-only snapshots are not sampled', () => {
  const ambiguous = device('account-a', 1_000, 10);
  ambiguous.limits.providers.push(codexProvider('account-b', 20));
  let result = observeCodexWeeklyCapacity(emptyCodexWeeklyCapacityArchive(), ambiguous, { nowMs: 1_800_000_000_000 });
  assert.equal(result.archive.accounts.length, 0);

  const managed = device('account-a', 1_000, 10);
  managed.limits.providers[0].sourceDetail = 'managed';
  result = observeCodexWeeklyCapacity(emptyCodexWeeklyCapacityArchive(), managed, { nowMs: 1_800_000_000_000 });
  assert.equal(result.archive.accounts.length, 0);
});

test('presentation attaches only a redacted estimate to matching Codex rows', () => {
  let archive = emptyCodexWeeklyCapacityArchive();
  archive = observe(archive, device('account-a', 1_000, 10), 0);
  archive = observe(archive, device('account-a', 2_000, 20), 1);
  const provider = codexProvider('account-a', 20);
  const stats = {
    limits: { providers: [provider, { provider: 'claude', status: 'ok', windows: [] }] },
    devices: [{ deviceId: 'local', limits: { providers: [provider] } }]
  };

  const projected = attachCodexWeeklyCapacityEstimates(stats, archive, { localDeviceId: 'local' });
  const estimate = projected.limits.providers[0].weeklyCapacityEstimate;
  assert.equal(estimate.capacityTokens, 10_000);
  assert.equal(Object.hasOwn(estimate, 'accountKey'), false);
  assert.equal(Object.hasOwn(projected.limits.providers[1], 'weeklyCapacityEstimate'), false);
  assert.equal(projected.devices[0].limits.providers[0].weeklyCapacityEstimate.capacityTokens, 10_000);
});
