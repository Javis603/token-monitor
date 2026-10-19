'use strict';

const { readJson, writeJsonAtomic } = require('../../config');

// Derive Today/Week/Month/All-time WorkBuddy Credits spend from positive deltas
// of the aggregate used total, as Z.ai and MiMo do for their cumulative
// figures. The billing API answers with one current-cycle used total per
// account and no period rollups, so a local snapshot diff is the only source
// for these periods.
const WORKBUDDY_USAGE_STORE_VERSION = 1;
// 40 days, the window DeepSeek's history and Z.ai's report both keep: it
// covers the rolling week and any calendar month with margin.
const WORKBUDDY_USAGE_RETENTION_MS = 40 * 24 * 60 * 60 * 1000;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function validTimeMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return null;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function localMonthKey(ms) {
  return localDayKey(ms).slice(0, 7);
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalMonth(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
}

function dayStartFromKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  // Only well-formed local day keys take part in sums and pruning: a stray key
  // would otherwise compare greater than every real date and inflate totals.
  return localDayKey(date.getTime()) === key ? date.getTime() : null;
}

function sumDailySpend(dailySpend, fromKey, toKey) {
  let total = 0;
  for (const [key, amount] of Object.entries(dailySpend || {})) {
    if (dayStartFromKey(key) === null) continue;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (key >= fromKey && key <= toKey) total += value;
  }
  return round2(total);
}

// A used total only ever grows inside a billing cycle, so consumption is the
// positive delta between observations. A drop (cycle reset, package expiry,
// package set change) moves the baseline without recording negative spend —
// the same rule Z.ai and MiMo document for their cumulative totals.
function recordWorkbuddyUsage({
  accountKey,
  used,
  now,
  storePath,
  readJson: readOverride,
  writeJsonAtomic: writeOverride
}) {
  const wantedKey = String(accountKey || '').trim();
  const usedTotal = used === null || used === undefined || used === '' ? null : Number(used);
  const nowMs = validTimeMs(now);
  // An omitted reading must not rebase the ledger to zero.
  if (!wantedKey || usedTotal === null || !Number.isFinite(usedTotal) || !storePath || nowMs === null) return null;
  const read = readOverride || readJson;
  const write = writeOverride || writeJsonAtomic;
  const observed = Math.max(0, usedTotal);

  let store;
  try {
    // config.readJson answers null for a missing or unparsable file instead of
    // throwing, so the shape check below — not only this try/catch — is what
    // makes a fresh store.
    store = read(storePath);
  } catch (_) {}
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || !store.accounts || typeof store.accounts !== 'object' || Array.isArray(store.accounts)) {
    store = { version: WORKBUDDY_USAGE_STORE_VERSION, accounts: {} };
  }

  let entry = store.accounts[wantedKey];
  let changed = false;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    entry = { lastUsed: null, dailySpend: {}, allTimeSpend: 0, trackingSince: nowMs };
    changed = true;
  }
  if (!entry.dailySpend || typeof entry.dailySpend !== 'object' || Array.isArray(entry.dailySpend)) {
    entry.dailySpend = {};
    changed = true;
  }
  if (!Number.isFinite(Number(entry.allTimeSpend)) || Number(entry.allTimeSpend) < 0) {
    entry.allTimeSpend = 0;
    changed = true;
  }
  const trackingSince = validTimeMs(entry.trackingSince) ?? nowMs;
  if (trackingSince !== entry.trackingSince) {
    entry.trackingSince = trackingSince;
    changed = true;
  }

  if (entry.lastUsed === null || entry.lastUsed === undefined || entry.lastUsed === '') {
    entry.lastUsed = observed;
    changed = true;
  } else if (Number(entry.lastUsed) !== observed) {
    const consumed = Math.max(0, observed - Number(entry.lastUsed));
    if (consumed > 0) {
      const dayKey = localDayKey(nowMs);
      entry.dailySpend[dayKey] = round2(Number(entry.dailySpend[dayKey] || 0) + consumed);
      entry.allTimeSpend = round2(Number(entry.allTimeSpend || 0) + consumed);
    }
    // A drop only rebases the baseline; already-recorded spend stays recorded.
    entry.lastUsed = observed;
    changed = true;
  }

  // Prune buckets past the retention window; the all-time total this ledger
  // reports keeps accumulating without them, because it is summed from the
  // recorded deltas rather than read off a provider figure.
  const cutoff = startOfLocalDay(nowMs - WORKBUDDY_USAGE_RETENTION_MS);
  const pruned = {};
  for (const [key, amount] of Object.entries(entry.dailySpend)) {
    const dayStart = dayStartFromKey(key);
    const value = Number(amount);
    if (dayStart === null || !Number.isFinite(value) || value <= 0 || dayStart < cutoff) {
      changed = true;
      continue;
    }
    pruned[key] = round2(value);
  }
  if (changed || Object.keys(pruned).length !== Object.keys(entry.dailySpend).length) {
    entry.dailySpend = pruned;
    changed = true;
  }
  store.accounts[wantedKey] = entry;
  // Best effort: a failed write (read-only dir, full disk) must not reject a
  // lane whose quota did answer. The next round uses the persisted baseline,
  // attributing any missed delta to that observation's day.
  if (changed) {
    try {
      write(storePath, store);
    } catch (_) {}
  }

  const todayKey = localDayKey(nowMs);
  // Rolling seven days including today, matching what DeepSeek's history and
  // Z.ai's report mean by weekSpend.
  const weekStart = new Date(nowMs);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  return {
    todaySpend: round2(entry.dailySpend[todayKey] || 0),
    weekSpend: sumDailySpend(entry.dailySpend, localDayKey(weekStart.getTime()), todayKey),
    monthSpend: sumDailySpend(entry.dailySpend, localMonthKey(nowMs), todayKey),
    allTimeSpend: round2(entry.allTimeSpend),
    trackingSince: new Date(trackingSince).toISOString(),
    // The month figure is summed from local buckets, so tracking that began
    // inside this month qualifies it — the marker DeepSeek and Z.ai emit.
    monthSinceTracking: trackingSince > startOfLocalMonth(nowMs)
  };
}

module.exports = {
  WORKBUDDY_USAGE_RETENTION_MS,
  WORKBUDDY_USAGE_STORE_VERSION,
  localDayKey,
  localMonthKey,
  recordWorkbuddyUsage,
  startOfLocalDay,
  startOfLocalMonth
};
