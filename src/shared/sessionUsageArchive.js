'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, normalizePeriod } = require('./usage');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function sessionUsageArchiveDate(deviceRecord, fallback = new Date()) {
  const collectedAt = new Date(deviceRecord?.updatedAt || '');
  return Number.isNaN(collectedAt.getTime()) ? toDate(fallback) : collectedAt;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDay(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localMonth(dateValue) {
  const date = toDate(dateValue);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sameJson(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function periodFor(record, periodName) {
  return normalizePeriod(record?.periods?.[periodName] || record?.[periodName]);
}

function normalizedSessionFrom(value, fallbackKey) {
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
      if (!session || !hasSessionUsage(session)) continue;
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
    normalized.sessions[`${entry.client}:${entry.sessionId}`] = entry;
  }

  return normalized;
}

function captureSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date()) {
  const archive = normalizeSessionUsageArchive(existingArchive);
  if (!deviceRecord || typeof deviceRecord !== 'object') return archive;

  const captureDate = toDate(capturedAt);
  for (const periodName of PERIODS) {
    const period = periodFor(deviceRecord, periodName);
    for (const session of Object.values(period.sessions || {})) {
      if (!hasSessionUsage(session)) continue;
      const archiveKey = sessionKey(session.client, session.sessionId);
      if (!archiveKey) continue;
      const entry = archive.sessions[archiveKey] || {
        client: session.client,
        sessionId: session.sessionId,
        capturedAt: captureDate.toISOString(),
        day: localDay(captureDate),
        month: localMonth(captureDate),
        periodWindows: {},
        periods: {}
      };
      const nextSession = clone(session);
      const window = entry.periodWindows?.[periodName] || {};
      const sameWindow = periodName === 'today'
        ? window.day === localDay(captureDate)
        : periodName === 'month'
          ? window.month === localMonth(captureDate)
          : true;
      if (sameJson(entry.periods[periodName], nextSession) && sameWindow) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.capturedAt = captureDate.toISOString();
      entry.day = localDay(captureDate);
      entry.month = localMonth(captureDate);
      entry.periods[periodName] = nextSession;
      entry.periodWindows = entry.periodWindows || {};
      entry.periodWindows[periodName] = { capturedAt: captureDate.toISOString() };
      if (periodName === 'today') entry.periodWindows[periodName].day = localDay(captureDate);
      if (periodName === 'month') entry.periodWindows[periodName].month = localMonth(captureDate);
      archive.sessions[archiveKey] = entry;
    }
  }

  return archive;
}

function targetPeriod(summary, periodName) {
  if (summary.periods && typeof summary.periods === 'object') {
    summary.periods[periodName] = normalizePeriod(summary.periods[periodName]);
    return summary.periods[periodName];
  }
  summary[periodName] = normalizePeriod(summary[periodName]);
  return summary[periodName];
}

function allocateIntegerTotal(total, weightedEntries) {
  if (total <= 0 || weightedEntries.length === 0) return new Map();
  const weightTotal = weightedEntries.reduce((sum, [, weight]) => sum + weight, 0);
  const allocations = weightedEntries.map(([key, weight]) => {
    const exact = total * weight / weightTotal;
    return { key, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - allocations.reduce((sum, item) => sum + item.value, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (let index = 0; index < remaining; index += 1) allocations[index].value += 1;
  return new Map(allocations.map(({ key, value }) => [key, value]));
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

  const cacheReads = allocateIntegerTotal(cacheRead, modelTokens);
  const cacheWrites = allocateIntegerTotal(cacheWrite, modelTokens);
  const outputs = allocateIntegerTotal(output, modelTokens);

  for (const [model] of modelTokens) {
    const cr = cacheReads.get(model) || 0;
    const cw = cacheWrites.get(model) || 0;
    const ou = outputs.get(model) || 0;
    if (cr > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cr;
    if (cw > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cw;
    if (ou > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + ou;
  }
}

function addArchivedSession(period, session) {
  const key = sessionKey(session.client, session.sessionId);
  if (!key || period.sessions[key]) return;

  const archived = { ...clone(session), archived: true };
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
  const normalizedArchive = normalizeSessionUsageArchive(archive);
  const now = toDate(options.now);
  const next = clone(summary);
  const targetPeriods = new Map();
  const targetFor = (periodName) => {
    if (!targetPeriods.has(periodName)) targetPeriods.set(periodName, targetPeriod(next, periodName));
    return targetPeriods.get(periodName);
  };

  for (const entry of Object.values(normalizedArchive.sessions)) {
    for (const periodName of PERIODS) {
      const session = entry.periods?.[periodName];
      if (!session || !hasSessionUsage(session) || !shouldApplyPeriod(periodName, entry, now)) continue;
      addArchivedSession(targetFor(periodName), session);
    }
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
  writeSessionUsageArchive
};
