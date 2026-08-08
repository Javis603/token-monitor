'use strict';

const net = require('node:net');
const os = require('node:os');
const { clientsCsvForSetting } = require('../shared/clientTracking');
const { projectClientHealth, projectHubDevices } = require('../shared/diagnosticReport');
const { resolveLocale } = require('./renderer/i18n');

function diagnosticAgeSeconds(value, nowMs = Date.now()) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((nowMs - timestamp) / 1000));
}

function recordFreshnessMs(record) {
  return [record?.receivedAt, record?.updatedAt]
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite)
    .reduce((latest, timestamp) => Math.max(latest, timestamp), null);
}

function selectLocalDeviceRecord(options = {}) {
  const deviceId = String(options.deviceId || '').trim();
  if (!deviceId) return null;
  const rawHubRecord = (Array.isArray(options.latestHubStats?.devices) ? options.latestHubStats.devices : [])
    .find((device) => device?.deviceId === deviceId) || null;
  const displayHubRecord = (Array.isArray(options.latestStats?.devices) ? options.latestStats.devices : [])
    .find((device) => device?.deviceId === deviceId) || null;
  if (options.externalAgentActive === true) return rawHubRecord;

  const candidates = [options.lastCollectedDevice, options.localDevice, displayHubRecord, rawHubRecord]
    .filter((device) => device?.deviceId === deviceId);
  let selected = null;
  let selectedAt = null;
  for (const candidate of candidates) {
    const candidateAt = recordFreshnessMs(candidate);
    if (!selected || (candidateAt !== null && (selectedAt === null || candidateAt > selectedAt))) {
      selected = candidate;
      selectedAt = candidateAt;
    }
  }
  return selected;
}

function diagnosticHubTarget(url) {
  const raw = String(url || '').trim();
  if (!raw) return 'none';
  try {
    const hostname = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')) return 'loopback';
    if (hostname === '10.0.0.1' || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.endsWith('.local')) return 'lan';
    const match = hostname.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 'lan';
    if (net.isIP(hostname) === 6
      && (hostname.startsWith('fc') || hostname.startsWith('fd') || /^fe[89ab]/.test(hostname))) return 'lan';
    return 'remote';
  } catch (_) {
    return 'remote';
  }
}

function diagnosticHubTransport(url) {
  try {
    const protocol = new URL(String(url || '')).protocol;
    if (protocol === 'http:' || protocol === 'https:') return protocol.slice(0, -1);
  } catch (_) {}
  return 'none';
}

function diagnosticOsInfo(device, platform = process.platform, osRelease = os.release()) {
  const name = String(device?.osName || '').trim() || (
    platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform
  );
  const version = String(device?.osVersion || '').trim() || osRelease;
  return { name, version };
}

function diagnosticStreamDetailCode(failure = {}) {
  const reason = String(failure.reason || '').trim().toLowerCase();
  if (reason === 'refused') return 'connection-refused';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'dns') return 'dns-failed';
  if (reason === 'unauthorized') return 'unauthorized';
  if (reason === 'disconnected') return 'eof';
  if (reason === 'unreachable') return 'unreachable';
  if (reason === 'server_error') return 'http-error';
  if (reason === 'network') {
    const detail = String(failure.detail || '').trim().toUpperCase();
    if (detail === 'ECONNREFUSED') return 'connection-refused';
    if (detail === 'ETIMEDOUT') return 'timeout';
    if (detail === 'ENOTFOUND' || detail === 'EAI_AGAIN') return 'dns-failed';
    if (detail === 'EHOSTUNREACH' || detail === 'ENETUNREACH') return 'unreachable';
    if (detail === 'ECONNRESET') return 'connection-reset';
  }
  return 'unknown';
}

function diagnosticTokscaleInfo(getTokscaleStatus) {
  try {
    const status = getTokscaleStatus?.() || {};
    return {
      version: status.current?.version || status.bundled?.version || 'unknown',
      source: status.current?.source || (status.bundled ? 'bundled' : 'unknown')
    };
  } catch (_) {
    return { version: 'unknown', source: 'unknown' };
  }
}

