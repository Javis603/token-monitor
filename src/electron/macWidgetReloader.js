'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_WIDGET_KIND = 'com.tokenmonitor.dashboard';
const DEFAULT_MIN_INTERVAL_MS = 30_000;

let lastReloadAt = 0;

function resolveWidgetReloaderPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const candidates = [];
  if (options.helperPath) candidates.push(options.helperPath);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'TokenMonitorWidgetReloader'));
  candidates.push(path.resolve(__dirname, '..', '..', 'build', 'macos-widget', 'TokenMonitorWidgetReloader'));
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function requestMacWidgetReload(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, options.minIntervalMs)
    : DEFAULT_MIN_INTERVAL_MS;
  if (now - lastReloadAt < minIntervalMs) return { ok: false, reason: 'throttled' };
  const helperPath = resolveWidgetReloaderPath(options);
  if (!helperPath) return { ok: false, reason: 'helper-missing' };

  const widgetKind = String(options.widgetKind || DEFAULT_WIDGET_KIND).trim() || DEFAULT_WIDGET_KIND;
  lastReloadAt = now;
  const execFileImpl = options.execFile || execFile;
  execFileImpl(helperPath, [widgetKind], (error) => {
    if (error) {
      try { options.logger?.(`[mac-widget] reload helper failed: ${error.message || error}`); } catch (_) {}
    }
  });
  return { ok: true, helperPath, widgetKind };
}

function resetMacWidgetReloadThrottle() {
  lastReloadAt = 0;
}

module.exports = {
  DEFAULT_WIDGET_KIND,
  requestMacWidgetReload,
  resetMacWidgetReloadThrottle,
  resolveWidgetReloaderPath
};
