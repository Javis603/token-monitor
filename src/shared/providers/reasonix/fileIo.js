'use strict';

const fs = require('node:fs');

const REASONIX_META_MAX_BYTES = 1 << 20;
// This bounds only the telemetry projection Token Monitor materializes. The
// complete Reasonix sidecar may be larger because its preceding ReadFiles array
// grows with a long-lived session.
const REASONIX_TELEMETRY_USAGE_MAX_BYTES = 4 << 20;
const REASONIX_SIDECAR_READ_CHUNK_BYTES = 64 << 10;
const REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES = 64 << 10;

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

function telemetryUsage(value) {
  const object = objectValue(value);
  return objectValue(object?.usage) || object;
}

function readFileWindow(fsApi, fileDescriptor, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let totalBytes = 0;
  while (totalBytes < length) {
    const bytesRead = fsApi.readSync(
      fileDescriptor,
      buffer,
      totalBytes,
      Math.min(REASONIX_SIDECAR_READ_CHUNK_BYTES, length - totalBytes),
      start + totalBytes
    );
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
  }
  return buffer.subarray(0, totalBytes);
}

function trailingTelemetryUsage(text) {
  let index = text.lastIndexOf('"usage"');
  while (index >= 0) {
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
    if (previous >= 0 && (text[previous] === ',' || text[previous] === '{')) {
      try {
        // Reasonix's json.MarshalIndent output writes usage as the final
        // top-level field. Rebuilding only that suffix avoids materializing the
        // potentially huge ReadFiles value which precedes it.
        const projected = objectValue(JSON.parse(`{${text.slice(index)}`));
        const usage = objectValue(projected?.usage);
        if (usage) return usage;
      } catch (_) {}
    }
    index = text.lastIndexOf('"usage"', index - 1);
  }
  return null;
}

function readReasonixTelemetryUsage(filePath, fsApi = fs) {
  if (!filePath) return null;
  let fileDescriptor;
  try {
    const initialStat = fsApi.statSync(filePath);
    if (!initialStat.isFile()) return null;
    fileDescriptor = fsApi.openSync(filePath, 'r');
    const openedStat = fsApi.fstatSync(fileDescriptor);
    if (!openedStat.isFile() || !Number.isSafeInteger(openedStat.size) || openedStat.size < 0) return null;

    if (openedStat.size <= REASONIX_TELEMETRY_USAGE_MAX_BYTES) {
      const bytes = readFileWindow(fsApi, fileDescriptor, 0, openedStat.size);
      if (bytes.length !== openedStat.size) return null;
      return telemetryUsage(JSON.parse(bytes.toString('utf8')));
    }

    const windowBytes = Math.min(
      openedStat.size,
      REASONIX_TELEMETRY_USAGE_MAX_BYTES + REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES
    );
    const bytes = readFileWindow(fsApi, fileDescriptor, openedStat.size - windowBytes, windowBytes);
    if (bytes.length !== windowBytes) return null;
    return trailingTelemetryUsage(bytes.toString('utf8'));
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
  readReasonixTelemetryUsage,
  REASONIX_META_MAX_BYTES,
  REASONIX_TELEMETRY_USAGE_MAX_BYTES,
  REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES
};
