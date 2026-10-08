(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenMonitorHomeActivityModes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const DAY = 86400000;
  const key = at => new Date(at).toISOString().slice(0, 10);
  function parse(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const at = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(at) && key(at) === value ? at : null;
  }
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  function project(daily, options = {}) {
    const mode = ['daily', 'weekly', 'cumulative'].includes(options.mode) ? options.mode : 'daily';
    const metric = options.metric === 'cost' ? 'cost' : 'tokens';
    const end = parse(options.endDate);
    const endDay = end === null ? null : new Date(end);
    const startDate = options.startDate ?? (endDay
      ? key(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth() - 11, 1)) : '');
    const start = parse(startDate);
    const result = { mode, metric, startDate, endDate: options.endDate || '', points: [] };
    if (start === null || end === null || start > end || end - start > 370 * DAY) return result;
    const days = new Map();
    for (const row of Array.isArray(daily) ? daily : []) {
      const at = parse(row?.date);
      if (at === null || at < start || at > end) continue;
      // The final daily snapshot replaces an older one; never sum duplicates.
      days.set(at, { tokens: amount(row.tokens), cost: amount(row.cost) });
    }
    const weeks = new Map();
    for (let at = start; at <= end; at += DAY) {
      const value = days.get(at)?.[metric] || 0;
      const week = at - new Date(at).getUTCDay() * DAY;
      weeks.set(week, (weeks.get(week) || 0) + value);
    }
    let cumulative = 0;
    for (let at = start; at <= end; at += DAY) {
      const original = days.get(at) || { tokens: 0, cost: 0 };
      const date = key(at), value = original[metric];
      const week = at - new Date(at).getUTCDay() * DAY;
      cumulative += value;
      result.points.push({ date, ...original,
        displayValue: mode === 'weekly' ? weeks.get(week) : mode === 'cumulative' ? cumulative : value,
        rangeStart: mode === 'weekly' ? key(Math.max(start, week)) : mode === 'cumulative' ? startDate : date,
        rangeEnd: mode === 'weekly' ? key(Math.min(end, week + 6 * DAY)) : date
      });
    }
    return result;
  }
  return { project };
});
