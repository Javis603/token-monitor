'use strict';

const fs = require('node:fs');

const REASONIX_META_MAX_BYTES = 1 << 20;
const REASONIX_TELEMETRY_MAX_BYTES = 4 << 20;
const REASONIX_SIDECAR_READ_CHUNK_BYTES = 64 << 10;

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readBoundedJson(filePath, maxBytes, fsApi = fs) {
  if (!filePath || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  let fileDescriptor;
  try {
    // statSync follows symlinks; this validates the resolved target before the
    // opened descriptor is checked again below.
    const initialStat = fsApi.statSync(filePath);
    if (!initialStat.isFile() || initialStat.size > maxBytes) return null;
    fileDescriptor = fsApi.openSync(filePath, 'r');
    const openedStat = fsApi.fstatSync(fileDescriptor);
    if (!openedStat.isFile() || openedStat.size > maxBytes) return null;

    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(REASONIX_SIDECAR_READ_CHUNK_BYTES, maxBytes + 1));
    let totalBytes = 0;
    while (true) {
      const bytesRead = fsApi.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) return null;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const value = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
    return objectValue(value);
  } catch (_) {
    return null;
  } finally {
    if (fileDescriptor !== undefined) {
      try { fsApi.closeSync(fileDescriptor); } catch (_) {}
    }
  }
}

module.exports = {
  readBoundedJson,
  REASONIX_META_MAX_BYTES,
  REASONIX_TELEMETRY_MAX_BYTES
};
