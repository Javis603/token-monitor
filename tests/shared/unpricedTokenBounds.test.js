'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizePeriod } = require('../../src/shared/usage');
const { applyArchivedClientUsage, normalizeArchivedClientUsage } = require('../../src/shared/clientUsageArchive');

test('normalizePeriod bounds normalized unpriced attribution to its usage buckets', () => {
  const period = normalizePeriod({
    totalTokens: 10,
    costUsd: 2.5,
    unpricedTokens: 99,
    clients: { 'Qoder CN': 3, qodercn: 4 },
    clientUnpricedTokens: { ' Qoder CN ': 5, qodercn: 5, ' qodercn ': -1, orphan: 7, nan: 'x' },
    models: { ' Model-A ': 2, 'model-a': 3 },
    modelUnpricedTokens: { 'MODEL-A': 4, ' model-a ': 4, ' MODEL-A ': -1, orphan: 2 },
    clientModels: { 'Qoder CN': { 'Model-A': 2 }, qodercn: { ' model-a ': 3 } },
    clientModelUnpricedTokens: { ' Qoder CN ': { 'MODEL-A': 4 }, qodercn: { 'model-a': 4, ' MODEL-A ': -1, orphan: 1 } }
  });

  assert.equal(period.totalTokens, 10);
  assert.equal(period.costUsd, 2.5);
  assert.equal(period.unpricedTokens, 10);
  assert.deepEqual(period.clients, { qodercn: 7 });
  assert.deepEqual(period.clientUnpricedTokens, { qodercn: 7 });
  assert.deepEqual(period.models, { 'model-a': 5 });
  assert.deepEqual(period.modelUnpricedTokens, { 'model-a': 5 });
  assert.deepEqual(period.clientModels, { qodercn: { 'model-a': 5 } });
  assert.deepEqual(period.clientModelUnpricedTokens, { qodercn: { 'model-a': 5 } });
});

test('archive normalization clamps unpriced totals and models before replay', () => {
  const archive = normalizeArchivedClientUsage({ clients: { qodercn: {
    client: 'qodercn', capturedAt: '2026-09-19T00:00:00.000Z', day: '2026-09-19', month: '2026-09',
    periods: { allTime: {
      totalTokens: 6, costUsd: 1.25, unpricedTokens: 99,
      models: { ' M ': 2, M: 1, m: 4 },
      modelUnpricedTokens: { ' M ': 5, M: 5, m: 5, orphan: 1 }
    } }
  } } });
  const usage = archive.clients.qodercn.periods.allTime;
  assert.equal(usage.unpricedTokens, 6);
  assert.deepEqual(usage.models, { M: 3, m: 4 });
  assert.deepEqual(usage.modelUnpricedTokens, { M: 3, m: 4 });

  const restored = applyArchivedClientUsage({ allTime: normalizePeriod({ totalTokens: 0 }) }, archive, {
    activeClients: '', now: new Date('2026-09-19T01:00:00.000Z')
  });
  assert.equal(restored.allTime.unpricedTokens, 6);
  assert.deepEqual(restored.allTime.clientUnpricedTokens, { qodercn: 6 });
  assert.deepEqual(restored.allTime.clientModelUnpricedTokens, { qodercn: { M: 3, m: 4 } });
});

test('valid zero and partial unpriced records keep their established semantics', () => {
  const zero = normalizePeriod({ totalTokens: 5, unpricedTokens: 0, clients: { qodercn: 5 }, clientUnpricedTokens: { qodercn: 0 } });
  const partial = normalizePeriod({ totalTokens: 5, unpricedTokens: 2, clients: { qodercn: 5 }, clientUnpricedTokens: { qodercn: 2 } });
  assert.equal(zero.unpricedTokens, 0);
  assert.deepEqual(zero.clientUnpricedTokens, {});
  assert.equal(partial.unpricedTokens, 2);
  assert.deepEqual(partial.clientUnpricedTokens, { qodercn: 2 });
});
