'use strict';

const { createLiveTokenRateGroupTracker, selectLiveTokenRatePeriods } = require('../renderer/tokenRatePresentation');

// A host-owned, demand-driven reader of captured snapshots. It uses the native
// matched-counter tracker, never collector/renderer elapsed time or new scans.
function createLiveRateResource({ now, leaseMs, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const groups = new Map(), owners = new Map();
  let stats = null, context = {}, identity = '', revision = 0, timer = null;

  function selection(deviceId) {
    if (stats?.stale === true) return { entries: [], reason: 'stale' };
    if (deviceId !== null) {
      const device = stats?.devices?.find(d => d.deviceId === deviceId);
      return { entries: device && !device.stale && device.periods?.today
        ? [{ id: `device:${deviceId}`, period: device.periods.today }] : [],
      reason: device?.stale ? 'stale' : 'missingData' };
    }
    return { ...selectLiveTokenRatePeriods(stats, context.deviceId, context.hubMode, 'all'), reason: 'missingData' };
  }
  function refresh(group, observe) {
    const selected = selection(group.deviceId);
    const boundary = JSON.stringify([selected.source, selected.entries.map(e => e.id).sort()]);
    if (boundary !== group.boundary) {
      group.tracker.reset(selected.entries);
      group.boundary = boundary;
      group.hadSample = false;
    } else if (observe) {
      const result = group.tracker.observe(selected.entries);
      if (result.changed && !result.sample) group.hadSample = false;
    }
    const sample = group.tracker.getSample();
    group.hadSample ||= !!sample;
    const supported = selected.entries.some(({ period }) => period?.capabilities?.throughput !== false
      && ['timedTokens', 'timedOutputTokens', 'timedDurationMs'].every(k => typeof period?.[k] === 'number' && Number.isFinite(period[k]) && period[k] >= 0));
    const value = { deviceId: group.deviceId, state: sample ? sample.idle ? 'idle' : 'live' : 'unavailable',
      reason: sample ? null : !selected.entries.length ? selected.reason : !supported ? 'unsupportedTiming' : group.hadSample ? 'expired' : 'waitingForSample',
      speed: sample?.speed ?? null, burn: sample?.burn ?? null, sampledAt: sample?.sampledAt ?? null,
      expiresAt: sample?.expiresAt ?? null, sampleRevision: sample?.revision ?? null, deviceCount: sample?.deviceCount ?? 0 };
    const signature = JSON.stringify(value);
    if (signature !== group.signature) { group.value = value; group.signature = signature; revision++; }
  }
  function prune() {
    for (const [key, owner] of owners) if (!owner.subscription && now() >= owner.expiresAt) owners.delete(key);
    const used = new Set([...owners.values()].map(o => o.scope));
    for (const key of groups.keys()) if (!used.has(key)) groups.delete(key);
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const scopes = new Set([...owners.values()].filter(o => o.subscription).map(o => o.scope));
    let deadline = Infinity;
    for (const scope of scopes) deadline = Math.min(deadline, groups.get(scope)?.value?.expiresAt ?? Infinity);
    if (!Number.isFinite(deadline)) return;
    timer = setTimer(() => {
      timer = null;
      prune();
      const before = revision;
      for (const group of groups.values()) refresh(group, false);
      schedule();
      if (revision !== before) onChange();
    }, Math.max(0, deadline - now()) + 1);
    timer?.unref?.();
  }
  function release(predicate) {
    for (const [key, owner] of owners) if (predicate(owner, key)) owners.delete(key);
    prune(); schedule();
  }
  return {
    revision: () => revision,
    publish(next, extras) {
      const nextContext = extras.liveRateContext || {};
      const nextIdentity = JSON.stringify([extras.sourceId, extras.identityEpoch, nextContext.hubMode, nextContext.deviceId, nextContext.clients]);
      if (identity !== nextIdentity) { groups.clear(); owners.clear(); identity = nextIdentity; revision++; }
      stats = next; context = nextContext;
      prune();
      for (const group of groups.values()) refresh(group, true);
      schedule();
    },
    read(deviceId, owner) {
      prune();
      const scope = JSON.stringify(deviceId);
      if (!groups.has(scope)) {
        if (groups.size >= 128) throw new Error('budgetExceeded');
        groups.set(scope, { deviceId, tracker: createLiveTokenRateGroupTracker({ now }), boundary: null, hadSample: false });
      }
      if (!owners.has(owner.key) && owners.size >= 512) throw new Error('budgetExceeded');
      owners.set(owner.key, { ...owner, scope, expiresAt: now() + leaseMs });
      const group = groups.get(scope);
      const before = revision, hadValue = !!group.value;
      refresh(group, false); schedule();
      if (hadValue && revision !== before) onChange();
      return { ...group.value };
    },
    releaseSubscription: id => release(o => o.subscription === id),
    releaseOwner: owner => release(o => o.owner === owner),
    revoke: pluginId => release(o => o.pluginId === pluginId),
    dispose() { if (timer !== null) clearTimer(timer); timer = null; groups.clear(); owners.clear(); stats = null; },
    inspect: () => ({ groups: groups.size, owners: owners.size, timer: timer !== null })
  };
}

module.exports = { createLiveRateResource };
