'use strict';

const { numberValue } = require('../../archiveHelpers');

// Tokscale's legacy CSV cache produced one Cursor session per usage event,
// `cursor-<account>-<CSV date>`. Its JSON sync refetches the same history under
// the session each event belongs to, so an archived legacy row replayed beside
// that session counts the event twice.
//
// The legacy row carries neither the account nor the conversation, and
// conversations on the same model overlap routinely, so neither can be inferred
// from timing. The JSON cache records both for the same event at the same
// millisecond with the same tokens, which identifies it exactly. The link is
// written onto the archived row once, while that cache exists, and replay skips
// a row only while its linked session is present; the row itself is kept.
//
// The CSV date is tokscale's `parse_date_to_timestamp` input: second precision
// with optional fraction and optional `Z`, UTC either way. Date-only IDs are
// indistinguishable from the JSON fallback's per-day IDs and are left alone.
const LEGACY_EVENT_ID = /^cursor-.+?-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/i;

function legacyCursorEventTime(session) {
  if (String(session?.client || '').trim().toLowerCase() !== 'cursor') return null;
  const match = LEGACY_EVENT_ID.exec(String(session?.sessionId || '').trim());
  if (!match) return null;
  const time = Date.parse(`${match[1]}Z`);
  return Number.isFinite(time) ? time : null;
}

function isLegacyCursorEntry(entry) {
  return legacyCursorEventTime({ client: entry?.client, sessionId: entry?.sessionId }) !== null;
}

// What a lookup is keyed on: the row's event time and its tokens. Every period
// of a legacy row holds the same single event, so they agree except while a
// progressive snapshot has refreshed one of them; the largest is the one the
// cache has to answer for, and a stale smaller period must not answer for a
// shape the row has already grown past.
function legacyCursorLookup(entry) {
  const sessions = Object.values(entry?.periods || {});
  const time = legacyCursorEventTime(sessions[0]);
  if (time === null) return null;
  const totalTokens = Math.max(...sessions.map((session) => Math.round(numberValue(session?.totalTokens))));
  return totalTokens > 0 ? { time, totalTokens } : null;
}

// The session ID the JSON cache files a legacy event under, or null when no
// event, or events in more than one session, match that lookup.
function supersedingCursorSessionId(lookup, usageEvents) {
  const sessionIds = usageEvents.sessionsAt(lookup.time, lookup.totalTokens);
  return sessionIds.length === 1 ? sessionIds[0] : null;
}

module.exports = {
  isLegacyCursorEntry,
  legacyCursorEventTime,
  legacyCursorLookup,
  supersedingCursorSessionId
};
