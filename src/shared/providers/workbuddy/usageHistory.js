'use strict';

// WorkBuddy Credits spend for the Spend row, sourced from the per-request
// billing ledger instead of a locally diffed cumulative total. See
// `usageRecords.js` for the request and the period arithmetic; this module is
// the provider-facing entry point that owns the failure policy.
//
// Why the ledger: the older approach diffed each account's aggregate used
// Credits against the previous observation, so the figures only covered time
// this machine was running the collector, and a cycle reset or package change
// silently moved the baseline. The ledger answers with real timestamps, so a
// period is complete for every row the provider kept.

const { fetchWorkbuddyUsageSpend } = require('./usageRecords');

/**
 * Read the Spend periods for one account.
 *
 * Spend is enrichment, never the reason a quota row fails: a ledger read that
 * throws or is refused yields `null`, and the caller keeps publishing the
 * Credits balance without the Spend fields.
 *
 * @param post - `(path, body) => Promise<body>`, bound to the account's billing
 *   transport so credentials, host and realm stay in `limits.js`.
 * @param now - observation time in epoch milliseconds.
 * @returns the Spend fields, or `null` when the ledger could not be read.
 */
async function recordWorkbuddyUsage(post, now) {
  if (typeof post !== 'function') return null;
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) return null;
  try {
    const spend = await fetchWorkbuddyUsageSpend(post, nowMs);
    if (!spend) return null;
    return {
      todaySpend: spend.todaySpend,
      weekSpend: spend.weekSpend,
      monthSpend: spend.monthSpend,
      // No allTimeSpend: the ledger API caps a request at 31 days and answers an
      // empty ledger beyond that, so any "all time" figure would be the window
      // total wearing a lifetime label. Omitting the field is what removes the
      // row entirely — the shared Spend renderer only draws entries a provider
      // actually reports.
      //
      // A month whose first day falls outside the window is a floor, not a
      // total; `monthSinceTracking` marks it, the same partial-coverage signal
      // DeepSeek and Z.ai emit.
      monthSinceTracking: !spend.monthFullyCovered,
      ...(spend.truncated ? { spendTruncated: true } : {})
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  recordWorkbuddyUsage
};
