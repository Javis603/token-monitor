'use strict';

const { aggregateDevices, normalizeDeviceRecord, normalizePeriod } = require('../shared/usage');
const { deviceHistoryRevision } = require('../shared/history');
const { pickRecentUsageActivity } = require('../shared/trayText');
const { grokBotSessionIdsForMaps } = require('./renderer/sessionRows');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function attachLocalNativeViews(stats, localDevice) {
  if (!stats || typeof stats !== 'object') return stats;
  // Hub aggregates intentionally discard these fields. Remove any accidental
  // legacy copy before overlaying the current local device, so native session
  // data can never look like it came from another device.
  delete stats.nativeSessions;
  delete stats.nativeProjects;
  delete stats.localRecentUsageActivity;
  // Electron-only identity evidence travels with this snapshot, not with the
  // device/Hub record. Look up only current DAY/MONTH ids in captured history;
  // completing the full summary here would defeat lazy all-time composition.
  stats.grokBotSessionIds = grokBotSessionIdsForMaps([
    stats.periods?.today?.sessions, stats.periods?.month?.sessions
  ], [localDevice && rawAllTime(localDevice)?.sessions, stats.periods?.allTime?.sessions]);
  if (hasOwn(localDevice, 'nativeSessions')) stats.nativeSessions = localDevice.nativeSessions;
  if (hasOwn(localDevice, 'nativeProjects')) stats.nativeProjects = localDevice.nativeProjects;
  // The tray's recent provider is a local-only presentation projection. Build
  // it here, before the renderer sees cross-device aggregate sessions, and
  // never add it to the device record or Hub payload.
  const activity = pickRecentUsageActivity({
    periods: localDevice?.periods || {
      today: localDevice?.today,
      month: localDevice?.month,
      allTime: localDevice?.allTime
    },
    nativeSessions: localDevice?.nativeSessions
  });
  if (activity) stats.localRecentUsageActivity = activity;
  return stats;
}

function attachLocalPresentationNativeViews(stats, options = {}) {
  // The anchor is a presentation fallback, not a completed observation. Once
  // collection succeeds, the live record always owns the overlay.
  const localDevice = options.lastCollectedDevice
    || (options.mode === 'local' ? options.seededLocalDevice : null);
  return attachLocalNativeViews(stats, localDevice);
}

// Each local collection replaces the record rather than mutating it, and every
// Hub event in between recomposes it again. Normalizing it once per record takes
// the largest share of a recompose off the main thread. A summary normalizes the
// record with its all-time session list already emptied: those sessions are
// most of the normalization, and a summary would only drop them afterwards. The
// full normalization then adds just the all-time period to the summary's, so a
// view that completes every summary does not normalize today and month twice.
const normalizedLocalSummaries = new WeakMap();
const normalizedLocalRecords = new WeakMap();

// A local record carries its periods at the top level, a wire record under
// `periods`; normalizeDeviceRecord() reads either, preferring the top level.
function rawAllTime(record) {
  return record.allTime || record.periods?.allTime;
}

function withoutRawAllTimeSessions(record) {
  const stripped = { ...record };
  if (record.allTime?.sessions) stripped.allTime = { ...record.allTime, sessions: {} };
  if (record.periods?.allTime?.sessions) {
    stripped.periods = { ...record.periods, allTime: { ...record.periods.allTime, sessions: {} } };
  }
  return stripped;
}

function normalizedLocalSummary(localDevice) {
  let normalized = normalizedLocalSummaries.get(localDevice);
  if (!normalized) {
    normalized = normalizeDeviceRecord(withoutRawAllTimeSessions(localDevice));
    normalizedLocalSummaries.set(localDevice, normalized);
  }
  return normalized;
}

function normalizedLocalRecord(localDevice) {
  let normalized = normalizedLocalRecords.get(localDevice);
  if (!normalized) {
    const summary = normalizedLocalSummary(localDevice);
    const allTime = normalizePeriod(rawAllTime(localDevice), { projectsEnabled: summary.projectsEnabled !== false });
    normalized = { ...summary, periods: { ...summary.periods, allTime } };
    normalizedLocalRecords.set(localDevice, normalized);
  }
  return normalized;
}

const summaryRecords = new WeakMap();

function withoutAllTimeSessions(record) {
  const allTime = record?.periods?.allTime;
  if (!allTime?.sessions) return record;
  let summary = summaryRecords.get(record);
  if (!summary) {
    summary = { ...record, periods: { ...record.periods, allTime: { ...allTime, sessions: {} } } };
    summaryRecords.set(record, summary);
  }
  return summary;
}

