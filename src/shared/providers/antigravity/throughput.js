'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractUsageFromTokscale, normalizeModelNameForClient } = require('../../usage');
const { antigravityDataRoots } = require('./selfSync');
const { antigravityCliDataDir } = require('../../clientSources');
const { tokscaleHomeDir } = require('../../tokscaleConfig');

const databaseCache = new Map();
let sqlite;

function readVarint(buffer, cursor) {
  let value = 0n;
  for (let shift = 0n; shift < 70n && cursor.offset < buffer.length; shift += 7n) {
    const byte = buffer[cursor.offset++];
    if (shift === 63n && byte > 1) break;
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) return value;
  }
  throw new Error('Invalid protobuf varint');
}

// Decode only wire fields, never conversation text or tool payloads.
function protobufFields(input) {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fields = new Map();
  const cursor = { offset: 0 };
  while (cursor.offset < buffer.length) {
    const tag = readVarint(buffer, cursor);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field || field > 0x1fffffff) throw new Error('Invalid protobuf field');
    if (wire === 0) { fields.set(field, readVarint(buffer, cursor)); continue; }
    const size = wire === 2 ? Number(readVarint(buffer, cursor)) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(size) || size < 0 || cursor.offset + size > buffer.length) {
      throw new Error('Invalid protobuf length');
    }
    if (wire === 2) fields.set(field, buffer.subarray(cursor.offset, cursor.offset + size));
    cursor.offset += size;
  }
  return fields;
}

function nested(fields, field) {
  const value = fields.get(field);
  return Buffer.isBuffer(value) ? protobufFields(value) : new Map();
}

function counter(fields, field) {
  const value = fields.get(field) ?? 0n;
  return typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : NaN;
}

function timeMs(fields) {
  const seconds = counter(fields, 1);
  const nanos = counter(fields, 2);
  return nanos < 1e9 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 + nanos / 1e6 : NaN;
}

function stepIndex(fields) {
  let value = fields.get(2);
  // Older databases encode the repeated step index as a packed varint.
  if (Buffer.isBuffer(value)) value = value.length ? readVarint(value, { offset: 0 }) : undefined;
  return typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : null;
}

function decodeGeneration(data) {
  try {
    const root = protobufFields(data);
    const chat = nested(root, 1);
    const usage = nested(chat, 4);
    if (!usage.size) return null;
    const duration = timeMs(nested(chat, 11)) + timeMs(nested(chat, 12));
    const tokens = {
      input: counter(usage, 1) + counter(usage, 2), output: counter(usage, 3),
      cacheWrite: 0, cacheRead: counter(usage, 5), reasoning: counter(usage, 10)
    };
    if (!Object.values(tokens).every(Number.isSafeInteger) || tokens.reasoning > tokens.output) return null;
    tokens.total = tokens.input + tokens.output + tokens.cacheRead;
    if (!Number.isSafeInteger(tokens.total)) return null;
    const model = chat.get(19);
    const response = usage.get(11) || usage.get(7);
    return {
      stepIdx: stepIndex(root),
      startedAt: timeMs(nested(nested(chat, 9), 4)) || 0,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
      model: normalizeModelNameForClient(Buffer.isBuffer(model) ? model.toString('utf8').replace(/-thinking$/, '') : '', 'antigravity'),
      responseId: Buffer.isBuffer(response) ? response.toString('utf8') : '',
      tokens
    };
  } catch (_) { return null; }
}

function fingerprint(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (_) { return ''; }
}

function conversationFile(sessionId, home, cli = false, env = process.env) {
  if (!/^[\w-]+$/.test(sessionId)) return '';
  const resolvedHome = home || tokscaleHomeDir({ env });
  const dirs = cli ? [antigravityCliDataDir({ homeDir: resolvedHome, env })]
    : antigravityDataRoots(resolvedHome).map(root => path.join(root, 'conversations'));
  for (const dir of dirs) {
    const file = path.join(dir, `${sessionId}.db`);
    if (fingerprint(file)) return file;
  }
  return '';
}

