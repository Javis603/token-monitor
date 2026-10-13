'use strict';

const fs = require('node:fs');
const { normalizeModelNameForClient } = require('../../usage');

const databaseCache = new Map();
let sqlite;

// Field numbers come from Antigravity IDE's cortex.proto and codeium_common.proto.
// Skip prompt payloads without decoding them; only usage and real model durations
// leave this reader. File mtimes invalidate the cache but never imply token activity.
function protobufFields(input) {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const values = new Map();
  let offset = 0;
  function varint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < buffer.length; shift += 7n) {
      const byte = buffer[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new Error('Invalid protobuf varint');
  }
  while (offset < buffer.length) {
    const tag = Number(varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error('Invalid protobuf field');
    if (wire === 0) {
      values.set(field, varint());
      continue;
    }
    const size = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) {
      throw new Error('Invalid protobuf length');
    }
    if (wire === 2) values.set(field, buffer.subarray(offset, offset + size));
    offset += size;
  }
  return values;
}

function nested(fields, number) {
  const value = fields.get(number);
  return Buffer.isBuffer(value) ? protobufFields(value) : new Map();
}

function counter(fields, number) {
  const value = fields.get(number);
  return typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : 0;
}

function secondsMs(fields) {
  const nanos = counter(fields, 2);
  return nanos < 1e9 ? counter(fields, 1) * 1000 + nanos / 1e6 : 0;
}

function decodeGeneration(data) {
  try {
    const chat = nested(protobufFields(data), 1);
    const usage = nested(chat, 4);
    const startedAt = secondsMs(nested(nested(chat, 9), 4));
    const durationMs = secondsMs(nested(chat, 11)) + secondsMs(nested(chat, 12));
    const modelBytes = chat.get(19);
    const model = Buffer.isBuffer(modelBytes) ? modelBytes.toString('utf8') : '';
    const output = counter(usage, 3);
    if (!model || !startedAt || !durationMs || !output) return null;
    const input = counter(usage, 2);
    const cacheWrite = counter(usage, 4);
    const cacheRead = counter(usage, 5);
    const response = usage.get(11) || usage.get(7);
    return {
      model: normalizeModelNameForClient(model.replace(/-thinking$/, ''), 'antigravity'),
      startedAt, durationMs, output, input, cacheWrite, cacheRead,
      responseId: Buffer.isBuffer(response) ? response.toString('utf8') : ''
    };
  } catch (_) {
    return null;
  }
}

function fingerprint(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (_) { return ''; }
}

function readGenerations(file) {
  const key = `${fingerprint(file)}|${fingerprint(`${file}-wal`)}`;
  if (!key.split('|')[0]) return [];
  const cached = databaseCache.get(file);
  if (cached?.key === key) return cached.generations;
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
  }
  if (!sqlite?.DatabaseSync) return [];
  let database;
  try {
    database = new sqlite.DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 100');
    const generations = [];
    const seen = new Set();
    for (const row of database.prepare('SELECT data FROM gen_metadata WHERE length(data) <= 8388608 ORDER BY idx DESC').iterate()) {
      const generation = decodeGeneration(row.data);
      if (!generation || (generation.responseId && seen.has(generation.responseId))) continue;
      if (generation.responseId) seen.add(generation.responseId);
      const stepIndices = protobufFields(row.data).get(2);
      generation.startStepIndex = null;
      if (typeof stepIndices === 'bigint') generation.startStepIndex = Number(stepIndices);
      else if (Buffer.isBuffer(stepIndices)) {
        let value = 0;
        let multiplier = 1;
        for (const byte of stepIndices) {
          value += (byte & 127) * multiplier;
          if (byte < 128) { generation.startStepIndex = value; break; }
          multiplier *= 128;
        }
      }
      generations.push(generation);
    }
    databaseCache.set(file, { key, generations });
    if (databaseCache.size > 128) databaseCache.delete(databaseCache.keys().next().value);
    return generations;
  } catch (_) {
    return [];
  } finally {
    try { database?.close(); } catch (_) {}
  }
}

module.exports = { decodeGeneration, protobufFields, readGenerations };
