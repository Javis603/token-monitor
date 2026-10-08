'use strict';

// One window definition for every model-speed surface. The Home summary, the
// all-model list and the single-model detail all resolve their range from the
// top DAY / MONTH / TOTAL selection, so the three can never disagree about
// which samples an "average speed" or a curve covers. Main computes the
// authoritative range; the renderer only reads the label key.
(function exposeModelSpeedRange(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelSpeedRange = api;
})(typeof window !== 'undefined' ? window : null, function createModelSpeedRangeApi() {
  const DAY = 86400000;
  // modelSpeedHistory prunes anything older than this. A range may never start
  // earlier, because no sample survives to answer for it.
  const RETENTION_DAYS = 90;
  const PERIODS = Object.freeze(['today', 'week', 'last7', 'month', 'last30', 'allTime']);
  const LABEL_KEYS = Object.freeze({
    today: 'home.modelSpeed.range.today',
    week: 'home.modelSpeed.range.week',
    last7: 'home.modelSpeed.range.last7',
    month: 'home.modelSpeed.range.month',
    last30: 'home.modelSpeed.range.last30',
    allTime: 'home.modelSpeed.range.allTime'
  });

  function isPeriod(value) {
    return PERIODS.includes(value);
  }

  function normalizePeriod(value) {
    return isPeriod(value) ? value : 'today';
  }

  // 0 = Sunday … 6 = Saturday, the same encoding the period menu already uses.
  function normalizeWeekStart(value) {
    const number = Math.floor(Number(value));
    return Number.isInteger(number) && number >= 0 && number <= 6 ? number : 1;
  }

  function localMidnight(at) {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function localMonthStart(at) {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
    return date.getTime();
  }

  function localWeekStart(at, weekStartsOn) {
    const date = new Date(localMidnight(at));
    const offset = (date.getDay() - normalizeWeekStart(weekStartsOn) + 7) % 7;
    date.setDate(date.getDate() - offset);
    return date.getTime();
  }

  // DAY is local midnight to now, never a rolling 24 hours. TOTAL stops at the
  // retention floor rather than implying samples that were already pruned.
  function rangeForPeriod(period, options = {}) {
    const key = normalizePeriod(period);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const today = localMidnight(now);
    const floor = today - (RETENTION_DAYS - 1) * DAY;
    let start = today;
    if (key === 'week') start = localWeekStart(now, options.weekStartsOn);
    else if (key === 'last7') start = today - 6 * DAY;
    else if (key === 'month') start = localMonthStart(now);
    else if (key === 'last30') start = today - 29 * DAY;
    else if (key === 'allTime') start = floor;
    if (start < floor) start = floor;
    return {
      period: key,
      start,
      end: now,
      labelKey: LABEL_KEYS[key],
      spanDays: Math.max(0, (now - start) / DAY)
    };
  }

  return {
    DAY,
    RETENTION_DAYS,
    PERIODS,
    LABEL_KEYS,
    isPeriod,
    normalizePeriod,
    normalizeWeekStart,
    localMidnight,
    localMonthStart,
    localWeekStart,
    rangeForPeriod
  };
});
