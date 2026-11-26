// @ts-check
'use strict';

const { readT3Activity } = require('../../t3/sessionActivity');
const { nativeAccountingId } = require('../../t3/sessionIdentity');
const { activityEntries, applyActivityPatch, projectNativeActivitySessions, rememberProjection } = require('../../sessionActivityProjection');
const { liveActivityExpiryAt } = require('../../sessionLive');

const CLIENT = 'antigravity';
const RENEW_INTERVAL_MS = 10_000;

/**
 * @param {Parameters<typeof activityEntries>[0]} summary
 * @param {Parameters<typeof readT3Activity>[0]} options
 */
async function readActivity(summary, options) {
  const readings = await readT3Activity(options, CLIENT);
  const sessions = [];
  for (const [sessionId, liveActivity] of readings) {
    if (liveActivity.state !== 'running' || nativeAccountingId(CLIENT, sessionId) !== sessionId) continue;
    const key = `${CLIENT}:${sessionId}`;
    sessions.push([key, {
      client: CLIENT, sessionId, native: true,
      totalTokens: 0, costUsd: 0, models: {}, tokenDataUnavailable: true,
      lastUsedAt: summary.nativeSessions?.today?.[key]?.lastUsedAt || liveActivity.observedAt,
      liveActivity
    }]);
  }
  return { readings, sessions: Object.fromEntries(sessions) };
}

/**
 * @param {Parameters<typeof activityEntries>[0]} summary
 * @param {Awaited<ReturnType<typeof readActivity>>} activity
 * @param {number} now
 */
function projectActivity(summary, { readings, sessions }, now = Date.now()) {
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
  const next = applyActivityPatch(summary, { observations: [...observations.values()] });
  // The lease can expire between reading SQLite and publishing the view.
  const activeSessions = Object.fromEntries(Object.entries(sessions).filter(([, row]) => liveActivityExpiryAt(row, now)));
  const nativeSessions = projectNativeActivitySessions(next, CLIENT, activeSessions, now, RENEW_INTERVAL_MS);
  if (!nativeSessions) return next;
  const projected = { ...next, nativeSessions };
  rememberProjection(next, projected);
  return projected;
}

module.exports = { readActivity, projectActivity };
