'use strict';

const { coerceHistory } = require('../shared/history');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseCompleteHistory(payload) {
  return coerceHistory(payload);
}

function parseDeviceHistories(payload) {
  const records = Array.isArray(payload) ? payload : payload?.devices;
  if (!Array.isArray(records)) return [];
  return records.map((record) => {
    const deviceId = String(record?.deviceId || record?.id || '').trim();
    if (!deviceId) return null;
    const historyAvailable = record?.historyAvailable === true
      && hasOwn(record, 'history')
      && record.history !== null;
    return {
      deviceId,
      displayName: String(record?.displayName || '').trim(),
      hostname: String(record?.hostname || '').trim(),
      platform: String(record?.platform || '').trim(),
      updatedAt: record?.updatedAt || record?.receivedAt || '',
      agentVersion: String(record?.agentVersion || '').trim(),
      agentRuntime: String(record?.agentRuntime || '').trim(),
      periodWindows: record?.periodWindows || null,
      periods: {
        today: record?.periods?.today || record?.today || null,
        month: record?.periods?.month || record?.month || null,
        allTime: record?.periods?.allTime || record?.allTime || null
      },
      historyAvailable,
      history: historyAvailable ? parseCompleteHistory(record.history) : null
    };
  }).filter(Boolean);
}

// The local collector can finalize History before its throttled sync upload reaches
// the Hub. Mirror composeLocalSyncStats' local-wins display contract here so a
// fixed range cannot refetch on the local revision and then render the older Hub
// copy. An absent local History means "no update in this snapshot", so retain a
// Hub last-good History only when the Hub record carries the producer's explicit
// capability with it; an explicit local null remains authoritative.
function devicesWithLocalHistory(records, localDevice) {
  const devices = Array.isArray(records) ? records.slice() : [];
  const localId = String(localDevice?.deviceId || '').trim();
  if (!localId) return devices;
  const index = devices.findIndex((record) => String(record?.deviceId || record?.id || '').trim() === localId);
  if (index < 0) return devices.concat(localDevice);
  const existing = devices[index] || {};
  const localUpdatedAt = Date.parse(localDevice?.updatedAt || localDevice?.receivedAt || '');
  const existingUpdatedAt = Date.parse(existing?.updatedAt || existing?.receivedAt || '');
  if (
    Number.isFinite(existingUpdatedAt)
    && (!Number.isFinite(localUpdatedAt) || localUpdatedAt < existingUpdatedAt)
  ) {
    return devices;
  }
  const merged = { ...existing, ...localDevice };
  if (!hasOwn(localDevice, 'history')) {
    if (existing?.historyAvailable === true && hasOwn(existing, 'history')) {
      merged.history = existing.history;
    } else {
      delete merged.history;
    }
  }
  devices[index] = merged;
  return devices;
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

// Fixed-range device rows need the same retained V1 History, but before the Hub
// merges away device identity. This is a read-side projection only: producers keep
// posting the existing device record and Hubs expose /api/devices. Fixed ranges
// still require the current producer's explicit History capability, so an older
// Hub that strips it fails closed instead of turning disabled History into zero.
async function resolveCompleteHistoryWithDevices(options = {}) {
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
  let records;
  switch (completeHistorySource(options)) {
    case 'empty':
      records = [];
      break;
    case 'local':
      records = localDevice ? [localDevice] : [];
      break;
    case 'embedded':
      records = devicesWithLocalHistory(embeddedHub.hub.getDevices(), localDevice);
      break;
    default: {
      if (typeof fetchImpl !== 'function') throw new Error('Device History fetch is unavailable');
      const url = `${String(hubUrl).replace(/\/$/, '')}/api/devices`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
        const payload = await response.json();
        records = devicesWithLocalHistory(
          Array.isArray(payload) ? payload : payload?.devices,
          localDevice
        );
      } finally {
        clearTimeout(timeout);
      }
      break;
    }
  }
  const devices = Array.isArray(records) ? records : [];
  return {
    history: parseCompleteHistory(aggregate(devices)),
    deviceHistories: parseDeviceHistories(devices)
  };
}

module.exports = {
  completeHistorySource,
  devicesWithLocalHistory,
  parseDeviceHistories,
  parseCompleteHistory,
  resolveCompleteHistory,
  resolveCompleteHistoryWithDevices
};
