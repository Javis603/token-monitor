'use strict';

const os = require('node:os');
const {
  deriveDiagnosticFindings,
  formatDiagnosticReport,
  MAX_REPORT_BYTES
} = require('../shared/diagnosticReport');

const DEFAULT_CPU_SAMPLE_DURATION_MS = 500;
const PROCESS_GROUPS = ['browser', 'tab', 'gpu', 'utility', 'other'];

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return number === null ? fallback : Math.max(0, number);
}

function roundMb(value) {
  const number = nonNegative(value);
  return number === null ? null : Number(number.toFixed(1));
}

function metricGroup(type) {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'browser' || value === 'main') return 'browser';
  if (value === 'tab' || value === 'renderer') return 'tab';
  if (value === 'gpu') return 'gpu';
  if (value === 'utility') return 'utility';
  return null;
}

function processMetricsSnapshot(metrics, options = {}) {
  const rows = Array.isArray(metrics) ? metrics : [];
  const privateMemorySupported = options.privateMemorySupported === true;
  const processGroups = Object.fromEntries(PROCESS_GROUPS.map((name) => [name, {
    count: 0,
    workingSetMb: 0,
    peakWorkingSetMaxMb: 0,
    cpuPercent: 0,
    ...(privateMemorySupported ? { privateMemoryMb: 0 } : {})
  }]));

  for (const metric of rows) {
    const name = metricGroup(metric?.type) || 'other';
    const group = processGroups[name];
    const memory = metric?.memory || {};
    group.count += 1;
    group.workingSetMb += nonNegative(memory.workingSetSize, 0) / 1024;
    group.peakWorkingSetMaxMb = Math.max(
      group.peakWorkingSetMaxMb,
      nonNegative(memory.peakWorkingSetSize, 0) / 1024
    );
    group.cpuPercent += nonNegative(metric?.cpu?.percentCPUUsage, 0);
    if (privateMemorySupported) {
      group.privateMemoryMb += nonNegative(memory.privateBytes, 0) / 1024;
    }
  }

  for (const group of Object.values(processGroups)) {
    group.workingSetMb = roundMb(group.workingSetMb);
    group.peakWorkingSetMaxMb = roundMb(group.peakWorkingSetMaxMb);
    group.cpuPercent = Number(group.cpuPercent.toFixed(1));
    if (privateMemorySupported) group.privateMemoryMb = roundMb(group.privateMemoryMb);
  }

  const aggregateWorkingSetMb = Object.values(processGroups)
    .reduce((sum, group) => sum + (group.workingSetMb || 0), 0);
  const aggregateCpuPercent = Object.values(processGroups)
    .reduce((sum, group) => sum + (group.cpuPercent || 0), 0);

  return {
    capturedAt: new Date().toISOString(),
    resourceSnapshotScope: 'electron-widget',
    resourceSampleKind: 'interval',
    cpuSampleDurationMs: nonNegative(options.cpuSampleDurationMs),
    privateMemorySupported,
    systemTotalMemoryMb: roundMb(options.totalMemoryBytes ? options.totalMemoryBytes / (1024 * 1024) : null),
    systemFreeMemoryMb: roundMb(options.freeMemoryBytes ? options.freeMemoryBytes / (1024 * 1024) : null),
    processCount: rows.length,
    aggregateWorkingSetMb: roundMb(aggregateWorkingSetMb),
    aggregateCpuPercent: Number(aggregateCpuPercent.toFixed(1)),
    externalAgentResourceMetricsAvailable: false,
    processGroups
  };
}

function statArchiveFile(stat, errorCode = null) {
  if (stat && Number.isFinite(Number(stat.size))) {
    return {
      sessionArchivePresent: true,
      sessionArchiveFileSizeBytes: Math.max(0, Math.round(Number(stat.size))),
      archiveStatFailureCode: 'none'
    };
  }
  if (errorCode === 'archive-not-enabled') {
    return {
      sessionArchivePresent: 'not-applicable',
      sessionArchiveFileSizeBytes: 'not-applicable',
      archiveStatFailureCode: 'none'
    };
  }
  if (errorCode === 'archive-not-present') {
    return {
      sessionArchivePresent: false,
      sessionArchiveFileSizeBytes: 0,
      archiveStatFailureCode: 'none'
    };
  }
  return {
    sessionArchivePresent: 'unknown',
    sessionArchiveFileSizeBytes: null,
    archiveStatFailureCode: errorCode || 'archive-stat-failed'
  };
}

function createDiagnosticReportGenerator(options = {}) {
  const getSnapshot = options.getSnapshot || (() => ({}));
  const getAppMetrics = options.getAppMetrics || (() => []);
  const getSystemMemory = options.getSystemMemory || (() => ({ total: os.totalmem(), free: os.freemem() }));
  const getArchiveFileStat = options.getArchiveFileStat || (async () => ({ ok: false, code: 'archive-stat-unavailable' }));
  const wait = options.wait || ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const now = options.now || (() => new Date());
  const cpuSampleDurationMs = Number.isFinite(Number(options.cpuSampleDurationMs))
    ? Math.max(0, Number(options.cpuSampleDurationMs))
    : DEFAULT_CPU_SAMPLE_DURATION_MS;
  let inFlight = null;

  async function generate() {
    if (inFlight) {
      const error = new Error('diagnostic generation already in progress');
      error.code = 'diagnostics-in-progress';
      throw error;
    }
    inFlight = (async () => {
      const generatedAt = now();
      const snapshot = await Promise.resolve(getSnapshot({ generatedAt }));
      const baselineAt = Date.now();
      // Electron reports CPU usage relative to the previous getAppMetrics call;
      // this first call primes the baseline and is intentionally discarded.
      getAppMetrics();
      await wait(cpuSampleDurationMs);
      const finalMetrics = getAppMetrics();
      const sampleDurationMs = Math.max(0, Date.now() - baselineAt);
      const memory = getSystemMemory() || {};
      const archive = await Promise.resolve(getArchiveFileStat());
      const resources = processMetricsSnapshot(finalMetrics, {
        cpuSampleDurationMs: sampleDurationMs,
        totalMemoryBytes: memory.total,
        freeMemoryBytes: memory.free,
        privateMemorySupported: options.privateMemorySupported === true
      });
      const archiveDiagnostics = archive?.ok === true
        ? statArchiveFile(archive.stat)
        : statArchiveFile(null, archive?.code || 'archive-stat-failed');
      const merged = {
        ...snapshot,
        report: {
          ...(snapshot.report || {}),
          generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString()
        },
        resources,
        workload: {
          ...(snapshot.workload || {}),
          ...(archiveDiagnostics.sessionArchivePresent !== undefined ? archiveDiagnostics : {})
        },
        storage: {
          ...(snapshot.storage || {}),
          ...(archiveDiagnostics.archiveStatFailureCode ? { archiveStatFailureCode: archiveDiagnostics.archiveStatFailureCode } : {})
        }
      };
      merged.findings = deriveDiagnosticFindings(merged, Date.parse(merged.report.generatedAt));
      const report = formatDiagnosticReport(merged);
      if (report.bytes > MAX_REPORT_BYTES) {
        const error = new Error('diagnostic report exceeds size limit');
        error.code = 'diagnostic-report-too-large';
        throw error;
      }
      return report;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return { generate };
}

module.exports = {
  DEFAULT_CPU_SAMPLE_DURATION_MS,
  createDiagnosticReportGenerator,
  metricGroup,
  processMetricsSnapshot,
  statArchiveFile
};
