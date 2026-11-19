'use strict';

// Tracks whether the user actually has a Widget on screen (demand) so the
// snapshot pipeline — history resolution, serialization, fsync, reload helper
// spawn — can be skipped entirely while nothing is installed. The signal is a
// zero-content marker file in the app group container that the widget extension
// touches whenever WidgetKit genuinely asks it for data. The extension is the
// only process WidgetKit lets speak for the widgets, so its marker mtimes are
// the demand lease.
//
// Two markers carry two lease lengths:
//   - "widget-demand" (full, 72 h): touched by timeline(). A placed widget
//     asking for its next update is the only authoritative "Widget on screen".
//   - "widget-demand-provisional" (short): touched by snapshot() outside the
//     gallery. WidgetKit calls snapshot() for transient situations that include
//     the add flow, before the user confirms placement, so this only warms up a
//     possible first placement and must not grant the full lease.
// A fresh marker of either length opens the gate; a real placement upgrades to
// the full lease on the next timeline(), while a cancelled add flow lets the
// provisional signal expire on its own.
//
// The leases are deliberately conservative: WidgetKit does not refresh a placed
// widget on a fixed cadence (a `.after(15 min)` timeline policy is only the
// earliest it may ask again, and rarely-viewed widgets are throttled much
// further), so a short TTL would starve a real widget. A long full lease means
// a removed widget keeps the pipeline warm for a few days — the accepted trade
// for never mis-gating someone who does have one. Users who never add a widget
// pay zero from day one, because neither marker ever exists (ENOENT closes the
// gate on the very first probe). A stale lease does not permanently starve a
// placed widget: the next genuine timeline request re-opens the gate within
// moments, and the host then produces a fresh snapshot and asks WidgetKit to
// reload.
//
// First-widget activation uses a directory watcher so the initial snapshot
// lands within moments of placement, with a low-frequency reconcile poll as
// the fallback. Every non-ENOENT error is fail-open: only confirmed missing or
// stale markers may gate work, because skipping work for a user who does have a
// Widget would starve the one thing this feature exists to keep fresh.

const fsSync = require('node:fs');
const path = require('node:path');

const WIDGET_DEMAND_MARKER = 'widget-demand';
const WIDGET_DEMAND_PROVISIONAL_MARKER = 'widget-demand-provisional';
const DEFAULT_DEMAND_LEASE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_PROVISIONAL_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RECONCILE_MS = 30_000;

function createMacWidgetDemandState(options = {}) {
  const markerPath = String(options.markerPath || '').trim();
  const provisionalMarkerPath = String(options.provisionalMarkerPath || '').trim() || null;
  const leaseMs = Number.isFinite(options.leaseMs)
    ? Math.max(1, options.leaseMs)
    : DEFAULT_DEMAND_LEASE_MS;
  const provisionalLeaseMs = Number.isFinite(options.provisionalLeaseMs)
    ? Math.max(1, options.provisionalLeaseMs)
    : DEFAULT_PROVISIONAL_LEASE_MS;
  const reconcileMs = Number.isFinite(options.reconcileMs)
    ? Math.max(1, options.reconcileMs)
    : DEFAULT_RECONCILE_MS;
  const fsApi = options.fs || fsSync;
  const now = options.now || Date.now;
  const setIntervalImpl = options.setInterval || setInterval;
  const clearIntervalImpl = options.clearInterval || clearInterval;
  const watchImpl = options.watch
    || ((directory, callback) => fsApi.watch(directory, { persistent: false }, callback));
  const onActivation = options.onActivation;
  const logger = options.logger;

  let installed = true; // fail-open until a probe confirms otherwise
  let watcher = null;
  let intervalId = null;
  let stopped = false;

  function log(message) {
    try { logger?.(message); } catch (_) {}
  }

  // Returns the marker age in ms, or null when the marker has never existed.
  // A clean missing file is the one signal that may count as "no demand"; any
  // other read outcome throws so the caller fails open instead.
  function probeMarker(targetPath) {
    let stat;
    try {
      stat = fsApi.lstatSync(targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    return now() - stat.mtimeMs;
  }

  function probe() {
    const ages = { full: probeMarker(markerPath), provisional: null };
    if (provisionalMarkerPath) ages.provisional = probeMarker(provisionalMarkerPath);
    return ages;
  }

  function apply(ages) {
    const fullFresh = ages.full !== null && ages.full < leaseMs;
    const provisionalFresh = ages.provisional !== null && ages.provisional < provisionalLeaseMs;
    const nowInstalled = fullFresh || provisionalFresh;
    const wasInstalled = installed;
    installed = nowInstalled;
    if (nowInstalled && !wasInstalled) {
      log('[mac-widget] widget demand lease acquired; priming the first snapshot');
      try {
        onActivation?.();
      } catch (error) {
        log(`[mac-widget] widget demand activation callback failed: ${error?.message || error}`);
      }
    }
  }

  async function refresh() {
    if (stopped) return;
    let ages;
    try {
      ages = probe();
    } catch (error) {
      log(`[mac-widget] widget demand marker unreadable; assuming a widget is present: ${error?.message || error}`);
      apply({ full: 0, provisional: 0 }); // fail-open: a broken marker must not read as "no widgets"
      return;
    }
    apply(ages);
  }

  function start() {
    if (stopped || watcher || intervalId !== null) return;
    if (markerPath) {
      try {
        watcher = watchImpl(path.dirname(markerPath), () => { void refresh(); });
        watcher?.on?.('error', (error) => {
          log(`[mac-widget] widget demand watcher failed; falling back to reconcile polling: ${error?.message || error}`);
          try { watcher?.close?.(); } catch (_) {}
          watcher = null;
        });
      } catch (error) {
        log(`[mac-widget] widget demand watcher unavailable; falling back to reconcile polling: ${error?.message || error}`);
        watcher = null;
      }
    }
    intervalId = setIntervalImpl(() => { void refresh(); }, reconcileMs);
    void refresh();
  }

  // The gate the snapshot pipeline consults on every tick. Only a confirmed
  // missing or stale marker reads false; everything else must not skip work.
  function isInstalled() {
    return installed;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      watcher = null;
    }
    if (intervalId !== null) {
      try { clearIntervalImpl(intervalId); } catch (_) {}
      intervalId = null;
    }
  }

  // Seed the initial answer synchronously so the first tick's gate is correct
  // (closed) for markers that never existed instead of fail-open.
  if (markerPath) {
    try {
      apply(probe());
    } catch (_) {
      apply({ full: 0, provisional: 0 });
    }
  }

  return { isInstalled, refresh, start, stop };
}

module.exports = {
  DEFAULT_DEMAND_LEASE_MS,
  DEFAULT_PROVISIONAL_LEASE_MS,
  DEFAULT_RECONCILE_MS,
  WIDGET_DEMAND_MARKER,
  WIDGET_DEMAND_PROVISIONAL_MARKER,
  createMacWidgetDemandState
};
