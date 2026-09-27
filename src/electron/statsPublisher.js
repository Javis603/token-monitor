'use strict';

// A published stats snapshot is read by every surface the main process feeds —
// renderer, tray, edge dock, Widget — and each of them asks for the presentation
// projection of the same object. The projection walks every session, so it runs
// once per snapshot and settings key rather than once per reader. Keyed by the
// snapshot object itself: a snapshot is never mutated after it is published, and
// a WeakMap lets superseded snapshots go with their projections.
function createStatsPresentationCache() {
  const cache = new WeakMap();
  return {
    get(stats, key, project) {
      if (!stats || typeof stats !== 'object') return project(stats);
      const hit = cache.get(stats);
      if (hit && hit.key === key) return hit.result;
      const result = project(stats);
      cache.set(stats, { key, result });
      return result;
    }
  };
}

// Hub client mode republishes on every local tick and on every hub event,
// including the hub's echo of this device's own upload a few hundred ms later.
// Each publish recomposes and ships the whole stats tree, so requests inside one
// window collapse into a single publish of whatever is newest when it closes.
//
// The batch keeps one request, and a remote one beats a local one: the renderer
// reads a `local` reason as "says nothing about the Hub connection", so letting
// a later local tick stand in for a Hub event would lose that evidence.
function createStatsPublicationBatcher(options = {}) {
  const publish = options.publish;
  if (typeof publish !== 'function') throw new TypeError('publish must be a function');
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const windowMs = Math.max(0, Number(options.windowMs) || 0);
  let timer = null;
  let remote = null;
  let local = null;

  function clearTimerOnly() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function take() {
    const batch = remote || local;
    remote = null;
    local = null;
    return batch;
  }

  function flush() {
    clearTimerOnly();
    const batch = take();
    if (batch) publish(batch);
  }

  function request(entry) {
    if (!entry) return;
    if (entry.reason === 'local') local = entry;
    else remote = entry;
    if (timer !== null) return;
    timer = setTimer(flush, windowMs);
    timer?.unref?.();
  }

  function cancel() {
    clearTimerOnly();
    take();
  }

  return { request, flush, cancel };
}

function withoutSessionDetail(period) {
  if (!period || typeof period !== 'object') return period;
  if (!('sessions' in period) && !('projects' in period)) return period;
  const summary = { ...period };
  delete summary.sessions;
  delete summary.projects;
  return summary;
}

// The shape the renderer receives, cut at the IPC boundary because structured
// clone copies every byte on the main thread. Main keeps the full snapshot: the
// exporter, tray, edge dock and Widget read it there.
//
// - Device records keep their period totals and breakdowns but not their
//   sessions and projects. The renderer only reads those aggregated, from
//   `periods`, and the local device's copy alone repeats all of them.
// - The all-time session list is pulled, not pushed (`stats:allTimeSessions`).
//   It is most of the payload and only one view shows it, so shipping it on
//   every publish would clone it for nothing nearly every time.
function rendererStats(stats) {
  if (!stats || typeof stats !== 'object') return stats;
  const result = { ...stats };
  const allTime = stats.periods?.allTime;
  if (allTime && typeof allTime === 'object' && 'sessions' in allTime) {
    const { sessions: _sessions, ...summary } = allTime;
    result.periods = { ...stats.periods, allTime: summary };
  }
  if (Array.isArray(stats.devices)) {
    result.devices = stats.devices.map((device) => {
      if (!device?.periods || typeof device.periods !== 'object') return device;
      const periods = {};
      for (const [name, period] of Object.entries(device.periods)) periods[name] = withoutSessionDetail(period);
      return { ...device, periods };
    });
  }
  return result;
}

// A detail the renderer pulls has to belong to the stats it is showing, not to
// whatever main published since. Every snapshot handed to the renderer is
// stamped with an id it can pull by, and with the source generation it came
// from, so a list pulled under one Hub is never shown under another. Only the
// most recently stamped snapshots stay addressable: the renderer only ever
// pulls for the one it holds, and a newer push brings a newer id. Stamping an
// older snapshot again (a presentation refresh re-sends `latestStats`) makes it
// recent again under its original id and source, so the id handed out always
// resolves.
function createRendererSnapshots(options = {}) {
  const source = options.source;
  if (typeof source !== 'function') throw new TypeError('source must be a function');
  const limit = Math.max(1, Number(options.limit) || 8);
  const tags = new WeakMap();
  const byId = new Map();
  let nextId = 1;

  function register(stats) {
    let tag = tags.get(stats);
    if (!tag) {
      tag = { id: nextId, source: source() };
      nextId += 1;
      tags.set(stats, tag);
    }
    byId.delete(tag.id);
    byId.set(tag.id, stats);
    if (byId.size > limit) byId.delete(byId.keys().next().value);
    return tag;
  }

  return {
    stamp(stats, copy) {
      if (!stats || typeof stats !== 'object' || !copy || typeof copy !== 'object') return copy;
      return { ...copy, snapshot: { ...register(stats) } };
    },
    get(id) {
      return byId.get(id) || null;
    }
  };
}

module.exports = { createRendererSnapshots, createStatsPresentationCache, createStatsPublicationBatcher, rendererStats };
