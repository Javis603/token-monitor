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

module.exports = { createStatsPresentationCache, createStatsPublicationBatcher };
