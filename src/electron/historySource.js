'use strict';

const { coerceHistory, deviceHistoryState } = require('../shared/history');

function parseCompleteHistory(payload) {
  return coerceHistory(payload);
}

// `historyAvailable: true` is only a capability statement. Collector snapshots
// carry it even on ticks that did not publish a History payload, so it cannot
// displace a Hub record's last-good history. An actual payload, or an explicit
// disabled state, is authoritative.
function hasAuthoritativeHistoryState(device) {
  return Object.prototype.hasOwnProperty.call(device || {}, 'history')
    || device?.historyOmitted === true
    || device?.historyAvailable === false;
}

function parseDeviceHistories(payload) {
  const devices = Array.isArray(payload) ? payload : payload?.devices;
  const histories = {};
  for (const device of Array.isArray(devices) ? devices : []) {
    const deviceId = String(device?.deviceId || device?.id || '').trim();
    if (!deviceId) continue;
    const historyState = deviceHistoryState(device);
    const history = historyState.history || coerceHistory(null);
    const hasDailyRows = history.daily.length > 0;
    const allTimeTokens = Number(device?.periods?.allTime?.totalTokens ?? device?.allTime?.totalTokens ?? 0);
    const retainedUsage = history.monthly.some((row) => Number(row?.tokens || 0) > 0)
      || Number(history.summary?.totalTokens || 0) > 0
      || allTimeTokens > 0;
    // Rolling/custom ranges require daily rows. An empty history is exact only
    // when every retained/lifetime signal also says the device has no usage.
    const available = historyState.state === 'available'
      && (hasDailyRows || !retainedUsage);
    histories[deviceId] = { ...history, available };
  }
  return histories;
}

function devicesWithLocalHistory(payload, localDevice) {
  const devices = Array.isArray(payload) ? payload : payload?.devices;
  const list = Array.isArray(devices) ? devices : [];
  const localId = String(localDevice?.deviceId || localDevice?.id || '').trim();
  const localHasHistory = localId && hasAuthoritativeHistoryState(localDevice);
  if (!localHasHistory) return list;
  return list
    .filter((device) => String(device?.deviceId || device?.id || '').trim() !== localId)
    .concat(localDevice);
}

// Which of the four resolutions below a configuration selects. Callers that need
// to know how expensive a history read will be ask this rather than re-deriving
// the branches, so the cost model cannot drift from the resolver: only 'remote'
// is a network round trip, and the other three are in-process.
function completeHistorySource(options = {}) {
  const { embeddedHub, hubMode, hubUrl, mode, historyEnabled = true } = options;
  if (historyEnabled === false) return 'empty';
  if (mode === 'local') return 'local';
  if (hubMode === 'host' && embeddedHub) return 'embedded';
  if (!hubUrl) return 'empty';
  return 'remote';
}

async function resolveCompleteHistory(options = {}) {
  const {
    aggregateHistory,
    embeddedHub,
    fetchImpl = globalThis.fetch,
    hubUrl,
    localDevice,
    secret,
    timeoutMs = 15_000
  } = options;
  const aggregate = typeof aggregateHistory === 'function' ? aggregateHistory : () => parseCompleteHistory(null);
  switch (completeHistorySource(options)) {
    case 'empty':
      return parseCompleteHistory(aggregate([]));
    case 'local':
      return parseCompleteHistory(aggregate(localDevice ? [localDevice] : []));
    case 'embedded':
      if (typeof embeddedHub.hub.getDevices === 'function') {
        return parseCompleteHistory(aggregate(devicesWithLocalHistory(embeddedHub.hub.getDevices(), localDevice)));
      }
      return parseCompleteHistory(embeddedHub.hub.getHistory());
    default:
      break;
  }
  if (typeof fetchImpl !== 'function') throw new Error('History fetch is unavailable');

  const url = `${String(hubUrl).replace(/\/$/, '')}/api/history`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return parseCompleteHistory(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDeviceHistories(options = {}) {
  const {
    embeddedHub,
    fetchImpl = globalThis.fetch,
    hubUrl,
    localDevice,
    secret,
    timeoutMs = 15_000
  } = options;
  switch (completeHistorySource(options)) {
    case 'empty':
      return {};
    case 'local':
      return parseDeviceHistories(localDevice ? [localDevice] : []);
    case 'embedded':
      return parseDeviceHistories(devicesWithLocalHistory(embeddedHub.hub.getDevices(), localDevice));
    default:
      break;
  }
  if (typeof fetchImpl !== 'function') throw new Error('Device history fetch is unavailable');

  const url = `${String(hubUrl).replace(/\/$/, '')}/api/devices`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return parseDeviceHistories(devicesWithLocalHistory(await response.json(), localDevice));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  completeHistorySource,
  parseCompleteHistory,
  parseDeviceHistories,
  devicesWithLocalHistory,
  hasAuthoritativeHistoryState,
  resolveCompleteHistory,
  resolveDeviceHistories
};
