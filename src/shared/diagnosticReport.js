'use strict';

const { staleAfterMsForSyncUpload } = require('./syncUploadInterval');
const { SELF_SYNC_FAILURE_CODES } = require('./selfSyncThrottle');
const {
  normalizeClientSyncDetailCode,
  normalizeClientSyncExitCode,
  normalizeClientSyncFailureStage
} = require('./clientHealth');

const DIAGNOSTIC_SCHEMA_VERSION = 1;
const DIAGNOSTIC_REDACTION_VERSION = 1;
const MAX_REPORT_BYTES = 32 * 1024;
const MAX_CLIENTS_IN_REPORT = 64;
const MAX_LIMIT_PROVIDERS_IN_REPORT = 32;
const MAX_REMOTE_GROUPS_IN_REPORT = 16;
const MAX_JOURNAL_EVENTS_IN_REPORT = 20;
const MAX_SOURCE_CHECKS_IN_REPORT = 8;
const MAX_TEXT_LENGTH = 256;

const CLIENT_STATES = new Set(['healthy', 'waiting', 'attention', 'unavailable', 'unknown']);
const COLLECTION_STATES = new Set(['direct', 'idle', 'pending', 'ok', 'failed', 'unknown']);
const SOURCE_STATES = new Set(['detected', 'missing', 'unknown']);
const FINDING_CODES = new Set([
  'collector-failed',
  'collector-stale',
  'client-sync-failed',
  'external-agent-stale',
  'limits-provider-failed',
  'storage-archive-write-failed',
  'stream-disconnected',
  'watcher-polling-fallback',
  'watcher-rebuild-failed'
]);

function text(value, fallback = 'unknown', maxLength = MAX_TEXT_LENGTH) {
  const raw = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw ? Array.from(raw).slice(0, maxLength).join('') : fallback;
}

