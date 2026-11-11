'use strict';

const { applyStatsPatch } = require('./hubDelta');

const UPLOAD_HEADER = 'x-token-monitor-upload';
const UPLOAD_VERSION = '1';
// Normalization can expand compact sessions several times over, so the Worker
// also bounds the stored record against its Durable Object limit. Baseline
// storage defaults to 16 times this value.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function uploadError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

// Ephemeral, bounded wire baselines, separate from normalized device storage.
// Eviction/restart needs no journal: the sender recovers with a complete ingest.
function createUploadBaselines({ maxEntries = 32, maxBytes = 16 * MAX_UPLOAD_BYTES } = {}) {
  const entries = new Map();
  const encoder = new TextEncoder();
  let bytes = 0;

  function forget(deviceId) {
    const previous = entries.get(deviceId);
    if (previous) bytes -= previous.bytes;
    entries.delete(deviceId);
  }

  function commit(deviceId, payload) {
    forget(deviceId);
    const body = JSON.stringify(payload);
    const size = encoder.encode(body).byteLength;
    if (size > MAX_UPLOAD_BYTES || size > maxBytes || maxEntries < 1) return undefined;
    while (entries.size >= maxEntries || bytes + size > maxBytes) forget(entries.keys().next().value);
    const revision = globalThis.crypto.randomUUID();
    entries.set(deviceId, { body, bytes: size, revision });
    bytes += size;
    return { version: 1, revision };
  }

  function prepare(payload) {
    if (!payload || typeof payload.deviceId !== 'string' || !payload.deviceId
      || typeof payload.baseRevision !== 'string' || !Array.isArray(payload.patch)
      || payload.patch.length > 20000) throw uploadError('invalid_upload_delta', 400);
    if (encoder.encode(JSON.stringify(payload)).byteLength > MAX_UPLOAD_BYTES) throw uploadError('payload_too_large', 413);
    const previous = entries.get(payload.deviceId);
    if (!previous || payload.baseRevision !== previous.revision) throw uploadError('upload_baseline_mismatch', 409);
    let next;
    try { next = applyStatsPatch(JSON.parse(previous.body), payload.patch); }
    catch (_) { throw uploadError('invalid_upload_delta', 400); }
    if (!next || Array.isArray(next) || typeof next !== 'object'
      || String(next.deviceId || next.id || '') !== payload.deviceId) throw uploadError('invalid_upload_delta', 400);
    if (encoder.encode(JSON.stringify(next)).byteLength > MAX_UPLOAD_BYTES) throw uploadError('payload_too_large', 413);
    return next;
  }

  return { prepare, commit, forget, clear() { entries.clear(); bytes = 0; } };
}

module.exports = { UPLOAD_HEADER, UPLOAD_VERSION, MAX_UPLOAD_BYTES, createUploadBaselines };
