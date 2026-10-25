'use strict';

const os = require('node:os');
const { collectCredits } = require('../providers/workbuddy/credits');
const { buildCreditsSummary } = require('./summary');
const { buildConversionProfiles } = require('./calibration');

// Single attach point reused by the headless agent, the Electron main
// process and the usage worker thread: every transformed summary carries the
// WorkBuddy credit ledger or an explicit unavailable marker. Collect cost is
// one read-only SQLite pass (~ms at current scale); failures never break the
// usage pipeline they ride on.
function createCreditsAttacher({ home, deps, now } = {}) {
  const homeDir = home === undefined ? os.homedir() : home;
  return function withCredits(summary) {
    let credits;
    try {
      const collected = collectCredits({ home: homeDir, deps });
      credits = buildCreditsSummary(collected, now ? { now } : undefined);
      if (credits.available === true) {
        const { profiles, pending } = buildConversionProfiles(collected.sessions, { tool: credits.tool });
        if (profiles.length > 0 || pending.length > 0) credits.calibration = { profiles, pending };
      }
    } catch (error) {
      credits = { available: false, reason: `collect failed: ${error.message}` };
    }
    return { ...summary, credits };
  };
}

module.exports = { createCreditsAttacher };
