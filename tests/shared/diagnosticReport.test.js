'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deriveDiagnosticFindings,
  formatDiagnosticReport,
  MAX_REPORT_BYTES,
  projectHubDevices
} = require('../../src/shared/diagnosticReport');
const { createDiagnosticReportGenerator, processMetricsSnapshot } = require('../../src/electron/diagnostics');

function baseSnapshot(overrides = {}) {
  return {
    report: {
      generatedAt: '2026-08-05T10:00:00.000Z',
      timezone: 'Asia/Hong_Kong',
      reportCompleteness: 'full',
      usageCompleteness: 'full',
      limitsCompleteness: 'full',
      journalScope: 'electron-widget'
    },
    environment: { appVersion: '0.41.0', osName: 'macOS', osVersion: '15.1.1' },
    topology: { hubMode: 'local', hubTarget: 'none', hubTransport: 'none', streamState: 'not-applicable' },
    hub: { runtime: { hubKind: 'none' }, devices: { summaryAvailable: false, summarySource: 'not-applicable' } },
    usage: { usageOwner: 'electron-widget', usageCompleteness: 'full' },
    collector: { detailsAvailable: true, state: 'idle', intervalMs: 300000, lastTickSuccessAt: '2026-08-05T09:59:59.000Z' },
    clients: { clients: [], counts: {} },
    limits: { providers: [] },
    journal: { events: [] },
    resources: { resourceSnapshotScope: 'electron-widget', privateMemorySupported: false, processGroups: {} },
    workload: {},
    storage: {},
    ...overrides
  };
}

test('process metrics aggregate current working set and CPU but keep peak as a maximum', () => {
  const resources = processMetricsSnapshot([
    { type: 'Tab', memory: { workingSetSize: 100, peakWorkingSetSize: 500 }, cpu: { percentCPUUsage: 1.25 } },
    { type: 'Tab', memory: { workingSetSize: 200, peakWorkingSetSize: 300 }, cpu: { percentCPUUsage: 2.25 } },
    { type: 'GPU', memory: { workingSetSize: 400, peakWorkingSetSize: 700 }, cpu: { percentCPUUsage: 0.5 } }
  ], {
    cpuSampleDurationMs: 500,
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
    freeMemoryBytes: 8 * 1024 * 1024 * 1024,
    privateMemorySupported: false
  });

  assert.deepEqual(resources.processGroups.tab, {
    count: 2,
    workingSetMb: 0.3,
    peakWorkingSetMaxMb: 0.5,
    cpuPercent: 3.5
  });
  assert.equal(resources.processGroups.gpu.workingSetMb, 0.4);
  assert.equal(resources.aggregateCpuPercent, 4);
  assert.equal(resources.systemTotalMemoryMb, 16384);
  assert.equal(Object.hasOwn(resources.processGroups.tab, 'privateMemoryMb'), false);
});

test('hub device projection removes identifiers and groups full OS compatibility data', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  const projected = projectHubDevices({
    staleAfterMs: 600000,
    devices: [
      {
        deviceId: 'machine-secret-id',
        hostname: 'javis-macbook',
        agentVersion: '0.41.0',
        agentRuntime: 'electron-widget',
        platform: 'darwin-arm64',
        osName: 'macOS',
        osVersion: '15.1.1',
        receivedAt: new Date(now - 8000).toISOString(),
        stale: false
      },
      {
        deviceId: 'remote-id',
        hostname: 'workstation-private-name',
        agentVersion: '0.41.0',
        agentRuntime: 'headless-agent',
        platform: 'win32-x64',
        osName: 'Windows',
        osVersion: '11.0.26100',
        receivedAt: new Date(now - 42000).toISOString(),
        stale: false
      }
    ]
  }, { summaryAvailable: true, localDeviceId: 'machine-secret-id', nowMs: now });

  assert.equal(projected.localDevice.osVersion, '15.1.1');
  assert.equal(projected.remoteGroups[0].osVersion, '11.0.26100');
  assert.equal(projected.remoteGroups[0].newestRecordAgeSeconds, 42);
  assert.equal(Object.hasOwn(projected.localDevice, 'deviceId'), false);
  assert.equal(Object.hasOwn(projected.remoteGroups[0], 'hostname'), false);
  assert.equal(Object.hasOwn(projected.remoteGroups[0], 'recordAgeSeconds'), false);
});

test('findings respect the effective collection interval', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  const findings = deriveDiagnosticFindings({
    collector: {
      detailsAvailable: true,
      intervalMs: 30 * 60 * 1000,
      lastTickSuccessAt: new Date(now - 20 * 60 * 1000).toISOString()
    },
    usage: {},
    topology: {},
    limits: {}
  }, now);
  assert.deepEqual(findings, []);
});

test('formatter is allowlisted, UTF-8 bounded, and deterministically truncates variable entries', () => {
  const clients = Array.from({ length: 100 }, (_, index) => ({
    client: `client-${index}`,
    overall: 'attention',
    sourceState: 'missing',
    collectionState: 'failed',
    diagnosticCodes: ['sync-timeout'],
    tokens: { today: index, month: index, allTime: index }
  }));
  const report = formatDiagnosticReport(baseSnapshot({
    environment: { appVersion: '0.41.0', homeDir: '/Users/javis/private', osName: 'macOS', osVersion: '15.1.1' },
    clients: { clients, counts: { attention: clients.length } },
    resources: { privateMemorySupported: false, processGroups: {}, stderr: 'Bearer secret-cookie /Users/javis/private' }
  }));

  assert.ok(report.bytes <= MAX_REPORT_BYTES);
  assert.equal(report.bytes, Buffer.byteLength(report.text, 'utf8'));
  assert.equal(report.truncated, true);
  assert.ok(report.omittedClientCount > 0);
  assert.equal(report.text.includes('/Users/javis'), false);
  assert.equal(report.text.includes('secret-cookie'), false);
});

test('report generator samples CPU on demand and prevents concurrent generation', async () => {
  let metricsCalls = 0;
  let waits = 0;
  let releaseWait;
  const generator = createDiagnosticReportGenerator({
    cpuSampleDurationMs: 500,
    now: () => new Date('2026-08-05T10:00:00.000Z'),
    getSnapshot: () => baseSnapshot(),
    getAppMetrics: () => {
      metricsCalls += 1;
      return [{ type: 'Browser', memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 }, cpu: { percentCPUUsage: metricsCalls === 1 ? 0 : 4 } }];
    },
    getSystemMemory: () => ({ total: 1024 * 1024 * 1024, free: 512 * 1024 * 1024 }),
    getArchiveFileStat: async () => ({ ok: false, code: 'archive-not-present' }),
    wait: () => new Promise((resolve) => {
      waits += 1;
      releaseWait = resolve;
    })
  });

  const first = generator.generate();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(generator.generate(), (error) => error.code === 'diagnostics-in-progress');
  assert.equal(metricsCalls, 1);
  assert.equal(waits, 1);
  releaseWait();
  const report = await first;
  assert.match(report.text, /cpuPercent: 4/);
  assert.equal(metricsCalls, 2);
});
