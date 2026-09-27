'use strict';

const { aggregateDevices, normalizeDeviceRecord } = require('../shared/usage');
const { deviceHistoryRevision } = require('../shared/history');
const { pickRecentUsageActivity } = require('../shared/trayText');

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
// the largest share of a recompose off the main thread.
const normalizedLocalRecords = new WeakMap();

function normalizedLocalRecord(localDevice) {
  let normalized = normalizedLocalRecords.get(localDevice);
  if (!normalized) {
    normalized = normalizeDeviceRecord(localDevice);
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
  const aggregate = aggregateDevices(devices, hubStaleAfterMs ?? 0, options.nowMs, {
    normalizeRecord: options.allTimeSessions === false ? (record) => withoutAllTimeSessions(normalize(record)) : normalize
  });

  aggregate.devices = aggregate.devices.map((device) => {
    const previous = previousDevices.get(device.deviceId);
    if (!previous) return device;
    if (device.deviceId === localDeviceId) return { ...previous, ...device };
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

function composeLocalSyncSummary(hubStats, localDevice, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const summary = composeLocalSyncStats(hubStats, localDevice, { nowMs, allTimeSessions: false });
  if (summary && summary !== hubStats) completions.set(summary, { hubStats, localDevice, nowMs, complete: null });
  return summary;
}

// Any other stats object is already complete and comes back as it is.
function completeLocalSyncStats(stats) {
  const entry = stats && typeof stats === 'object' ? completions.get(stats) : null;
  if (!entry) return stats;
  if (!entry.complete) entry.complete = composeLocalSyncStats(entry.hubStats, entry.localDevice, { nowMs: entry.nowMs });
  return entry.complete;
}

module.exports = {
  attachLocalNativeViews,
  attachLocalPresentationNativeViews,
  completeLocalSyncStats,
  composeLocalSyncStats,
  composeLocalSyncSummary
};
