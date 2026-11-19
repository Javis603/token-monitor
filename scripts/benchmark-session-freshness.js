#!/usr/bin/env node
'use strict';

// Local deterministic replay, not a production traffic capture. Count the exact
// UTF-8 SSE frames used by both runtimes, before any HTTP/TLS compression.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const baseline = process.argv[2] || 'fd494149c';
const start = Date.parse('2026-10-27T10:00:00.000Z');
const clock = start + 300_000;
const iso = ms => new Date(ms).toISOString();
const rowsPerPeriod = 500;
const deviceCount = 4;
const rounds = 30;
const results = [];

function oldProtocol(file) {
  const source = execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' });
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context, { filename: file });
  return context.module.exports;
}

function record(deviceIndex, round, changes, usage) {
  const at = iso(start + round * 10_000);
  const periods = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, {
    totalTokens: rowsPerPeriod * 1000 + (deviceIndex === 0 ? changes : 0),
    sessions: Object.fromEntries(Array.from({ length: rowsPerPeriod }, (_, i) => [`codex:d${deviceIndex}-s${i}`, {
      client: 'codex', sessionId: `d${deviceIndex}-s${i}`,
      totalTokens: 1000 + (deviceIndex === 0 && i === 0 ? changes : 0),
      inputTokens: 700, outputTokens: 300, costUsd: 0.01,
      lastUsedAt: iso(start), turnEnded: true,
      ...(i < 2 ? { liveActivity: { state: 'waiting', observedAt: at } } : {})
    }]))
  }]));
  return usage.mergeDeviceRecord(null, { deviceId: `device-${deviceIndex}`, updatedAt: at, receivedAt: at, periods });
}

function statsFor(round, changes, usage) {
  const stats = usage.aggregateDevices(Array.from({ length: deviceCount }, (_, i) => record(i, round, changes, usage)), 600000, clock);
  return { ...stats, updatedAt: iso(start + round * 10_000), staleAfterMs: 600000 };
}

for (const [runtime, prefix] of [['Node Hub', 'src'], ['Worker', 'worker/src']]) {
  const after = require(path.join(root, prefix, 'shared/hubProtocol'));
  const before = oldProtocol(`${prefix}/shared/hubProtocol.js`);
  const usage = require(path.join(root, prefix, 'shared/usage'));
  for (const scenario of ['renewal-only', 'mixed', 'v2-client']) {
    const initial = statsFor(0, 0, usage);
    let beforeKey = before.hubStatsContentKey(initial);
    let afterKey = after.hubStatsContentKey(initial);
    let reconstructed = initial;
    const row = { runtime, scenario, updates: rounds, beforeBytes: 0, afterBytes: 0, beforeStats: 0, afterStats: 0, afterFreshness: 0 };
    row.initialSnapshotBytes = Buffer.byteLength(after.encodeSseEvent('snapshot', { type: 'stats', reason: 'snapshot', stats: initial, at: iso(start) }));
    for (let round = 1; round <= rounds; round++) {
      const current = statsFor(round, scenario === 'mixed' ? Math.floor(round / 6) : 0, usage);
      const input = { stats: current, reason: 'ingest', at: iso(start + round * 10_000), hasFreshnessClients: true };
      const oldFrames = before.prepareSseFanout({ ...input, lastContentKey: beforeKey });
      const newFrames = after.prepareSseFanout({ ...input, lastContentKey: afterKey,
        hasFreshnessClients: scenario !== 'v2-client', hasLegacyClients: scenario === 'v2-client' });
      const oldFrame = before.sseFrameForClient(oldFrames, { freshnessEvents: true });
      const newFrame = after.sseFrameForClient(newFrames, { freshnessEvents: scenario !== 'v2-client' });
      const event = JSON.parse(newFrame.split('data: ')[1]);
      reconstructed = event.type === 'freshness' ? after.applyFreshnessEvent(reconstructed, event) : event.stats;
      assert.deepEqual(JSON.parse(JSON.stringify(reconstructed)), JSON.parse(JSON.stringify(current)), `${runtime}/${scenario}/${round}: replay differs from full snapshot`);
      row.beforeBytes += Buffer.byteLength(oldFrame);
      row.afterBytes += Buffer.byteLength(newFrame);
      row.beforeStats += Number(oldFrame.startsWith('event: stats'));
      row.afterStats += Number(event.type === 'stats');
      row.afterFreshness += Number(event.type === 'freshness');
      if (round === 1) { row.beforeFirstUpdateBytes = Buffer.byteLength(oldFrame); row.afterFirstUpdateBytes = Buffer.byteLength(newFrame); }
      beforeKey = oldFrames.contentKey;
      afterKey = newFrames.contentKey;
    }
    row.savedPercent = Number(((1 - row.afterBytes / row.beforeBytes) * 100).toFixed(4));
    results.push(row);
  }
}
for (let i = 0; i < 3; i++) assert.deepEqual({ ...results[i], runtime: '' }, { ...results[i + 3], runtime: '' });
console.log(JSON.stringify({ baseline, mode: 'local deterministic SSE encoder replay; no network compression',
  devices: deviceCount, sessionRowsPerDevicePerPeriod: rowsPerPeriod, liveSessionsPerDevice: 2,
  periods: 3, updates: rounds, intervalSeconds: 10, durationSeconds: 300,
  mixedUsageUpdates: 5, correctness: 'all reconstructed snapshots equal full snapshots; Node and Worker bytes identical', results }, null, 2));
