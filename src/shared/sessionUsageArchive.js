'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, normalizePeriod } = require('./usage');
const {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  periodFor,
  targetPeriod,
  toDate
} = require('./archiveHelpers');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { filterReasonixSyntheticSessions, isReasonixSyntheticSession } = require('./providers/reasonix/sessionGuard');
const {
  isLegacyCursorEntry,
  legacyCursorLookup,
  supersedingCursorSessionId
} = require('./providers/cursor/sessionGuard');

function sessionUsageArchiveDate(deviceRecord, fallback = new Date()) {
  const collectedAt = new Date(deviceRecord?.updatedAt || '');
  return Number.isNaN(collectedAt.getTime()) ? toDate(fallback) : collectedAt;
}

function sessionKey(client, sessionId) {
  const normalized = normalizePeriod({
    sessions: {
      candidate: { client, sessionId, totalTokens: 1 }
    }
  });
  const session = Object.values(normalized.sessions)[0];
  return session ? `${session.client}:${session.sessionId}` : null;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function normalizedSessionFrom(value, fallbackKey) {
  if (isReasonixSyntheticSession(value, fallbackKey)) return null;
  const period = normalizePeriod({ sessions: { [fallbackKey || 'session']: value } });
  return Object.values(period.sessions)[0] || null;
}

function hasSessionUsage(session) {
  return numberValue(session?.totalTokens) > 0 || numberValue(session?.costUsd) > 0;
}

function normalizeSessionUsageArchive(value) {
  const source = value?.sessions && typeof value.sessions === 'object' ? value.sessions : value;
  const normalized = { version: 1, sessions: {} };
  if (!source || typeof source !== 'object') return normalized;

  for (const [rawKey, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    if (isReasonixSyntheticSession(rawEntry, rawKey)) continue;
    const rawPeriods = rawEntry.periods && typeof rawEntry.periods === 'object'
      ? rawEntry.periods
      : rawEntry;
    const entry = {
      client: '',
      sessionId: '',
      capturedAt: toDate(rawEntry.capturedAt).toISOString(),
      day: String(rawEntry.day || localDay(rawEntry.capturedAt)),
      month: String(rawEntry.month || localMonth(rawEntry.capturedAt)),
      periodWindows: {},
      periods: {}
    };

    for (const periodName of PERIODS) {
      const session = normalizedSessionFrom(rawPeriods?.[periodName], rawKey);
      if (!session || isReasonixSyntheticSession(session, rawKey) || !hasSessionUsage(session)) continue;
      const key = sessionKey(session.client, session.sessionId);
      if (!key) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.periods[periodName] = session;
      const rawWindow = rawEntry.periodWindows?.[periodName] || {};
      entry.periodWindows[periodName] = {
        capturedAt: toDate(rawWindow.capturedAt || rawEntry.capturedAt).toISOString()
      };
      if (periodName === 'today') entry.periodWindows[periodName].day = String(rawWindow.day || rawEntry.day || localDay(rawEntry.capturedAt));
      if (periodName === 'month') entry.periodWindows[periodName].month = String(rawWindow.month || rawEntry.month || localMonth(rawEntry.capturedAt));
    }

    if (!entry.client || !entry.sessionId || Object.keys(entry.periods).length === 0) continue;
    const supersededBy = sessionKey('cursor', String(rawEntry.supersededBy || '').replace(/^cursor:/, ''));
    if (rawEntry.supersededBy && supersededBy && isLegacyCursorEntry(entry)) entry.supersededBy = supersededBy;
    normalized.sessions[`${entry.client}:${entry.sessionId}`] = entry;
  }

  return normalized;
}

function canonicalSessionUsageArchive(value) {
  if (value?.version === 1 && value.sessions && typeof value.sessions === 'object') return value;
  return normalizeSessionUsageArchive(value);
}

function pruneExpiredSessionUsagePeriods(archive, capturedAt, changedKeys) {
  const day = localDay(capturedAt);
  const month = localMonth(capturedAt);
  // Collector snapshots can finish out of order across processes. A stale
  // snapshot must never move the pruning frontier backwards.
  const pruneDay = !archive.prunedDay || archive.prunedDay < day;
  const pruneMonth = !archive.prunedMonth || archive.prunedMonth < month;
  if (!pruneDay && !pruneMonth) return;

  for (const [key, entry] of Object.entries(archive.sessions)) {
    let changed = false;
    entry.periodWindows = entry.periodWindows || {};
    const todayWindow = entry.periodWindows?.today;
    const retainedDay = todayWindow?.day || entry.day;
    if (pruneDay && entry.periods?.today && (!retainedDay || retainedDay < day)) {
      delete entry.periods.today;
      delete entry.periodWindows.today;
      changed = true;
    }
    const monthWindow = entry.periodWindows?.month;
    const retainedMonth = monthWindow?.month || entry.month;
    if (pruneMonth && entry.periods?.month && (!retainedMonth || retainedMonth < month)) {
      delete entry.periods.month;
      delete entry.periodWindows.month;
      changed = true;
    }
    if (changed) changedKeys.add(key);
  }
  if (pruneDay) archive.prunedDay = day;
  if (pruneMonth) archive.prunedMonth = month;
}

// The caller owns the canonical in-memory archive. Updating it in place keeps a
// watch tick proportional to the sessions in that tick instead of cloning and
// normalizing every retained session. Persistence receives only changed keys.
function updateSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date(), options = {}) {
  const archive = canonicalSessionUsageArchive(existingArchive);
  const changedKeys = new Set();
  const captureDate = toDate(capturedAt);
  const captureTime = captureDate.getTime();
  pruneExpiredSessionUsagePeriods(archive, captureDate, changedKeys);
  if (!deviceRecord || typeof deviceRecord !== 'object') return { archive, changedKeys };

  const capturedAtIso = captureDate.toISOString();
  const day = localDay(captureDate);
  const month = localMonth(captureDate);
  for (const periodName of PERIODS) {
    if (periodName === 'today' && archive.prunedDay && day < archive.prunedDay) continue;
    if (periodName === 'month' && archive.prunedMonth && month < archive.prunedMonth) continue;
    const rawPeriod = deviceRecord?.periods?.[periodName] || deviceRecord?.[periodName];
    const period = options.canonicalSummary === true
      ? (rawPeriod && typeof rawPeriod === 'object' ? rawPeriod : { sessions: {} })
      : periodFor(deviceRecord, periodName);
    for (const session of Object.values(period.sessions || {})) {
      if (isReasonixSyntheticSession(session) || !hasSessionUsage(session)) continue;
      const archiveKey = sessionKey(session.client, session.sessionId);
      if (!archiveKey) continue;
      const entry = archive.sessions[archiveKey] || {
        client: session.client,
        sessionId: session.sessionId,
        capturedAt: capturedAtIso,
        day,
        month,
        periodWindows: {},
        periods: {}
      };
      const nextSession = cloneJson(session);
      const window = entry.periodWindows?.[periodName] || {};
      const retainedCaptureTime = Date.parse(window.capturedAt || '');
      // SQLite serializes commits, not collection time. Keep the newest event
      // for each period when two collectors finish in the opposite order.
      if (Number.isFinite(retainedCaptureTime) && retainedCaptureTime > captureTime) continue;
      const sameWindow = periodName === 'today'
        ? window.day === day
        : periodName === 'month'
          ? window.month === month
          : true;
      if (sameJson(entry.periods[periodName], nextSession) && sameWindow) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.capturedAt = capturedAtIso;
      entry.day = day;
      entry.month = month;
      entry.periods[periodName] = nextSession;
      entry.periodWindows = entry.periodWindows || {};
      entry.periodWindows[periodName] = { capturedAt: capturedAtIso };
      if (periodName === 'today') entry.periodWindows[periodName].day = day;
      if (periodName === 'month') entry.periodWindows[periodName].month = month;
      archive.sessions[archiveKey] = entry;
      changedKeys.add(archiveKey);
    }
  }

  if (options.cursorUsageEvents) linkLegacyCursorEvents(archive, changedKeys, options.cursorUsageEvents);
  return { archive, changedKeys };
}

// Every capture asks the Cursor JSON cache about the legacy rows that still
// have no link, and a link, once written, is never revisited. A legacy row is
// one CSV event, keyed on that event's full timestamp, so its tokens can only
// change if tokscale folds a second event carrying the very same timestamp into
// it: that event is either in the conversation the link already names, or in a
// second one, in which case no single event ever matched the row and there was
// no link to invalidate. Deriving the work from the archive on each pass is
// also what makes a row another writer added arrive on its own.
function linkLegacyCursorEvents(archive, changedKeys, readCursorUsageEvents) {
  const pending = [];
  for (const [key, entry] of Object.entries(archive.sessions)) {
    if (entry.supersededBy || !isLegacyCursorEntry(entry)) continue;
    const lookup = legacyCursorLookup(entry);
    if (lookup) pending.push([key, entry, lookup]);
  }
  if (pending.length === 0) return;

  const usageEvents = readCursorUsageEvents();
  if (!usageEvents) return;
  for (const [key, entry, lookup] of pending) {
    const sessionId = supersedingCursorSessionId(lookup, usageEvents);
    if (!sessionId) continue;
    entry.supersededBy = sessionKey('cursor', sessionId);
    changedKeys.add(key);
  }
}

function captureSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date()) {
  const archive = normalizeSessionUsageArchive(existingArchive);
  return updateSessionUsageArchive(archive, deviceRecord, capturedAt).archive;
}

