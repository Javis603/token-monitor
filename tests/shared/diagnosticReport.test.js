'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deriveDiagnosticFindings,
  formatDiagnosticReport,
  MAX_REPORT_BYTES,
  projectClientHealth,
  projectHubDevices,
  projectLimitsDiagnostics
} = require('../../src/shared/diagnosticReport');
const { createDiagnosticReportGenerator, processMetricsSnapshot, statArchiveFile } = require('../../src/electron/diagnostics');

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

test('process metrics include unclassified Electron processes in the aggregate', () => {
  const resources = processMetricsSnapshot([
    { type: 'Browser', memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 }, cpu: { percentCPUUsage: 1 } },
    { type: 'Zygote', memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 }, cpu: { percentCPUUsage: 2 } }
  ], { privateMemorySupported: false });

  assert.equal(resources.processCount, 2);
  assert.deepEqual(resources.processGroups.other, {
    count: 1,
    workingSetMb: 2,
    peakWorkingSetMaxMb: 4,
    cpuPercent: 2
  });
  assert.equal(resources.aggregateWorkingSetMb, 3);
  assert.equal(resources.aggregateCpuPercent, 3);
});

test('archive stat projection distinguishes absent, disabled, and unreadable archives', () => {
  assert.deepEqual(statArchiveFile({ size: 12 }), {
    sessionArchivePresent: true,
    sessionArchiveFileSizeBytes: 12,
    archiveStatFailureCode: 'none'
  });
  assert.deepEqual(statArchiveFile(null, 'archive-not-present'), {
    sessionArchivePresent: false,
    sessionArchiveFileSizeBytes: 0,
    archiveStatFailureCode: 'none'
  });
  assert.deepEqual(statArchiveFile(null, 'archive-not-enabled'), {
    sessionArchivePresent: 'not-applicable',
    sessionArchiveFileSizeBytes: 'not-applicable',
    archiveStatFailureCode: 'none'
  });
  assert.deepEqual(statArchiveFile(null, 'archive-stat-failed'), {
    sessionArchivePresent: 'unknown',
    sessionArchiveFileSizeBytes: null,
    archiveStatFailureCode: 'archive-stat-failed'
  });
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

test('client projection sorts by health before applying the report limit', () => {
  const tracked = Array.from({ length: 64 }, (_, index) => `healthy-${index}`);
  tracked.push('attention-late');
  const clients = Object.fromEntries(tracked.map((client) => [client, {
    overall: client === 'attention-late' ? 'attention' : 'healthy',
    source: { state: 'detected' },
    collection: { state: 'ok' },
    data: {}
  }]));
  const projected = projectClientHealth({ clients }, { trackedClients: tracked });

  assert.equal(projected.clients.length, 64);
  assert.equal(projected.clients[0].client, 'attention-late');
  assert.equal(projected.omittedClientCount, 1);
  assert.equal(projected.counts.attention, 1);
  assert.equal(projected.counts.healthy, 64);
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

test('findings mark a collector stale after the effective interval threshold', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  const findings = deriveDiagnosticFindings({
    collector: {
      detailsAvailable: true,
      intervalMs: 30 * 60 * 1000,
      lastTickSuccessAt: new Date(now - 61 * 60 * 1000).toISOString()
    },
    usage: {},
    topology: {},
    limits: {}
  }, now);
  assert.deepEqual(findings, [{ code: 'collector-stale' }]);
});

test('client sync failures become findings for Cursor and Antigravity', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  const findings = deriveDiagnosticFindings(baseSnapshot({
    clients: {
      clients: [
        {
          client: 'cursor',
          collectionState: 'failed',
          diagnosticCodes: ['sync-timeout']
        },
        {
          client: 'antigravity',
          collectionState: 'failed',
          diagnosticCodes: ['sync-exit-error']
        }
      ],
      counts: { attention: 2 }
    }
  }), now);

  assert.deepEqual(findings, [
    { code: 'client-sync-failed', client: 'cursor', detailCode: 'sync-timeout' },
    { code: 'client-sync-failed', client: 'antigravity', detailCode: 'sync-exit-error' }
  ]);
});

test('client findings require a recognized sync failure code', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  const findings = deriveDiagnosticFindings(baseSnapshot({
    clients: {
      clients: [{
        client: 'antigravity',
        collectionState: 'failed',
        diagnosticCodes: ['source-missing']
      }],
      counts: { attention: 1 }
    }
  }), now);

  assert.deepEqual(findings, []);
});

test('client report includes bounded sync stage and exit evidence', () => {
  const report = formatDiagnosticReport(baseSnapshot({
    clients: {
      clients: [{
        client: 'antigravity',
        collectionState: 'failed',
        syncFailureStage: 'process-exit',
        syncDetailCode: 'rpc-failed',
        syncExitCode: 17,
        diagnosticCodes: ['sync-exit-error']
      }],
      counts: { attention: 1 }
    }
  }));

  assert.match(report.text, /syncFailureStage: process-exit/);
  assert.match(report.text, /syncDetailCode: rpc-failed/);
  assert.match(report.text, /syncExitCode: 17/);
  assert.equal(report.text.includes('/Users/'), false);
});

test('diagnostic values preserve large token totals and archive sizes', () => {
  const report = formatDiagnosticReport(baseSnapshot({
    environment: {
      platform: 'darwin',
      languageSetting: 'auto',
      resolvedLocale: 'zh-TW'
    },
    topology: { hubStatsCacheAgeSeconds: 'not-applicable' },
    hub: { runtime: { hubStatsCacheAgeSeconds: 'not-applicable' }, devices: { notApplicable: true } },
    collector: { wslStatus: null },
    clients: {
      clients: [{
        client: 'codex',
        overall: 'healthy',
        tokens: { today: 2500001, month: 2500002, allTime: 2500003 }
      }],
      counts: { healthy: 1 }
    },
    workload: {
      sessionArchiveFileSizeBytes: 2500004,
      sessionArchiveSessionCount: 2500005
    }
  }));

  assert.match(report.text, /todayTokens: 2500001/);
  assert.match(report.text, /sessionArchiveFileSizeBytes: 2500004/);
  assert.match(report.text, /hubStatsCacheAgeSeconds: not-applicable/);
  assert.match(report.text, /wslStatus: not-applicable/);
  assert.match(report.text, /languageSetting: auto/);
  assert.match(report.text, /resolvedLocale: zh-TW/);
  assert.match(report.text, /\[Hub Devices\]\nnotApplicable: true/);
  assert.equal(report.text.includes('remoteGroups:'), false);
});

test('configuration is allowlisted and preserves false values', () => {
  const report = formatDiagnosticReport(baseSnapshot({
    configuration: {
      configurationSource: 'effective-normalized',
      allTimeSince: '2025-06-01',
      historyEnabled: false,
      historyIntervalMs: 3600000,
      projectsEnabled: false,
      wslScanEnabled: false,
      syncUploadIntervalMs: 0,
      limitsRefreshMs: 60000,
      claudeWebCookie: 'sessionKey=secret',
      hubHostSecret: 'hub-secret'
    }
  }));

  assert.match(report.text, /\[Configuration\][\s\S]*configurationSource: effective-normalized/);
  assert.match(report.text, /allTimeSince: 2025-06-01/);
  assert.match(report.text, /historyEnabled: false/);
  assert.match(report.text, /projectsEnabled: false/);
  assert.match(report.text, /wslScanEnabled: false/);
  assert.match(report.text, /syncUploadIntervalMs: 0/);
  assert.match(report.text, /limitsRefreshMs: 60000/);
  assert.equal(report.text.includes('sessionKey=secret'), false);
  assert.equal(report.text.includes('hub-secret'), false);
});

test('invalid diagnostic configuration dates are redacted to unknown', () => {
  const report = formatDiagnosticReport(baseSnapshot({
    configuration: { allTimeSince: '/Users/javis/private' }
  }));

  assert.match(report.text, /allTimeSince: unknown/);
  assert.equal(report.text.includes('/Users/javis'), false);
});

test('not-configured limits are unavailable without raising a failure finding', () => {
  const limits = projectLimitsDiagnostics({
    providers: [
      {
        provider: 'antigravity',
        lastFailureCode: 'notConfigured',
        accountCount: 1
      },
      {
        provider: 'zai',
        lastFailureCode: 'unavailable',
        accountCount: 1
      }
    ]
  });
  assert.deepEqual(limits.providers[0], {
    provider: 'antigravity',
    configured: false,
    state: 'not-configured',
    accountCount: 1,
    pendingCount: 0,
    retryAttempt: 0,
    retryAt: 'none',
    lastAttemptAt: null,
    lastSuccessAt: null,
    failureCode: 'none'
  });
  assert.equal(deriveDiagnosticFindings({
    collector: { detailsAvailable: false },
    limits: { providers: limits.providers }
  }).length, 1);
  assert.deepEqual(deriveDiagnosticFindings({
    collector: { detailsAvailable: false },
    limits: { providers: [{ provider: 'zai', lastFailureCode: 'unavailable' }] }
  }), [{ code: 'limits-provider-failed', provider: 'zai' }]);
});

test('archive write failures become actionable findings', () => {
  const now = Date.parse('2026-08-05T10:00:00.000Z');
  assert.deepEqual(deriveDiagnosticFindings(baseSnapshot({
    workload: { lastSessionArchiveFailureCode: 'archive-write-failed' }
  }), now), [{ code: 'storage-archive-write-failed', detailCode: 'archive-write-failed' }]);
  assert.deepEqual(deriveDiagnosticFindings(baseSnapshot({
    workload: { sessionArchiveEnabled: false, lastSessionArchiveFailureCode: 'archive-write-failed' }
  }), now), []);
  assert.deepEqual(deriveDiagnosticFindings(baseSnapshot({
    usage: { usageOwner: 'external-agent' },
    workload: { lastSessionArchiveFailureCode: 'archive-write-failed' }
  }), now), []);
  assert.deepEqual(deriveDiagnosticFindings(baseSnapshot({
    storage: { settingsWritable: false, archiveWritable: false }
  }), now), []);
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

test('report generator carries archive write failures into final findings', async () => {
  const generator = createDiagnosticReportGenerator({
    cpuSampleDurationMs: 0,
    now: () => new Date('2026-08-05T10:00:00.000Z'),
    getSnapshot: () => baseSnapshot({
      workload: { lastSessionArchiveFailureCode: 'archive-write-failed' }
    }),
    getAppMetrics: () => [],
    getSystemMemory: () => ({ total: 0, free: 0 }),
    getArchiveFileStat: async () => ({ ok: false, code: 'archive-stat-failed' }),
    wait: async () => {}
  });

  const report = await generator.generate();

  assert.match(report.text, /findingCount: 1/);
  assert.match(report.text, /storage-archive-write-failed/);
});
