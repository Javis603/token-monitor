'use strict';

const { readJson, writeJsonAtomic } = require('../../config');

// The console reports cumulative money spent and the current month, and nothing
// finer: the per-call ledger behind it is a paginated POST, so Today and Week are
// not questions this API answers. They are what the account spent between two
// observations of that total, kept in a local day-bucket ledger — the derivation
// Z.ai makes for its own cumulative report, with the retention DeepSeek's balance
// history keeps, so one wire field means one thing across providers.
//
// Month and All time stay provider-reported: rebasing them onto local buckets
// would trade a figure the console states for one this machine guessed. What the
// ledger adds is the two periods the console cannot state, plus `trackingSince`
// so a reader can tell a quiet day from a ledger that began today.
const MIMO_SPEND_STORE_VERSION = 1;
// 40 days, the window DeepSeek's history and Z.ai's report both keep.
const MIMO_SPEND_RETENTION_MS = 40 * 24 * 60 * 60 * 1000;

function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// A cumulative total only ever grows in normal use, so consumption is the
// positive delta between observations. A drop (refund, plan reset) moves the
// baseline without recording negative spend — the same rule Z.ai documents.
function recordMimoCumulativeSpend({ accountKey, currency, totalCost, now, storePath, readJson: readOverride, writeJsonAtomic: writeOverride }) {
  // A null total is a report that omitted the field, not a zero: Number(null)
  // is 0, so the check must come before the finite one or a missing field would
  // rebase the tracked total to zero.
  if (!accountKey || totalCost === null || !Number.isFinite(totalCost) || !storePath) return null;
  const nowMs = Number(now);
  const total = Math.max(0, totalCost);
  const read = readOverride || readJson;
  const write = writeOverride || writeJsonAtomic;
  let store;
  try {
    // config.readJson answers null for a missing or unparsable file instead of
    // throwing, so the shape check below — not only this try/catch — is what
    // makes a fresh store.
    store = read(storePath);
  } catch (_) {}
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || !store.accounts || typeof store.accounts !== 'object' || Array.isArray(store.accounts)) {
    store = { version: MIMO_SPEND_STORE_VERSION, accounts: {} };
  }
  const wanted = String(currency || '').trim();
  let entry = store.accounts[accountKey];
  let changed = false;
  // A ledger only compares like with like: the console states its spend in the
  // account's own currency, so a change of currency rebases the ledger instead
  // of subtracting one currency's total from another's — DeepSeek's rule.
  if (entry && wanted && String(entry.currency || '') !== wanted) {
    entry = null;
    changed = true;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    entry = { lastTotal: null, currency: wanted, dailySpend: {}, trackingSince: nowMs };
    changed = true;
  }
  if (!entry.dailySpend || typeof entry.dailySpend !== 'object' || Array.isArray(entry.dailySpend)) {
    entry.dailySpend = {};
    changed = true;
  }
  if (entry.lastTotal === null || !Number.isFinite(Number(entry.lastTotal))) {
    entry.lastTotal = total;
    changed = true;
  } else if (entry.lastTotal !== total) {
    const consumed = Math.max(0, total - entry.lastTotal);
    const dayKey = localDayKey(nowMs);
    entry.dailySpend[dayKey] = Math.round(((entry.dailySpend[dayKey] || 0) + consumed) * 100) / 100;
    entry.lastTotal = total;
    changed = true;
  }
  // Prune buckets past the retention window; the total this ledger rebases on
  // keeps accumulating without them, because the periods are read off the
  // console's own cumulative figure rather than summed from history.
  const cutoffKey = localDayKey(nowMs - MIMO_SPEND_RETENTION_MS);
  const pruned = {};
  for (const [key, amount] of Object.entries(entry.dailySpend || {})) {
    if (key >= cutoffKey) pruned[key] = amount;
  }
  if (Object.keys(pruned).length !== Object.keys(entry.dailySpend || {}).length) {
    entry.dailySpend = pruned;
    changed = true;
  }
  store.accounts[accountKey] = entry;
  // Best effort: a failed write (read-only dir, full disk) must not reject a
  // lane whose balance and quota did answer. The next round re-reads the older
  // baseline and its delta still lands.
  if (changed) {
    try {
      write(storePath, store);
    } catch (_) {}
  }

  const todayKey = localDayKey(nowMs);
  // Rolling seven days including today, matching what DeepSeek's history and
  // Z.ai's report mean by `weekSpend`.
  const weekStart = new Date(nowMs);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekKey = localDayKey(weekStart.getTime());
  const weekSpend = Math.round(Object.entries(entry.dailySpend)
    .filter(([key]) => key >= weekKey)
    .reduce((sum, [, amount]) => sum + amount, 0) * 100) / 100;
  // No `monthSinceTracking`: DeepSeek and Z.ai emit it because their month is
  // summed from these buckets, so "tracking began inside this month" qualifies a
  // figure they derived. MiMo's month is the console's own, and a flag that
  // qualifies a local derivation would misdescribe it.
  return {
    todaySpend: entry.dailySpend[todayKey] || 0,
    weekSpend,
    trackingSince: entry.trackingSince
  };
}

module.exports = {
  MIMO_SPEND_RETENTION_MS,
  MIMO_SPEND_STORE_VERSION,
  localDayKey,
  recordMimoCumulativeSpend
};
