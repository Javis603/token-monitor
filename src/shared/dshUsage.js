'use strict';

/**
 * DeepSeek Harness (DSH) session usage parser.
 *
 * Reads zstd-packed session logs from <DSH_HOME>/sessions/<id>/session.jsonl.zstd
 * and aggregates token usage reported by assistant-message 'usage' fields.
 * The tokscale-shaped builders (periods / history graph / estimated cost) live
 * in the shared localSessionAdapter pipeline; this module only owns the
 * DSH-specific zstd frame decoding and record extraction.
 *
 * DSH's on-disk format is a concatenation of independent zstd frames; each frame
 * holds JSONL records. The first record of the first frame is the session
 * header (type: 'session'). Each completed assistant step emits an
 * 'assistant/chunk' of type 'usage' followed by an 'assistant/message' carrying
 * the identical usage totals plus the provider/model pair, so counting only
 * assistant messages avoids double-counting (verified against real logs).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { buildHistoryGraph, buildPeriods, buildTokscaleJson } = require('./localSessionAdapter');
const { DSH_CLIENT, resolveDshSessionsDir } = require('./dshPaths');

const SESSION_LOG_NAME = 'session.jsonl.zstd';
const ZSTD_MAGIC = 0xfd2fb528; // 28 B5 2F FD little-endian

// zstd support landed in Node 22.15 / Electron 22.x-bundled runtimes. The
// adapter degrades to an empty scan on older runtimes instead of throwing on
// every collection tick; the collector logs nothing for an empty scan (missing
// DSH home is the normal case on most machines).
function dshNativeZstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

// Structural zstd frame scanner. Walks the public frame layout (magic, frame
// header descriptor, window descriptor, dictionary id, frame content size,
// block headers, optional checksum) so concatenated frames can be decoded one
// at a time with zstdDecompressSync — the same shape DSH itself writes. The
// walk follows the zstd specification; DSH's own watcher uses an equivalent
// scan (session logs are append-only frame streams, not seekable archives).
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return frames;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeFrame(buffer) {
  return zlib.zstdDecompressSync(buffer).toString('utf8');
}

function walkSessionLogs(root, pathApi = path, fsApi = fs) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const filePath = pathApi.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && entry.name === SESSION_LOG_NAME) files.push(filePath);
    }
  };
  walk(root);
  return files;
}

// Parse one session log into message-level usage rows. Returns an empty array
// when the file has no usable header or no usage records.
function collectSessionRows(filePath, options = {}) {
  const fsApi = options.fsModule || fs;
  let buffer;
  try {
    buffer = fsApi.readFileSync(filePath);
  } catch (_) {
    return [];
  }
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) return [];

  let header = null;
  let title = '';
  const messageGroups = new Map(); // message.id -> usage chunks sharing that id

  for (const frame of frames) {
    let text;
    try { text = decodeFrame(buffer.subarray(frame.start, frame.end)); } catch (_) { break; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { continue; }
      if (!row || typeof row !== 'object') continue;

      if (header === null && row.type === 'session') {
        header = {
          id: String(row.id || '').trim(),
          createdAt: numberValue(row.createdAt),
          cwd: String(row.cwd || '').trim()
        };
        continue;
      }
      if (row.type === 'session/title') {
        const data = row.data;
        if (data && typeof data === 'object' && typeof data.title === 'string' && data.title.trim()) {
          title = data.title.trim();
        }
        continue;
      }
      if (row.type !== 'assistant/message') continue;
      const data = row.data;
      if (!data || typeof data !== 'object') continue;
      const usage = data.usage;
      if (!usage || typeof usage !== 'object') continue;
      const message = data.message;
      if (!message || typeof message !== 'object') continue;
      const source = message.source;
      if (!source || typeof source !== 'object' || source.kind !== 'model') continue;

      // Message ID: some paths use message.id; fall back to the turn/step pair
      // so a missing id cannot merge unrelated calls.
      const msgId = typeof message.id === 'string' && message.id
        ? message.id
        : String(data.turn) + ':' + String(data.step);
      const model = String(source.model || '').trim().toLowerCase() || 'unknown';
      const provider = String(source.provider || '').trim().toLowerCase() || DSH_CLIENT;
      const input = numberValue(usage.inputTokens);
      const output = numberValue(usage.outputTokens);
      const cacheRead = numberValue(usage.cacheReadTokens);
      const createdAt = numberValue(row.time);

      if (!messageGroups.has(msgId)) messageGroups.set(msgId, []);
      messageGroups.get(msgId).push({ model, provider, input, output, cacheRead, createdAt });
    }
  }

  if (!header || !header.id) return [];

  // Collapse each message group: retries/replays share a message id, so take
  // the entry with the largest total tokens and the latest timestamp.
  const collapsed = [];
  for (const chunks of messageGroups.values()) {
    if (chunks.length === 0) continue;
    chunks.sort((left, right) => (right.input + right.output + right.cacheRead + right.cacheWrite)
      - (left.input + left.output + left.cacheRead + left.cacheWrite));
    const row = { ...chunks[0] };
    row.createdAt = Math.max(0, ...chunks.map((chunk) => chunk.createdAt || 0));
    collapsed.push(row);
  }

  const lastUsedAt = collapsed.length > 0
    ? Math.max(0, ...collapsed.map((row) => row.createdAt || 0))
    : header.createdAt;
  const project = typeof options.projectIdentity === 'function' && header.cwd
    ? options.projectIdentity(header.cwd) || {}
    : {};
  const sessionMeta = {
    sessionId: header.id,
    startedAt: header.createdAt,
    lastUsedAt,
    ...(title ? { title } : {}),
    ...(project && project.projectId ? { projectId: project.projectId } : {}),
    ...(project && project.projectLabel ? { projectLabel: project.projectLabel } : {})
  };

  return collapsed.map((row) => ({ ...sessionMeta, ...row }));
}

// Read every session log exactly once per collection tick. The caller can then
// derive several windows (and history) from the same immutable snapshot rather
// than reopening every zstd log once for each period.
function collectDshRows(options = {}) {
  if (!dshNativeZstdAvailable()) return [];
  const pathApi = options.pathModule || path;
  const fsApi = options.fsModule || fs;
  const roots = Array.isArray(options.roots) && options.roots.length > 0
    ? options.roots
    : [resolveDshSessionsDir({
      env: options.env || process.env,
      homeDir: options.homeDir,
      platform: options.platform || process.platform,
      cwdDir: options.cwdDir || process.cwd()
    })];
  const rows = [];
  for (const root of roots) {
    for (const filePath of walkSessionLogs(root, pathApi, fsApi)) {
      try {
        rows.push(...collectSessionRows(filePath, options));
      } catch (_) {
        // skip unreadable files
      }
    }
  }
  return rows;
}

function dshRows(options = {}) {
  return Array.isArray(options.rows) ? options.rows : collectDshRows(options);
}

function buildDshTokscaleJson(windows = {}, options = {}) {
  return buildTokscaleJson(windows, { ...options, client: DSH_CLIENT, provider: DSH_CLIENT, rows: dshRows(options) });
}

function buildDshHistoryGraph(options = {}) {
  return buildHistoryGraph({ ...options, client: DSH_CLIENT, rows: dshRows(options) });
}

function buildDshPeriods(options = {}) {
  return buildPeriods({ ...options, client: DSH_CLIENT, provider: DSH_CLIENT, rows: dshRows(options) });
}

module.exports = {
  DSH_CLIENT,
  SESSION_LOG_NAME,
  buildDshHistoryGraph,
  buildDshPeriods,
  buildDshTokscaleJson,
  collectDshRows,
  collectSessionRows,
  dshNativeZstdAvailable,
  resolveDshSessionsDir,
  scanZstdFrames,
  walkSessionLogs
};
