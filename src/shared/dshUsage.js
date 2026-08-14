'use strict';

/**
 * DeepSeek Harness (dsh) session usage parser.
 *
 * Reads session transcripts from the DeepSeek Harness home (`$DSH_HOME` or
 * `~/.dsh`): `sessions/<project>/<sessionId>/session.jsonl.zstd`. The logs
 * are append-only JSONL stored as a concatenation of independent zstd frames
 * (one per durable write batch), so decompression scans frame boundaries and
 * decodes each frame separately. `assistant/message` events carry
 * `data.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, ...)
 * plus the model/provider in `data.message.source` — exactly the token
 * accounting this parser aggregates, the same way the Pi agent's transcripts
 * are surfaced through the shared tokscale pipeline.
 *
 * Returns data shaped like a tokscale JSON response so it can be fed directly
 * into extractUsageFromTokscale or merged alongside tokscale results (the
 * Proma local-adapter pattern).
 *
 * SWITCH-OVER when tokscale natively supports dsh: this adapter exists only
 * because tokscale (^4.13) does not know the DeepSeek Harness client yet.
 * Once `tokscale --client` accepts dsh, flip the tracked client to the
 * tokscale path instead of maintaining a second parser:
 *   1. tests/shared/clientTracking.test.js — drop 'dsh' from locallyParsedClients
 *   2. src/shared/collector.js — stop filtering dsh out of tokscaleClients /
 *      targetTokscaleClients and remove the includesDsh local-parse block
 *   3. src/shared/wslUsage.js — drop the collectDsh home-scan block (tokscale
 *      --home covers it)
 *   4. src/shared/collector.js clientSourceRoots() — point the dsh source root
 *      at whatever tokscale actually reads
 * This module can then be retired (or kept as a fallback) at maintainer
 * discretion; the data it produces is shape-identical to tokscale's, so the
 * renderer, health checks and history need no changes.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { zstdDecompressSync } = require('node:zlib');
const { hashKey } = require('./hashKey');

const DSH_HOME_DIR_NAME = '.dsh';
const DSH_HOME_ENV = 'DSH_HOME';
// Little-endian bytes of the zstd frame magic 0xFD2FB528.
const ZSTD_MAGIC = 4247762216;
// Rows of sessions whose file mtime/size are unchanged are reused across ticks.
// Bounded: a very long-lived home with thousands of sessions must not grow the
// cache without limit; a full re-parse is the cost of eviction.
const ROW_CACHE_MAX = 512;

const rowCache = new Map(); // `${root}\0${relativePath}` -> { size, mtimeMs, rows }

function defaultDshHome() {
  return path.join(os.homedir(), DSH_HOME_DIR_NAME);
}

function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Resolve the DeepSeek Harness home. Precedence: explicit configured path,
 * `$DSH_HOME`, then `~/.dsh` — mirroring @deepseek-ai/dsh-home-paths.
 */
function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV];
  const value = configured ?? (fromEnv !== undefined && String(fromEnv).trim().length > 0 ? fromEnv : defaultDshHome());
  return path.resolve(expandHomePath(value));
}

/**
 * Locate complete zstd frames without decompressing their blocks (port of the
 * structural scanner used by the harness' own JSONL persistence). Invalid
 * complete structure throws; EOF inside the final frame returns its start so
 * a torn tail (a write batch still landing) can be skipped.
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
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
  return { frames, tornStart: null };
}

/**
 * Decompress a concatenated-frame zstd session log. Complete frames are
 * decoded with node:zlib's one-shot zstd (checksummed per frame by the
 * harness writer); an incomplete final frame is skipped — its data lands on a
 * later tick. Returns '' when the log is unreadable (still being created or
 * structurally corrupt), never throws.
 */
function decompressSessionLog(buffer) {
  if (!buffer || buffer.length === 0) return '';
  let frames;
  try {
    frames = scanZstdFrames(buffer).frames;
  } catch (_) {
    return '';
  }
  if (frames.length === 0) return '';
  const chunks = [];
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    } catch (_) {
      // A single bad frame is not worth losing the whole session's history.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

// Cost is an estimate from a model-price catalog, never a provider invoice.
// Return null rather than silently undercount when a row uses a token category
// whose rate is unavailable (mirrors promaUsage.estimatedRowCost).
function estimatedRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[normalizedModelId(row.model)];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function sourceNamespace(root) {
  return createHash('sha256').update(path.normalize(String(root || ''))).digest('hex').slice(0, 12);
}

function normalizeProjectPath(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith('//');
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  if (!root) normalized = normalized.replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

// Mirrors collector.js projectIdentity so dsh sessions land in the same
// project namespace as every other tracked client.
function projectIdentityFromCwd(value) {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return { projectId: '', projectLabel: '' };
  const root = normalized === '/' || /^[a-z]:\/$/i.test(normalized);
  let displayPath = String(value || '').trim().replace(/\\/g, '/');
  if (!root) displayPath = displayPath.replace(/\/+$/, '');
  const label = root ? (normalized === '/' ? '/' : `${normalized[0].toUpperCase()}:\\`) : displayPath.split('/').pop();
  return { projectId: hashKey('project', normalized), projectLabel: label };
}

function usageFields(usage) {
  return {
    input: numberValue(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens),
    output: numberValue(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens),
    cacheRead: numberValue(usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cachedTokens),
    cacheWrite: numberValue(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cacheCreationInputTokens)
  };
}

/**
 * Parse one session log's plaintext into message-level rows. Each
 * `assistant/message` carrying `data.usage` produces one row (an
 * empty-content assistant message exists only to host usage and still counts).
 * Model/provider fall back from the most recent request/header config, then to
 * 'unknown'/'dsh'.
 */
function collectSessionRows(text, options = {}) {
  const rows = [];
  const sessionId = options.sessionId || '';
  let header = null;
  let lastModel = '';
  let lastProvider = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.type === 'session' && !header) header = obj;
    else if (obj.type === 'request/header' && obj.data?.header?.config) {
      lastModel = obj.data.header.config.model || lastModel;
      lastProvider = obj.data.header.config.provider || lastProvider;
      continue;
    }
    if (obj.type !== 'assistant/message') continue;
    const usage = obj.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const source = obj.data?.message?.source;
    const model = source?.model || lastModel || 'unknown';
    const provider = source?.provider || lastProvider || '';
    rows.push({
      sessionId,
      model,
      provider,
      createdAt: timestampMs(obj.time),
      messages: 1,
      ...usageFields(usage)
    });
  }
  return { header, rows };
}

function sessionLogFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'session.jsonl.zstd') files.push(full);
    }
  };
  walk(path.join(root, 'sessions'));
  return files;
}

// Read every session exactly once per collection tick per file: unchanged
// files reuse cached rows (keyed by size+mtime), so a watch tick that only
// touched one active session does not re-decompress the whole home.
function collectDshRows(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [resolveDshHome(options.home)];
  const all = [];
  for (const root of roots) {
    const sourceId = sourceNamespace(root);
    const defaultRoot = defaultDshHome();
    for (const filePath of sessionLogFiles(root)) {
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }
      const rel = path.relative(root, filePath);
      const cacheKey = `${root}\0${rel}`;
      const cached = rowCache.get(cacheKey);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        all.push(...cached.rows);
        continue;
      }
      const sessionId = path.basename(path.dirname(filePath));
      // Host sessions keep the bare harness session id; a non-default home
      // (WSL distro, custom DSH_HOME) is namespaced so two homes can never
      // collide in the same merged period.
      const scopedId = path.resolve(root) === path.resolve(defaultRoot) ? sessionId : `${sessionId}@${sourceId}`;
      const rows = [];
      try {
        const text = decompressSessionLog(fs.readFileSync(filePath));
        const { header, rows: messageRows } = collectSessionRows(text, { sessionId: scopedId });
        if (!header) { rowCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, rows }); all.push(...rows); continue; }
        const identity = projectIdentityFromCwd(header.cwd);
        for (const row of messageRows) {
          rows.push({
            ...row,
            startedAt: timestampMs(header.createdAt),
            ...identity
          });
        }
      } catch (_) {
        // Unreadable/mid-write session files contribute nothing this tick.
      }
      if (rowCache.size > ROW_CACHE_MAX) rowCache.clear();
      rowCache.set(cacheKey, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
      all.push(...rows);
    }
  }
  return all;
}

function resetDshRowCache() {
  rowCache.clear();
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from dsh session rows.
 *
 * @param {{ todayStart?: number, monthStart?: number, allTimeSince?: number }} windows
 * @returns {{ entries: Array, totalInput: number, ... }}
 */
function buildDshTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0;
  let allOutput = 0;
  let allCacheRead = 0;
  let allCacheWrite = 0;
  let allMessages = 0;
  let allCost = 0;

  const allRows = (Array.isArray(options.rows) ? options.rows : collectDshRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\0${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        provider: row.provider || 'dsh',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectId: row.projectId || '',
        projectLabel: row.projectLabel || ''
      });
    }
    const m = bySessionModel.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.messages += Number(row.messages || 1);
    m.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    entries.push({
      client: 'dsh',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: m.provider,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: 0,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      projectId: m.projectId,
      projectLabel: m.projectLabel,
      performance: null
    });
    allInput += m.input;
    allOutput += m.output;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
    allCost += m.cost;
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: allCacheRead,
    totalCacheWrite: allCacheWrite,
    totalMessages: allMessages,
    totalCost: allCost,
    processingTimeMs: 0
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

// Return raw graph-compatible contributions so collector.js can merge this
// local adapter with tokscale's graph output through the shared history core.
function buildDshHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
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
        client: 'dsh',
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.tokens.cacheRead += row.cacheRead;
    client.tokens.cacheWrite += row.cacheWrite;
    client.cost += cost === null ? 0 : cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * Compute local midnight for today and month start, then build
 * tokscale-compatible JSON.
 *
 * @param {{ now?: Date | number | string, allTimeSince?: number | string, roots?: string[], rows?: Array }} options
 */
function buildDshPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectDshRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildDshTokscaleJson({ todayStart }, buildOptions),
    month: buildDshTokscaleJson({ monthStart }, buildOptions),
    allTime: buildDshTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  DSH_HOME_DIR_NAME,
  DSH_HOME_ENV,
  buildDshHistoryGraph,
  buildDshPeriods,
  buildDshTokscaleJson,
  collectDshRows,
  collectSessionRows,
  decompressSessionLog,
  defaultDshHome,
  estimatedRowCost,
  resetDshRowCache,
  resolveDshHome,
  scanZstdFrames
};
