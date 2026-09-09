#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const nodeHistory = require('../src/shared/history');
const nodeProtocol = require('../src/shared/hubProtocol');
const nodeUsage = require('../src/shared/usage');
const workerHistory = require('../worker/src/shared/history');
const workerProtocol = require('../worker/src/shared/hubProtocol');
const workerUsage = require('../worker/src/shared/usage');

const NOW = '2026-09-09T18:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const STALE_AFTER_MS = 10 * 60 * 1000;

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sessions(prefix, count, totalOffset = 0) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const totalTokens = totalOffset + index + 100;
    return [`${prefix}-${String(index).padStart(4, '0')}`, {
      totalTokens,
      inputTokens: totalTokens - 40,
      outputTokens: 40,
      cacheReadTokens: 20,
      costUsd: Number((totalTokens * 0.000002).toFixed(6)),
      client: index % 2 ? 'codex' : 'claude',
      model: index % 2 ? 'gpt-5.3-codex-spark' : 'claude-sonnet-4-5',
      projectLabel: `workspace-${index % 12}`,
      lastUsedAt: NOW
    }];
  }));
}

function period(prefix, count, totalOffset = 0) {
  const periodSessions = sessions(prefix, count, totalOffset);
  const totalTokens = Object.values(periodSessions).reduce((sum, session) => sum + session.totalTokens, 0);
  return { totalTokens, costUsd: Number((totalTokens * 0.000002).toFixed(6)), sessions: periodSessions };
}

function payload(totalOffset = 0, updatedAt = NOW) {
  return {
    deviceId: 'benchmark-device',
    hostname: 'benchmark-host',
    platform: 'win32',
    agentVersion: '0.54.0',
    agentRuntime: 'electron',
    updatedAt,
    periods: {
      today: period('today', 450, totalOffset),
      month: period('month', 600, totalOffset),
      allTime: period('all', 750, totalOffset)
    },
    limits: {
      updatedAt: NOW,
      providers: [{
        provider: 'codex',
        status: 'ok',
        source: 'oauth',
        updatedAt: NOW,
        windows: [{ kind: 'weekly', usedPercent: 54, remainingPercent: 46, resetsAt: '2026-09-12T20:51:00.000Z' }]
      }]
    }
  };
}

function statsFor(usage, history, record) {
  const stats = usage.aggregateDevices([record], STALE_AFTER_MS, NOW_MS);
  stats.updatedAt = NOW;
  stats.staleAfterMs = STALE_AFTER_MS;
  const aggregateHistory = usage.aggregateHistory([record]);
  stats.historyPreview = history.historyPreview(aggregateHistory);
  stats.historyRevision = history.historyRevision(aggregateHistory);
  stats.deviceHistoryRevision = history.deviceHistoryRevision([record]);
  stats.subscriptionsUpdatedAt = '';
  return stats;
}

async function webGzipSize(text) {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(compressed).arrayBuffer()).byteLength;
}

