(function exposePeriodRanges(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPeriodRanges = api;
})(typeof window !== 'undefined' ? window : null, function createPeriodRangesApi() {
  const SLOT_MODES = Object.freeze({
    today: Object.freeze(['today']),
    month: Object.freeze(['month', 'week', 'last7', 'last30']),
    allTime: Object.freeze(['allTime', 'range'])
  });
  const SETTING_KEYS = Object.freeze({
    today: 'periodTodayMode',
    month: 'periodMonthMode',
    allTime: 'periodTotalMode'
  });
  const DEFAULT_MODES = Object.freeze({ today: 'today', month: 'month', allTime: 'allTime' });
  const DISPLAY_LABELS = Object.freeze({
    today: 'DAY',
    month: 'MONTH',
    allTime: 'TOTAL',
    week: 'WEEK',
    last7: '7D',
    last30: '30D',
    range: 'RANGE'
  });

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeMode(slot, value, fallback = DEFAULT_MODES[slot]) {
    const allowed = SLOT_MODES[slot] || [];
    const normalizedFallback = allowed.includes(fallback) ? fallback : (DEFAULT_MODES[slot] || allowed[0] || '');
    return allowed.includes(value) ? value : normalizedFallback;
  }

  function modeSettingKey(slot) {
    return SETTING_KEYS[slot] || '';
  }

  function modeForSlot(slot, settings = {}) {
    return normalizeMode(slot, settings?.[modeSettingKey(slot)]);
  }

  function normalizedSettings(settings = {}) {
    return {
      periodTodayMode: modeForSlot('today', settings),
      periodMonthMode: modeForSlot('month', settings),
      periodTotalMode: modeForSlot('allTime', settings),
      periodRangeStart: normalizeDateKey(settings.periodRangeStart),
      periodRangeEnd: normalizeDateKey(settings.periodRangeEnd)
    };
  }

  function effectiveSelection(slot, settings = {}, options = {}) {
    const mode = modeForSlot(slot, settings);
    if (options.historyEnabled === false && isDerived(mode)) return DEFAULT_MODES[slot] || mode;
    return mode;
  }

  function displayLabel(selection) {
    return DISPLAY_LABELS[selection] || DISPLAY_LABELS.today;
  }

  function isDerived(selection) {
    return selection === 'week' || selection === 'last7' || selection === 'last30' || selection === 'range';
  }

  function supportsBreakdown(selection, breakdown) {
    return !isDerived(selection) || (breakdown !== 'project' && breakdown !== 'session');
  }

  function normalizeDateKey(value) {
    const key = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
  }

  function normalizeDateRange(start, end) {
    const normalizedStart = normalizeDateKey(start);
    const normalizedEnd = normalizeDateKey(end);
    if (!normalizedStart || !normalizedEnd || normalizedStart > normalizedEnd) return null;
    return { start: normalizedStart, end: normalizedEnd };
  }

  function dayKeyAddDays(key, delta) {
    const normalized = normalizeDateKey(key);
    if (!normalized) return '';
    const date = new Date(`${normalized}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(delta || 0));
    return date.toISOString().slice(0, 10);
  }

  function localDayKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function weekStartsOn(locale) {
    try {
      const resolved = new Intl.Locale(String(locale || 'en'));
      const info = typeof resolved.getWeekInfo === 'function'
        ? resolved.getWeekInfo()
        : resolved.weekInfo;
      const firstDay = Number(info?.firstDay);
      if (Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    } catch (_) { /* fall through to the ISO week default */ }
    return 1;
  }

  function rangeForSelection(selection, options = {}) {
    const todayKey = normalizeDateKey(options.todayKey) || localDayKey();
    if (selection === 'week') {
      const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
      const daysSinceStart = (weekday - weekStartsOn(options.locale) + 7) % 7;
      return { start: dayKeyAddDays(todayKey, -daysSinceStart), end: todayKey };
    }
    if (selection === 'last7') return { start: dayKeyAddDays(todayKey, -6), end: todayKey };
    if (selection === 'last30') return { start: dayKeyAddDays(todayKey, -29), end: todayKey };
    if (selection === 'range') return normalizeDateRange(options.rangeStart, options.rangeEnd);
    return null;
  }

  function emptyPeriod() {
    return {
      totalTokens: 0,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      timedTokens: 0,
      timedOutputTokens: 0,
      timedDurationMs: 0,
      clients: {},
      clientCosts: {},
      clientCacheReads: {},
      clientCacheWrites: {},
      clientOutputs: {},
      models: {},
      modelCosts: {},
      modelCacheReads: {},
      modelCacheWrites: {},
      modelOutputs: {},
      clientModels: {},
      clientModelCosts: {},
      projects: {},
      sessions: {}
    };
  }

  function dailyRowFromPeriod(period, date, previous = {}) {
    const perClient = {};
    for (const [client, tokens] of Object.entries(period?.clients || {})) {
      perClient[client] = {
        tokens: finiteNumber(tokens),
        cost: finiteNumber(period?.clientCosts?.[client]),
        messages: finiteNumber(previous?.perClient?.[client]?.messages)
      };
    }
    const perModel = {};
    for (const [model, tokens] of Object.entries(period?.models || {})) {
      perModel[model] = {
        tokens: finiteNumber(tokens),
        cost: finiteNumber(period?.modelCosts?.[model])
      };
    }
    return {
      ...previous,
      date,
      tokens: finiteNumber(period?.totalTokens),
      cost: finiteNumber(period?.costUsd),
      perClient,
      perModel
    };
  }

  function patchToday(daily, todayKey, nativeToday) {
    const rows = Array.isArray(daily) ? daily.map((row) => ({ ...row })) : [];
    const date = normalizeDateKey(todayKey);
    if (!date || !nativeToday) return rows;
    const index = rows.findIndex((row) => normalizeDateKey(row?.date) === date);
    const previous = index >= 0 ? rows[index] : {};
    const next = dailyRowFromPeriod(nativeToday, date, previous);
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return rows.sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));
  }

  function dailyRowsForSelection(daily, options = {}) {
    const selection = options.selection;
    const range = rangeForSelection(selection, options);
    if (!range) return [];
    return patchToday(daily, options.todayKey, options.nativeToday).filter((row) => {
      const date = normalizeDateKey(row?.date);
      return date && date >= range.start && date <= range.end;
    });
  }

  function addMapValue(target, key, value) {
    if (!key) return;
    target[key] = finiteNumber(target[key]) + finiteNumber(value);
  }

  function derivePeriod(daily, options = {}) {
    const period = emptyPeriod();
    const rows = dailyRowsForSelection(daily, options);
    for (const row of rows) {
      period.totalTokens += finiteNumber(row?.tokens);
      period.costUsd += finiteNumber(row?.cost);
      for (const [client, value] of Object.entries(row?.perClient || {})) {
        addMapValue(period.clients, client, value?.tokens);
        addMapValue(period.clientCosts, client, value?.cost);
      }
      for (const [model, value] of Object.entries(row?.perModel || {})) {
        addMapValue(period.models, model, value?.tokens);
        addMapValue(period.modelCosts, model, value?.cost);
      }
    }
    period.totalTokens = Math.max(0, Math.round(period.totalTokens));
    period.costUsd = Number(period.costUsd.toFixed(6));
    for (const map of [period.clients, period.models]) {
      for (const key of Object.keys(map)) map[key] = Math.max(0, Math.round(map[key]));
    }
    for (const map of [period.clientCosts, period.modelCosts]) {
      for (const key of Object.keys(map)) map[key] = Number(map[key].toFixed(6));
    }
    return period;
  }

  function rangeSummary(daily, options = {}) {
    const rows = dailyRowsForSelection(daily, options);
    const range = rangeForSelection(options.selection, options);
    const activeDates = new Set(rows
      .filter((row) => finiteNumber(row?.tokens) > 0)
      .map((row) => normalizeDateKey(row?.date))
      .filter(Boolean));
    let currentStreak = 0;
    let cursor = range?.end || '';
    while (cursor && activeDates.has(cursor)) {
      currentStreak += 1;
      cursor = dayKeyAddDays(cursor, -1);
    }
    return {
      activeDays: rows.filter((row) => finiteNumber(row?.tokens) > 0).length,
      currentStreak,
      activeTimeMs: rows.reduce((sum, row) => sum + finiteNumber(row?.activeTimeMs), 0),
      peakDayTokens: rows.reduce((peak, row) => Math.max(peak, finiteNumber(row?.tokens)), 0)
    };
  }

  return {
    DEFAULT_MODES,
    DISPLAY_LABELS,
    SLOT_MODES,
    dailyRowsForSelection,
    dayKeyAddDays,
    derivePeriod,
    displayLabel,
    effectiveSelection,
    isDerived,
    localDayKey,
    modeForSlot,
    modeSettingKey,
    normalizeDateKey,
    normalizeDateRange,
    normalizeMode,
    normalizedSettings,
    patchToday,
    rangeForSelection,
    rangeSummary,
    supportsBreakdown,
    weekStartsOn
  };
});