function createDiagnosticSnapshotBuilder(options = {}) {
  const getSettings = options.getSettings || (() => ({}));
  const getMode = options.getMode || (() => 'idle');
  const getEffectiveHubConfig = options.getEffectiveHubConfig || (() => ({ url: null }));
  const getExternalAgentActive = options.getExternalAgentActive || (() => false);
  const getDeviceRuntime = options.getDeviceRuntime || (() => null);
  const getEmbeddedHub = options.getEmbeddedHub || (() => null);
  const getStreamState = options.getStreamState || (() => ({ connected: false, failure: null }));
  const getLatestHubStats = options.getLatestHubStats || (() => null);
  const getLatestHubStatsReceivedAt = options.getLatestHubStatsReceivedAt || (() => null);
  const getLatestHubStatsSource = options.getLatestHubStatsSource || null;
  const getLatestHubStatsGeneration = options.getLatestHubStatsGeneration || null;
  const getLatestHubStatsIdentity = options.getLatestHubStatsIdentity || null;
  const getHubModeGeneration = options.getHubModeGeneration || null;
  const getCurrentHubStatsIdentity = options.getCurrentHubStatsIdentity || null;
  const getLocalRecord = options.getLocalRecord || (() => null);
  const getTokscaleStatus = options.getTokscaleStatus || (() => null);
  const getConfiguration = options.getConfiguration || (() => ({}));
  const getJournalSnapshot = options.getJournalSnapshot || (() => ({}));
  const getArchiveState = options.getArchiveState || (() => ({}));
  const getAppVersion = options.getAppVersion || (() => 'unknown');
  const getDefaultDeviceId = options.getDefaultDeviceId || (() => 'unknown');
  const canRefreshUsageRuntime = options.canRefreshUsageRuntime || (() => false);
  const getAppState = options.getAppState || (() => ({ packaged: false, preferredLanguages: ['en'], locale: 'en' }));
  const getProcessVersions = options.getProcessVersions || (() => process.versions);
  const getPlatform = options.getPlatform || (() => process.platform);
  const getArchitecture = options.getArchitecture || (() => process.arch);
  const getUptimeSeconds = options.getUptimeSeconds || (() => Math.round(process.uptime()));
  const getOsRelease = options.getOsRelease || (() => os.release());
  const getNowMs = options.getNowMs || (() => Date.now());

  function diagnosticRuntimeInfo() {
    const settings = getSettings() || {};
    const hubMode = settings.hubMode || 'local';
    const { url: hubUrl } = getEffectiveHubConfig() || {};
    const externalAgentActive = Boolean(getExternalAgentActive());
    const runtimeHandle = getDeviceRuntime();
    const runtimeDiagnostics = runtimeHandle?.getDiagnostics?.() || {};
    const usageDiagnostics = runtimeDiagnostics.usage || null;
    const limitsDiagnostics = runtimeDiagnostics.limits || null;
    const usageOwner = externalAgentActive
      ? 'external-agent'
      : usageDiagnostics && canRefreshUsageRuntime(getMode(), () => false)
        ? 'electron-widget'
        : 'none';
    const limitsOwner = limitsDiagnostics ? 'electron-widget' : 'none';
    const usageCompleteness = externalAgentActive
      ? 'partial-external-owner'
      : usageDiagnostics
        ? 'full'
        : 'partial-no-runtime';
    const limitsCompleteness = limitsDiagnostics ? 'full' : 'partial-no-runtime';
    let hubKind = 'none';
    let hubSoftwareVersion = 'not-applicable';
    let hubSoftwareVersionSource = 'not-applicable';
    if (hubMode === 'host') {
      hubKind = 'embedded-node';
      hubSoftwareVersion = getAppVersion();
      hubSoftwareVersionSource = 'embedded-app-version';
    } else if (hubMode === 'client') {
      hubKind = 'remote-unknown';
      hubSoftwareVersion = 'unknown';
      hubSoftwareVersionSource = 'unavailable';
    }
    const stream = getStreamState() || {};
    const embeddedHub = getEmbeddedHub();
    const streamState = hubMode === 'local'
      ? 'not-applicable'
      : hubMode === 'host'
        ? embeddedHub ? 'connected' : 'disconnected'
        : stream.connected ? 'connected' : 'disconnected';
    const lastStreamFailureCode = streamState === 'disconnected'
      ? diagnosticStreamDetailCode(stream.failure || {})
      : 'none';
    const expectedHubStatsSource = hubMode === 'host'
      ? 'host'
      : hubMode === 'client'
        ? 'client'
        : 'none';
    const sourceMatches = typeof getLatestHubStatsSource !== 'function'
      || String(getLatestHubStatsSource() || 'none') === expectedHubStatsSource;
    const generationMatches = typeof getLatestHubStatsGeneration !== 'function'
      || typeof getHubModeGeneration !== 'function'
      || Object.is(getLatestHubStatsGeneration(), getHubModeGeneration());
    const identityMatches = typeof getLatestHubStatsIdentity !== 'function'
      || typeof getCurrentHubStatsIdentity !== 'function'
      || getLatestHubStatsIdentity() === getCurrentHubStatsIdentity(hubMode);
    const hubStatsCacheMatchesMode = sourceMatches && generationMatches && identityMatches;
    const hubStatsCacheAgeSeconds = hubMode === 'local'
      ? 'not-applicable'
      : hubStatsCacheMatchesMode
        ? diagnosticAgeSeconds(getLatestHubStatsReceivedAt(), getNowMs())
        : 'not-applicable';
    const hubRuntime = {
      hubKind,
      hubSoftwareVersion,
      hubSoftwareVersionSource,
      hubTarget: hubMode === 'local' ? 'none' : diagnosticHubTarget(hubUrl),
      hubTransport: hubMode === 'local' ? 'none' : diagnosticHubTransport(hubUrl),
      streamState,
      hubStatsCacheAgeSeconds
    };
    return {
      externalAgentActive,
      runtimeDiagnostics,
      usageDiagnostics,
      limitsDiagnostics,
      usageOwner,
      limitsOwner,
      usageCompleteness,
      limitsCompleteness,
      hubStatsCacheMatchesMode,
      hubRuntime,
      topology: {
        hubMode,
        hubTarget: hubRuntime.hubTarget,
        hubTransport: hubRuntime.hubTransport,
        externalAgentAlive: externalAgentActive,
        usageOwner,
        limitsOwner,
        streamState,
        lastStreamFailureCode,
        embeddedHubRunning: Boolean(embeddedHub),
        hubStatsCacheAgeSeconds: hubRuntime.hubStatsCacheAgeSeconds
      }
    };
  }

  function build(generatedAt = new Date()) {
    const settings = getSettings() || {};
    const nowMs = getNowMs();
    const runtime = diagnosticRuntimeInfo();
    const localRecord = getLocalRecord();
    const platform = getPlatform();
    const osInfo = diagnosticOsInfo(localRecord, platform, getOsRelease());
    const trackedClients = localRecord?.trackedClients
      || clientsCsvForSetting(settings.clients).split(',').filter(Boolean);
    const clientDevice = localRecord || { trackedClients };
    const clients = projectClientHealth(localRecord?.clientHealth || null, clientDevice);
    const usageObservationAt = runtime.usageOwner === 'external-agent'
      ? localRecord?.receivedAt || localRecord?.updatedAt || clients.observedAt
      : runtime.usageDiagnostics?.lastTickSuccessAt || clients.observedAt;
    const syncIntervalMs = Number(localRecord?.syncUploadIntervalMs);
    const usageStaleAfterMs = Math.max(10 * 60 * 1000, Number.isFinite(syncIntervalMs) ? syncIntervalMs * 2 : 0);
    const localRecordAgeSeconds = diagnosticAgeSeconds(localRecord?.receivedAt || localRecord?.updatedAt, nowMs);
    let hubStats = null;
    let hubSummarySource = 'not-applicable';
    if (settings.hubMode === 'host') {
      hubStats = runtime.hubStatsCacheMatchesMode ? getLatestHubStats() : null;
      hubSummarySource = 'same-process-hub-cache';
    } else if (settings.hubMode === 'client') {
      hubStats = runtime.hubStatsCacheMatchesMode ? getLatestHubStats() : null;
      hubSummarySource = 'cached-hub-stats';
    }
    const hubDevices = projectHubDevices(hubStats, {
      summaryAvailable: Boolean(hubStats && Array.isArray(hubStats.devices)),
      summarySource: hubSummarySource,
      localDeviceId: settings.deviceId || getDefaultDeviceId(),
      nowMs
    });
    const tokScale = diagnosticTokscaleInfo(getTokscaleStatus);
    const archive = getArchiveState() || {};
    const reportJournal = getJournalSnapshot() || {};
    const reportCompleteness = runtime.usageCompleteness === 'full' && runtime.limitsCompleteness === 'full'
      ? 'full'
      : runtime.usageCompleteness === 'partial-external-owner'
        ? 'partial-external-owner'
        : 'partial-no-runtime';
    const versions = getProcessVersions() || {};
    const appState = getAppState() || {};
    const preferredLanguages = Array.isArray(appState.preferredLanguages) && appState.preferredLanguages.length > 0
      ? appState.preferredLanguages
      : [appState.locale || 'en'];
    return {
      report: {
        generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
        reportCompleteness,
        usageCompleteness: runtime.usageCompleteness,
        limitsCompleteness: runtime.limitsCompleteness,
        journalScope: 'electron-widget',
        journalStartedAt: reportJournal.startedAt,
        journalOmittedCount: 0
      },
      environment: {
        appVersion: getAppVersion(),
        electronVersion: versions.electron,
        nodeVersion: versions.node,
        chromiumVersion: versions.chrome,
        tokscaleVersion: tokScale.version,
        tokscaleSource: tokScale.source,
        packaged: appState.packaged === true,
        platform,
        osName: osInfo.name,
        osVersion: osInfo.version,
        architecture: getArchitecture(),
        languageSetting: settings.language || 'auto',
        resolvedLocale: resolveLocale(settings.language || 'auto', preferredLanguages),
        appUptimeSeconds: getUptimeSeconds()
      },
      configuration: getConfiguration(),
      topology: runtime.topology,
      hub: {
        runtime: runtime.hubRuntime,
        devices: hubDevices
      },
      usage: {
        usageOwner: runtime.usageOwner,
        localUsageRuntimePresent: Boolean(getDeviceRuntime() && runtime.usageDiagnostics),
        usageRefreshAllowed: runtime.usageOwner === 'electron-widget',
        usageCompleteness: runtime.usageCompleteness,
        usageJournalAvailable: runtime.usageOwner === 'electron-widget' && Boolean(runtime.usageDiagnostics),
        localRecordAgeSeconds,
        usageObservationAgeSeconds: diagnosticAgeSeconds(usageObservationAt, nowMs),
        usageStaleAfterSeconds: Math.round(usageStaleAfterMs / 1000),
        limitsOwner: runtime.limitsOwner,
        limitsCompleteness: runtime.limitsCompleteness
      },
      collector: {
        ...(runtime.usageDiagnostics || { state: 'unavailable' }),
        detailsAvailable: !runtime.externalAgentActive && Boolean(runtime.usageDiagnostics)
      },
      clients,
      limits: runtime.limitsDiagnostics || { enabled: false, active: 0, maxConcurrency: null, queued: 0, providers: [] },
      journal: reportJournal,
      workload: {
        sessionArchiveEnabled: archive.enabled !== false,
        sessionArchivePresent: archive.loaded === true,
        sessionArchiveSessionCount: archive.sessionCount ?? null,
        sessionArchiveCountSource: archive.countSource || (archive.enabled === false ? 'not-enabled' : 'not-loaded'),
        lastSessionArchiveUpdateDurationMs: archive.lastUpdate?.durationMs ?? null,
        lastSessionArchiveUpdateAt: archive.lastUpdate?.at ?? null,
        lastSessionArchiveFailureCode: archive.lastUpdate?.failureCode ?? null,
        lastCollectorTickDurationMs: runtime.usageDiagnostics?.lastTickDurationMs ?? null,
        lastCollectorTickScope: runtime.usageDiagnostics?.lastTickScope || null,
        lastHistoryScanDurationMs: runtime.usageDiagnostics?.lastHistoryScanDurationMs ?? null
      },
      storage: {
        settingsReadable: Boolean(settings),
        settingsWritable: null,
        archiveReadable: null,
        archiveWritable: null
      }
    };
  }

  return { build, diagnosticRuntimeInfo };
}

module.exports = {
  createDiagnosticSnapshotBuilder,
  diagnosticAgeSeconds,
  diagnosticHubTarget,
  diagnosticHubTransport,
  diagnosticOsInfo,
  diagnosticStreamDetailCode,
  diagnosticTokscaleInfo,
  selectLocalDeviceRecord
};
