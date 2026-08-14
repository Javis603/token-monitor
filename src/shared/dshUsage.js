'use strict';

/**
 * DeepSeek Harness (`dsh`) usage parser.
 *
 * `dsh` persists each agent session as an append-only, event-sourced JSONL log
 * under `<dsh-home>/sessions/<project-key>/<session-id>/session.jsonl(.zstd)`.
 * Every completed model step appends one `assistant/message` record whose
 * `data.usage` block carries the provider-reported token accounting and whose
 * `data.provenance` block carries the provider/model route. This module reads
 * exactly those records (plus the immutable header line) so prompts, stream
 * chunks and tool arguments never leave the source file.
 *
 * The default artifact encoding is a concatenation of independently decodable
 * Zstandard frames. Node exposes `zstdDecompressSync` from 22.15, so older
 * 22.x releases report `zstd-unsupported` and the caller falls back to raw
 * `.jsonl` sessions only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { estimatedRowCost } = require('./promaUsage');

const DSH_CLIENT = 'dsh';
const DSH_SUPPORTED_LOG_VERSION = 0;
const DSH_HOME_DIR_NAME = '.dsh';
const DSH_SESSION_LOG_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd']);
const DSH_SESSION_DIR_DEPTH = 2; // <root>/<project>/<session>/<artifact>
const DSH_MAX_SESSION_BYTES = 64 * 1024 * 1024;
const DSH_MAX_CACHED_FILES = 512;
const DSH_MAX_ROWS_PER_SESSION = 200_000;
const ZSTD_MAGIC = 0xFD2FB528;

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function expandHomePath(value, homeDir) {
  const raw = String(value || '');
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
}

// Mirrors dsh's resolveDshHome: explicit override > $DSH_HOME > ~/.dsh.
// `TOKEN_MONITOR_DSH_SESSIONS_DIR` points directly at the persistence root for
// deployments that patch `session-persistence-jsonl.root` away from the default.
function resolveDshSessionsRoot(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const cwdDir = options.cwdDir || process.cwd();
  const explicit = String(env.TOKEN_MONITOR_DSH_SESSIONS_DIR || '').trim();
  if (explicit) return path.resolve(cwdDir, expandHomePath(explicit, homeDir));
  const dshHome = String(env.DSH_HOME || '').trim();
  const base = dshHome
    ? path.resolve(cwdDir, expandHomePath(dshHome, homeDir))
    : path.join(homeDir, DSH_HOME_DIR_NAME);
  return path.join(base, 'sessions');
}

function dshSessionFiles(root) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < DSH_SESSION_DIR_DEPTH) stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile() && DSH_SESSION_LOG_NAMES.has(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

// Locate complete frames without decompressing them. Ported from dsh's
// session-persistence-jsonl backend (MIT): the artifact is a concatenation of
// independent Zstandard frames, and the trailing frame may be torn by a crash.
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt dsh session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt dsh session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt dsh session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function decodeZstdBuffer(buffer) {
  if (!zstdAvailable()) {
    const error = new Error('this Node.js build does not support Zstandard decompression');
    error.code = 'zstd-unsupported';
    throw error;
  }
  const { frames } = scanZstdFrames(buffer);
  return { text: decodeZstdFrames(buffer, frames), lastFrameEnd: frames.length > 0 ? frames[frames.length - 1].end : 0 };
}

function decodeZstdFrames(buffer, frames) {
  let text = '';
  for (const frame of frames) {
    text += zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
  }
  return text;
}

function decodeSessionText(filePath, buffer) {
  return filePath.endsWith('.jsonl.zstd')
    ? decodeZstdBuffer(buffer)
    : { text: buffer.toString('utf8'), lastFrameEnd: buffer.length };
}

function validHeader(header) {
  return Boolean(
    header
    && typeof header === 'object'
    && header.type === 'session'
    && typeof header.id === 'string'
    && header.id
    && Number.isFinite(Number(header.createdAt))
    && Number(header.createdAt) >= 0
  );
}

function assertSupportedVersion(header) {
  const version = Number(header.version);
  if (version !== DSH_SUPPORTED_LOG_VERSION) {
    const error = new Error(`unsupported dsh session log version ${String(header.version)}`);
    error.code = 'unsupported-format-version';
    throw error;
  }
}

function usageRow(header, event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') return null;
  const provenance = data.provenance && typeof data.provenance === 'object'
    ? data.provenance
    : (data.message?.source && typeof data.message.source === 'object'
      ? data.message.source
      : {});
  const input = Math.max(0, Math.round(numberValue(usage.inputTokens)));
  const output = Math.max(0, Math.round(numberValue(usage.outputTokens)));
  const cacheRead = Math.max(0, Math.round(numberValue(usage.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(usage.cacheWriteTokens)));
  const reasoning = Math.max(0, Math.round(numberValue(usage.reasoningTokens)));
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) return null;
  const time = Math.max(0, numberValue(event.time) || Number(header.createdAt) || 0);
  return {
    sessionId: header.id,
    model: normalizedModelId(provenance.model) || 'unknown',
    provider: String(provenance.provider || '').trim().toLowerCase() || 'deepseek',
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    messages: 1,
    time,
    createdAt: Number(header.createdAt) || 0,
    projectId: '',
    projectLabel: '',
    cwd: typeof header.cwd === 'string' ? header.cwd : ''
  };
}

// One event per line except packed chunk rows, which reconstruct raw stream
// chunks only and never carry usage. Skipping them is layout-independent:
// `assistant/message` is always an ordinary SessionEvent line.
function parseSessionLines(lines, state) {
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_) {
      continue; // partial or malformed line — never trust it
    }
    if (state.expectsHeader) {
      state.expectsHeader = false;
      if (!validHeader(event)) {
        const error = new Error('dsh session log has no valid session header');
        error.code = 'corrupt-log';
        throw error;
      }
      assertSupportedVersion(event);
      state.header = {
        id: String(event.id),
        version: Number(event.version),
        createdAt: Number(event.createdAt) || 0,
        cwd: typeof event.cwd === 'string' ? event.cwd : ''
      };
      continue;
    }
    if (event?.type !== 'assistant/message') continue;
    if (state.header) {
      const row = usageRow(state.header, event);
      if (row) rows.push(row);
    }
  }
  if (rows.length > DSH_MAX_ROWS_PER_SESSION) {
    const error = new Error('dsh session log exceeds the supported row count');
    error.code = 'session-too-large';
    throw error;
  }
  return rows;
}

const dshFileStates = new Map();

function resetDshFileCache() {
  dshFileStates.clear();
}

function evictOldestFileState() {
  const oldest = dshFileStates.keys().next().value;
  if (oldest !== undefined) dshFileStates.delete(oldest);
}

function readFileRange(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

// Append-only, size-based incremental reader. A complete-bytes cursor means a
// torn trailing Zstandard frame from a crash is revisited on the next tick
// instead of being dropped; a shrunk file (dsh repair) is re-read whole.
function readDshSession(filePath) {
  const existing = dshFileStates.get(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    if (existing) dshFileStates.delete(filePath);
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > DSH_MAX_SESSION_BYTES) {
    const state = { filePath, completeBytes: stat.size, mtimeMs: stat.mtimeMs, errorCode: 'session-too-large', rows: [] };
    dshFileStates.set(filePath, state);
    return state;
  }
  if (
    existing
    && existing.filePath === filePath
    && stat.size === existing.completeBytes
    && stat.mtimeMs === existing.mtimeMs
  ) {
    return existing;
  }
  const reset = !existing || stat.size < existing.completeBytes;
  if (reset) {
    dshFileStates.delete(filePath);
  }
  const start = reset ? 0 : (existing.completeBytes || 0);
  const length = stat.size - start;
  if (length <= 0) return existing;
  let buffer;
  try {
    buffer = readFileRange(filePath, start, length);
  } catch (error) {
    const state = { filePath, completeBytes: start, mtimeMs: stat.mtimeMs, errorCode: error.code === 'ENOENT' ? null : 'read-failed', rows: existing?.rows || [] };
    dshFileStates.set(filePath, state);
    return state;
  }
  let decoded;
  try {
    decoded = decodeSessionText(filePath, buffer);
  } catch (error) {
    const state = {
      filePath,
      completeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      errorCode: error.code || 'corrupt-log',
      rows: reset ? [] : (existing?.rows || [])
    };
    dshFileStates.set(filePath, state);
    return state;
  }
  const text = decoded.text;
  const state = {
    filePath,
    completeBytes: reset ? stat.size : start,
    mtimeMs: stat.mtimeMs,
    errorCode: null,
    header: reset ? null : (existing?.header || null),
    expectsHeader: reset,
    rows: reset ? [] : (existing?.rows || [])
  };
  try {
    let lines;
    if (reset) {
      lines = text.split(/\r?\n/);
      state.completeBytes = stat.size;
    } else if (filePath.endsWith('.jsonl.zstd')) {
      if (decoded.lastFrameEnd === 0) return existing;
      state.completeBytes = start + decoded.lastFrameEnd;
      lines = text.split(/\r?\n/);
    } else {
      // Keep only complete appended lines. An in-flight final line is re-read
      // from its start on the next tick.
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return existing;
      const complete = text.slice(0, lastNewline);
      state.completeBytes += Buffer.byteLength(complete, 'utf8') + 1;
      lines = complete.split(/\r?\n/);
    }
    state.rows.push(...parseSessionLines(lines, state));
  } catch (error) {
    state.errorCode = error.code || 'corrupt-log';
    if (!reset) {
      // A repair or format change rewrites the tail; the next full tick
      // re-reads from zero when the size no longer grows monotonically.
      state.completeBytes = stat.size;
    }
  }
  if (dshFileStates.size >= DSH_MAX_CACHED_FILES && !dshFileStates.has(filePath)) evictOldestFileState();
  dshFileStates.set(filePath, state);
  return state;
}

function collectDshRows(options = {}) {
  const roots = Array.isArray(options.roots) && options.roots.length > 0
    ? options.roots
    : [resolveDshSessionsRoot(options)];
  const rows = [];
  const errors = [];
  let files = 0;
  for (const root of roots) {
    for (const filePath of dshSessionFiles(root)) {
      files += 1;
      const state = readDshSession(filePath);
      if (!state) continue;
      if (state.errorCode) errors.push({ code: state.errorCode });
      else if (state.rows.length > 0) rows.push(...state.rows);
    }
  }
  return { rows, files, errors };
}

function estimatedDshRowCost(row, pricingByModel) {
  const cost = estimatedRowCost(row, pricingByModel);
  return cost === null ? 0 : cost;
}

function decorateProject(row, projectIdentity) {
  if (typeof projectIdentity !== 'function' || !row.cwd) return;
  const identity = projectIdentity(row.cwd);
  if (!identity) return;
  row.projectId = String(identity.projectId || '');
  row.projectLabel = String(identity.projectLabel || '');
}

// Build a tokscale-compatible JSON shape for one window so the shared
// extractUsageFromTokscale() pipeline treats dsh exactly like a native client.
function buildDshTokscaleJson({ rows, sinceMs, pricingByModel, projectIdentity }) {
  const selected = rows.filter((row) => {
    if (!sinceMs) return true;
    if (!row.time) return false;
    return row.time >= sinceMs;
  });
  const bySessionModel = new Map();
  for (const row of selected) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        provider: row.provider,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectId: '',
        projectLabel: '',
        cwd: row.cwd || ''
      });
    }
    const entry = bySessionModel.get(key);
    entry.input += row.input;
    entry.output += row.output;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite;
    entry.reasoning += row.reasoning;
    entry.messages += Number(row.messages || 1);
    entry.cost += estimatedDshRowCost(row, pricingByModel);
    if (row.createdAt && (!entry.startedAt || row.createdAt < entry.startedAt)) entry.startedAt = row.createdAt;
    if (row.time > entry.lastUsedAt) entry.lastUsedAt = row.time;
  }
  const entries = [];
  for (const entry of bySessionModel.values()) {
    decorateProject(entry, projectIdentity);
    entries.push({
      client: DSH_CLIENT,
      mergedClients: null,
      sessionId: entry.sessionId,
      model: entry.model,
      provider: entry.provider,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      reasoning: entry.reasoning,
      messageCount: entry.messages,
      cost: entry.cost,
      startedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : '',
      lastUsedAt: entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : '',
      projectId: entry.projectId,
      projectLabel: entry.projectLabel,
      performance: null
    });
  }
  return {
    groupBy: 'client,session,model',
    entries
  };
}

function buildDshPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const allTimeSince = Math.max(0, timestampMs(options.allTimeSince));
  return {
    today: buildDshTokscaleJson({ rows, sinceMs: todayStart, pricingByModel: options.pricingByModel, projectIdentity: options.projectIdentity }),
    month: buildDshTokscaleJson({ rows, sinceMs: monthStart, pricingByModel: options.pricingByModel, projectIdentity: options.projectIdentity }),
    allTime: buildDshTokscaleJson({ rows, sinceMs: allTimeSince, pricingByModel: options.pricingByModel, projectIdentity: options.projectIdentity })
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Raw graph-compatible contributions so collector.js merges this local adapter
// with tokscale's graph output through the shared history core.
function buildDshHistoryGraph(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const byDate = new Map();
  for (const row of rows) {
    const date = row.time ? localDateKey(row.time) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: DSH_CLIENT,
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.tokens.reasoning += row.reasoning;
    client.cost += estimatedDshRowCost(row, options.pricingByModel);
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

// One call site for collector ticks: read the persisted logs once, then derive
// periods, history and diagnostics from that immutable snapshot.
function collectDshUsageOnce(options = {}) {
  const collected = collectDshRows(options);
  return {
    rows: collected.rows,
    files: collected.files,
    errors: collected.errors,
    periods: buildDshPeriods({ ...options, rows: collected.rows }),
    graph: buildDshHistoryGraph({ ...options, rows: collected.rows })
  };
}

module.exports = {
  DSH_CLIENT,
  DSH_MAX_CACHED_FILES,
  DSH_MAX_ROWS_PER_SESSION,
  DSH_MAX_SESSION_BYTES,
  DSH_SESSION_DIR_DEPTH,
  DSH_SESSION_LOG_NAMES,
  DSH_SUPPORTED_LOG_VERSION,
  buildDshHistoryGraph,
  buildDshPeriods,
  collectDshRows,
  collectDshUsageOnce,
  decodeSessionText,
  dshSessionFiles,
  parseSessionLines,
  resetDshFileCache,
  resolveDshSessionsRoot,
  scanZstdFrames,
  usageRow,
  zstdAvailable
};
