'use strict';

const { addPeriodInto, emptyPeriod, normalizePeriod } = require('../shared/usage');
const {
  deviceDayState, fixedPeriodSnapshotFromDevices, rangeForSelection
} = require('./renderer/fixedPeriodRanges');
const { projectSessionDeviceSessions } = require('./sessionDeviceSources');

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
    detailsAvailable: !fallback?.length,
    period: { ...period, sessions }
  };
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

module.exports = { resolveSyncedFixedPeriod, historyFallbackForDevices };
