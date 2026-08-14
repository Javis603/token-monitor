'use strict';

const { MAX_JSON_BODY_BYTES } = require('./http');
const { syncLimits } = require('./limits');
const { isReasonixSyntheticSession } = require('./reasonixSessionGuard');

const SYNC_PAYLOAD_MARGIN_BYTES = 16 * 1024;
const SYNC_PAYLOAD_BUDGET_BYTES = MAX_JSON_BODY_BYTES - SYNC_PAYLOAD_MARGIN_BYTES;
const SYNC_HISTORY_COMPONENT_DAYS = 30;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function dayKeyAddDays(key, delta) {
  const ms = Date.parse(`${String(key || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + delta * 86400000).toISOString().slice(0, 10);
}

function stripTokenComponents(value) {
  if (!value || typeof value !== 'object') return value;
  const rest = { ...value };
  delete rest.cacheReadTokens;
  delete rest.cacheWriteTokens;
  delete rest.outputTokens;
  delete rest.unclassifiedTokens;
  delete rest.tokenComponentsAvailable;
  return rest;
}

function historyForSync(history, periodWindows) {
  if (!history || typeof history !== 'object' || !Array.isArray(history.daily)) return history;
  const latestDailyKey = history.daily.reduce((latest, row) => {
    const key = String(row?.date || '').slice(0, 10);
    return key > latest ? key : latest;
  }, '');
  const todayKey = String(periodWindows?.today?.key || latestDailyKey).slice(0, 10);
  const componentStart = dayKeyAddDays(todayKey, -(SYNC_HISTORY_COMPONENT_DAYS - 1));
  if (!componentStart) return history;
  return {
    ...history,
    daily: history.daily.map((row) => {
      const date = String(row?.date || '').slice(0, 10);
      if (date >= componentStart && date <= todayKey) return row;
      const stripped = stripTokenComponents(row);
      stripped.perClient = Object.fromEntries(Object.entries(row?.perClient || {})
        .map(([key, value]) => [key, stripTokenComponents(value)]));
      stripped.perModel = Object.fromEntries(Object.entries(row?.perModel || {})
        .map(([key, value]) => [key, stripTokenComponents(value)]));
      return stripped;
    })
  };
}

function historyWithoutTokenComponents(history) {
  if (!history || typeof history !== 'object' || !Array.isArray(history.daily)) return history;
  return {
    ...history,
    daily: history.daily.map((row) => {
      const stripped = stripTokenComponents(row);
      stripped.perClient = Object.fromEntries(Object.entries(row?.perClient || {})
        .map(([key, value]) => [key, stripTokenComponents(value)]));
      stripped.perModel = Object.fromEntries(Object.entries(row?.perModel || {})
        .map(([key, value]) => [key, stripTokenComponents(value)]));
      return stripped;
    })
  };
}

function projectEntries(period) {
  return period?.projects && typeof period.projects === 'object'
    ? Object.keys(period.projects).length
    : 0;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sessionTimestamp(session) {
  const value = session?.lastUsedAt || session?.startedAt;
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function recentSessionEntries(sessions) {
  return Object.entries(sessions || {}).sort(([aKey, a], [bKey, b]) => {
    const timeDiff = sessionTimestamp(b) - sessionTimestamp(a);
    if (timeDiff) return timeDiff;
    const tokenDiff = Number(b?.totalTokens || 0) - Number(a?.totalTokens || 0);
    return tokenDiff || aKey.localeCompare(bKey);
  });
}

function setSessionOmission(payload, periodName, omitted) {
  const next = { ...(payload.sessionDetailsOmitted || {}) };
  if (omitted > 0) next[periodName] = omitted;
  else delete next[periodName];
  if (Object.keys(next).length > 0) payload.sessionDetailsOmitted = next;
  else delete payload.sessionDetailsOmitted;
}

function setPeriodProjectOmission(payload, periodName, omitted) {
  const next = { ...(payload.periodProjectsOmitted || {}) };
  if (omitted > 0) next[periodName] = omitted;
  else delete next[periodName];
  if (Object.keys(next).length > 0) payload.periodProjectsOmitted = next;
  else delete payload.periodProjectsOmitted;
}

function fitRecentSessionEntries(payload, periodName, entries, maxBytes) {
  const period = payload[periodName];
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    period.sessions = Object.fromEntries(entries.slice(0, count));
    setSessionOmission(payload, periodName, entries.length - count);
    if (jsonBytes(payload) <= maxBytes) low = count;
    else high = count - 1;
  }
  period.sessions = Object.fromEntries(entries.slice(0, low));
  setSessionOmission(payload, periodName, entries.length - low);
}

function fitPeriodSessions(payload, summary, periodName, maxBytes) {
  const period = payload?.[periodName];
  const entries = recentSessionEntries(period?.sessions);
  if (!period || entries.length === 0) return;

  // Once session detail becomes partial, carry the authoritative project rollup
  // instead of asking the hub to rebuild an incomplete one from the retained rows.
  if (summary.projectsEnabled !== false && summary?.[periodName]?.projects && typeof summary[periodName].projects === 'object') {
    period.projects = summary[periodName].projects;
  }

  fitRecentSessionEntries(payload, periodName, entries, maxBytes);
  if (jsonBytes(payload) > maxBytes && projectEntries(period) > 0) {
    const omittedProjects = projectEntries(period);
    delete period.projects;
    setPeriodProjectOmission(payload, periodName, omittedProjects);
    fitRecentSessionEntries(payload, periodName, entries, maxBytes);
  }
}

function sessionsWithoutProjectMetadata(sessions) {
  if (!sessions || typeof sessions !== 'object') return sessions;
  const sanitized = Object.create(null);
  for (const [key, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') {
      sanitized[key] = session;
      continue;
    }
    sanitized[key] = { ...session };
    delete sanitized[key].projectId;
    delete sanitized[key].project_id;
    delete sanitized[key].projectLabel;
    delete sanitized[key].project_label;
  }
  return sanitized;
}

function sessionsWithoutReasonix(sessions) {
  if (!sessions || typeof sessions !== 'object') return sessions;
  const sanitized = {};
  let removed = false;
  for (const [key, session] of Object.entries(sessions)) {
    if (isReasonixSyntheticSession(session, key)) {
      removed = true;
      continue;
    }
    sanitized[key] = session;
  }
  return removed ? sanitized : sessions;
}

function buildSyncPayload(summary, {
  omitAllTimeProjects = false,
  omitHistoryTokenComponents = false
} = {}) {
  if (!summary || typeof summary !== 'object') return summary;
  const payload = { ...summary, limits: syncLimits(summary.limits) };
  if (summary.history && typeof summary.history === 'object') {
    payload.history = historyForSync(summary.history, summary.periodWindows);
    if (omitHistoryTokenComponents) {
      payload.history = historyWithoutTokenComponents(payload.history);
    }
  }
  // Reasonix native sessions are a local-only view. They contain provider
  // metadata and project labels that are intentionally not part of the device
  // wire contract, and uploading them would also make local paths/preview text
  // a hub concern. Tokscale remains the only aggregate/session authority.
  delete payload.nativeSessions;
  delete payload.nativeProjects;
  const projectsEnabled = summary.projectsEnabled !== false;
  delete payload.allTimeProjectsOmitted;
  delete payload.allTimeProjectsIncomplete;
  delete payload.sessionDetailsOmitted;
  delete payload.periodProjectsOmitted;

  for (const periodName of ['today', 'month']) {
    const period = summary[periodName];
    if (!period || typeof period !== 'object') continue;
    payload[periodName] = { ...period };
    delete payload[periodName].projects;
    if (hasOwn(payload[periodName], 'sessions')) {
      payload[periodName].sessions = sessionsWithoutReasonix(payload[periodName].sessions);
      if (!projectsEnabled) payload[periodName].sessions = sessionsWithoutProjectMetadata(payload[periodName].sessions);
    }
  }

  if (summary.allTime && typeof summary.allTime === 'object') {
    payload.allTime = { ...summary.allTime };
    delete payload.allTime.sessions;
    if (!projectsEnabled) delete payload.allTime.projects;
    if (omitAllTimeProjects && hasOwn(payload.allTime, 'projects')) {
      delete payload.allTime.projects;
      payload.allTimeProjectsOmitted = true;
    }
  }
  return payload;
}

function serializeSyncPayload(summary, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SYNC_PAYLOAD_BUDGET_BYTES;
  const buildOptions = {
    ...options,
    omitAllTimeProjects: options.omitAllTimeProjects === true,
    omitHistoryTokenComponents: options.omitHistoryTokenComponents === true
  };
  let payload = buildSyncPayload(summary, buildOptions);
  if (!payload || typeof payload !== 'object') {
    const body = JSON.stringify(payload);
    return { payload, body, bytes: body ? Buffer.byteLength(body, 'utf8') : 0 };
  }
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > maxBytes && payload.history && typeof payload.history === 'object') {
    // Component detail is additive. Never let it evict an existing project/session
    // payload or turn a previously uploadable History V1 record into a 413.
    buildOptions.omitHistoryTokenComponents = true;
    payload = buildSyncPayload(summary, buildOptions);
    body = JSON.stringify(payload);
  }
  if (
    !buildOptions.omitAllTimeProjects
    && Buffer.byteLength(body, 'utf8') > maxBytes
    && projectEntries(payload?.allTime) > 0
  ) {
    buildOptions.omitAllTimeProjects = true;
    payload = buildSyncPayload(summary, buildOptions);
    body = JSON.stringify(payload);
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Month detail is the first collection to grow large enough to threaten the
    // ingest limit. Keep today's most useful live detail for as long as possible.
    for (const periodName of ['month', 'today']) {
      fitPeriodSessions(payload, summary, periodName, maxBytes);
      body = JSON.stringify(payload);
      if (Buffer.byteLength(body, 'utf8') <= maxBytes) break;
    }
  }
  return { payload, body, bytes: Buffer.byteLength(body, 'utf8') };
}

function syncPayload(summary, options = {}) {
  return serializeSyncPayload(summary, options).payload;
}

async function postSyncPayload(fetchFn, url, { headers = {}, summary, logger } = {}) {
  let serialized = serializeSyncPayload(summary);
  if (serialized.payload?.allTimeProjectsOmitted === true && typeof logger === 'function') {
    logger(`all-time project breakdown omitted; payload reduced to ${serialized.bytes} bytes (budget ${SYNC_PAYLOAD_BUDGET_BYTES})`);
  }
  if (serialized.payload?.sessionDetailsOmitted && typeof logger === 'function') {
    const omitted = Object.entries(serialized.payload.sessionDetailsOmitted)
      .map(([period, count]) => `${period}: ${count}`)
      .join(', ');
    logger(`session detail omitted for sync (${omitted}); payload reduced to ${serialized.bytes} bytes (budget ${SYNC_PAYLOAD_BUDGET_BYTES})`);
  }
  if (serialized.payload?.periodProjectsOmitted && typeof logger === 'function') {
    const omitted = Object.entries(serialized.payload.periodProjectsOmitted)
      .map(([period, count]) => `${period}: ${count}`)
      .join(', ');
    logger(`project detail omitted for sync (${omitted}); payload reduced to ${serialized.bytes} bytes (budget ${SYNC_PAYLOAD_BUDGET_BYTES})`);
  }
  let response = await fetchFn(url, { method: 'POST', headers, body: serialized.body });
  const retrySerialized = response.status === 413
    ? serializeSyncPayload(summary, {
        omitHistoryTokenComponents: true,
        omitAllTimeProjects: true
      })
    : null;
  const canRetryReduced = response.status === 413
    && retrySerialized?.body !== serialized.body;
  if (canRetryReduced) {
    try { await response.arrayBuffer(); } catch (_) { /* best-effort drain before retry */ }
    serialized = retrySerialized;
    if (typeof logger === 'function') {
      logger('hub rejected the payload; retrying once without additive History components or all-time projects');
    }
    response = await fetchFn(url, { method: 'POST', headers, body: serialized.body });
  }
  return { response, payload: serialized.payload, retried: canRetryReduced };
}

module.exports = {
  SYNC_PAYLOAD_BUDGET_BYTES,
  postSyncPayload,
  serializeSyncPayload,
  syncPayload
};
