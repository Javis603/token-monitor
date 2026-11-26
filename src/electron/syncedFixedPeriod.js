'use strict';

const { addPeriodInto, emptyPeriod, isPeriodExpired, mergePeriods, normalizePeriod } = require('../shared/usage');
const {
  deviceDayState, fixedPeriodSnapshotFromDevices, rangeForSelection
} = require('./renderer/fixedPeriodRanges');
const { projectSessionDeviceSessions } = require('./sessionDeviceSources');

function createFixedRangeReadCache(maxEntries = 16) {
  const pending = new Map();
  const completed = new Map();
  const queue = [];
  let active = 0;

  function drain() {
    while (active < maxEntries && queue.length) queue.shift().start();
  }

  function read(key, load) {
    if (pending.has(key)) return pending.get(key).promise;
    if (completed.has(key)) {
      const result = completed.get(key);
      completed.delete(key);
      completed.set(key, result);
      return result;
    }
    const controller = new AbortController();
    const entry = { controller, promise: null, cancel: null, start: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.cancel = () => resolve(null);
      entry.start = () => {
        active++;
        Promise.resolve().then(() => controller.signal.aborted ? null : load(controller.signal)).then(result => {
          if (controller.signal.aborted) return null;
          if (result) {
            completed.set(key, result);
            if (completed.size > maxEntries) completed.delete(completed.keys().next().value);
          }
          return result;
        }).finally(() => {
          active--;
          if (pending.get(key) === entry) pending.delete(key);
          drain();
        }).then(resolve, reject);
      };
    });
    pending.set(key, entry);
    queue.push(entry);
    drain();
    return entry.promise;
  }

  return { read, clear() {
    for (const { controller } of pending.values()) controller.abort();
    for (const entry of queue.splice(0)) entry.cancel();
    pending.clear();
    completed.clear();
  } };
}

async function resolveSyncedFixedPeriod(selection, devices, revisions, options) {
  const entries = await Promise.all(devices.map(async (device) => {
    const revision = Object.hasOwn(revisions, device.deviceId) && revisions[device.deviceId];
    const day = deviceDayState(device, options);
    const range = day && rangeForSelection(selection, { ...options, todayKey: day.currentKey });
    if (!range) return { device };
    const local = options.localDevice;
    const localWindow = local?.nativeRangeWindows?.[selection];
    const localPeriod = local?.nativeRanges?.[selection];
    if (localPeriod && local.deviceId === device.deviceId && local.updatedAt === device.updatedAt
      && localWindow?.start === range.start && localWindow.end === range.end) {
      return { device, range, period: normalizePeriod(localPeriod, { projectsEnabled: local.projectsEnabled !== false }) };
    }
    if (!revision) return { device };
    let period;
    try { period = await options.read(device.deviceId, selection, range, revision); }
    catch (_) { /* the existing History fallback handles an unavailable transport */ }
    return { device, range, period };
  }));
  const scanned = entries.filter(entry => entry.period);
  if (!scanned.length) return null;
  const missing = entries.filter(entry => !entry.period).map(({ device }) => device);
  const fallback = missing.length ? await options.history(missing) : [];
  if (missing.length && !fallback) return null;
  const derived = new Map((fallback || []).map(entry => [entry.deviceId, entry]));
  const period = emptyPeriod();
  const rows = [];
  const sessionSources = [];
  for (const entry of entries) {
    const { device } = entry;
    const source = entry.period ? entry : derived.get(device.deviceId);
    if (!source) continue; // The History resolver found no usage for this device.
    const { sessions, projects, ...totals } = entry.period
      || normalizePeriod(source.period, { projectsEnabled: false });
    const range = source.range;
    const { periods: _periods, ...metadata } = device;
    addPeriodInto(period, { ...totals, projects, sessions }, true);
    rows.push({ ...metadata, period: totals, range });
    if (entry.period) sessionSources.push({ ...metadata, [selection]: { sessions } });
  }
  const sessions = projectSessionDeviceSessions(period.sessions, sessionSources, [selection]);
  for (const [key, session] of Object.entries(sessions)) {
    // A shared accounting ID has ambiguous transcript ownership. A row is
    // allowed to open a local transcript only with positive local provenance.
    if (!session.sourceDevice) sessions[key] = { ...session, sourceDevice: { ambiguous: true } };
  }
  const range = rows.reduce((bounds, row) => ({
    start: !bounds || row.range.start < bounds.start ? row.range.start : bounds.start,
    end: !bounds || row.range.end > bounds.end ? row.range.end : bounds.end
  }), null);
  return {
    status: 'ready', selection, range, devices: rows,
    detailsAvailable: fallback.every(({ period }) => period.totalTokens === 0 && period.costUsd === 0),
    period: { ...period, sessions }
  };
}

async function resolveSyncedSessionPeriod(selection, devices, revisions, options) {
  let incomplete = false;
  const rows = await Promise.all(devices.filter(device => !isPeriodExpired(device, selection, options.now)).map(async device => {
    const inline = device.periods?.[selection];
    const omitted = device.sessionDetailsOmitted?.[selection] > 0;
    if (!omitted) return { ...device, [selection]: inline };
    const day = device.periodWindows?.today?.key;
    const revision = Object.hasOwn(revisions, device.deviceId) && revisions[device.deviceId];
    let paged;
    if (day && revision) {
      const start = selection === 'month' ? day.slice(0, 7) + '-01' : day;
      try { paged = await options.read(device.deviceId, selection, { start, end: day }, revision); }
      catch (_) { /* retain the inline rows when pages are temporarily unavailable */ }
    }
    if (!paged) incomplete = true;
    return { ...device, [selection]: paged ? { ...inline, sessions: { ...paged.sessions, ...inline?.sessions } } : inline };
  }));
  const period = mergePeriods(...rows.map(row => row[selection]));
  const sessions = projectSessionDeviceSessions(period.sessions, rows, [selection]);
  for (const [key, session] of Object.entries(sessions)) {
    if (!session.sourceDevice) sessions[key] = { ...session, sourceDevice: { ambiguous: true } };
  }
  return { period: { ...period, sessions }, detailsAvailable: !incomplete, devices: [] };
}

function historyFallbackForDevices(selection, devices, histories, options) {
  const byId = new Map(histories.map(source => [source.deviceId, source]));
  const sources = devices.map(device => {
    const fetched = byId.get(device.deviceId);
    const source = fetched && fetched.updatedAt === device.updatedAt ? fetched : device;
    return {
      ...device,
      history: source.history,
      historyAvailable: source.historyAvailable === true && Array.isArray(source.history?.daily)
    };
  });
  const snapshot = fixedPeriodSnapshotFromDevices(selection, sources, { ...options, historyAvailable: true });
  return snapshot.status === 'ready' ? snapshot.devices : null;
}

module.exports = { createFixedRangeReadCache, resolveSyncedFixedPeriod, resolveSyncedSessionPeriod, historyFallbackForDevices };
