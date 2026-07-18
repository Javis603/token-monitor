'use strict';

// Portable (Node-free) usage-history core. Mirrors usage.js conventions so the
// Cloudflare Worker can import it. Pure functions only — no I/O.

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeTimeMetrics(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    totalActiveTimeMs: num(value.totalActiveTimeMs ?? value.total_active_time_ms),
    longestContinuousMs: num(value.longestContinuousMs ?? value.longest_continuous_ms),
    maxConcurrentSessions: num(value.maxConcurrentSessions ?? value.max_concurrent_sessions),
    sessionCount: num(value.sessionCount ?? value.session_count)
  };
}

// Additive token components. `reasoning` is excluded on purpose: tokscale already
// folds reasoning into `output`, so adding it would double-count (same rule as usage.js).
function sumTokens(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return 0;
  return num(breakdown.input) + num(breakdown.output)
    + num(breakdown.cacheRead) + num(breakdown.cacheWrite);
}

// Folds tokscale `graph` output (contributions[].clients[]) into a per-day shape where a
// day's total always equals the sum of its perClient and perModel stacks.
function parseGraphResult(raw) {
  const contributions = [];
  const rows = raw && Array.isArray(raw.contributions) ? raw.contributions : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    const perClient = {};
    const perModel = {};
    let tokens = 0;
    let cost = 0;
    let messages = 0;
    const clientRows = Array.isArray(row.clients) ? row.clients : [];
    for (const c of clientRows) {
      if (!c || typeof c !== 'object') continue;
      const client = String(c.client || 'unknown');
      const model = String(c.modelId || c.model || c.model_id || 'unknown');
      const t = sumTokens(c.tokens);
      const cst = num(c.cost);
      const msg = num(c.messages);
      tokens += t;
      cost += cst;
      messages += msg;
      const pc = perClient[client] || (perClient[client] = { tokens: 0, cost: 0, messages: 0 });
      pc.tokens += t; pc.cost += cst; pc.messages += msg;
      const pm = perModel[model] || (perModel[model] = { tokens: 0, cost: 0 });
      pm.tokens += t; pm.cost += cst;
    }
    contributions.push({
      date,
      tokens,
      cost,
      messages,
      activeTimeMs: num(row.activeTimeMs ?? row.active_time_ms),
      perClient,
      perModel
    });
  }
  const timeMetrics = normalizeTimeMetrics(raw?.timeMetrics ?? raw?.time_metrics);
  return timeMetrics ? { contributions, timeMetrics } : { contributions };
}

function intensityBucket(value, max) {
  if (max <= 0) return 0;
  const ratio = num(value) / max;
  return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
}

// Preserve the legacy cost-based .intensity field for mixed-version hubs/widgets,
// while exposing explicit fields for new metric-aware renderers. Mutates and returns
// the same array.
function computeIntensities(days) {
  const list = Array.isArray(days) ? days : [];
  let maxTokens = 0;
  let maxCost = 0;
  for (const d of list) {
    maxTokens = Math.max(maxTokens, num(d.tokens));
    maxCost = Math.max(maxCost, num(d.cost));
  }
  for (const d of list) {
    d.tokenIntensity = intensityBucket(d.tokens, maxTokens);
    d.costIntensity = intensityBucket(d.cost, maxCost);
    d.intensity = d.costIntensity;
  }
  return list;
}

function dayKeyAddDays(key, delta) {
  const ms = Date.parse(`${key}T00:00:00Z`) + delta * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// A day is "active" when tokens > 0. currentStreak = consecutive active days ending at
// todayKey (0 if today is inactive). longestStreak = longest run anywhere.
function computeStreaks(days, todayKey) {
  const active = new Set();
  for (const d of (Array.isArray(days) ? days : [])) {
    if (num(d.tokens) > 0) active.add(String(d.date).slice(0, 10));
  }
  // current: walk back from todayKey while active
  let currentStreak = 0;
  let cursor = String(todayKey).slice(0, 10);
  while (active.has(cursor)) {
    currentStreak += 1;
    cursor = dayKeyAddDays(cursor, -1);
  }
  // longest: scan sorted active dates for consecutive runs
  const sorted = [...active].sort();
  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const key of sorted) {
    run = (prev !== null && key === dayKeyAddDays(prev, 1)) ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = key;
  }
  return { currentStreak, longestStreak };
}

