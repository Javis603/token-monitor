// @ts-check
'use strict';

const { readT3Activity } = require('../../t3/sessionActivity');
const { activityEntries, applyActivityPatch } = require('../../sessionActivityProjection');
const { liveActivityExpiryAt } = require('../../sessionLive');

const CLIENT = 'antigravity';
const RENEW_INTERVAL_MS = 10_000;

/**
 * @param {Parameters<typeof activityEntries>[0]} _summary
 * @param {Parameters<typeof readT3Activity>[0]} options
 */
async function readActivity(_summary, options) {
  return { readings: await readT3Activity(options, CLIENT) };
}

/**
 * @param {Parameters<typeof activityEntries>[0]} summary
 * @param {Awaited<ReturnType<typeof readActivity>>} activity
 * @param {number} now
 */
function projectActivity(summary, { readings }, now = Date.now()) {
  const observations = new Map();
  for (const { session } of activityEntries(summary, CLIENT, readings.keys())) {
    const { sessionId, liveActivity: previous } = session;
    if (observations.has(sessionId)) continue;
    const reading = readings.get(sessionId);
    // Keep permission and input prompts outside this adapter's running/idle
    // scope. In the absence of live evidence, restore the ordinary turn state.
    const hasLiveReading = (reading?.state === 'running' || reading?.state === 'idle')
      && liveActivityExpiryAt({ ...session, liveActivity: reading }, now);
    let liveActivity = hasLiveReading
      ? reading
      : { state: 'unknown', observedAt: new Date(now).toISOString() };
    // T3 only returns recent completions. A recovered completion can replace
    // the clearance once without advancing its clock on subsequent reads.
    if (liveActivity.state === 'idle' && previous?.state === 'unknown') {
      const clearedAt = Date.parse(previous.observedAt);
      if (clearedAt <= now && Date.parse(liveActivity.observedAt) < clearedAt) {
        liveActivity = { ...liveActivity, observedAt: previous.observedAt };
      }
    }
    if (!previous && liveActivity.state === 'unknown') continue;
    if (previous?.state === liveActivity.state && (liveActivity.state === 'unknown'
      || Date.parse(liveActivity.observedAt) - Date.parse(previous.observedAt) < RENEW_INTERVAL_MS)) continue;
    observations.set(sessionId, { client: CLIENT, sessionId, liveActivity });
  }
  return applyActivityPatch(summary, { observations: [...observations.values()] });
}

module.exports = { readActivity, projectActivity };
