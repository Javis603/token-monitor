'use strict';

const { readJson, writeJsonAtomic } = require('./config');

const RETENTION_MS = 40 * 24 * 60 * 60 * 1000;
const STORE_VERSION = 2;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfLocalMonth(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function sameLocalMonth(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();
}

function localDayKey(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMonthKey(ms) {
  return localDayKey(ms).slice(0, 7);
}

function localDayStartFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const value = date.getTime();
  return Number.isFinite(value) && localDayKey(value) === key ? value : null;
}

// snapshots: [{ ts: epochMs, paid: number }] — single currency.
// Spend = sum of paid drops (increases are top-ups -> 0), bucketed by interval-end local time.
function computeConsumption(snapshots, nowMs) {
  const sorted = [...(snapshots || [])]
    .map((s) => ({ ts: Number(s.ts), paid: Number(s.paid) }))
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.paid))
    .sort((a, b) => a.ts - b.ts);

  let todaySpend = 0;
  let monthSpend = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const drop = Math.max(0, sorted[i - 1].paid - sorted[i].paid);
    if (drop <= 0) continue;
    const ts = sorted[i].ts;
    if (sameLocalDay(ts, nowMs)) todaySpend += drop;
    if (sameLocalMonth(ts, nowMs)) monthSpend += drop;
  }

  const earliest = sorted.length ? sorted[0].ts : nowMs;
  return {
    todaySpend: round2(todaySpend),
    monthSpend: round2(monthSpend),
    monthSinceTracking: earliest > startOfLocalMonth(nowMs)
  };
}

function addDailySpend(dailySpend, timestamp, amount) {
  if (!(amount > 0)) return;
  const key = localDayKey(timestamp);
  dailySpend[key] = Number(dailySpend[key] || 0) + amount;
}

function compactLegacyEntry(entry, currency, now) {
  const snapshots = [...(entry?.snapshots || [])]
    .map((snapshot) => ({ ts: Number(snapshot?.ts), paid: Number(snapshot?.paid) }))
    .filter((snapshot) => Number.isFinite(snapshot.ts) && Number.isFinite(snapshot.paid))
    .sort((a, b) => a.ts - b.ts);
  const dailySpend = {};
  for (let index = 1; index < snapshots.length; index += 1) {
    addDailySpend(dailySpend, snapshots[index].ts, Math.max(0, snapshots[index - 1].paid - snapshots[index].paid));
  }
  return {
    version: STORE_VERSION,
    currency,
    trackingSince: snapshots[0]?.ts ?? Number(now),
    lastPaid: snapshots.at(-1)?.paid ?? null,
    dailySpend
  };
}

function normalizedCompactEntry(entry, currency, now) {
  if (entry?.version !== STORE_VERSION || entry?.currency !== currency) {
    if (entry?.currency === currency && Array.isArray(entry?.snapshots)) {
      return { entry: compactLegacyEntry(entry, currency, now), changed: true };
    }
    return {
      entry: {
        version: STORE_VERSION,
        currency,
        trackingSince: Number(now),
        lastPaid: null,
        dailySpend: {}
      },
      changed: true
    };
  }

  const trackingSince = Number(entry.trackingSince);
  const lastPaid = entry.lastPaid === null || entry.lastPaid === undefined || entry.lastPaid === ''
    ? null
    : Number(entry.lastPaid);
  const dailySpend = {};
  for (const [key, value] of Object.entries(entry.dailySpend || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const amount = Number(value);
    if (localDayStartFromKey(key) == null || !Number.isFinite(amount) || amount <= 0) continue;
    dailySpend[key] = amount;
  }
  const normalized = {
    version: STORE_VERSION,
    currency,
    trackingSince: Number.isFinite(trackingSince) ? trackingSince : Number(now),
    lastPaid: Number.isFinite(lastPaid) ? lastPaid : null,
    dailySpend
  };
  return { entry: normalized, changed: JSON.stringify(normalized) !== JSON.stringify(entry) };
}

function pruneDailySpend(dailySpend, now) {
  const cutoff = startOfLocalDay(Number(now) - RETENTION_MS);
  const pruned = {};
  for (const [key, amount] of Object.entries(dailySpend || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const dayStart = localDayStartFromKey(key);
    if (dayStart == null || dayStart < cutoff) continue;
    pruned[key] = amount;
  }
  return pruned;
}

function computeCompactConsumption(entry, now) {
  const todayKey = localDayKey(now);
  const monthKey = localMonthKey(now);
  let monthSpend = 0;
  for (const [key, amount] of Object.entries(entry.dailySpend || {})) {
    if (key.startsWith(monthKey)) monthSpend += Number(amount) || 0;
  }
  return {
    todaySpend: round2(entry.dailySpend?.[todayKey] || 0),
    monthSpend: round2(monthSpend),
    monthSinceTracking: Number(entry.trackingSince) > startOfLocalMonth(now)
  };
}

// deps: { readJson, writeJsonAtomic } injectable for tests.
function recordConsumption({ accountKey, currency, paid, now, storePath }, deps = {}) {
  const read = deps.readJson || readJson;
  const write = deps.writeJsonAtomic || writeJsonAtomic;
  const store = read(storePath, {}) || {};
  const nowMs = Number(now);
  const paidAmount = Number(paid);
  if (!accountKey || !currency || !Number.isFinite(nowMs) || !Number.isFinite(paidAmount)) {
    throw new TypeError('invalid DeepSeek balance observation');
  }

  const normalized = normalizedCompactEntry(store[accountKey], currency, nowMs);
  const entry = normalized.entry;
  let changed = normalized.changed;

  if (entry.lastPaid == null) {
    entry.lastPaid = paidAmount;
    changed = true;
  } else if (entry.lastPaid !== paidAmount) {
    addDailySpend(entry.dailySpend, nowMs, Math.max(0, entry.lastPaid - paidAmount));
    entry.lastPaid = paidAmount;
    changed = true;
  }

  const prunedDailySpend = pruneDailySpend(entry.dailySpend, nowMs);
  if (JSON.stringify(prunedDailySpend) !== JSON.stringify(entry.dailySpend)) changed = true;
  entry.dailySpend = prunedDailySpend;

  if (changed) {
    store[accountKey] = entry;
    write(storePath, store);
  }
  return computeCompactConsumption(entry, nowMs);
}

module.exports = {
  computeConsumption,
  recordConsumption,
  round2,
  startOfLocalDay,
  startOfLocalMonth
};