function identifier(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : fallback;
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integer(value, fallback = null) {
  const numeric = finiteNumber(value, fallback);
  return numeric === null ? fallback : Math.round(numeric);
}

function booleanOrUnknown(value) {
  return typeof value === 'boolean' ? value : 'unknown';
}

function dateKey(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'unknown';
  const parsed = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw ? raw : 'unknown';
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ageSecondsFromValue(value, nowMs = Date.now()) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function periodForDevice(device, name) {
  return device?.periods?.[name] || device?.[name] || {};
}

function clientTokens(device, client, periodName) {
  const value = finiteNumber(periodForDevice(device, periodName)?.clients?.[client], 0);
  return Math.max(0, Math.round(value));
}

function safeClientState(value) {
  const state = String(value || '').trim();
  return CLIENT_STATES.has(state) ? state : 'unknown';
}

function safeCollectionState(value) {
  const state = String(value || '').trim();
  return COLLECTION_STATES.has(state) ? state : 'unknown';
}

function safeSourceState(value) {
  const state = String(value || '').trim();
  return SOURCE_STATES.has(state) ? state : 'unknown';
}

function projectClientHealth(health, device = {}) {
  const tracked = Array.isArray(device.trackedClients)
    ? device.trackedClients.map((client) => identifier(client, '')).filter(Boolean)
    : [];
  const entries = health?.clients && typeof health.clients === 'object' ? health.clients : {};
  const ids = [...new Set([...tracked, ...Object.keys(entries).map((client) => identifier(client, '')).filter(Boolean)])];

  const clients = ids.map((client) => {
    const entry = entries[client];
    const source = entry?.source || {};
    const collection = entry?.collection || {};
    const data = entry?.data || {};
    const checks = Array.isArray(source.checks)
      ? source.checks.slice(0, MAX_SOURCE_CHECKS_IN_REPORT).map((check) => ({
          id: identifier(check?.id, 'unknown'),
          state: check?.exists === true ? 'found' : 'missing'
        }))
      : [];
    const diagnosticCodes = Array.isArray(entry?.diagnostics)
      ? entry.diagnostics.map((item) => identifier(item?.code, '')).filter(Boolean).slice(0, 4)
      : [];
    return {
      client,
      healthEntryAvailable: Boolean(entry),
      overall: safeClientState(entry?.overall),
      sourceState: safeSourceState(source.state),
      detectedCount: integer(source.detectedCount, 0),
      checkedCount: integer(source.checkedCount, 0),
      sourceChecks: checks,
      collectionState: safeCollectionState(collection.state),
      syncFailureStage: safeCollectionState(collection.state) === 'failed'
        ? normalizeClientSyncFailureStage(collection.syncFailureStage)
        : null,
      syncDetailCode: safeCollectionState(collection.state) === 'failed'
        ? (normalizeClientSyncDetailCode(collection.syncDetailCode) || 'unknown')
        : null,
      syncExitCode: safeCollectionState(collection.state) === 'failed'
        ? normalizeClientSyncExitCode(collection.syncExitCode)
        : null,
      lastAttemptAt: isoTimestamp(collection.lastAttemptAt),
      lastSuccessAt: isoTimestamp(collection.lastSuccessAt),
      lastActivityDay: text(data.lastActivityDay, 'unknown', 16),
      observedAt: isoTimestamp(health?.observedAt),
      tokens: {
        today: clientTokens(device, client, 'today'),
        month: clientTokens(device, client, 'month'),
        allTime: clientTokens(device, client, 'allTime')
      },
      diagnosticCodes
    };
  });

  const order = { attention: 0, unknown: 1, waiting: 2, unavailable: 3, healthy: 4 };
  clients.sort((a, b) => (order[a.overall] - order[b.overall]) || a.client.localeCompare(b.client));
  const counts = { healthy: 0, waiting: 0, attention: 0, unavailable: 0, unknown: 0 };
  for (const entry of clients) counts[entry.overall] += 1;
  const omittedClientCount = Math.max(0, clients.length - MAX_CLIENTS_IN_REPORT);
  return {
    available: Boolean(health),
    observedAt: isoTimestamp(health?.observedAt),
    trackedClientCount: tracked.length,
    healthEntryCount: Object.keys(entries).length,
    missingHealthEntryCount: tracked.filter((client) => !entries[client]).length,
    counts,
    omittedClientCount,
    clients: clients.slice(0, MAX_CLIENTS_IN_REPORT)
  };
}

function deviceAgeSeconds(device, nowMs) {
  const fromAge = finiteNumber(device?.ageMs);
  if (fromAge !== null && fromAge >= 0) return Math.round(fromAge / 1000);
  return ageSecondsFromValue(device?.receivedAt || device?.updatedAt, nowMs);
}

function deviceFreshness(device, stats, nowMs) {
  if (device?.stale === true) return 'stale';
  if (device?.stale === false) return 'fresh';
  const age = deviceAgeSeconds(device, nowMs);
  if (age === null) return 'unknown';
  const threshold = staleAfterMsForSyncUpload(device?.syncUploadIntervalMs, stats?.staleAfterMs);
  return threshold > 0 && age * 1000 > threshold ? 'stale' : 'fresh';
}

function projectDeviceCompatibility(device, stats, nowMs) {
  const age = deviceAgeSeconds(device, nowMs);
  return {
    softwareVersion: text(device?.agentVersion),
    runtime: identifier(device?.agentRuntime),
    platform: text(device?.platform),
    osName: text(device?.osName),
    osVersion: text(device?.osVersion),
    recordAgeSeconds: age,
    freshness: deviceFreshness(device, stats, nowMs)
  };
}

function groupKey(device) {
  return [
    device.softwareVersion,
    device.runtime,
    device.platform,
    device.osName,
    device.osVersion,
    device.freshness
  ].join('\u0000');
}

function projectHubDevices(stats, options = {}) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  if (!options.summaryAvailable || !Array.isArray(stats?.devices)) {
    return {
      summarySource: options.summarySource || 'not-applicable',
      summaryAvailable: false,
      notApplicable: (options.summarySource || 'not-applicable') === 'not-applicable',
      deviceCount: 0,
      remoteDeviceCount: 0,
      includedRemoteGroupCount: 0,
      omittedRemoteGroupCount: 0,
      localDevice: null,
      remoteGroups: []
    };
  }

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const localDeviceId = String(options.localDeviceId || '').trim();
  const localRaw = localDeviceId ? devices.find((device) => String(device?.deviceId || '') === localDeviceId) : null;
  const remote = localRaw ? devices.filter((device) => device !== localRaw) : devices;
  const groups = new Map();

  for (const device of remote) {
    const projected = projectDeviceCompatibility(device, stats, nowMs);
    const { recordAgeSeconds: _recordAgeSeconds, ...groupProjection } = projected;
    const key = groupKey(projected);
    if (!groups.has(key)) groups.set(key, { ...groupProjection, count: 0, ages: [] });
    const group = groups.get(key);
    group.count += 1;
    if (projected.recordAgeSeconds !== null) group.ages.push(projected.recordAgeSeconds);
  }

  const localVersion = localRaw ? text(localRaw.agentVersion) : 'unknown';
  const remoteGroups = [...groups.values()].map((group) => {
    const ages = group.ages;
    const { ages: _ages, ...rest } = group;
    return {
      ...rest,
      newestRecordAgeSeconds: ages.length > 0 ? Math.min(...ages) : null,
      oldestRecordAgeSeconds: ages.length > 0 ? Math.max(...ages) : null
    };
  });
  const priority = (group) => (
    group.freshness === 'stale' ? 0
      : group.softwareVersion !== localVersion ? 1
        : group.softwareVersion === 'unknown' || group.runtime === 'unknown' ? 2
          : 3
  );
  const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));
  const compareAge = (a, b) => {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    return a - b;
  };
  remoteGroups.sort((a, b) => (
    priority(a) - priority(b)
    || b.count - a.count
    || compareText(a.softwareVersion, b.softwareVersion)
    || compareText(a.runtime, b.runtime)
    || compareText(a.platform, b.platform)
    || compareText(a.osName, b.osName)
    || compareText(a.osVersion, b.osVersion)
    || compareText(a.freshness, b.freshness)
    || compareAge(a.newestRecordAgeSeconds, b.newestRecordAgeSeconds)
    || compareAge(a.oldestRecordAgeSeconds, b.oldestRecordAgeSeconds)
  ));
  const selectedGroups = remoteGroups.slice(0, MAX_REMOTE_GROUPS_IN_REPORT);

  return {
    summarySource: options.summarySource || 'cached-hub-stats',
    summaryAvailable: true,
    notApplicable: false,
    deviceCount: devices.length,
    remoteDeviceCount: remote.length,
    includedRemoteGroupCount: selectedGroups.length,
    omittedRemoteGroupCount: Math.max(0, remoteGroups.length - selectedGroups.length),
    localDevice: localRaw ? projectDeviceCompatibility(localRaw, stats, nowMs) : null,
    remoteGroups: selectedGroups
  };
}

function projectLimitsDiagnostics(diagnostics = {}) {
  const providers = Array.isArray(diagnostics.providers) ? diagnostics.providers : [];
  return {
    enabled: diagnostics.enabled !== false,
    active: integer(diagnostics.active, 0),
    maxConcurrency: integer(diagnostics.maxConcurrency, null),
    queued: integer(diagnostics.queued, 0),
    omittedProviderCount: Math.max(0, providers.length - MAX_LIMIT_PROVIDERS_IN_REPORT),
    providers: providers.slice(0, MAX_LIMIT_PROVIDERS_IN_REPORT).map((provider) => {
      const rawFailure = provider?.lastFailureCode ?? provider?.failureCode;
      const notConfigured = isNotConfiguredFailure(rawFailure);
      const failure = notConfigured || isNoFailureCode(rawFailure)
        ? null
        : (rawFailure ? identifier(rawFailure, 'unknown') : null);
      const lastSuccessAt = isoTimestamp(provider?.lastSuccessAt);
      return {
        provider: identifier(provider?.provider),
        configured: provider?.configured !== false && (!notConfigured || Boolean(lastSuccessAt)),
        state: provider?.active
          ? 'active'
          : provider?.pending > 0
            ? 'pending'
            : failure
              ? 'failed'
              : lastSuccessAt
                ? 'ok'
                : notConfigured
                  ? 'not-configured'
                  : 'unknown',
        accountCount: integer(provider?.accountCount, 0),
        pendingCount: integer(provider?.pending, 0),
        retryAttempt: integer(provider?.retryAttempt, 0),
        retryAt: isoTimestamp(provider?.retryAt) || 'none',
        lastAttemptAt: isoTimestamp(provider?.lastAttemptAt),
        lastSuccessAt,
        failureCode: failure || 'none'
      };
    })
  };
}

