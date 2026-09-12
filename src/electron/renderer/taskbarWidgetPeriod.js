'use strict';

(function exposeTaskbarWidgetPeriod(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTaskbarWidgetPeriod = api;
})(typeof window !== 'undefined' ? window : null, function createTaskbarWidgetPeriod() {
  const TASKBAR_WIDGET_PERIODS = Object.freeze(['today', 'month', 'allTime']);
  const TASKBAR_WIDGET_PERIOD_LABEL_KEYS = Object.freeze({
    today: 'trayComposer.period.today',
    month: 'trayComposer.period.month',
    allTime: 'trayComposer.period.allTime'
  });

  function normalizeTaskbarWidgetPeriod(value, fallback = 'allTime') {
    const period = String(value || '').trim();
    return TASKBAR_WIDGET_PERIODS.includes(period) ? period : fallback;
  }

  function nextTaskbarWidgetPeriod(value) {
    const current = normalizeTaskbarWidgetPeriod(value);
    const index = TASKBAR_WIDGET_PERIODS.indexOf(current);
    return TASKBAR_WIDGET_PERIODS[(index + 1) % TASKBAR_WIDGET_PERIODS.length];
  }

  function taskbarWidgetPeriodTokens(stats, period) {
    const key = normalizeTaskbarWidgetPeriod(period);
    return Number(stats?.periods?.[key]?.totalTokens || 0);
  }

  function taskbarWidgetPeriodLabelKey(period) {
    return TASKBAR_WIDGET_PERIOD_LABEL_KEYS[normalizeTaskbarWidgetPeriod(period)];
  }

  return {
    TASKBAR_WIDGET_PERIODS,
    TASKBAR_WIDGET_PERIOD_LABEL_KEYS,
    normalizeTaskbarWidgetPeriod,
    nextTaskbarWidgetPeriod,
    taskbarWidgetPeriodLabelKey,
    taskbarWidgetPeriodTokens
  };
});
