'use strict';

function normalizeAllTimeSince(value, fallback = '2024-01-01') {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : fallback;
}

module.exports = { normalizeAllTimeSince };