function isNotConfiguredFailure(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'notconfigured' || normalized === 'not-configured';
}

function isNoFailureCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'none';
}

function sanitizeFinding(finding) {
  const code = text(finding?.code, 'unknown', 64);
  return {
    code: FINDING_CODES.has(code) ? code : 'unknown',
    ...(finding?.client ? { client: identifier(finding.client) } : {}),
    ...(finding?.provider ? { provider: identifier(finding.provider) } : {}),
    ...(finding?.detailCode ? { detailCode: identifier(finding.detailCode) } : {})
  };
}

function boundedCount(value, fallback = 0) {
  const count = integer(value, fallback);
  return count === null ? fallback : Math.max(0, Math.min(count, 1000000));
}

function boundedLargeInteger(value, fallback = null) {
  const count = integer(value, fallback);
  return count === null ? fallback : Math.max(0, Math.min(count, Number.MAX_SAFE_INTEGER));
}

function boundedNumber(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return number === null ? fallback : Math.max(0, Math.min(number, 1000000000));
}

function safeChoice(value, choices, fallback = 'unknown') {
  const choice = String(value || '').trim().toLowerCase();
  return choices.has(choice) ? choice : fallback;
}

function sanitizeWslStatus(status, platform) {
  if (platform && platform !== 'win32') return 'not-applicable';
  if (!status || typeof status !== 'object') return 'unknown';
  const detected = Array.isArray(status.detected)
    ? status.detected.map((client) => identifier(client, '')).filter(Boolean).slice(0, MAX_CLIENTS_IN_REPORT)
    : [];
  const withData = Array.isArray(status.withData)
    ? status.withData.map((client) => identifier(client, '')).filter(Boolean).slice(0, MAX_CLIENTS_IN_REPORT)
    : [];
  return {
    state: safeChoice(status.state, new Set(['disabled', 'unavailable', 'active', 'no-data', 'ok', 'not-applicable'])),
    detectedClientCount: detected.length,
    withDataClientCount: withData.length,
    detectedClients: detected,
    withDataClients: withData,
    observedAt: isoTimestamp(status.observedAt)
  };
}

function sanitizeCollector(collector = {}, platform) {
  const safe = {
    detailsAvailable: collector.detailsAvailable !== false,
    state: safeChoice(collector.state, new Set(['stopped', 'running', 'idle', 'failed', 'stale', 'unavailable'])),
    collectionMode: safeChoice(collector.collectionMode, new Set(['live', 'smart', 'interval'])),
    intervalMs: boundedNumber(collector.intervalMs),
    watchDebounceMs: boundedNumber(collector.watchDebounceMs),
    watchEnabled: collector.watchEnabled === true,
    watchMode: safeChoice(collector.watchMode, new Set(['native', 'polling', 'disabled'])),
    watchFallbackCode: collector.watchFallbackCode ? identifier(collector.watchFallbackCode) : 'none',
    lastWatchFailureCode: collector.lastWatchFailureCode ? identifier(collector.lastWatchFailureCode) : 'none',
    tickInFlight: collector.tickInFlight === true,
    tickPending: collector.tickPending === true,
    lastTickReasonCode: collector.lastTickReasonCode ? identifier(collector.lastTickReasonCode) : null,
    lastTickScope: collector.lastTickScope ? identifier(collector.lastTickScope) : null,
    lastTickAttemptAt: isoTimestamp(collector.lastTickAttemptAt),
    lastTickSuccessAt: isoTimestamp(collector.lastTickSuccessAt),
    lastTickFailureAt: isoTimestamp(collector.lastTickFailureAt) || 'none',
    lastTickDurationMs: boundedNumber(collector.lastTickDurationMs),
    lastFullScanAt: isoTimestamp(collector.lastFullScanAt),
    lastHistoryAttemptAt: isoTimestamp(collector.lastHistoryAttemptAt),
    lastHistorySuccessAt: isoTimestamp(collector.lastHistorySuccessAt),
    lastHistoryFailureCode: collector.lastHistoryFailureCode ? identifier(collector.lastHistoryFailureCode) : 'none',
    lastHistoryScanDurationMs: boundedNumber(collector.lastHistoryScanDurationMs),
    lastFailureCode: collector.lastFailureCode ? identifier(collector.lastFailureCode) : 'none',
    wslStatus: sanitizeWslStatus(collector.wslStatus, platform)
  };
  return safe;
}

function sanitizeClient(client = {}) {
  const sourceChecks = Array.isArray(client.sourceChecks)
    ? client.sourceChecks.slice(0, MAX_SOURCE_CHECKS_IN_REPORT).map((check) => ({
        id: identifier(check?.id),
        state: safeChoice(check?.state, new Set(['found', 'missing', 'unknown']))
      }))
    : [];
  const diagnosticCodes = Array.isArray(client.diagnosticCodes)
    ? client.diagnosticCodes.map((code) => identifier(code, '')).filter(Boolean).slice(0, 4)
    : [];
  const collectionState = safeCollectionState(client.collectionState);
  return {
    client: identifier(client.client),
    healthEntryAvailable: client.healthEntryAvailable === true,
    overall: safeClientState(client.overall),
    sourceState: safeSourceState(client.sourceState),
    detectedCount: boundedCount(client.detectedCount),
    checkedCount: boundedCount(client.checkedCount),
    sourceChecks,
    collectionState,
    syncFailureStage: collectionState === 'failed' ? normalizeClientSyncFailureStage(client.syncFailureStage) : null,
    syncDetailCode: collectionState === 'failed'
      ? (normalizeClientSyncDetailCode(client.syncDetailCode) || 'unknown')
      : null,
    syncExitCode: collectionState === 'failed' ? normalizeClientSyncExitCode(client.syncExitCode) : null,
    lastAttemptAt: isoTimestamp(client.lastAttemptAt),
    lastSuccessAt: isoTimestamp(client.lastSuccessAt),
    lastActivityDay: text(client.lastActivityDay, 'unknown', 16),
    observedAt: isoTimestamp(client.observedAt),
    tokens: {
      today: boundedLargeInteger(client.tokens?.today),
      month: boundedLargeInteger(client.tokens?.month),
      allTime: boundedLargeInteger(client.tokens?.allTime)
    },
    diagnosticCodes
  };
}

