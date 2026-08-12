'use strict';

const { MAX_JSON_BODY_BYTES } = require('./http');
const { syncLimits } = require('./limits');
const { HISTORY_SCHEMA_VERSION } = require('./history');
const { isReasonixSyntheticSession } = require('./reasonixSessionGuard');

const SYNC_PAYLOAD_MARGIN_BYTES = 16 * 1024;
const SYNC_PAYLOAD_BUDGET_BYTES = MAX_JSON_BODY_BYTES - SYNC_PAYLOAD_MARGIN_BYTES;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
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

function buildSyncPayload(summary, { omitAllTimeProjects = false } = {}) {
  if (!summary || typeof summary !== 'object') return summary;
  const payload = { ...summary, limits: syncLimits(summary.limits) };
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
  if (
    hasOwn(payload, 'history')
    && payload.history?.schemaVersion === HISTORY_SCHEMA_VERSION
    && payload.history?.coverage
  ) {
    delete payload.historyOmitted;
  }

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

function historyWithoutClientModels(history) {
  if (!history || typeof history !== 'object') return history;
  return {
    ...history,
    capabilities: { ...(history.capabilities || {}), clientModels: false },
    daily: Array.isArray(history.daily) ? history.daily.map((row) => {
      const compact = {
        ...row,
        capabilities: { ...(row?.capabilities || {}), clientModels: false }
      };
      delete compact.perClientModel;
      return compact;
    }) : []
  };
}

function historyWithoutAttribution(history) {
  if (!history || typeof history !== 'object') return history;
  const stripDaily = (row) => {
    const compact = {
      ...row,
      capabilities: { ...(row?.capabilities || {}), attribution: false, clientModels: false }
    };
    delete compact.perClient;
    delete compact.perModel;
    delete compact.perClientModel;
    return compact;
  };
  const stripMonthly = (row) => {
    const compact = { ...row };
    delete compact.perClient;
    delete compact.perModel;
    return compact;
  };
  return {
    ...history,
    capabilities: { ...(history.capabilities || {}), attribution: false, clientModels: false },
    daily: Array.isArray(history.daily) ? history.daily.map(stripDaily) : [],
    monthly: Array.isArray(history.monthly) ? history.monthly.map(stripMonthly) : []
  };
}

function serializeSyncPayload(summary, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : SYNC_PAYLOAD_BUDGET_BYTES;
  let payload = buildSyncPayload(summary, options);
  if (!payload || typeof payload !== 'object') {
    const body = JSON.stringify(payload);
    return { payload, body, bytes: body ? Buffer.byteLength(body, 'utf8') : 0 };
  }
  let body = JSON.stringify(payload);
  if (
    !options.omitAllTimeProjects
    && Buffer.byteLength(body, 'utf8') > maxBytes
    && projectEntries(payload?.allTime) > 0
  ) {
    payload = buildSyncPayload(summary, { ...options, omitAllTimeProjects: true });
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
  if (
    Buffer.byteLength(body, 'utf8') > maxBytes
    && payload.history
    && typeof payload.history === 'object'
  ) {
    // The client→model intersection duplicates data already present in the
    // per-client and per-model maps and is normally the largest retained-history
    // field. Sacrifice that optional attribution first so daily totals, component
    // counters, and coverage can continue to advance on the Hub.
    payload.history = historyWithoutClientModels(payload.history);
    body = JSON.stringify(payload);
  }
  if (
    Buffer.byteLength(body, 'utf8') > maxBytes
    && payload.history
    && typeof payload.history === 'object'
  ) {
    // If the intersection alone is not enough, retain the versioned coverage and
    // exact daily totals/components. This keeps flexible-range headlines correct
    // while deliberately making client/model attribution unavailable.
    payload.history = historyWithoutAttribution(payload.history);
    body = JSON.stringify(payload);
  }
  if (
    Buffer.byteLength(body, 'utf8') > maxBytes
    && payload.history
    && typeof payload.history === 'object'
  ) {
    // Absence alone means "no update" and would make the Hub's last-good copy
    // look current forever. Keep that copy for recovery, but explicitly mark this
    // device unavailable for derived ranges until a complete history fits again.
    delete payload.history;
    payload.historyOmitted = true;
    body = JSON.stringify(payload);
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
  const canRetryWithoutProjects = response.status === 413
    && serialized.payload?.allTimeProjectsOmitted !== true
    && projectEntries(serialized.payload?.allTime) > 0;
  if (canRetryWithoutProjects) {
    try { await response.arrayBuffer(); } catch (_) { /* best-effort drain before retry */ }
    serialized = serializeSyncPayload(summary, { omitAllTimeProjects: true });
    if (typeof logger === 'function') logger('hub rejected the payload; retrying once without all-time projects');
    response = await fetchFn(url, { method: 'POST', headers, body: serialized.body });
  }
  return { response, payload: serialized.payload, retried: canRetryWithoutProjects };
}

module.exports = {
  SYNC_PAYLOAD_BUDGET_BYTES,
  postSyncPayload,
  serializeSyncPayload,
  syncPayload
};
