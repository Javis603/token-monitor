'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDevices } = require('../../src/shared/usage');
const { buildSyncPayload } = require('../../src/shared/syncPayload');
const { composeLocalOnlySummary, composeLocalSyncSummary, completeLocalSyncStats, projectLocalActivity } = require('../../src/electron/syncDisplayStats');

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function record(id, total = 10) {
  const period = () => ({ totalTokens: total, sessions: {
    'claude:one': { client: 'claude', sessionId: 'one', totalTokens: total, title: 'Original title',
      promptCache: { observedAt: '2026-10-24T00:00:00Z', ttlSeconds: 300 },
      models: { model: total }, modelCosts: { model: 0.1 }, providers: { anthropic: total }, costUsd: 0.1,
      lastUsedAt: '2026-10-24T00:00:00Z', liveActivity: { state: 'running', observedAt: '2026-10-24T00:00:00Z' } }
  } });
  return freeze({ deviceId: id, updatedAt: '2026-10-24T00:00:00Z', today: period(), month: period(), allTime: period() });
}
for (const mode of ['local', 'sync']) test(`plugin source completion retains old ${mode} accounting and activity snapshots`, t => {
  const clock = Date.parse('2026-10-24T00:00:01Z');
  t.mock.method(Date, 'now', () => clock);
  const firstRecord = record('local');
  const remote = freeze(aggregateDevices([buildSyncPayload(record('remote', 3))], 0, clock));
  const compose = local => mode === 'local' ? composeLocalOnlySummary(local, stats => stats, { nowMs: clock })
    : composeLocalSyncSummary(remote, local, { nowMs: clock });
  const first = compose(firstRecord);
  const complete = completeLocalSyncStats(first);
  const before = JSON.stringify(complete);
  const oldDevices = JSON.stringify(complete.devices);
  freeze(complete);
  const updated = projectLocalActivity(first, { observations: [{ client: 'claude', sessionId: 'one',
    liveActivity: { state: 'waiting', observedAt: '2026-10-24T00:00:01Z' } }] }, clock);
  const updatedComplete = completeLocalSyncStats(updated);
  assert.equal(updatedComplete.periods.allTime.sessions['claude:one'].liveActivity.state, 'waiting');
  assert.equal(complete.periods.allTime.sessions['claude:one'].liveActivity.state, 'running');
  const replacement = structuredClone(firstRecord);
  for (const name of ['today', 'month', 'allTime']) {
    replacement[name].totalTokens = 20;
    Object.assign(replacement[name].sessions['claude:one'], { totalTokens: 20, title: 'New title', models: { other: 20 } });
  }
  const next = completeLocalSyncStats(compose(freeze(replacement)));
  assert.equal(next.periods.allTime.sessions['claude:one'].totalTokens, 20);
  assert.equal(next.periods.allTime.sessions['claude:one'].title, 'New title');
  assert.equal(JSON.stringify(completeLocalSyncStats(first)), before, 'old completion and nested session content stay unchanged');
  assert.equal(JSON.stringify(complete.devices), oldDevices, 'source provenance and metadata are unchanged');
  assert.equal(firstRecord.allTime.sessions['claude:one'].models.model, 10);
});