function sanitizeHubDevices(devices = {}) {
  const safeCompatibility = (device) => {
    if (!device || typeof device !== 'object') return null;
    return {
      softwareVersion: text(device.softwareVersion),
      runtime: identifier(device.runtime),
      platform: text(device.platform),
      osName: text(device.osName),
      osVersion: text(device.osVersion),
      recordAgeSeconds: boundedCount(device.recordAgeSeconds, null),
      freshness: safeChoice(device.freshness, new Set(['fresh', 'stale', 'unknown']))
    };
  };
  const localDevice = safeCompatibility(devices.localDevice);
  const remoteGroups = Array.isArray(devices.remoteGroups)
    ? devices.remoteGroups.slice(0, MAX_REMOTE_GROUPS_IN_REPORT).map((group) => {
      const { recordAgeSeconds: _recordAgeSeconds, ...compatibility } = safeCompatibility(group) || {};
      return {
        ...compatibility,
        count: boundedCount(group?.count),
        newestRecordAgeSeconds: boundedCount(group?.newestRecordAgeSeconds, null),
        oldestRecordAgeSeconds: boundedCount(group?.oldestRecordAgeSeconds, null)
      };
    })
    : [];
  return {
    summarySource: safeChoice(devices.summarySource, new Set(['cached-hub-stats', 'same-process-hub-cache', 'same-process-hub', 'not-applicable'])),
    summaryAvailable: devices.summaryAvailable === true,
    notApplicable: devices.notApplicable === true || devices.summarySource === 'not-applicable',
    deviceCount: boundedCount(devices.deviceCount),
    remoteDeviceCount: boundedCount(devices.remoteDeviceCount),
    includedRemoteGroupCount: boundedCount(devices.includedRemoteGroupCount, remoteGroups.length),
    omittedRemoteGroupCount: boundedCount(devices.omittedRemoteGroupCount)
      + Math.max(0, (Array.isArray(devices.remoteGroups) ? devices.remoteGroups.length : 0) - MAX_REMOTE_GROUPS_IN_REPORT),
    localDevice,
    remoteGroups
  };
}

function sanitizeJournal(journal = {}) {
  const events = Array.isArray(journal.events)
    ? journal.events.slice(-MAX_JOURNAL_EVENTS_IN_REPORT).map((event) => ({
        at: isoTimestamp(event?.at),
        subsystem: identifier(event?.subsystem),
        code: identifier(event?.code),
        ...(event?.detailCode ? { detailCode: identifier(event.detailCode) } : {}),
        ...(event?.scope ? { scope: identifier(event.scope) } : {}),
        ...(event?.client ? { client: identifier(event.client) } : {}),
        ...(event?.provider ? { provider: identifier(event.provider) } : {}),
        ...(event?.modeAtEvent ? { modeAtEvent: safeChoice(event.modeAtEvent, new Set(['local', 'client', 'host'])) } : {}),
        ...(event?.durationMs !== undefined ? { durationMs: boundedNumber(event.durationMs) } : {})
      }))
    : [];
  return {
    capacity: boundedCount(journal.capacity, 20),
    startedAt: isoTimestamp(journal.startedAt),
    omittedCount: boundedCount(journal.omittedCount)
      + Math.max(0, (Array.isArray(journal.events) ? journal.events.length : 0) - MAX_JOURNAL_EVENTS_IN_REPORT),
    events
  };
}

function sanitizeProcessGroup(group = {}, includePrivateMemory) {
  const safe = {
    count: boundedCount(group.count),
    workingSetMb: boundedNumber(group.workingSetMb),
    peakWorkingSetMaxMb: boundedNumber(group.peakWorkingSetMaxMb),
    cpuPercent: boundedNumber(group.cpuPercent)
  };
  if (includePrivateMemory) safe.privateMemoryMb = boundedNumber(group.privateMemoryMb);
  return safe;
}

function sanitizeResources(resources = {}) {
  const includePrivateMemory = resources.privateMemorySupported === true;
  const groups = resources.processGroups && typeof resources.processGroups === 'object' ? resources.processGroups : {};
  return {
    capturedAt: isoTimestamp(resources.capturedAt),
    resourceSnapshotScope: safeChoice(resources.resourceSnapshotScope, new Set(['electron-widget'])),
    resourceSampleKind: safeChoice(resources.resourceSampleKind, new Set(['interval'])),
    cpuSampleDurationMs: boundedNumber(resources.cpuSampleDurationMs),
    systemTotalMemoryMb: boundedNumber(resources.systemTotalMemoryMb),
    systemFreeMemoryMb: boundedNumber(resources.systemFreeMemoryMb),
    processCount: boundedCount(resources.processCount),
    aggregateWorkingSetMb: boundedNumber(resources.aggregateWorkingSetMb),
    aggregateCpuPercent: boundedNumber(resources.aggregateCpuPercent),
    externalAgentResourceMetricsAvailable: resources.externalAgentResourceMetricsAvailable === true,
    processGroups: {
      browser: sanitizeProcessGroup(groups.browser, includePrivateMemory),
      tab: sanitizeProcessGroup(groups.tab, includePrivateMemory),
      gpu: sanitizeProcessGroup(groups.gpu, includePrivateMemory),
      utility: sanitizeProcessGroup(groups.utility, includePrivateMemory),
      other: sanitizeProcessGroup(groups.other, includePrivateMemory)
    }
  };
}

function archivePresence(value) {
  if (value === true || value === false) return value;
  const normalized = String(value || '').trim().toLowerCase();
  return new Set(['unknown', 'not-applicable']).has(normalized) ? normalized : 'unknown';
}

function archiveSize(value) {
  if (value === 'not-applicable') return 'not-applicable';
  return boundedLargeInteger(value);
}

