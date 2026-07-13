'use strict';

const { MAX_JSON_BODY_BYTES } = require('./http');
const { syncLimits } = require('./limits');

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

function buildSyncPayload(summary, { omitAllTimeProjects = false } = {}) {
  if (!summary || typeof summary !== 'object') return summary;
  const payload = { ...summary, limits: syncLimits(summary.limits) };
  delete payload.allTimeProjectsOmitted;

  for (const periodName of ['today', 'month']) {
    const period = summary[periodName];
    if (!period || typeof period !== 'object') continue;
    payload[periodName] = { ...period };
    delete payload[periodName].projects;
  }

  if (summary.allTime && typeof summary.allTime === 'object') {
    payload.allTime = { ...summary.allTime };
    delete payload.allTime.sessions;
    if (omitAllTimeProjects && hasOwn(payload.allTime, 'projects')) {
      delete payload.allTime.projects;
      payload.allTimeProjectsOmitted = true;
    }
  }
  return payload;
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
  return { payload, body, bytes: Buffer.byteLength(body, 'utf8') };
}

function syncPayload(summary, options = {}) {
  return serializeSyncPayload(summary, options).payload;
}

async function postSyncPayload(fetchFn, url, { headers = {}, summary, logger } = {}) {
  let serialized = serializeSyncPayload(summary);
  if (serialized.payload?.allTimeProjectsOmitted === true && typeof logger === 'function') {
    logger(`all-time project breakdown omitted to keep the payload under ${SYNC_PAYLOAD_BUDGET_BYTES} bytes`);
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
