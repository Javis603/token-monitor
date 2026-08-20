'use strict';

(function exposeDashboardDimensions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDashboardDimensions = api;
})(typeof window !== 'undefined' ? window : null, function createDashboardDimensionsApi() {
  function n(value) {
    const x = Number(value);
    return Number.isFinite(x) ? x : 0;
  }

  function metricOf(entry, metric) {
    return n(entry && entry[metric === 'cost' ? 'cost' : 'tokens']);
  }

  function normalizeMetric(value) {
    return value === 'cost' ? 'cost' : 'tokens';
  }

  function hasClientModel(daily) {
    for (const day of Array.isArray(daily) ? daily : []) {
      const nested = day?.perClientModel;
      if (!nested || typeof nested !== 'object') continue;
      for (const models of Object.values(nested)) {
        if (models && typeof models === 'object' && Object.keys(models).length > 0) return true;
      }
    }
    return false;
  }

  function addInto(target, key, entry, metric) {
    const value = metricOf(entry, metric);
    if (value === 0 && n(entry?.tokens) === 0 && n(entry?.cost) === 0) return;
    const cur = target[key] || (target[key] = { tokens: 0, cost: 0, messages: 0 });
    cur.tokens += n(entry?.tokens);
    cur.cost += n(entry?.cost);
    cur.messages += n(entry?.messages);
    const outputTokens = n(entry?.outputTokens);
    if (outputTokens > 0) cur.outputTokens = n(cur.outputTokens) + outputTokens;
  }

  function outputTokensOf(day, filter = {}) {
    const client = String(filter.client || '').trim();
    const model = String(filter.model || '').trim();
    if (client && model) return n(day?.perClientModel?.[client]?.[model]?.outputTokens);
    if (client) return n(day?.perClient?.[client]?.outputTokens);
    if (model) return n(day?.perModel?.[model]?.outputTokens);
    const direct = n(day?.outputTokens);
    if (direct > 0) return direct;
    let fromClients = 0;
    for (const entry of Object.values(day?.perClient || {})) fromClients += n(entry?.outputTokens);
    if (fromClients > 0) return fromClients;
    let fromModels = 0;
    for (const entry of Object.values(day?.perModel || {})) fromModels += n(entry?.outputTokens);
    return fromModels;
  }

  function rankedEntries(map, metric, limit = 0) {
    const rows = Object.entries(map || {})
      .map(([key, entry]) => ({ key, value: metricOf(entry, metric), tokens: n(entry?.tokens), cost: n(entry?.cost) }))
      .filter((row) => row.value > 0 || row.tokens > 0 || row.cost > 0)
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    const cap = Math.max(0, Math.floor(Number(limit) || 0));
    return cap > 0 ? rows.slice(0, cap) : rows;
  }

  function sumField(daily, field, metric) {
    const totals = {};
    for (const day of Array.isArray(daily) ? daily : []) {
      for (const [key, entry] of Object.entries(day?.[field] || {})) addInto(totals, key, entry, metric);
    }
    return totals;
  }

  function sumClientModel(daily) {
    const nested = {};
    for (const day of Array.isArray(daily) ? daily : []) {
      for (const [client, models] of Object.entries(day?.perClientModel || {})) {
        const dest = nested[client] || (nested[client] = {});
        for (const [model, entry] of Object.entries(models || {})) addInto(dest, model, entry);
      }
    }
    return nested;
  }

  function filterDaily(daily, filter = {}) {
    const client = String(filter.client || '').trim();
    const model = String(filter.model || '').trim();
    if (!client && !model) return Array.isArray(daily) ? daily : [];
    return (Array.isArray(daily) ? daily : []).map((day) => {
      const nested = day?.perClientModel && typeof day.perClientModel === 'object' ? day.perClientModel : null;
      if (!nested) {
        const next = { ...day, perClient: { ...(day.perClient || {}) }, perModel: { ...(day.perModel || {}) } };
        if (client) next.perClient = next.perClient[client] ? { [client]: next.perClient[client] } : {};
        if (model) next.perModel = next.perModel[model] ? { [model]: next.perModel[model] } : {};
        next.tokens = client
          ? n(next.perClient[client]?.tokens)
          : Object.values(next.perModel).reduce((sum, entry) => sum + n(entry?.tokens), 0);
        next.cost = client
          ? n(next.perClient[client]?.cost)
          : Object.values(next.perModel).reduce((sum, entry) => sum + n(entry?.cost), 0);
        next.outputTokens = outputTokensOf(day, { client, model });
        return next;
      }

      const perClientModel = {};
      const perClient = {};
      const perModel = {};
      let tokens = 0;
      let cost = 0;
      let messages = 0;
      for (const [rowClient, models] of Object.entries(nested)) {
        if (client && rowClient !== client) continue;
        for (const [rowModel, entry] of Object.entries(models || {})) {
          if (model && rowModel !== model) continue;
          const cellTokens = n(entry?.tokens);
          const cellCost = n(entry?.cost);
          const cellMessages = n(entry?.messages);
          if (cellTokens <= 0 && cellCost <= 0) continue;
          (perClientModel[rowClient] || (perClientModel[rowClient] = {}))[rowModel] = {
            tokens: cellTokens, cost: cellCost, messages: cellMessages
          };
          addInto(perClient, rowClient, entry);
          addInto(perModel, rowModel, entry);
          tokens += cellTokens;
          cost += cellCost;
          messages += cellMessages;
        }
      }
      return {
        ...day,
        tokens,
        cost,
        messages,
        outputTokens: outputTokensOf(day, { client, model }),
        perClient,
        perModel,
        perClientModel
      };
    });
  }

  function drillRows(daily, { dimension, key, metric = 'tokens', limit = 8 } = {}) {
    const nested = sumClientModel(daily);
    const metricKey = normalizeMetric(metric);
    if (dimension === 'client') {
      return rankedEntries(nested[key] || {}, metricKey, limit);
    }
    const totals = {};
    for (const [client, models] of Object.entries(nested)) {
      const entry = models?.[key];
      if (entry) addInto(totals, client, entry);
    }
    return rankedEntries(totals, metricKey, limit);
  }

  function normalizeDateKey(value) {
    const key = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
  }

  function addDaysUTC(key, delta) {
    const normalized = normalizeDateKey(key);
    if (!normalized) return '';
    return new Date(Date.parse(`${normalized}T00:00:00Z`) + Number(delta || 0) * 86400000)
      .toISOString()
      .slice(0, 10);
  }

  function localDayKey(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Intl weekInfo.firstDay is 1=Monday … 7=Sunday; JS getUTCDay is 0=Sunday.
  function weekStartsOn(locale) {
    try {
      const resolved = new Intl.Locale(String(locale || 'en'));
      const info = typeof resolved.getWeekInfo === 'function' ? resolved.getWeekInfo() : resolved.weekInfo;
      const firstDay = Number(info?.firstDay);
      if (Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    } catch (_) { /* ISO Monday */ }
    return 1;
  }

  function weekStartKey(key, firstDay = 1) {
    const day = normalizeDateKey(key);
    if (!day) return '';
    const sun0 = new Date(`${day}T00:00:00Z`).getUTCDay();
    const start = ((Number(firstDay) % 7) + 7) % 7;
    return addDaysUTC(day, -((sun0 - start + 7) % 7));
  }

  function dataBounds(daily) {
    const keys = (Array.isArray(daily) ? daily : [])
      .map((row) => normalizeDateKey(row?.date))
      .filter(Boolean)
      .sort();
    return keys.length ? { start: keys[0], end: keys[keys.length - 1] } : { start: '', end: '' };
  }

  function normalizeGroupBy(value) {
    return value === 'week' || value === 'month' ? value : 'day';
  }

  function resolveRange(range, options = {}) {
    const today = normalizeDateKey(options.todayKey) || localDayKey(options.now);
    const bounds = dataBounds(options.daily);
    const end = today || bounds.end;
    const preset = String(range || '30');
    if (!end) return { start: '', end: '', preset: 'all' };
    if (preset === 'all') return { start: bounds.start || '', end, preset: 'all' };
    if (preset === 'custom') {
      let start = normalizeDateKey(options.customStart) || bounds.start || end;
      let finish = normalizeDateKey(options.customEnd) || end;
      if (start > finish) [start, finish] = [finish, start];
      return { start, end: finish, preset: 'custom' };
    }
    const days = Math.max(1, Math.floor(Number(preset) || 30));
    return { start: addDaysUTC(end, -(days - 1)), end, preset: String(days) };
  }

  function sliceDaily(daily, range = {}) {
    const start = normalizeDateKey(range.start);
    const end = normalizeDateKey(range.end);
    return (Array.isArray(daily) ? daily : []).filter((row) => {
      const key = normalizeDateKey(row?.date);
      if (!key) return false;
      if (start && key < start) return false;
      if (end && key > end) return false;
      return true;
    });
  }

  function mergeMap(target, source) {
    for (const [key, entry] of Object.entries(source || {})) addInto(target, key, entry);
  }

  function mergeClientModel(target, source) {
    for (const [client, models] of Object.entries(source || {})) {
      mergeMap(target[client] || (target[client] = {}), models);
    }
  }

  function emptyBucket(date) {
    return {
      date,
      endDate: date,
      tokens: 0,
      cost: 0,
      messages: 0,
      outputTokens: 0,
      activeTimeMs: 0,
      timedOutputTokens: 0,
      timedDurationMs: 0,
      perClient: {},
      perModel: {},
      perClientModel: {}
    };
  }

  function inclusiveDays(start, end) {
    const from = normalizeDateKey(start);
    const to = normalizeDateKey(end);
    if (!from || !to || from > to) return 0;
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  }

  function inDateRange(key, range = {}) {
    const day = normalizeDateKey(key);
    if (!day) return false;
    const start = normalizeDateKey(range.start);
    const end = normalizeDateKey(range.end);
    if (start && day < start) return false;
    if (end && day > end) return false;
    return true;
  }

  function previousRange(range) {
    const start = normalizeDateKey(range?.start);
    const end = normalizeDateKey(range?.end);
    const days = inclusiveDays(start, end);
    if (days <= 0) return { start: '', end: '' };
    const prevEnd = addDaysUTC(start, -1);
    return { start: addDaysUTC(prevEnd, -(days - 1)), end: prevEnd };
  }

  function utcWeekday(key) {
    const day = normalizeDateKey(key);
    if (!day) return -1;
    return new Date(`${day}T00:00:00Z`).getUTCDay();
  }

  function filterWeekday(daily, weekday) {
    if (weekday == null || weekday === '') return Array.isArray(daily) ? daily : [];
    const want = Number(weekday);
    if (!Number.isInteger(want) || want < 0 || want > 6) return Array.isArray(daily) ? daily : [];
    return (Array.isArray(daily) ? daily : []).filter((row) => utcWeekday(row?.date) === want);
  }

  function weekdayTotals(daily, { firstDay = 1 } = {}) {
    const start = ((Number(firstDay) % 7) + 7) % 7;
    const buckets = Array.from({ length: 7 }, (_, index) => ({
      weekday: (start + index) % 7,
      tokens: 0,
      cost: 0,
      messages: 0
    }));
    const indexOf = Object.fromEntries(buckets.map((bucket, index) => [bucket.weekday, index]));
    for (const row of Array.isArray(daily) ? daily : []) {
      const weekday = utcWeekday(row?.date);
      const index = indexOf[weekday];
      if (index == null) continue;
      buckets[index].tokens += n(row?.tokens);
      buckets[index].cost += n(row?.cost);
      buckets[index].messages += n(row?.messages);
    }
    return buckets;
  }

  function computeStreaks(days, todayKey) {
    const active = new Set();
    for (const row of Array.isArray(days) ? days : []) {
      if (n(row?.tokens) > 0) {
        const key = normalizeDateKey(row?.date);
        if (key) active.add(key);
      }
    }
    let currentStreak = 0;
    let cursor = normalizeDateKey(todayKey);
    while (cursor && active.has(cursor)) {
      currentStreak += 1;
      cursor = addDaysUTC(cursor, -1);
    }
    const sorted = [...active].sort();
    let longestStreak = 0;
    let run = 0;
    let prev = '';
    for (const key of sorted) {
      run = prev && key === addDaysUTC(prev, 1) ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      prev = key;
    }
    return { currentStreak, longestStreak };
  }

  function favoriteModelOf(daily) {
    const totals = {};
    for (const row of Array.isArray(daily) ? daily : []) mergeMap(totals, row?.perModel);
    return rankedEntries(totals, 'tokens', 1)[0]?.key || '';
  }

  function windowSummary(daily, options = {}) {
    const rows = Array.isArray(daily) ? daily : [];
    let totalTokens = 0;
    let totalCost = 0;
    let messages = 0;
    let outputTokens = 0;
    let activeTimeMs = 0;
    let activeDays = 0;
    let peakDayTokens = 0;
    let timedOutputTokens = 0;
    let timedDurationMs = 0;
    for (const row of rows) {
      const tokens = n(row?.tokens);
      totalTokens += tokens;
      totalCost += n(row?.cost);
      messages += n(row?.messages);
      outputTokens += outputTokensOf(row);
      activeTimeMs += n(row?.activeTimeMs);
      timedOutputTokens += n(row?.timedOutputTokens);
      timedDurationMs += n(row?.timedDurationMs);
      if (tokens > 0) activeDays += 1;
      peakDayTokens = Math.max(peakDayTokens, tokens);
    }
    const endKey = normalizeDateKey(options.endKey) || (rows.length ? normalizeDateKey(rows[rows.length - 1]?.date) : '');
    const { currentStreak, longestStreak } = computeStreaks(
      Array.isArray(options.streakDaily) ? options.streakDaily : rows,
      endKey
    );
    return {
      totalTokens,
      totalCost,
      messages,
      outputTokens,
      activeTimeMs,
      activeDays,
      currentStreak,
      longestStreak,
      peakDayTokens,
      favoriteModel: favoriteModelOf(rows),
      outputTokPerSec: timedDurationMs > 0 && timedOutputTokens > 0
        ? timedOutputTokens * 1000 / timedDurationMs
        : 0
    };
  }

  const COMPARE_KEYS = [
    'totalTokens', 'totalCost', 'messages', 'outputTokens', 'activeTimeMs', 'activeDays', 'currentStreak',
    'peakDayTokens', 'outputTokPerSec'
  ];

  function changeRatio(current, previous) {
    const curr = n(current);
    const prev = n(previous);
    if (prev === 0) return curr === 0 ? 0 : null;
    return (curr - prev) / prev;
  }

  function compareSummary(current, previous) {
    const out = {};
    for (const key of COMPARE_KEYS) {
      const curr = n(current?.[key]);
      const prev = n(previous?.[key]);
      out[key] = { current: curr, previous: prev, delta: curr - prev, ratio: changeRatio(curr, prev) };
    }
    return out;
  }

  function groupDaily(daily, { period = 'day', weekStartsOn: firstDay = 1 } = {}) {
    const mode = normalizeGroupBy(period);
    const rows = (Array.isArray(daily) ? daily : [])
      .map((row) => ({ row, key: normalizeDateKey(row?.date) }))
      .filter((entry) => entry.key)
      .sort((a, b) => a.key.localeCompare(b.key));
    if (mode === 'day') {
      return rows.map(({ row, key }) => ({ ...row, date: key, endDate: key }));
    }
    const buckets = new Map();
    for (const { row, key } of rows) {
      const bucketKey = mode === 'month' ? key.slice(0, 7) : weekStartKey(key, firstDay);
      if (!bucketKey) continue;
      const cur = buckets.get(bucketKey) || emptyBucket(bucketKey);
      cur.tokens += n(row.tokens);
      cur.cost += n(row.cost);
      cur.messages += n(row.messages);
      cur.outputTokens += outputTokensOf(row);
      cur.activeTimeMs += n(row.activeTimeMs);
      cur.timedOutputTokens = n(cur.timedOutputTokens) + n(row.timedOutputTokens);
      cur.timedDurationMs = n(cur.timedDurationMs) + n(row.timedDurationMs);
      mergeMap(cur.perClient, row.perClient);
      mergeMap(cur.perModel, row.perModel);
      mergeClientModel(cur.perClientModel, row.perClientModel);
      if (key > cur.endDate) cur.endDate = key;
      buckets.set(bucketKey, cur);
    }
    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  function crossMatrix(daily, { metric = 'tokens', maxRows = 8, maxCols = 6 } = {}) {
    const metricKey = normalizeMetric(metric);
    const nested = sumClientModel(daily);
    const rowTotals = {};
    const colTotals = {};
    const cells = {};
    let grand = 0;
    for (const [client, models] of Object.entries(nested)) {
      for (const [model, entry] of Object.entries(models || {})) {
        const value = metricOf(entry, metricKey);
        if (value <= 0) continue;
        addInto(rowTotals, client, entry);
        addInto(colTotals, model, entry);
        const cellKey = `${client}\0${model}`;
        cells[cellKey] = (cells[cellKey] || 0) + value;
        grand += value;
      }
    }
    const rowKeys = rankedEntries(rowTotals, metricKey, maxRows).map((row) => row.key);
    const colKeys = rankedEntries(colTotals, metricKey, maxCols).map((row) => row.key);
    const rowSet = new Set(rowKeys);
    const colSet = new Set(colKeys);
    const grid = rowKeys.map((client) => colKeys.map((model) => cells[`${client}\0${model}`] || 0));
    const shown = grid.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
    return {
      metric: metricKey,
      rowKeys,
      colKeys,
      grid,
      rowTotals: rowKeys.map((key) => metricOf(rowTotals[key], metricKey)),
      colTotals: colKeys.map((key) => metricOf(colTotals[key], metricKey)),
      grand,
      shown,
      other: Math.max(0, grand - shown),
      truncated: Object.keys(rowTotals).some((key) => !rowSet.has(key))
        || Object.keys(colTotals).some((key) => !colSet.has(key))
    };
  }

  // tokscale daily history has no hour-of-day. Session startedAt/lastUsedAt is
  // the only clock we have, so tokens smear across that local-hour span — not
  // an estimate of per-turn load, and a stale open session is capped so it
  // cannot paint every hour of the day.
  const HOUR_MS = 3600000;
  const MAX_SESSION_SPREAD_MS = 12 * HOUR_MS;
  const DASHBOARD_SESSION_LIMIT = 4000;
  const HOUR_SLOTS = [
    { id: 'night', start: 0, end: 6 },
    { id: 'morning', start: 6, end: 12 },
    { id: 'afternoon', start: 12, end: 18 },
    { id: 'evening', start: 18, end: 24 }
  ];

  function earlierIso(a, b) {
    const left = Date.parse(a) || 0;
    const right = Date.parse(b) || 0;
    if (!left) return b || '';
    if (!right) return a || '';
    return left <= right ? a : b;
  }

  function laterIso(a, b) {
    const left = Date.parse(a) || 0;
    const right = Date.parse(b) || 0;
    if (!left) return b || '';
    if (!right) return a || '';
    return left >= right ? a : b;
  }

  function mergeModelMap(target, source) {
    const next = { ...(target || {}) };
    for (const [key, value] of Object.entries(source || {})) {
      const tokens = n(value);
      if (tokens <= 0) continue;
      next[key] = Math.max(n(next[key]), tokens);
    }
    return next;
  }

  function compactSession(session) {
    const startedAt = String(session?.startedAt || '').trim();
    const lastUsedAt = String(session?.lastUsedAt || '').trim();
    if (!startedAt && !lastUsedAt) return null;
    if (!(Date.parse(startedAt) || Date.parse(lastUsedAt))) return null;
    const models = {};
    for (const [key, tokens] of Object.entries(session?.models || {})) {
      const value = n(tokens);
      if (value > 0) models[key] = value;
    }
    return {
      client: String(session?.client || ''),
      sessionId: String(session?.sessionId || ''),
      startedAt,
      lastUsedAt,
      tokens: n(session?.totalTokens ?? session?.tokens),
      cost: n(session?.costUsd ?? session?.cost),
      messages: n(session?.messageCount ?? session?.messages),
      models
    };
  }

  function mergeCompactSession(current, incoming) {
    if (!current) return incoming;
    return {
      client: incoming.client || current.client,
      sessionId: incoming.sessionId || current.sessionId,
      startedAt: earlierIso(current.startedAt, incoming.startedAt),
      lastUsedAt: laterIso(current.lastUsedAt, incoming.lastUsedAt),
      tokens: Math.max(current.tokens, incoming.tokens),
      cost: Math.max(current.cost, incoming.cost),
      messages: Math.max(current.messages, incoming.messages),
      models: mergeModelMap(current.models, incoming.models)
    };
  }

  function periodSessionMaps(record) {
    const periods = record?.periods && typeof record.periods === 'object' ? record.periods : record;
    return [periods?.today, periods?.month, periods?.allTime];
  }

  function ingestSessionMap(byKey, sessions, deviceId) {
    for (const [key, session] of Object.entries(sessions || {})) {
      const compact = compactSession(session);
      if (!compact) continue;
      if (!compact.sessionId) compact.sessionId = String(key);
      const mapKey = deviceId
        ? `${deviceId}\0${compact.client}\0${compact.sessionId}`
        : `${compact.client}\0${compact.sessionId}`;
      byKey.set(mapKey, mergeCompactSession(byKey.get(mapKey), compact));
    }
  }

  function compactDashboardSessions(devices, { extraPeriods = [], limit = DASHBOARD_SESSION_LIMIT } = {}) {
    const byKey = new Map();
    for (const device of Array.isArray(devices) ? devices : []) {
      const deviceId = String(device?.deviceId || device?.id || '');
      for (const period of periodSessionMaps(device)) {
        ingestSessionMap(byKey, period?.sessions, deviceId);
      }
    }
    for (const period of Array.isArray(extraPeriods) ? extraPeriods : []) {
      ingestSessionMap(byKey, period?.sessions, '');
      ingestSessionMap(byKey, period?.today?.sessions, '');
      ingestSessionMap(byKey, period?.month?.sessions, '');
      ingestSessionMap(byKey, period?.allTime?.sessions, '');
    }
    const cap = Math.max(0, Math.floor(Number(limit) || 0)) || DASHBOARD_SESSION_LIMIT;
    return [...byKey.values()]
      .sort((a, b) => (Date.parse(b.lastUsedAt || b.startedAt) || 0) - (Date.parse(a.lastUsedAt || a.startedAt) || 0))
      .slice(0, cap)
      .map((row) => ({
        client: row.client,
        startedAt: row.startedAt,
        lastUsedAt: row.lastUsedAt,
        tokens: row.tokens,
        cost: row.cost,
        messages: row.messages,
        models: row.models
      }));
  }

  function filterSessions(sessions, filter = {}) {
    const client = String(filter.client || '').trim();
    const model = String(filter.model || '').trim();
    return (Array.isArray(sessions) ? sessions : []).flatMap((session) => {
      if (client && session?.client !== client) return [];
      if (!model) return [session];
      const modelTokens = n(session?.models?.[model]);
      if (modelTokens <= 0) return [];
      const total = n(session?.tokens);
      const ratio = total > 0 ? Math.min(1, modelTokens / total) : 0;
      return [{
        ...session,
        tokens: modelTokens,
        cost: n(session?.cost) * ratio,
        messages: n(session?.messages) * ratio
      }];
    });
  }

  function spreadSessionHours(session, range = {}) {
    const startMs = Date.parse(session?.startedAt) || 0;
    const endMs = Date.parse(session?.lastUsedAt) || 0;
    const fromMs = startMs || endMs;
    const toMs = endMs || startMs;
    if (!fromMs) return [];
    let from = Math.min(fromMs, toMs);
    let to = Math.max(fromMs, toMs);
    if (to - from > MAX_SESSION_SPREAD_MS) from = to - MAX_SESSION_SPREAD_MS;

    const hours = [];
    const cursor = new Date(from);
    cursor.setMinutes(0, 0, 0);
    cursor.setSeconds(0, 0);
    const last = new Date(to);
    last.setMinutes(0, 0, 0);
    last.setSeconds(0, 0);
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard < 48) {
      hours.push({
        hour: cursor.getHours(),
        weekday: cursor.getDay(),
        dayKey: localDayKey(cursor)
      });
      cursor.setHours(cursor.getHours() + 1);
      guard += 1;
    }
    if (hours.length === 0) return [];
    const share = {
      tokens: n(session?.tokens ?? session?.totalTokens) / hours.length,
      cost: n(session?.cost ?? session?.costUsd) / hours.length,
      messages: n(session?.messages ?? session?.messageCount) / hours.length
    };
    return hours
      .filter((row) => inDateRange(row.dayKey, range) || (!range.start && !range.end))
      .map((row) => ({ ...row, ...share }));
  }

  function matchesWeekday(point, weekday) {
    if (weekday == null || weekday === '') return true;
    const want = Number(weekday);
    return Number.isInteger(want) && point.weekday === want;
  }

  function emptyHours() {
    return Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0, cost: 0, messages: 0 }));
  }

  function hourTotals(sessions, { range = {}, weekday = null } = {}) {
    const buckets = emptyHours();
    for (const session of Array.isArray(sessions) ? sessions : []) {
      for (const point of spreadSessionHours(session, range)) {
        if (!matchesWeekday(point, weekday)) continue;
        buckets[point.hour].tokens += point.tokens;
        buckets[point.hour].cost += point.cost;
        buckets[point.hour].messages += point.messages;
      }
    }
    return buckets;
  }

  function slotOfHour(hour) {
    const value = Number(hour);
    if (!Number.isInteger(value) || value < 0) return 'night';
    if (value < 6) return 'night';
    if (value < 12) return 'morning';
    if (value < 18) return 'afternoon';
    return 'evening';
  }

  function slotTotals(hours) {
    const slots = HOUR_SLOTS.map((slot) => ({ ...slot, tokens: 0, cost: 0, messages: 0 }));
    const indexOf = Object.fromEntries(slots.map((slot, index) => [slot.id, index]));
    for (const row of Array.isArray(hours) ? hours : []) {
      const slot = slots[indexOf[slotOfHour(row?.hour)]];
      if (!slot) continue;
      slot.tokens += n(row?.tokens);
      slot.cost += n(row?.cost);
      slot.messages += n(row?.messages);
    }
    return slots;
  }

  function weekdayHourGrid(sessions, { range = {}, firstDay = 1, weekday = null } = {}) {
    const start = ((Number(firstDay) % 7) + 7) % 7;
    const rows = Array.from({ length: 7 }, (_, index) => ({
      weekday: (start + index) % 7,
      hours: emptyHours()
    }));
    const indexOf = Object.fromEntries(rows.map((row, index) => [row.weekday, index]));
    for (const session of Array.isArray(sessions) ? sessions : []) {
      for (const point of spreadSessionHours(session, range)) {
        if (!matchesWeekday(point, weekday)) continue;
        const row = rows[indexOf[point.weekday]];
        if (!row) continue;
        row.hours[point.hour].tokens += point.tokens;
        row.hours[point.hour].cost += point.cost;
        row.hours[point.hour].messages += point.messages;
      }
    }
    return rows;
  }

  function usagePortrait(daily, sessions, options = {}) {
    const metric = normalizeMetric(options.metric);
    const range = options.range || {};
    const tools = rankedEntries(sumField(daily, 'perClient', metric), metric);
    const models = rankedEntries(sumField(daily, 'perModel', metric), metric);
    const toolTotal = tools.reduce((sum, row) => sum + n(row.value), 0);
    const modelTotal = models.reduce((sum, row) => sum + n(row.value), 0);
    const hours = hourTotals(sessions, { range, weekday: options.weekday });
    const slots = slotTotals(hours).map((slot) => {
      const value = metricOf(slot, metric);
      return { id: slot.id, start: slot.start, end: slot.end, tokens: slot.tokens, cost: slot.cost, value };
    });
    const slotTotal = slots.reduce((sum, slot) => sum + slot.value, 0);
    const slotShares = slots.map((slot) => ({
      ...slot,
      share: slotTotal > 0 ? slot.value / slotTotal : 0
    }));
    const peakSlot = slotShares.slice().sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))[0] || null;
    const weekdays = weekdayTotals(daily, { firstDay: options.firstDay });
    const weekTotal = weekdays.reduce((sum, row) => sum + metricOf(row, metric), 0);
    const weekend = weekdays
      .filter((row) => row.weekday === 0 || row.weekday === 6)
      .reduce((sum, row) => sum + metricOf(row, metric), 0);
    const weekendShare = weekTotal > 0 ? weekend / weekTotal : 0;
    const topToolShare = toolTotal > 0 ? n(tools[0]?.value) / toolTotal : 0;
    const topModelShare = modelTotal > 0 ? n(models[0]?.value) / modelTotal : 0;

    let time = 'unknown';
    if (slotTotal > 0) time = peakSlot && peakSlot.share >= 0.38 ? peakSlot.id : 'allDay';

    let focus = 'explorer';
    if (tools.length === 0) focus = 'explorer';
    else if (tools.length <= 1 || topToolShare >= 0.7) focus = 'specialist';
    else if (tools.length <= 3 && topToolShare >= 0.45) focus = 'regular';

    let catalog = 'mixer';
    if (models.length === 0) catalog = 'mixer';
    else if (models.length <= 1 || topModelShare >= 0.6) catalog = 'loyal';
    else if (models.length >= 6 || topModelShare < 0.35) catalog = 'hopper';

    let rhythm = 'mixed';
    if (weekTotal > 0 && weekendShare >= 0.42) rhythm = 'weekend';
    else if (weekTotal > 0 && weekendShare <= 0.18) rhythm = 'weekday';

    let combo = '';
    if (time === 'night' && rhythm === 'weekday') combo = 'officeNight';
    else if (time === 'night' && rhythm === 'weekend') combo = 'weekendNight';
    else if (time === 'evening' && rhythm === 'weekday') combo = 'officeEvening';
    else if (time === 'morning' && rhythm === 'weekday') combo = 'earlyClock';
    else if (time === 'allDay') combo = 'alwaysOn';
    else if (focus === 'explorer' && catalog === 'hopper') combo = 'restless';
    else if (focus === 'specialist' && catalog === 'loyal') combo = 'trueFan';

    const tagKeys = [];
    if (time !== 'unknown') tagKeys.push(`tag.time.${time}`);
    tagKeys.push(`tag.catalog.${catalog}`);
    tagKeys.push(`tag.rhythm.${rhythm}`);
    if (combo) tagKeys.push(`tag.combo.${combo}`);

    return {
      empty: toolTotal <= 0 && slotTotal <= 0,
      time,
      focus,
      catalog,
      rhythm,
      combo,
      tagKeys,
      topTool: tools[0]?.key || '',
      topModel: models[0]?.key || '',
      toolCount: tools.length,
      modelCount: models.length,
      topToolShare,
      topModelShare,
      weekendShare,
      tools,
      models,
      slots: slotShares
    };
  }

  return {
    normalizeMetric,
    normalizeDateKey,
    normalizeGroupBy,
    localDayKey,
    weekStartsOn,
    weekStartKey,
    dataBounds,
    resolveRange,
    sliceDaily,
    previousRange,
    inDateRange,
    utcWeekday,
    filterWeekday,
    weekdayTotals,
    windowSummary,
    changeRatio,
    compareSummary,
    groupDaily,
    hasClientModel,
    sumField,
    sumClientModel,
    rankedEntries,
    filterDaily,
    drillRows,
    crossMatrix,
    HOUR_SLOTS,
    compactDashboardSessions,
    filterSessions,
    spreadSessionHours,
    hourTotals,
    slotOfHour,
    slotTotals,
    weekdayHourGrid,
    usagePortrait
  };
});