function sanitizeWorkload(workload = {}) {
  return {
    sessionArchiveEnabled: workload.sessionArchiveEnabled !== false,
    sessionArchivePresent: archivePresence(workload.sessionArchivePresent),
    sessionArchiveFileSizeBytes: archiveSize(workload.sessionArchiveFileSizeBytes),
    sessionArchiveSessionCount: boundedLargeInteger(workload.sessionArchiveSessionCount),
    sessionArchiveCountSource: safeChoice(workload.sessionArchiveCountSource, new Set(['loaded-memory', 'not-loaded', 'not-enabled', 'unavailable'])),
    lastSessionArchiveUpdateDurationMs: boundedNumber(workload.lastSessionArchiveUpdateDurationMs),
    lastSessionArchiveUpdateAt: isoTimestamp(workload.lastSessionArchiveUpdateAt),
    lastSessionArchiveFailureCode: workload.lastSessionArchiveFailureCode ? identifier(workload.lastSessionArchiveFailureCode) : null,
    lastCollectorTickDurationMs: boundedNumber(workload.lastCollectorTickDurationMs),
    lastCollectorTickScope: workload.lastCollectorTickScope ? identifier(workload.lastCollectorTickScope) : null,
    lastHistoryScanDurationMs: boundedNumber(workload.lastHistoryScanDurationMs)
  };
}

function sanitizeStorage(storage = {}) {
  return {
    settingsReadable: storage.settingsReadable !== false,
    settingsWritable: storage.settingsWritable === null || storage.settingsWritable === undefined
      ? null
      : storage.settingsWritable === true,
    archiveReadable: storage.archiveReadable === null || storage.archiveReadable === undefined
      ? null
      : storage.archiveReadable === true,
    archiveWritable: storage.archiveWritable === null || storage.archiveWritable === undefined
      ? null
      : storage.archiveWritable === true,
    archiveStatFailureCode: storage.archiveStatFailureCode ? identifier(storage.archiveStatFailureCode) : null
  };
}

function deriveDiagnosticFindings(snapshot, nowMs = Date.now()) {
  const findings = [];
  const usage = snapshot.usage || {};
  const topology = snapshot.topology || {};
  const collector = snapshot.collector || {};
  const limits = snapshot.limits || {};
  const workload = snapshot.workload || {};
  const add = (finding) => findings.push(sanitizeFinding(finding));

  if (collector.detailsAvailable !== false) {
    if (!isNoFailureCode(collector.lastFailureCode)) add({ code: 'collector-failed' });
    const lastSuccessAge = ageSecondsFromValue(collector.lastTickSuccessAt, nowMs);
    const intervalMs = finiteNumber(collector.intervalMs, 0);
    if (!collector.lastTickSuccessAt || (lastSuccessAge !== null && intervalMs > 0 && lastSuccessAge * 1000 > Math.max(intervalMs * 2, 60 * 1000))) {
      if (isNoFailureCode(collector.lastFailureCode)) add({ code: 'collector-stale' });
    }
    if (collector.watchMode === 'polling' && collector.watchFallbackCode && !isNoFailureCode(collector.watchFallbackCode)) {
      add({ code: 'watcher-polling-fallback', detailCode: collector.watchFallbackCode });
    }
    if (collector.lastWatchFailureCode && !isNoFailureCode(collector.lastWatchFailureCode)) add({ code: 'watcher-rebuild-failed' });
  }
  if (topology.streamState === 'disconnected') add({ code: 'stream-disconnected', detailCode: topology.lastStreamFailureCode });
  const usageStaleAfterSeconds = finiteNumber(usage.usageStaleAfterSeconds, 600);
  if (usage.usageOwner === 'external-agent' && usage.usageObservationAgeSeconds !== null && usage.usageObservationAgeSeconds > usageStaleAfterSeconds) {
    add({ code: 'external-agent-stale' });
  }
  for (const client of snapshot.clients?.clients || []) {
    if (client?.collectionState !== 'failed') continue;
    const detailCode = (Array.isArray(client.diagnosticCodes) ? client.diagnosticCodes : [])
      .map((code) => String(code || '').trim().toLowerCase())
      .find((code) => SELF_SYNC_FAILURE_CODES.has(code));
    if (detailCode) add({ code: 'client-sync-failed', client: client.client, detailCode });
  }
  for (const provider of limits.providers || []) {
    const failureCode = provider.failureCode || provider.lastFailureCode;
    if (!isNoFailureCode(failureCode) && !isNotConfiguredFailure(failureCode)) {
      add({ code: 'limits-provider-failed', provider: provider.provider });
    }
  }
  if (workload.sessionArchiveEnabled !== false
    && usage.usageOwner === 'electron-widget'
    && !isNoFailureCode(workload.lastSessionArchiveFailureCode)) {
    add({ code: 'storage-archive-write-failed', detailCode: workload.lastSessionArchiveFailureCode });
  }
  return findings;
}

