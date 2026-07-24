'use strict';

const { readJson, writeJsonAtomic } = require('./config');

const RETENTION_MS = 40 * 24 * 60 * 60 * 1000;
const STORE_VERSION = 2;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function validDateMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
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

function addDailySpend(dailySpend, timestamp, amount) {
  if (!(amount > 0)) return;
  const key = localDayKey(timestamp);
  dailySpend[key] = round2(Number(dailySpend[key] || 0) + amount);
}

function compactLegacyEntry(entry, currency, now) {
  const snapshots = [...(entry?.snapshots || [])]
    .map((snapshot) => ({ ts: validDateMs(snapshot?.ts), paid: Number(snapshot?.paid) }))
    .filter((snapshot) => snapshot.ts !== null && Number.isFinite(snapshot.paid))
    .sort((a, b) => a.ts - b.ts);
  const dailySpend = {};
  for (let index = 1; index < snapshots.length; index += 1) {
    addDailySpend(dailySpend, snapshots[index].ts, Math.max(0, snapshots[index - 1].paid - snapshots[index].paid));
  }
  const allTimeSpend = round2(Object.values(dailySpend).reduce((sum, amount) => sum + Number(amount || 0), 0));
  return {
    version: STORE_VERSION,
    currency,
    trackingSince: snapshots[0]?.ts ?? Number(now),
    lastPaid: snapshots.at(-1)?.paid ?? null,
    allTimeSpend,
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
        allTimeSpend: 0,
        dailySpend: {}
      },
      changed: true
    };
  }

  const trackingSince = validDateMs(entry.trackingSince);
  const lastPaid = entry.lastPaid === null || entry.lastPaid === undefined || entry.lastPaid === ''
    ? null
    : Number(entry.lastPaid);
  const dailySpend = {};
  for (const [key, value] of Object.entries(entry.dailySpend || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const amount = Number(value);
    if (localDayStartFromKey(key) == null || !Number.isFinite(amount) || amount <= 0) continue;
    dailySpend[key] = round2(amount);
  }
  const storedAllTimeSpend = Number(entry.allTimeSpend);
  const allTimeSpend = Number.isFinite(storedAllTimeSpend) && storedAllTimeSpend >= 0
    ? round2(storedAllTimeSpend)
    : round2(Object.values(dailySpend).reduce((sum, amount) => sum + Number(amount || 0), 0));
  const normalized = {
    version: STORE_VERSION,
    currency,
    trackingSince: trackingSince ?? Number(now),
    lastPaid: Number.isFinite(lastPaid) ? lastPaid : null,
    allTimeSpend,
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

function compactLegacyEntries(store, now) {
  const compacted = { ...store };
  let changed = false;
  for (const [accountKey, entry] of Object.entries(store || {})) {
    const currency = String(entry?.currency || '').trim();
    if (!currency || !Array.isArray(entry?.snapshots)) continue;
    const compactEntry = compactLegacyEntry(entry, currency, now);
    compactEntry.dailySpend = pruneDailySpend(compactEntry.dailySpend, now);
    compacted[accountKey] = compactEntry;
    changed = true;
  }
  return { store: compacted, changed };
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
    allTimeSpend: round2(entry.allTimeSpend || 0),
    trackingSince: new Date(Number(entry.trackingSince)).toISOString(),
    monthSinceTracking: Number(entry.trackingSince) > startOfLocalMonth(now)
  };
}

function loadStore(read, storePath, legacyStorePath) {
  const current = read(storePath, null);
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return { store: current, migrated: false };
  }
  if (legacyStorePath && legacyStorePath !== storePath) {
    const legacy = read(legacyStorePath, null);
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      return { store: legacy, migrated: true };
    }
  }
  return { store: {}, migrated: false };
}

// deps: { readJson, writeJsonAtomic } injectable for tests.
function recordConsumption({ accountKey, currency, paid, now, storePath, legacyStorePath }, deps = {}) {
  const read = deps.readJson || readJson;
  const write = deps.writeJsonAtomic || writeJsonAtomic;
  const nowMs = validDateMs(now);
  const paidAmount = Number(paid);
  if (!accountKey || !currency || !storePath || nowMs === null || !Number.isFinite(paidAmount)) {
    throw new TypeError('invalid DeepSeek balance observation');
  }

  const loaded = loadStore(read, storePath, legacyStorePath);
  const compacted = compactLegacyEntries(loaded.store, nowMs);
  const store = compacted.store;
  const normalized = normalizedCompactEntry(store[accountKey], currency, nowMs);
  const entry = normalized.entry;
  let changed = loaded.migrated || compacted.changed || normalized.changed;

  if (entry.lastPaid == null) {
    entry.lastPaid = paidAmount;
    changed = true;
  } else if (entry.lastPaid !== paidAmount) {
    const drop = Math.max(0, entry.lastPaid - paidAmount);
    addDailySpend(entry.dailySpend, nowMs, drop);
    entry.allTimeSpend = round2(Number(entry.allTimeSpend || 0) + drop);
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
  recordConsumption,
  round2,
  startOfLocalDay,
  startOfLocalMonth
};