function composeLocalSyncStats(hubStats, localDevice, options = {}) {
  if (!localDevice?.deviceId) return hubStats;
  if (hubStats && !Array.isArray(hubStats.devices)) return hubStats;

  const hubDevices = Array.isArray(hubStats?.devices) ? hubStats.devices : [];
  const localDeviceId = String(localDevice.deviceId);
  const previousDevices = new Map(hubDevices.map((device) => [String(device?.deviceId || ''), device]));
  const devices = hubDevices
    .filter((device) => String(device?.deviceId || '') !== localDeviceId)
    .concat(localDevice);
  const hubStaleAfterMs = nonNegativeNumber(hubStats?.staleAfterMs);
  const hasHubStaleAfterMs = hubStaleAfterMs !== null;
  const normalize = (record) => (record === localDevice ? normalizedLocalRecord(localDevice) : normalizeDeviceRecord(record));
  const summarize = (record) => (record === localDevice
    ? normalizedLocalSummary(localDevice)
    : withoutAllTimeSessions(normalizeDeviceRecord(record)));
  const aggregate = aggregateDevices(devices, hubStaleAfterMs ?? 0, options.nowMs, {
    normalizeRecord: options.allTimeSessions === false ? summarize : normalize
  });

  aggregate.devices = aggregate.devices.map((device) => {
    const previous = previousDevices.get(device.deviceId);
    // The live record replaces this device's receivedAt with the collection
    // time; the Hub's copy is the only proof an upload landed, so it travels
    // alongside for the sync settings panel (null until the Hub has one).
    if (device.deviceId === localDeviceId) {
      return { ...previous, ...device, hubReceivedAt: previous?.receivedAt || null };
    }
    if (!previous) return device;
    if (hasHubStaleAfterMs) return { ...previous, ...device };
    return {
      ...previous,
      ...device,
      stale: previous.stale,
      ageMs: previous.ageMs
    };
  });

  const displayStats = {
    ...(hubStats || {}),
    updatedAt: aggregate.updatedAt,
    periods: aggregate.periods,
    devices: aggregate.devices,
    projectsIncomplete: aggregate.projectsIncomplete,
    limits: hasHubStaleAfterMs || !hasOwn(hubStats, 'limits') ? aggregate.limits : hubStats.limits
  };
  // The local collector can own fresher History than the Hub copy currently
  // represented by its revision. Include that overlay in the display cache key
  // so fixed ranges refetch immediately instead of waiting for the next upload.
  displayStats.deviceHistoryRevision = `${String(
    hubStats?.deviceHistoryRevision || hubStats?.historyRevision || ''
  )}:${deviceHistoryRevision([localDevice])}`;
  attachLocalNativeViews(displayStats, localDevice);

  for (const key of ['sessionDetailsOmitted', 'periodProjectsOmitted']) {
    if (hasOwn(aggregate, key)) displayStats[key] = aggregate[key];
    else delete displayStats[key];
  }

  return displayStats;
}

// Most of a recompose is merging this machine's all-time sessions, which no
// per-publish reader needs: the Hub strips them from uploads (#118), so the list
// is only ever shown whole, on request. A publish composes without them, and the
// exporter and the renderer's session list complete that same snapshot when
// they ask. The completion is composed from the publish's own inputs and clock,
// so it agrees with the summary it completes.
const completions = new WeakMap();
const { applyActivityPatch, materializeActivity } = require('../shared/sessionActivityProjection');
const localActivity = new WeakMap();

// Keep lazy all-time completion tied to the same accounting snapshot while
// refreshing its small local metadata overlay. No aggregation on a heartbeat.
function projectLocalActivity(stats, patch, now = Date.now()) {
  if (!stats) return stats;
  const prior = localActivity.get(stats);
  const observations = new Map((prior?.patch.observations || []).filter((row) =>
    now - Date.parse(row.liveActivity.observedAt) < 30_000).map((row) => [`${row.client}:${row.sessionId}`, row]));
  for (const row of patch.observations) observations.set(`${row.client}:${row.sessionId}`, row);
  const merged = { ...patch, observations: [...observations.values()] };
  const next = applyActivityPatch(stats, patch);
  const base = prior?.base || completions.get(stats);
  localActivity.set(next, { base, patch: merged });
  if (base) completions.set(next, { compose: () => applyActivityPatch(base.complete ||= base.compose(), merged), complete: null });
  return next;
}

function localActivityPatch(stats) { return localActivity.get(stats)?.patch; }

function composeLocalSyncSummary(hubStats, localDevice, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const summary = composeLocalSyncStats(hubStats, localDevice, { nowMs, allTimeSessions: false });
  if (summary && summary !== hubStats) {
    completions.set(summary, { compose: () => composeLocalSyncStats(hubStats, localDevice, { nowMs }), complete: null });
  }
  return summary;
}

// Local mode's publish: this machine's record alone, summarised the same way.
// `finish` adds what main layers on top of the aggregate, to the summary now and
// to its completion when that is asked for.
function composeLocalOnlySummary(localDevice, finish, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const compose = (normalizeRecord) => finish(aggregateDevices([localDevice], 0, nowMs, { normalizeRecord }));
  const summary = compose(normalizedLocalSummary);
  completions.set(summary, { compose: () => compose(normalizedLocalRecord), complete: null });
  return summary;
}

// Any other stats object is already complete and comes back as it is.
function completeLocalSyncStats(stats) {
  const entry = stats && typeof stats === 'object' ? completions.get(stats) : null;
  if (!entry) return materializeActivity(stats);
  if (!entry.complete) entry.complete = materializeActivity(entry.compose());
  return entry.complete;
}

module.exports = {
  attachLocalNativeViews,
  attachLocalPresentationNativeViews,
  completeLocalSyncStats,
  composeLocalOnlySummary,
  composeLocalSyncStats,
  composeLocalSyncSummary,
  projectLocalActivity,
  localActivityPatch
};