function sanitizeDiagnosticSnapshot(input = {}) {
  const report = input.report || {};
  const environment = input.environment || {};
  const configuration = input.configuration || {};
  const topology = input.topology || {};
  const usage = input.usage || {};
  const collector = sanitizeCollector(input.collector || {}, environment.platform);
  const clients = input.clients || {};
  const limits = projectLimitsDiagnostics(input.limits || {});
  const journal = sanitizeJournal(input.journal || {});
  const resources = sanitizeResources(input.resources || {});
  const workload = sanitizeWorkload(input.workload || {});
  const storage = sanitizeStorage(input.storage || {});
  const findings = Array.isArray(input.findings) ? input.findings.map(sanitizeFinding) : [];

  return {
    report: {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      redactionVersion: DIAGNOSTIC_REDACTION_VERSION,
      generatedAt: isoTimestamp(report.generatedAt) || new Date().toISOString(),
      timezone: text(report.timezone),
      reportCompleteness: text(report.reportCompleteness),
      usageCompleteness: text(report.usageCompleteness),
      limitsCompleteness: text(report.limitsCompleteness),
      journalScope: text(report.journalScope),
      journalStartedAt: isoTimestamp(report.journalStartedAt),
      journalOmittedCount: integer(report.journalOmittedCount, 0)
    },
    environment: {
      appVersion: text(environment.appVersion),
      electronVersion: text(environment.electronVersion),
      nodeVersion: text(environment.nodeVersion),
      chromiumVersion: text(environment.chromiumVersion),
      tokscaleVersion: text(environment.tokscaleVersion),
      tokscaleSource: text(environment.tokscaleSource),
      packaged: environment.packaged === true,
      platform: text(environment.platform),
      osName: text(environment.osName),
      osVersion: text(environment.osVersion),
      architecture: text(environment.architecture),
      languageSetting: text(environment.languageSetting ?? environment.locale, 'auto'),
      resolvedLocale: text(environment.resolvedLocale, 'unknown'),
      appUptimeSeconds: integer(environment.appUptimeSeconds, null)
    },
    configuration: {
      configurationSource: text(configuration.configurationSource, 'unknown', 64),
      allTimeSince: dateKey(configuration.allTimeSince),
      historyEnabled: booleanOrUnknown(configuration.historyEnabled),
      historyIntervalMs: integer(configuration.historyIntervalMs, null),
      projectsEnabled: booleanOrUnknown(configuration.projectsEnabled),
      wslScanEnabled: booleanOrUnknown(configuration.wslScanEnabled),
      syncUploadIntervalMs: integer(configuration.syncUploadIntervalMs, null),
      limitsRefreshMode: text(configuration.limitsRefreshMode, 'unknown', 16),
      limitsRefreshMs: integer(configuration.limitsRefreshMs, null)
    },
    topology: {
      hubMode: text(topology.hubMode),
      hubTarget: text(topology.hubTarget),
      hubTransport: text(topology.hubTransport),
      externalAgentAlive: topology.externalAgentAlive === true,
      usageOwner: text(topology.usageOwner),
      limitsOwner: text(topology.limitsOwner),
      streamState: text(topology.streamState),
      lastStreamFailureCode: text(topology.lastStreamFailureCode, 'none', 64),
      embeddedHubRunning: topology.embeddedHubRunning === true,
      hubStatsCacheAgeSeconds: topology.hubStatsCacheAgeSeconds === 'not-applicable'
        ? 'not-applicable'
        : integer(topology.hubStatsCacheAgeSeconds, null)
    },
    hub: {
      runtime: {
        hubKind: text(input.hub?.runtime?.hubKind),
        hubSoftwareVersion: text(input.hub?.runtime?.hubSoftwareVersion),
        hubSoftwareVersionSource: text(input.hub?.runtime?.hubSoftwareVersionSource),
        hubTarget: text(input.hub?.runtime?.hubTarget),
        hubTransport: text(input.hub?.runtime?.hubTransport),
        streamState: text(input.hub?.runtime?.streamState),
        hubStatsCacheAgeSeconds: input.hub?.runtime?.hubStatsCacheAgeSeconds === 'not-applicable'
          ? 'not-applicable'
          : integer(input.hub?.runtime?.hubStatsCacheAgeSeconds, null)
      },
      devices: sanitizeHubDevices(input.hub?.devices || {})
    },
    usage: {
      usageOwner: text(usage.usageOwner),
      localUsageRuntimePresent: usage.localUsageRuntimePresent === true,
      usageRefreshAllowed: usage.usageRefreshAllowed === true,
      usageCompleteness: text(usage.usageCompleteness),
      usageJournalAvailable: usage.usageJournalAvailable === true,
      localRecordAgeSeconds: integer(usage.localRecordAgeSeconds, null),
      usageObservationAgeSeconds: integer(usage.usageObservationAgeSeconds, null),
      usageStaleAfterSeconds: integer(usage.usageStaleAfterSeconds, null),
      limitsOwner: text(usage.limitsOwner),
      limitsCompleteness: text(usage.limitsCompleteness)
    },
    collector,
    clients: {
      available: clients.available === true,
      observedAt: isoTimestamp(clients.observedAt),
      trackedClientCount: integer(clients.trackedClientCount, 0),
      healthEntryCount: integer(clients.healthEntryCount, 0),
      missingHealthEntryCount: integer(clients.missingHealthEntryCount, 0),
      omittedClientCount: Math.max(0, integer(clients.omittedClientCount, 0))
        + Math.max(0, (Array.isArray(clients.clients) ? clients.clients.length : 0) - MAX_CLIENTS_IN_REPORT),
      counts: {
        healthy: boundedCount(clients.counts?.healthy),
        waiting: boundedCount(clients.counts?.waiting),
        attention: boundedCount(clients.counts?.attention),
        unavailable: boundedCount(clients.counts?.unavailable),
        unknown: boundedCount(clients.counts?.unknown)
      },
      clients: Array.isArray(clients.clients) ? clients.clients.slice(0, MAX_CLIENTS_IN_REPORT).map(sanitizeClient) : []
    },
    limits,
    findings,
    journal,
    resources,
    workload,
    storage
  };
}

function lineValue(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return text(value, 'unknown');
}

function line(key, value, indent = '') {
  return `${indent}${key}: ${lineValue(value)}`;
}

function section(title, lines) {
  return [`[${title}]`, ...lines, ''].join('\n');
}

function formatClient(client) {
  const lines = [
    `  - ${line('client', client.client)}`,
    line('overall', client.overall, '    '),
    line('healthEntryAvailable', client.healthEntryAvailable, '    '),
    line('sourceState', client.sourceState, '    '),
    line('detectedCount', client.detectedCount, '    '),
    line('checkedCount', client.checkedCount, '    '),
    line('collectionState', client.collectionState, '    '),
    ...(client.collectionState === 'failed' && client.syncFailureStage
      ? [line('syncFailureStage', client.syncFailureStage, '    ')]
      : []),
    ...(client.collectionState === 'failed' && client.syncDetailCode
      ? [line('syncDetailCode', client.syncDetailCode, '    ')]
      : []),
    ...(client.collectionState === 'failed' && client.syncExitCode !== null && client.syncExitCode !== undefined
      ? [line('syncExitCode', client.syncExitCode, '    ')]
      : []),
    line('lastAttemptAt', client.lastAttemptAt, '    '),
    line('lastSuccessAt', client.lastSuccessAt, '    '),
    line('lastActivityDay', client.lastActivityDay, '    '),
    line('todayTokens', client.tokens?.today, '    '),
    line('monthTokens', client.tokens?.month, '    '),
    line('allTimeTokens', client.tokens?.allTime, '    '),
    line('diagnosticCodes', (client.diagnosticCodes || []).join(', ') || 'none', '    ')
  ];
  if (client.sourceChecks?.length) {
    lines.push('    sourceChecks:');
    for (const check of client.sourceChecks) lines.push(`      ${text(check.id)}: ${text(check.state)}`);
  }
  return lines.join('\n');
}

