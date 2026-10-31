'use strict';

const { createLiveTokenRateGroupTracker, selectLiveTokenRatePeriods } = require('../renderer/tokenRatePresentation');

// A host-owned, demand-driven reader of captured snapshots. It uses the native
// matched-counter tracker, never collector/renderer elapsed time or new scans.
function createLiveRateResource({ now, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const groups = new Map();
  let stats = null, context = {}, identity = '', revision = 0, timer = null;

  function selection(deviceId) {
    if (stats?.stale === true) return { entries: [], reason: 'stale' };
    if (deviceId !== null) {
      const device = stats?.devices?.find(d => d.deviceId === deviceId);
      return { entries: device && !device.stale && device.periods?.today
        ? [{ id: `device:${deviceId}`, period: device.periods.today }] : [],
      reason: device?.stale ? 'stale' : 'missingData' };
    }
    const selected = selectLiveTokenRatePeriods(stats, context.deviceId, context.hubMode, 'all');
    const allStale = selected.source === 'devices:all' && stats?.devices?.length > 0 && stats.devices.every(d => d.stale === true);
    return { ...selected, reason: allStale ? 'stale' : 'missingData' };
  }
  function value(deviceId, selected, sample = null, hadSample = false) {
    const supported = selected.entries.some(({ period }) => period?.capabilities?.throughput !== false
      && ['timedTokens', 'timedOutputTokens', 'timedDurationMs'].every(k => typeof period?.[k] === 'number' && Number.isFinite(period[k]) && period[k] >= 0));
    return { deviceId, state: sample ? sample.idle ? 'idle' : 'live' : 'unavailable',
      reason: sample ? null : !selected.entries.length ? selected.reason : !supported ? 'unsupportedTiming' : hadSample ? 'expired' : 'waitingForSample',
      speed: sample?.speed ?? null, burn: sample?.burn ?? null, sampledAt: sample?.sampledAt ?? null,
      expiresAt: sample?.expiresAt ?? null, sampleRevision: sample?.revision ?? null, deviceCount: sample?.deviceCount ?? 0 };
  }
  function refresh(group, observe, reset = false) {
    const selected = selection(group.deviceId);
    const boundary = selected.source ?? null;
    if (reset || boundary !== group.boundary) {
      group.tracker.reset(selected.entries);
      group.boundary = boundary;
      group.hadSample = false;
    } else if (observe) {
      const result = group.tracker.observe(selected.entries);
      const present = new Set(selected.entries.map(e => e.id));
      const removed = group.members.some(id => !present.has(id));
      // Active survivors are already recomputed by observe(). Only clear the
      // retained idle aggregate when it could still contain a departed device.
      if (removed && result.sample?.idle) {
        group.tracker.reset(selected.entries); group.hadSample = false;
      } else if (result.changed && !result.sample) group.hadSample = false;
    }
    group.members = selected.entries.map(e => e.id);
    const sample = group.tracker.getSample();
    group.hadSample ||= !!sample;
    const reading = value(group.deviceId, selected, sample, group.hadSample);
    const signature = JSON.stringify(reading);
    if (reset || signature !== group.signature) { group.value = reading; group.signature = signature; group.revision = ++revision; }
  }
  function addScope(deviceId) {
    const group = { deviceId, tracker: createLiveTokenRateGroupTracker({ now }), boundary: undefined, members: [], hadSample: false };
    groups.set(deviceId, group);
    refresh(group, false);
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    let deadline = Infinity;
    for (const group of groups.values()) deadline = Math.min(deadline, group.value.expiresAt ?? Infinity);
    if (!Number.isFinite(deadline)) return;
    timer = setTimer(() => {
      timer = null;
      const before = revision;
      for (const group of groups.values()) refresh(group, false);
      schedule();
      if (revision !== before) onChange();
    }, Math.max(0, deadline - now()) + 1);
    timer?.unref?.();
  }
  return {
    revision: deviceId => groups.get(deviceId)?.revision ?? JSON.stringify(value(deviceId, selection(deviceId))),
    setScopes(scopes) {
      for (const id of groups.keys()) if (!scopes.has(id)) groups.delete(id);
      for (const id of scopes) if (!groups.has(id)) addScope(id);
      schedule();
    },
    publish(next, extras) {
      const nextContext = extras.liveRateContext || {};
      const nextIdentity = JSON.stringify([extras.sourceId, extras.identityEpoch, nextContext.hubMode, nextContext.deviceId, nextContext.clients]);
      const reset = identity !== nextIdentity;
      stats = next; context = nextContext; identity = nextIdentity;
      for (const group of groups.values()) refresh(group, true, reset);
      schedule();
    },
    read(deviceId) {
      return { ...(groups.get(deviceId)?.value ?? value(deviceId, selection(deviceId))) };
    },
    dispose() { if (timer !== null) clearTimer(timer); timer = null; groups.clear(); stats = null; },
    inspect: () => ({ groups: groups.size, timer: timer !== null })
  };
}

module.exports = { createLiveRateResource };
