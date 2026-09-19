'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_WIDGET_KIND = 'com.tokenmonitor.dashboard';
const DEFAULT_MIN_INTERVAL_MS = 30_000;

let lastReloadAt = null;
let pendingReload = null;
let trailingTimer = null;
let trailingClearTimeout = clearTimeout;

function resolveWidgetReloaderPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const candidates = [];
  if (options.helperPath) candidates.push(options.helperPath);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'TokenMonitorWidgetReloader'));
  candidates.push(path.resolve(__dirname, '..', '..', 'build', 'macos-widget', 'TokenMonitorWidgetReloader'));
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function schedulerFor(options = {}) {
  const scheduler = options.scheduler || {};
  return {
    now: typeof scheduler.now === 'function' ? scheduler.now.bind(scheduler) : Date.now,
    setTimeout: typeof scheduler.setTimeout === 'function'
      ? scheduler.setTimeout.bind(scheduler)
      : setTimeout,
    clearTimeout: typeof scheduler.clearTimeout === 'function'
      ? scheduler.clearTimeout.bind(scheduler)
      : clearTimeout
  };
}

function clearTrailingTimer() {
  if (trailingTimer !== null) {
    try { trailingClearTimeout(trailingTimer); } catch (_) {}
    trailingTimer = null;
  }
}

function log(logger, message) {
  try { logger?.(message); } catch (_) {}
}

function launchReload(request, now) {
  if (request.isCurrent && !request.isCurrent()) {
    return { ok: false, reason: 'superseded' };
  }
  const helperPath = resolveWidgetReloaderPath(request);
  if (!helperPath) return { ok: false, reason: 'helper-missing' };
  const widgetKind = String(request.widgetKind || DEFAULT_WIDGET_KIND).trim() || DEFAULT_WIDGET_KIND;
  const execFileImpl = request.execFile || execFile;
  try {
    execFileImpl(helperPath, [widgetKind], (error) => {
      if (error) log(request.logger, `[mac-widget] reload helper failed: ${error.message || error}`);
    });
  } catch (error) {
    log(request.logger, `[mac-widget] reload helper failed: ${error.message || error}`);
    return { ok: false, reason: 'helper-failed', error };
  }
  // Only record a launch after execFile accepted the process start. A thrown
  // launch must not suppress the next valid request.
  lastReloadAt = now;
  return { ok: true, helperPath, widgetKind };
}

function scheduleTrailingReload(request, minIntervalMs, now, scheduler) {
  if (trailingTimer !== null) return;
  const delay = lastReloadAt === null
    ? 0
    : Math.max(0, lastReloadAt + minIntervalMs - now);
  trailingClearTimeout = scheduler.clearTimeout;
  trailingTimer = scheduler.setTimeout(() => {
    trailingTimer = null;
    const pending = pendingReload;
    if (!pending) return;
    const pendingScheduler = schedulerFor(pending);
    const pendingNow = Number(pendingScheduler.now());
    if (lastReloadAt !== null && pendingNow - lastReloadAt < pending.minIntervalMs) {
      scheduleTrailingReload(pending, pending.minIntervalMs, pendingNow, pendingScheduler);
      return;
    }
    const result = launchReload(pending, pendingNow);
    if (result.ok) {
      pendingReload = null;
    } else if (result.reason === 'helper-missing') {
      // Keep the latest request available for the next refresh after the
      // helper becomes available; do not silently consume the update.
      pendingReload = pending;
    } else {
      pendingReload = null;
    }
  }, delay);
}

function requestMacWidgetReload(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' };
  if (options.runtimeSupported === false) return { ok: false, reason: 'unsupported-os' };
  const scheduler = schedulerFor(options);
  const schedulerNow = Number(scheduler.now());
  const now = Number.isFinite(options.now) ? options.now : schedulerNow;
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, options.minIntervalMs)
    : DEFAULT_MIN_INTERVAL_MS;
  const request = { ...options, scheduler, now, minIntervalMs };
  if (lastReloadAt === null || now - lastReloadAt >= minIntervalMs) {
    const result = launchReload(request, now);
    if (result.ok) {
      pendingReload = null;
      clearTrailingTimer();
    } else if (result.reason === 'helper-missing') {
      pendingReload = request;
    }
    return result;
  }

  pendingReload = request;
  scheduleTrailingReload(request, minIntervalMs, now, scheduler);
  return { ok: false, reason: 'throttled', pending: true };
}

function resetMacWidgetReloadThrottle() {
  clearTrailingTimer();
  pendingReload = null;
  lastReloadAt = null;
}

module.exports = {
  DEFAULT_WIDGET_KIND,
  requestMacWidgetReload,
  resetMacWidgetReloadThrottle,
  resolveWidgetReloaderPath
};