function formatProvider(provider) {
  return [
    `  - ${line('provider', provider.provider)}`,
    line('state', provider.state, '    '),
    line('configured', provider.configured, '    '),
    line('accountCount', provider.accountCount, '    '),
    line('pendingCount', provider.pendingCount, '    '),
    line('retryAttempt', provider.retryAttempt, '    '),
    line('retryAt', provider.retryAt, '    '),
    line('lastAttemptAt', provider.lastAttemptAt, '    '),
    line('lastSuccessAt', provider.lastSuccessAt, '    '),
    line('failureCode', provider.failureCode, '    ')
  ].join('\n');
}

function formatRemoteGroup(group) {
  return [
    `  - ${line('count', group.count)}`,
    line('softwareVersion', group.softwareVersion, '    '),
    line('runtime', group.runtime, '    '),
    line('platform', group.platform, '    '),
    line('osName', group.osName, '    '),
    line('osVersion', group.osVersion, '    '),
    line('freshness', group.freshness, '    '),
    line('newestRecordAgeSeconds', group.newestRecordAgeSeconds, '    '),
    line('oldestRecordAgeSeconds', group.oldestRecordAgeSeconds, '    ')
  ].join('\n');
}

function formatProcessGroup(name, group) {
  return [
    `${name}:`,
    line('count', group?.count, '  '),
    line('workingSetMb', group?.workingSetMb, '  '),
    line('peakWorkingSetMaxMb', group?.peakWorkingSetMaxMb, '  '),
    line('cpuPercent', group?.cpuPercent, '  '),
    ...(group?.privateMemoryMb !== undefined ? [line('privateMemoryMb', group.privateMemoryMb, '  ')] : [])
  ].join('\n');
}