function addSessionBreakdown(period, session) {
  const client = session.client;
  const cacheRead = Math.max(0, Math.round(numberValue(session.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(session.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(session.outputTokens)));

  if (cacheRead > 0) period.clientCacheReads[client] = (period.clientCacheReads[client] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[client] = (period.clientCacheWrites[client] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[client] = (period.clientOutputs[client] || 0) + output;

  const modelTokens = Object.entries(session.models || {})
    .map(([model, tokens]) => [model, numberValue(tokens)])
    .filter(([, tokens]) => tokens > 0);
  const totalModelTokens = modelTokens.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (totalModelTokens === 0) return;
  if (modelTokens.length > 1) {
    for (const [model, tokens] of modelTokens) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + tokens;
    }
    period.capabilities.tokenComponents = false;
    return;
  }

  for (const [model, tokens] of modelTokens) {
    const cr = Math.min(tokens, cacheRead);
    const cw = Math.min(tokens - cr, cacheWrite);
    const ou = Math.min(tokens - cr - cw, output);
    if (cr > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cr;
    if (cw > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cw;
    if (ou > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + ou;
    const unclassified = Math.max(0, tokens - cr - cw - ou);
    if (unclassified > 0) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + unclassified;
      period.capabilities.tokenComponents = false;
    }
  }
}

function addArchivedSession(period, session, archiveKey = null) {
  if (isReasonixSyntheticSession(session)) return;
  const key = archiveKey || sessionKey(session.client, session.sessionId);
  if (!key || period.sessions[key]) return;

  const archived = { ...cloneJson(session), archived: true };
  period.sessions[key] = archived;
  const tokens = Math.max(0, Math.round(numberValue(archived.totalTokens)));
  const cost = numberValue(archived.costUsd);
  const cacheRead = Math.max(0, Math.round(numberValue(archived.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(archived.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(archived.outputTokens)));

  period.totalTokens += tokens;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;
  const unclassified = Math.max(0, tokens - cacheRead - cacheWrite - output);
  if (unclassified > 0) {
    period.unclassifiedTokens += unclassified;
    period.clientUnclassifiedTokens[archived.client] = (period.clientUnclassifiedTokens[archived.client] || 0) + unclassified;
    period.capabilities.tokenComponents = false;
  }
  if (tokens > 0) period.clients[archived.client] = (period.clients[archived.client] || 0) + tokens;
  if (cost > 0) period.clientCosts[archived.client] = (period.clientCosts[archived.client] || 0) + cost;

  for (const [model, modelTokens] of Object.entries(archived.models || {})) {
    const next = Math.max(0, Math.round(numberValue(modelTokens)));
    if (next <= 0) continue;
    period.models[model] = (period.models[model] || 0) + next;
    if (!period.clientModels[archived.client]) period.clientModels[archived.client] = {};
    period.clientModels[archived.client][model] = (period.clientModels[archived.client][model] || 0) + next;
  }
  for (const [model, modelCost] of Object.entries(archived.modelCosts || {})) {
    const next = numberValue(modelCost);
    if (next <= 0) continue;
    period.modelCosts[model] = (period.modelCosts[model] || 0) + next;
    if (!period.clientModelCosts[archived.client]) period.clientModelCosts[archived.client] = {};
    period.clientModelCosts[archived.client][model] = (period.clientModelCosts[archived.client][model] || 0) + next;
  }

  addSessionBreakdown(period, archived);
}

function shouldApplyPeriod(periodName, entry, now) {
  const window = entry?.periodWindows?.[periodName] || {};
  if (periodName === 'today') return (window.day || entry.day) === localDay(now);
  if (periodName === 'month') return (window.month || entry.month) === localMonth(now);
  return periodName === 'allTime';
}

function applySessionUsageArchive(summary, archive, options = {}) {
  const normalizedArchive = options.canonical === true
    ? canonicalSessionUsageArchive(archive)
    : normalizeSessionUsageArchive(archive);
  const now = toDate(options.now);
  const next = options.mutate === true ? summary : cloneJson(summary);
  const periodContainer = next.periods && typeof next.periods === 'object' ? next.periods : next;
  for (const periodName of PERIODS) {
    const period = periodContainer?.[periodName];
    if (period && typeof period === 'object' && Object.prototype.hasOwnProperty.call(period, 'sessions')) {
      period.sessions = filterReasonixSyntheticSessions(period.sessions);
    }
  }
  const targetPeriods = new Map();
  const targetFor = (periodName) => {
    if (!targetPeriods.has(periodName)) {
      const period = options.canonicalSummary === true
        ? (next.periods && typeof next.periods === 'object' ? next.periods[periodName] : next[periodName])
        : targetPeriod(next, periodName);
      targetPeriods.set(periodName, period);
    }
    return targetPeriods.get(periodName);
  };

  const supersededRows = [];
  for (const [archiveKey, entry] of Object.entries(normalizedArchive.sessions)) {
    for (const periodName of PERIODS) {
      const session = entry.periods?.[periodName];
      if (!session || !hasSessionUsage(session) || !shouldApplyPeriod(periodName, entry, now)) continue;
      // Same rule as the client archive: never create a period the summary does
      // not have. A progressive preview is marked partial by the periods it
      // omits, and a partial that looks complete loses the attribution fields
      // deviceState would otherwise carry forward.
      if (!hasSummaryPeriod(next, periodName)) continue;
      const period = targetFor(periodName);
      if (period.sessions[archiveKey]) continue;
      if (entry.supersededBy) {
        supersededRows.push([period, archiveKey, session, entry.supersededBy]);
        continue;
      }
      addArchivedSession(period, session, archiveKey);
    }
  }

  // A legacy Cursor row whose event now belongs to another session is judged
  // after every other row has replayed, so that session counts whether it is
  // live or only archived. Without it the row is still the only record.
  for (const [period, archiveKey, session, supersededBy] of supersededRows) {
    if (!period.sessions[supersededBy]) addArchivedSession(period, session, archiveKey);
  }

  return next;
}

function sessionUsageArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'session-usage-archive.json');
}

function readSessionUsageArchive(options = {}) {
  const read = options.readJson || readJson;
  return normalizeSessionUsageArchive(read(sessionUsageArchivePath(options), {}));
}

function writeSessionUsageArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(sessionUsageArchivePath(options), normalizeSessionUsageArchive(archive));
}

function clearSessionUsageArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(sessionUsageArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  sessionUsageArchiveDate,
  sessionUsageArchivePath,
  updateSessionUsageArchive,
  writeSessionUsageArchive
};