function readConversation(file) {
  const stamp = () => `${fingerprint(file)}|${fingerprint(`${file}-wal`)}`;
  const key = stamp();
  if (!file || key.startsWith('|')) return null;
  const cached = databaseCache.get(file);
  if (cached?.key === key) return cached.value;
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
  }
  if (!sqlite?.DatabaseSync) return null;
  let database;
  try {
    database = new sqlite.DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA busy_timeout = 100; BEGIN');
    const steps = new Map();
    let complete = true;
    const hasSteps = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'").get();
    if (hasSteps) {
      for (const row of database.prepare('SELECT idx,CASE WHEN length(metadata)<=8388608 THEN metadata END AS metadata FROM steps').iterate()) {
        let meta;
        try { meta = row.metadata ? protobufFields(row.metadata) : new Map(); }
        catch (_) { meta = new Map(); complete = false; }
        steps.set(row.idx, timeMs(nested(meta, 1)) || 0);
      }
    }
    const generations = [];
    const seen = new Set();
    for (const row of database.prepare('SELECT CASE WHEN length(data)<=8388608 THEN data END AS data FROM gen_metadata ORDER BY idx DESC').iterate()) {
      const generation = decodeGeneration(row.data);
      if (!generation) { complete = false; continue; }
      if (generation.responseId && seen.has(generation.responseId)) continue;
      if (generation.responseId) seen.add(generation.responseId);
      generation.startedAt ||= steps.get(generation.stepIdx) || 0;
      if (!generation.startedAt) complete = false;
      generations.unshift(generation);
    }
    database.exec('COMMIT');
    const value = { generations, complete };
    if (key === stamp()) {
      databaseCache.set(file, { key, value });
      if (databaseCache.size > 128) databaseCache.delete(databaseCache.keys().next().value);
    }
    return value;
  } catch (_) {
    // Never cache a busy, corrupt or partially traversed database as an empty result.
    return null;
  } finally {
    try { database?.close(); } catch (_) {}
  }
}

function inWindow(startedAt, flags, now) {
  if (!startedAt) return false;
  const start = new Date(now);
  if (flags.includes('--today')) start.setHours(0, 0, 0, 0);
  else if (flags.includes('--month')) { start.setDate(1); start.setHours(0, 0, 0, 0); }
  else if (flags.includes('--since')) return startedAt >= new Date(`${flags[flags.indexOf('--since') + 1]}T00:00:00`).getTime();
  else return true;
  return startedAt >= start.getTime() && startedAt <= now;
}

// Supplement existing counters only when the native sample exactly covers one
// scan row. Usage/costs remain owned by Tokscale; ambiguous or partial coverage
// must not put untimed output on another generation's clock.
function applyAntigravityThroughput(json, { home, env = process.env, flags = [], now = Date.now() } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(json?.entries) ? json.entries : []) {
    if (!String(row.client || '').startsWith('antigravity')) continue;
    const period = extractUsageFromTokscale({ entries: [row] });
    const session = Object.values(period.sessions)[0];
    const model = Object.keys(period.models)[0];
    if (!session || session.client !== 'antigravity' || !model) continue;
    const key = `${row.client}:${session.sessionId}:${model}`;
    const group = groups.get(key) || [];
    group.push({ row, session, model });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length !== 1) continue;
    const { row, session, model } = group[0];
    if (session.timedDurationMs > 0) continue;
    const data = readConversation(conversationFile(session.sessionId, home, row.client === 'antigravity-cli', env));
    if (!data?.complete) continue;
    const window = data.generations.filter(generation => inWindow(generation.startedAt, flags, now));
    let samples = window.filter(generation => generation.model === model);
    // Tokscale owns model aliases. A single-model session can be joined without
    // copying its alias table; mixed-model sessions still require an exact id.
    if (!samples.length && new Set(window.map(generation => generation.model)).size === 1
      && [...groups.values()].filter(rows => rows[0].session.sessionId === session.sessionId).length === 1) samples = window;
    if (!samples.length || samples.some(generation => !generation.durationMs)) continue;
    const output = samples.reduce((sum, generation) => sum + generation.tokens.output, 0);
    if (!output || output !== session.outputTokens) continue;
    row.performance = {
      ...row.performance,
      totalDurationMs: samples.reduce((sum, generation) => sum + generation.durationMs, 0),
      timedTokens: samples.reduce((sum, generation) => sum + generation.tokens.total, 0)
    };
  }
}

module.exports = { applyAntigravityThroughput, conversationFile, decodeGeneration, readConversation };