function renderReport(snapshot, selected) {
  const originalClients = snapshot.clients.clients || [];
  const originalProviders = snapshot.limits.providers || [];
  const originalGroups = snapshot.hub.devices.remoteGroups || [];
  const originalEvents = snapshot.journal.events || [];
  const omittedClientCount = (snapshot.clients.omittedClientCount || 0) + originalClients.length - selected.clients.length;
  const omittedLimitProviderCount = (snapshot.limits.omittedProviderCount || 0) + originalProviders.length - selected.providers.length;
  const omittedRemoteGroupCount = (snapshot.hub.devices.omittedRemoteGroupCount || 0) + originalGroups.length - selected.groups.length;
  const omittedJournalCount = originalEvents.length - selected.events.length;
  const truncated = omittedClientCount + omittedLimitProviderCount + omittedRemoteGroupCount + omittedJournalCount > 0;
  const journalOmittedCount = snapshot.report.journalOmittedCount + snapshot.journal.omittedCount + omittedJournalCount;
  const lines = [
    'Token Monitor Diagnostic Report',
    line('schemaVersion', snapshot.report.schemaVersion),
    line('redactionVersion', snapshot.report.redactionVersion),
    line('generatedAt', snapshot.report.generatedAt),
    line('timezone', snapshot.report.timezone),
    line('reportCompleteness', snapshot.report.reportCompleteness),
    line('usageCompleteness', snapshot.report.usageCompleteness),
    line('limitsCompleteness', snapshot.report.limitsCompleteness),
    line('journalScope', snapshot.report.journalScope),
    line('journalStartedAt', snapshot.report.journalStartedAt),
    line('journalOmittedCount', journalOmittedCount),
    line('findingCount', snapshot.findings.length),
    line('includedClientCount', selected.clients.length),
    line('omittedClientCount', omittedClientCount),
    line('includedLimitProviderCount', selected.providers.length),
    line('omittedLimitProviderCount', omittedLimitProviderCount),
    line('includedRemoteGroupCount', selected.groups.length),
    line('omittedRemoteGroupCount', omittedRemoteGroupCount),
    line('includedJournalEventCount', selected.events.length),
    line('truncated', truncated),
    ''
  ];

  lines.push(section('Environment', Object.entries(snapshot.environment).map(([key, value]) => line(key, value)).join('\n').split('\n')));
  lines.push(section('Configuration', Object.entries(snapshot.configuration).map(([key, value]) => line(key, value)).join('\n').split('\n')));
  lines.push(section('Hub Runtime', Object.entries(snapshot.hub.runtime).map(([key, value]) => line(key, value)).join('\n').split('\n')));
  const hubDevices = snapshot.hub.devices;
  const hubDeviceLines = hubDevices.notApplicable
    ? [line('notApplicable', true)]
    : [
        line('summarySource', hubDevices.summarySource),
        line('summaryAvailable', hubDevices.summaryAvailable),
        line('deviceCount', hubDevices.deviceCount),
        line('remoteDeviceCount', hubDevices.remoteDeviceCount),
        line('includedRemoteGroupCount', selected.groups.length),
        line('omittedRemoteGroupCount', omittedRemoteGroupCount)
      ];
  if (!hubDevices.notApplicable) {
    if (hubDevices.localDevice) {
      hubDeviceLines.push('localDevice:');
      for (const [key, value] of Object.entries(hubDevices.localDevice)) hubDeviceLines.push(line(key, value, '  '));
    } else hubDeviceLines.push(line('localDevice', 'unavailable'));
    hubDeviceLines.push('remoteGroups:');
    for (const group of selected.groups) hubDeviceLines.push(formatRemoteGroup(group));
  }
  lines.push(section('Hub Devices', hubDeviceLines));

  const usageLines = Object.entries(snapshot.usage).map(([key, value]) => line(key, value));
  lines.push(section('Usage and Limits Topology', usageLines));
  const collectorLines = Object.entries(snapshot.collector)
    .filter(([key]) => key !== 'wslStatus')
    .map(([key, value]) => line(key, value));
  if (snapshot.collector.wslStatus && typeof snapshot.collector.wslStatus === 'object') {
    collectorLines.push('wslStatus:');
    for (const [key, value] of Object.entries(snapshot.collector.wslStatus)) collectorLines.push(line(key, value, '  '));
  } else {
    collectorLines.push(line('wslStatus', snapshot.collector.wslStatus));
  }
  lines.push(section('Collector', collectorLines));

  const clientLines = [
    line('available', snapshot.clients.available),
    line('observedAt', snapshot.clients.observedAt),
    line('trackedClientCount', snapshot.clients.trackedClientCount),
    line('healthEntryCount', snapshot.clients.healthEntryCount),
    line('missingHealthEntryCount', snapshot.clients.missingHealthEntryCount),
    line('counts', Object.entries(snapshot.clients.counts || {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'none')
  ];
  for (const client of selected.clients) clientLines.push(formatClient(client));
  lines.push(section('Clients', clientLines));

  const limitLines = [
    line('enabled', snapshot.limits.enabled),
    line('active', snapshot.limits.active),
    line('maxConcurrency', snapshot.limits.maxConcurrency),
    line('queued', snapshot.limits.queued)
  ];
  for (const provider of selected.providers) limitLines.push(formatProvider(provider));
  lines.push(section('Limits', limitLines));

  const findingLines = snapshot.findings.length > 0
    ? snapshot.findings.map((finding) => `- ${finding.code}${finding.client ? ` client=${finding.client}` : ''}${finding.provider ? ` provider=${finding.provider}` : ''}`)
    : ['- none'];
  lines.push(section('Findings', findingLines));

  const eventLines = selected.events.length > 0
    ? selected.events.map((event) => `- ${event.at} ${event.subsystem}/${event.code}${event.modeAtEvent ? ` mode=${event.modeAtEvent}` : ''}${event.detailCode ? ` detail=${event.detailCode}` : ''}${event.client ? ` client=${event.client}` : ''}${event.provider ? ` provider=${event.provider}` : ''}`)
    : ['- none'];
  lines.push(section('Recent State Transitions', eventLines));

  const resources = snapshot.resources;
  const resourceLines = Object.entries(resources)
    .filter(([key]) => key !== 'processGroups')
    .map(([key, value]) => line(key, value));
  for (const [name, group] of Object.entries(resources.processGroups || {})) resourceLines.push(formatProcessGroup(name, group));
  lines.push(section('Resources', resourceLines));
  lines.push(section('Workload', Object.entries(snapshot.workload).map(([key, value]) => line(key, value)).join('\n').split('\n')));
  lines.push(section('Storage', Object.entries(snapshot.storage).map(([key, value]) => line(key, value)).join('\n').split('\n')));
  return lines.join('\n');
}

function formatDiagnosticReport(input) {
  const snapshot = sanitizeDiagnosticSnapshot(input);
  const original = {
    clients: snapshot.clients.clients.slice(),
    providers: snapshot.limits.providers.slice(),
    groups: (snapshot.hub.devices.remoteGroups || []).slice(),
    events: (snapshot.journal.events || []).slice()
  };
  const selected = {
    clients: original.clients.slice(),
    providers: original.providers.slice(),
    groups: original.groups.slice(),
    events: original.events.slice()
  };

  for (;;) {
    const textValue = renderReport(snapshot, selected);
    if (Buffer.byteLength(textValue, 'utf8') <= MAX_REPORT_BYTES) {
      return {
        generatedAt: snapshot.report.generatedAt,
        completeness: snapshot.report.reportCompleteness,
        text: textValue,
        bytes: Buffer.byteLength(textValue, 'utf8'),
        truncated: snapshot.clients.omittedClientCount > 0
          || snapshot.limits.omittedProviderCount > 0
          || snapshot.hub.devices.omittedRemoteGroupCount > 0
          || snapshot.journal.omittedCount > 0
          || original.clients.length !== selected.clients.length
          || original.providers.length !== selected.providers.length
          || original.groups.length !== selected.groups.length
          || original.events.length !== selected.events.length,
        includedClientCount: selected.clients.length,
        omittedClientCount: snapshot.clients.omittedClientCount + original.clients.length - selected.clients.length,
        includedLimitProviderCount: selected.providers.length,
        omittedLimitProviderCount: snapshot.limits.omittedProviderCount + original.providers.length - selected.providers.length,
        includedRemoteGroupCount: selected.groups.length,
        omittedRemoteGroupCount: snapshot.hub.devices.omittedRemoteGroupCount + original.groups.length - selected.groups.length,
        includedJournalEventCount: selected.events.length,
        journalOmittedCount: snapshot.report.journalOmittedCount + snapshot.journal.omittedCount + original.events.length - selected.events.length
      };
    }
    if (selected.clients.length > 0) selected.clients.pop();
    else if (selected.providers.length > 0) selected.providers.pop();
    else if (selected.groups.length > 0) selected.groups.pop();
    else if (selected.events.length > 0) selected.events.shift();
    else {
      // All variable-length data is bounded above. This fallback only protects
      // the fixed fields if a future schema adds an unexpectedly large value.
      const minimal = `${textValue.split('\n\n')[0]}\n\n[Findings]\n- report-too-large\n`;
      return {
        generatedAt: snapshot.report.generatedAt,
        completeness: snapshot.report.reportCompleteness,
        text: minimal,
        bytes: Buffer.byteLength(minimal, 'utf8'),
        truncated: true,
        includedClientCount: 0,
        omittedClientCount: snapshot.clients.omittedClientCount + original.clients.length,
        includedLimitProviderCount: 0,
        omittedLimitProviderCount: snapshot.limits.omittedProviderCount + original.providers.length,
        includedRemoteGroupCount: 0,
        omittedRemoteGroupCount: snapshot.hub.devices.omittedRemoteGroupCount + original.groups.length,
        includedJournalEventCount: 0,
        journalOmittedCount: snapshot.report.journalOmittedCount + snapshot.journal.omittedCount + original.events.length
      };
    }
  }
}

module.exports = {
  DIAGNOSTIC_REDACTION_VERSION,
  DIAGNOSTIC_SCHEMA_VERSION,
  MAX_REPORT_BYTES,
  deriveDiagnosticFindings,
  formatDiagnosticReport,
  projectClientHealth,
  projectDeviceCompatibility,
  projectHubDevices,
  projectLimitsDiagnostics,
  sanitizeDiagnosticSnapshot
};
