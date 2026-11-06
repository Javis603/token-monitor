'use strict';

// Trae exposes one cumulative number — `usage_summary.consumed_amount` — and
// nothing else: no per-request rows, no per-model tokens, no daily series (the
// only usage endpoint it has, query_user_usage_group_by_session, returns zero
// rows for a normal account). The local database is encrypted, so there is no
// second source to cross-check against.
//
// What is left is arithmetic across polls: remember the consumed counter, and
// the rise between two samples is the spend in between. A day's spend is
// `last - first` within that day; a week's is the sum of the daily rises. This
// is exact for "how much did the counter move", and lossy only for the unobserved
// tail after the final sample of a day — which is why the value is labelled as a
// poll-derived spend rather than a ledger.
//
// The store is deliberately boring JSON: one entry per local day, bounded, and
// never allowed to throw into the limits pipeline that rides on it.

const { sharedDataDir } = require('../../config');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const MAX_DAYS = 60;

function historyPath(options = {}) {
  return options.spendHistoryPath || path.join(sharedDataDir(options), 'trae-credit-spend.json');
}

function dayKey(date) {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function emptyHistory() {
  return { version: VERSION, days: {} };
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Unknown or corrupt documents degrade to an empty history: a broken snapshot
// must cost one day of spend history, not the credit card it is attached to.
function normalizeHistory(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return emptyHistory();
  const days = {};
  const entries = Object.entries(raw.days || {})
    .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key)
      && value && finiteNonNegative(value.first) !== null && finiteNonNegative(value.last) !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-MAX_DAYS);
  for (const [key, value] of entries) {
    days[key] = { first: Number(value.first), last: Number(value.last) };
  }
  return { version: VERSION, days };
}

function readHistory(options = {}) {
  try {
    return normalizeHistory(JSON.parse(fs.readFileSync(historyPath(options), 'utf8')));
  } catch (_) {
    return emptyHistory();
  }
}

function writeHistory(history, options = {}) {
  const target = historyPath(options);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(normalizeHistory(history))}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

// Folds one observation into the history. A counter that went *down* means the
// plan was topped up or reset, so the day restarts from the new value instead of
// reporting a negative spend.
function recordObservation(history, { used, at = Date.now() } = {}) {
  const value = finiteNonNegative(used);
  if (value === null) return normalizeHistory(history);
  const next = normalizeHistory(history);
  const key = dayKey(at);
  const previous = next.days[key];
  next.days[key] = previous
    ? { first: value < previous.first ? value : previous.first, last: value }
    : { first: value, last: value };
  // Normalisation already bounded the *existing* days; adding today can push the
  // store one past the cap, so trim again rather than letting a long-lived
  // install drift.
  const keys = Object.keys(next.days).sort();
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete next.days[stale];
  return next;
}

function daySpend(day) {
  if (!day) return 0;
  return Math.max(0, day.last - day.first);
}

// Calendar-based windows, not rolling 24h: the card says "today", so the number
// has to mean the local day the user is looking at.
function summarizeSpend(history, { now = Date.now() } = {}) {
  const normalized = normalizeHistory(history);
  const days = Object.entries(normalized.days).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const today = dayKey(now);
  const cutoff = (count) => {
    const from = new Date(now);
    from.setDate(from.getDate() - (count - 1));
    from.setHours(0, 0, 0, 0);
    return dayKey(from);
  };
  const weekFrom = cutoff(7);
  const monthFrom = cutoff(30);
  let todaySpend = 0;
  let weekSpend = 0;
  let monthSpend = 0;
  let trackedDays = 0;
  for (const [key, day] of days) {
    const spend = daySpend(day);
    if (spend > 0) trackedDays += 1;
    if (key === today) todaySpend += spend;
    if (key >= weekFrom) weekSpend += spend;
    if (key >= monthFrom) monthSpend += spend;
  }
  return {
    todaySpend: Math.round(todaySpend * 100) / 100,
    weekSpend: Math.round(weekSpend * 100) / 100,
    monthSpend: Math.round(monthSpend * 100) / 100,
    trackedDays
  };
}

// Newest first, one row per observed day. Only days that actually moved are
// returned: a day with no observation is not a day with no spend, and printing
// a zero would claim a measurement this data cannot make.
function dailyRows(history, { now = Date.now(), limit = 7 } = {}) {
  const normalized = normalizeHistory(history);
  const today = dayKey(now);
  const rows = [];
  for (const [key, day] of Object.entries(normalized.days).sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))) {
    if (rows.length >= limit) break;
    if (key > today) continue;
    const spend = daySpend(day);
    if (spend <= 0) continue;
    rows.push({ day: key, spend: Math.round(spend * 100) / 100 });
  }
  return rows;
}

// Read → fold → write in one call, returning the summary to publish. Any I/O
// failure still yields a usable summary for this poll.
function trackSpend({ used, at = Date.now(), options = {} } = {}) {
  const before = readHistory(options);
  const after = recordObservation(before, { used, at });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writeHistory(after, options);
  return summarizeSpend(after, { now: at });
}

module.exports = {
  VERSION,
  MAX_DAYS,
  historyPath,
  dayKey,
  emptyHistory,
  normalizeHistory,
  readHistory,
  writeHistory,
  recordObservation,
  summarizeSpend,
  dailyRows,
  trackSpend
};
