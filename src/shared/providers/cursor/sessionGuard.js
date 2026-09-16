'use strict';

const { numberValue } = require('../../archiveHelpers');

// Tokscale's legacy CSV cache produced one Cursor session per usage event,
// `cursor-<account>-<CSV date>`. Its JSON sync refetches the same history under
// conversation UUIDs, so an archived legacy row replayed beside the live
// conversation that now holds its event counts that usage twice.
//
// Neither row names the account, and `active` only meant whichever account was
// active when the CSV was written, so coverage cannot be proven outright. A
// legacy row is skipped only when a live conversation's whole usage is exactly
// the legacy events that fall inside it; the row stays archived and anything
// less certain replays as before. A replay miss repeats the double count this
// exists to remove, while a false match would hide usage that has no other
// record once its account is gone, so every doubt resolves toward replaying.
//
// The CSV date is tokscale's `parse_date_to_timestamp` input: second precision
// with optional fraction and optional `Z`, UTC either way. Date-only IDs are
// indistinguishable from the JSON fallback's per-day IDs and never match.
const LEGACY_EVENT_ID = /^cursor-.+?-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/i;

function isCursor(session) {
  return String(session?.client || '').trim().toLowerCase() === 'cursor';
}

function legacyCursorEventTime(session) {
  if (!isCursor(session)) return null;
  const match = LEGACY_EVENT_ID.exec(String(session?.sessionId || '').trim());
  if (!match) return null;
  const time = Date.parse(`${match[1]}Z`);
  return Number.isFinite(time) ? time : null;
}

function tokens(value) {
  return Math.round(numberValue(value));
}

function usedModels(session) {
  return Object.keys(session?.models || {}).filter((model) => tokens(session.models[model]) > 0);
}

// Live conversations grouped by each model they used. Bounds that are missing
// or inverted cannot place an event, so those sessions are left out.
function liveSessionsByModel(liveSessions) {
  const byModel = new Map();
  for (const [key, session] of Object.entries(liveSessions || {})) {
    if (!isCursor(session) || session.archived || legacyCursorEventTime(session) !== null) continue;
    const startedAt = Date.parse(session.startedAt || '');
    const lastUsedAt = Date.parse(session.lastUsedAt || '');
    if (!Number.isFinite(startedAt) || !Number.isFinite(lastUsedAt) || lastUsedAt < startedAt) continue;
    for (const model of usedModels(session)) {
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push({ key, session, startedAt, lastUsedAt });
    }
  }
  return byModel;
}

// Calls `assign(event, live)` for each event that falls inside exactly one live
// session. One sweep over time-sorted events keeps the sessions open at each
// event, so the cost is the sorts plus a linear pass however the intervals nest.
function assignToSoleContainingSession(events, sessions, assign) {
  const byStart = [...sessions].sort((left, right) => left.startedAt - right.startedAt);
  const byEnd = [...sessions].sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  const open = new Set();
  let started = 0;
  let ended = 0;
  for (const event of [...events].sort((left, right) => left.time - right.time)) {
    while (started < byStart.length && byStart[started].startedAt <= event.time) open.add(byStart[started++]);
    while (ended < byEnd.length && byEnd[ended].lastUsedAt < event.time) open.delete(byEnd[ended++]);
    if (open.size === 1) assign(event, open.values().next().value);
  }
}

// Archive keys of legacy Cursor events that live conversations already account
// for. Each event must fall inside exactly one conversation that used its model,
// and a conversation's events are skipped together only when they add up to
// that conversation's total and every per-model total. That rules out partial
// matches and conversations holding post-migration events, but it is a usage
// fingerprint rather than proof of account identity.
function coveredLegacyCursorSessionKeys(archivedSessions, liveSessions) {
  const covered = new Set();
  const liveByModel = liveSessionsByModel(liveSessions);
  if (liveByModel.size === 0) return covered;

  const eventsByModel = new Map();
  for (const [key, session] of archivedSessions) {
    const time = legacyCursorEventTime(session);
    const models = time === null ? [] : usedModels(session);
    if (models.length !== 1 || !liveByModel.has(models[0])) continue;
    if (!eventsByModel.has(models[0])) eventsByModel.set(models[0], []);
    eventsByModel.get(models[0]).push({ key, session, time });
  }

  const groups = new Map();
  for (const [model, events] of eventsByModel) {
    assignToSoleContainingSession(events, liveByModel.get(model), (event, live) => {
      const group = groups.get(live.key) || { live: live.session, totalTokens: 0, models: {}, keys: [] };
      group.totalTokens += tokens(event.session.totalTokens);
      group.models[model] = (group.models[model] || 0) + tokens(event.session.models[model]);
      group.keys.push(event.key);
      groups.set(live.key, group);
    });
  }

  for (const group of groups.values()) {
    const liveModels = usedModels(group.live);
    const exact = group.totalTokens === tokens(group.live.totalTokens)
      && liveModels.length === Object.keys(group.models).length
      && liveModels.every((model) => group.models[model] === tokens(group.live.models[model]));
    if (exact) group.keys.forEach((key) => covered.add(key));
  }
  return covered;
}

module.exports = { coveredLegacyCursorSessionKeys, legacyCursorEventTime };