function wireScenario(protocol, usage, history, gzipSize, runtime) {
  const basePayload = payload();
  const baseRecord = usage.mergeDeviceRecord(null, { ...basePayload, receivedAt: NOW });
  const baseStats = statsFor(usage, history, baseRecord);
  const response = { ok: true, deviceId: baseRecord.deviceId, stats: baseStats };
  const fullEvent = sse('stats', { type: 'stats', reason: 'ingest', stats: baseStats, at: NOW });
  const snapshot = sse('snapshot', { type: 'stats', reason: 'snapshot', stats: baseStats, at: NOW });
  const freshness = sse('freshness', protocol.freshnessEvent(baseStats, 'ingest', NOW));
  const burstEvents = [];
  for (let index = 1; index <= 10; index += 1) {
    const changed = usage.mergeDeviceRecord(baseRecord, {
      ...payload(index, `2026-09-09T18:00:${String(index).padStart(2, '0')}.000Z`),
      receivedAt: `2026-09-09T18:00:${String(index).padStart(2, '0')}.000Z`
    });
    const changedStats = statsFor(usage, history, changed);
    burstEvents.push(sse('stats', { type: 'stats', reason: 'ingest', stats: changedStats, at: NOW }));
  }
  const legacyBody = JSON.stringify(response, null, 2);
  const compactBody = JSON.stringify(response);
  return {
    runtime,
    ingestRequest: bytes(JSON.stringify(basePayload)),
    legacyIngestResponse: bytes(legacyBody),
    compressedLegacyResponse: gzipSize(compactBody),
    minimalIngestResponse: bytes(JSON.stringify({ ok: true, deviceId: baseRecord.deviceId })),
    initialSnapshotPerClient: bytes(snapshot),
    unchangedLegacyPerClient: bytes(fullEvent),
    unchangedNewPerClient: bytes(freshness),
    meaningfulChangePerClient: bytes(fullEvent),
    burst10LegacyPerClient: burstEvents.reduce((sum, event) => sum + bytes(event), 0),
    burst10NewPerClient: bytes(burstEvents.at(-1)),
    unchangedNewTwoClients: bytes(freshness) * 2,
    meaningfulNewTwoClients: bytes(fullEvent) * 2
  };
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value} B`;
}

function reduction(before, after) {
  const percent = (1 - after / before) * 100;
  return `${percent.toFixed(percent >= 99.995 ? 4 : 2)}%`;
}

async function main() {
  const base = payload();
  const nodeRecord = nodeUsage.mergeDeviceRecord(null, { ...base, receivedAt: NOW });
  const workerRecord = workerUsage.mergeDeviceRecord(null, { ...base, receivedAt: NOW });
  assert.deepEqual(workerRecord, nodeRecord, 'Node and Worker normalized records drifted');
  assert.deepEqual(
    statsFor(workerUsage, workerHistory, workerRecord),
    statsFor(nodeUsage, nodeHistory, nodeRecord),
    'Node and Worker aggregate stats drifted'
  );

  const node = wireScenario(
    nodeProtocol,
    nodeUsage,
    nodeHistory,
    (text) => zlib.gzipSync(text, { level: zlib.constants.Z_BEST_SPEED }).byteLength,
    'Node Hub'
  );
  const worker = wireScenario(
    workerProtocol,
    workerUsage,
    workerHistory,
    () => 0,
    'Cloudflare Worker'
  );
  const workerStats = statsFor(workerUsage, workerHistory, workerRecord);
  worker.compressedLegacyResponse = await webGzipSize(JSON.stringify({
    ok: true,
    deviceId: workerRecord.deviceId,
    stats: workerStats
  }));

  const rows = [node, worker];
  console.log(`Deterministic fixture: ${Object.keys(base.periods.today.sessions).length + Object.keys(base.periods.month.sessions).length + Object.keys(base.periods.allTime.sessions).length} session rows, fixed at ${NOW}`);
  console.log('');
  console.table(rows.map((row) => ({
    Runtime: row.runtime,
    'Ingest request': formatBytes(row.ingestRequest),
    'Legacy response': formatBytes(row.legacyIngestResponse),
    'Gzip legacy response': formatBytes(row.compressedLegacyResponse),
    'Minimal ack': formatBytes(row.minimalIngestResponse),
    'Ack reduction': reduction(row.legacyIngestResponse, row.minimalIngestResponse)
  })));
  console.table(rows.map((row) => ({
    Runtime: row.runtime,
    'First snapshot/client': formatBytes(row.initialSnapshotPerClient),
    'Unchanged before/client': formatBytes(row.unchangedLegacyPerClient),
    'Unchanged after/client': formatBytes(row.unchangedNewPerClient),
    'Unchanged reduction': reduction(row.unchangedLegacyPerClient, row.unchangedNewPerClient),
    'Meaningful change/client': formatBytes(row.meaningfulChangePerClient),
    '10-update burst before/client': formatBytes(row.burst10LegacyPerClient),
    '10-update burst after/client': formatBytes(row.burst10NewPerClient),
    'Burst reduction': reduction(row.burst10LegacyPerClient, row.burst10NewPerClient),
    'Unchanged after/2 clients': formatBytes(row.unchangedNewTwoClients),
    'Meaningful after/2 clients': formatBytes(row.meaningfulNewTwoClients)
  })));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