function addPerClient(target, source) {
  for (const [client, v] of Object.entries(source || {})) {
    const t = target[client] || (target[client] = { tokens: 0, cost: 0, messages: 0 });
    t.tokens += num(v.tokens); t.cost += num(v.cost); t.messages += num(v.messages);
  }
}

function addPerModel(target, source) {
  for (const [model, v] of Object.entries(source || {})) {
    const t = target[model] || (target[model] = { tokens: 0, cost: 0 });
    t.tokens += num(v.tokens); t.cost += num(v.cost);
  }
}

function activeTimeTotal(days) {
  return (Array.isArray(days) ? days : []).reduce((sum, day) => sum + num(day.activeTimeMs), 0);
}

function monthlyRollup(days) {
  const byMonth = new Map();
  for (const d of (Array.isArray(days) ? days : [])) {
    const month = String(d.date).slice(0, 7);
    if (month.length !== 7) continue;
    const m = byMonth.get(month) || { month, tokens: 0, cost: 0, activeTimeMs: 0, perClient: {}, perModel: {} };
    m.tokens += num(d.tokens); m.cost += num(d.cost); m.activeTimeMs += num(d.activeTimeMs);
    addPerClient(m.perClient, d.perClient);
    addPerModel(m.perModel, d.perModel);
    byMonth.set(month, m);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

const DEFAULT_CAP_DAYS = 370;

function rollingDailyWindow(days, todayKey, capDays = DEFAULT_CAP_DAYS) {
  const count = Math.max(0, Math.floor(num(capDays)));
  if (count === 0) return [];
  const startKey = dayKeyAddDays(todayKey, -(count - 1));
  return (Array.isArray(days) ? days : []).filter((d) => {
    const key = String(d?.date || '').slice(0, 10);
    return key >= startKey && key <= todayKey;
  });
}

function favoriteModelOf(contributions) {
  const totals = {};
  for (const d of contributions) {
    for (const [model, v] of Object.entries(d.perModel || {})) {
      totals[model] = (totals[model] || 0) + num(v.tokens);
    }
  }
  let best = '';
  let bestTokens = -1;
  for (const [model, t] of Object.entries(totals)) {
    if (t > bestTokens) { best = model; bestTokens = t; }
  }
  return best;
}

// Three-tier output. The daily tier is capped to capDays (default 370) ending at todayKey;
// monthly and summary are derived from the FULL (uncapped) contribution set, so the cap
// never affects lifetime totals.
function normalizeHistory(graphData, options = {}) {
  const capDays = Number.isFinite(options.capDays) ? options.capDays : DEFAULT_CAP_DAYS;
  const todayKey = String(options.todayKey || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const full = (graphData && Array.isArray(graphData.contributions) ? graphData.contributions : [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const daily = rollingDailyWindow(full, todayKey, capDays).map((d) => ({ ...d }));
  computeIntensities(daily);

  const monthly = monthlyRollup(full);
  const totalTokens = full.reduce((s, d) => s + num(d.tokens), 0);
  const totalCost = full.reduce((s, d) => s + num(d.cost), 0);
  const messages = full.reduce((s, d) => s + num(d.messages), 0);
  const activeDays = full.reduce((s, d) => s + (num(d.tokens) > 0 ? 1 : 0), 0);
  const peakDayTokens = full.reduce((m, d) => Math.max(m, num(d.tokens)), 0);
  const { currentStreak, longestStreak } = computeStreaks(full, todayKey);
  const timeMetrics = normalizeTimeMetrics(graphData?.timeMetrics);
  const activeTimeMs = timeMetrics ? timeMetrics.totalActiveTimeMs : activeTimeTotal(full);

  return {
    daily,
    monthly,
    summary: {
      totalTokens, totalCost, activeDays, currentStreak, longestStreak,
      peakDayTokens, favoriteModel: favoriteModelOf(full), messages,
      activeTimeMs,
      ...(timeMetrics ? { timeMetrics } : {})
    }
  };
}

function mergeDailyMaps(histories) {
  const byDate = new Map();
  for (const h of histories) {
    for (const d of (h && Array.isArray(h.daily) ? h.daily : [])) {
      const cur = byDate.get(d.date)
        || { date: d.date, tokens: 0, cost: 0, messages: 0, activeTimeMs: 0, perClient: {}, perModel: {} };
      cur.tokens += num(d.tokens); cur.cost += num(d.cost); cur.messages += num(d.messages); cur.activeTimeMs += num(d.activeTimeMs);
      addPerClient(cur.perClient, d.perClient);
      addPerModel(cur.perModel, d.perModel);
      byDate.set(d.date, cur);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function mergeMonthlyMaps(histories) {
  const byMonth = new Map();
  for (const h of histories) {
    for (const m of (h && Array.isArray(h.monthly) ? h.monthly : [])) {
      const cur = byMonth.get(m.month) || { month: m.month, tokens: 0, cost: 0, activeTimeMs: 0, perClient: {}, perModel: {} };
      cur.tokens += num(m.tokens); cur.cost += num(m.cost); cur.activeTimeMs += num(m.activeTimeMs);
      addPerClient(cur.perClient, m.perClient);
      addPerModel(cur.perModel, m.perModel);
      byMonth.set(m.month, cur);
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Combine per-device histories. daily unions by date (sum + recompute intensity); monthly
// unions by month. Lifetime totals come from the uncapped monthly tier; daily-granularity
// stats (active days / peak / streaks) come from the merged daily window.
function mergeHistories(histories, options = {}) {
  const list = Array.isArray(histories) ? histories : [];
  const todayKey = String(options.todayKey || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const capDays = Number.isFinite(options.capDays) ? options.capDays : DEFAULT_CAP_DAYS;

  // Re-cap after merging: an offline device's persisted daily tier no longer
  // advances at collection time, but the aggregate must keep a rolling window.
  // Monthly/lifetime data remains durable and uncapped.
  const daily = rollingDailyWindow(mergeDailyMaps(list), todayKey, capDays);
  computeIntensities(daily);
  const monthly = mergeMonthlyMaps(list);

  const totalTokens = monthly.reduce((s, m) => s + num(m.tokens), 0);
  const totalCost = monthly.reduce((s, m) => s + num(m.cost), 0);
  const messages = monthly.reduce((s, m) => {
    for (const v of Object.values(m.perClient || {})) s += num(v.messages);
    return s;
  }, 0);
  const activeDays = daily.reduce((s, d) => s + (num(d.tokens) > 0 ? 1 : 0), 0);
  const peakDayTokens = daily.reduce((mx, d) => Math.max(mx, num(d.tokens)), 0);
  const { currentStreak, longestStreak } = computeStreaks(daily, todayKey);
  const favoriteModel = favoriteModelOf(daily);
  const activeTimeMs = activeTimeTotal(monthly.length ? monthly : daily);

  return {
    daily,
    monthly,
    summary: {
      totalTokens, totalCost, activeDays, currentStreak, longestStreak,
      peakDayTokens, favoriteModel, messages, activeTimeMs
    }
  };
}

// Defensively normalize arbitrary wire JSON to the { daily, monthly, summary } shape.
function coerceHistory(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    daily: Array.isArray(src.daily) ? src.daily : [],
    monthly: Array.isArray(src.monthly) ? src.monthly : [],
    summary: src.summary && typeof src.summary === 'object' ? src.summary : {}
  };
}

const HISTORY_PREVIEW_DAILY_DAYS = 26 * 7;

// Trim a full History to a compact, per-client-free payload for /api/stats.
function historyPreview(history, options = {}) {
  const dailyDays = Number.isFinite(options.dailyDays) ? options.dailyDays : HISTORY_PREVIEW_DAILY_DAYS;
  const monthlyMonths = Number.isFinite(options.monthlyMonths) ? options.monthlyMonths : 12;
  const h = coerceHistory(history);
  const daily = h.daily.slice(-dailyDays).map((d) => ({ date: d.date, tokens: num(d.tokens), cost: num(d.cost), activeTimeMs: num(d.activeTimeMs) }));
  const monthly = h.monthly.slice(-monthlyMonths).map((m) => ({ month: m.month, tokens: num(m.tokens), cost: num(m.cost), activeTimeMs: num(m.activeTimeMs) }));
  return { daily, monthly, summary: h.summary };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

// Compact, deterministic invalidation token for the full history payload. This
// includes daily/monthly breakdowns (not just headline totals), stays portable
// to the Worker runtime, and keeps /api/stats small.
function historyRevision(history) {
  const source = stableJson(coerceHistory(history));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

module.exports = {
  HISTORY_PREVIEW_DAILY_DAYS,
  num, sumTokens, parseGraphResult, computeIntensities,
  computeStreaks, monthlyRollup, normalizeHistory, mergeHistories,
  coerceHistory, historyPreview, historyRevision
};
