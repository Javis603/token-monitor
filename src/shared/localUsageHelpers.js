'use strict';

/**
 * Shared pure helpers for parse-local usage adapters (Proma, MiniMax Code, …).
 * Keep numeric/timestamp/window semantics in one place so period shaping stays
 * aligned across clients that do not go through tokscale.
 */

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizedModelId(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || 'unknown';
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function windowStartMs(windows = {}) {
  return Math.max(
    0,
    timestampMs(windows.todayStart),
    timestampMs(windows.monthStart),
    timestampMs(windows.allTimeSince)
  );
}

function localPeriodBounds(nowInput) {
  const now = nowInput ? new Date(nowInput) : new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  return { now, todayStart, monthStart };
}

module.exports = {
  numberValue,
  timestampMs,
  normalizedModelId,
  localDateKey,
  windowStartMs,
  localPeriodBounds
};
