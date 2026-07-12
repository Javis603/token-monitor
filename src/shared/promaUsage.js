'use strict';

/**
 * Proma session usage parser.
 *
 * Reads session transcripts from ~/.proma/agent-sessions/*.jsonl and
 * aggregates token usage reported in assistant-message `usage` fields.
 * Returns data shaped like a tokscale JSON response so it can be fed
 * directly into extractUsageFromTokscale or merged alongside tokscale
 * results.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const PROMA_ROOT = path.join(os.homedir(), '.proma', 'agent-sessions');

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

function rowTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

// Cost is an estimate from a model-price catalog, never a provider invoice.
// Return null rather than silently undercount when a row uses a token category
// whose rate is unavailable (notably cache writes for some custom prices).
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

function collectSessionRows(filePath, options = {}) {
  const sourceId = options.sourceId || sourceNamespace(path.dirname(filePath));
  const sessionId = `${path.basename(filePath, path.extname(filePath))}@${sourceId}`;
  const content = String(fs.readFileSync(filePath, 'utf8') || '');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const msgGroups = new Map(); // message.id -> [{ usage, model, createdAt }]

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || !msg.usage) continue;
      const msgId = msg.id;
      if (!msgId) continue;

      const model = msg.model || obj._channelModelId || 'unknown';
      const u = msg.usage;
      const input = numberValue(u.input_tokens || u.inputTokens);
      const output = numberValue(u.output_tokens || u.outputTokens);
      const cacheRead = numberValue(u.cache_read_input_tokens || u.cacheReadInputTokens);
      const cacheWrite = numberValue(u.cache_creation_input_tokens || u.cacheCreationInputTokens);
      const createdAt = timestampMs(obj._createdAt || obj.createdAt || obj.created_at || obj.timestamp);

      if (!msgGroups.has(msgId)) msgGroups.set(msgId, []);
      msgGroups.get(msgId).push({ sessionId, model, input, output, cacheRead, cacheWrite, createdAt });
    } catch (_) {
      // skip malformed lines
    }
  }

  // Collapse each message group: take the entry with the largest total tokens
  // (multiple chunks share a message.id for thinking/tool_use/text splits)
  const collapsed = [];
  for (const chunks of msgGroups.values()) {
    if (chunks.length === 0) continue;
    chunks.sort((a, b) => rowTotal(b) - rowTotal(a));
    const row = { ...chunks[0] };
    row.createdAt = Math.max(0, ...chunks.map((chunk) => chunk.createdAt || 0));
    row.messages = 1;
    collapsed.push(row);
  }
  return collapsed;
}

/**
 * Parse a single JSONL session file, returning per-model usage rows.
 *
 * @param {string} filePath  Absolute path to a .jsonl file
 * @param {{ sinceMs?: number, includeUndated?: boolean }} options
 * @returns {{ sessionId: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, messages: number, cost: number, _createdAt: number }}
 */
function parseSessionFile(filePath, options = {}) {
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const collapsed = collectSessionRows(filePath, options)
    .filter((row) => !sinceMs || (row.createdAt ? row.createdAt >= sinceMs : options.includeUndated === true));

  // Aggregate by model
  const byModel = new Map();
  for (const entry of collapsed) {
    if (!byModel.has(entry.model)) {
      byModel.set(entry.model, { sessionId: entry.sessionId, model: entry.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, _createdAt: entry.createdAt });
    }
    const m = byModel.get(entry.model);
    m.input += entry.input;
    m.output += entry.output;
    m.cacheRead += entry.cacheRead;
    m.cacheWrite += entry.cacheWrite;
    m.messages += 1;
    // Keep the earliest _createdAt as a proxy for session start time
    if (entry.createdAt && (!m._createdAt || entry.createdAt < m._createdAt)) m._createdAt = entry.createdAt;
  }

  return Array.from(byModel.values());
}

function jsonlFiles(root) {
  try {
    return fs.readdirSync(root)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(root, n));
  } catch (_) {
    return [];
  }
}

// Read every session exactly once per collection tick. The caller can then
// derive several windows (and history) from the same immutable snapshot rather
// than reopening every JSONL file once for each period.
function collectPromaRows(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [PROMA_ROOT];
  const rows = [];
  for (const root of roots) {
    const sourceId = sourceNamespace(root);
    for (const filePath of jsonlFiles(root)) {
      try {
        rows.push(...collectSessionRows(filePath, { sourceId }));
      } catch (_) {
        // skip unreadable files
      }
    }
  }
  return rows;
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from Proma session data.
 *
 * @param {{ todayStart?: number, monthStart?: number, allTimeSince?: number }} windows
 *        Unix timestamps (ms) for period boundaries.
 * @returns {{ entries: Array, totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number, totalMessages: number, totalCost: number }}
 */
function buildTokscaleJson(windows = {}, options = {}) {
  // Conversation transcripts can contain assistant-shaped messages that
  // overlap agent-session records. Keep parsing limited to the verified
  // agent-session format until conversation attribution is implemented.
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  // Filter after loading message-level rows. Filtering after per-model
  // aggregation would use the model's earliest timestamp and drop today's
  // usage from a session that began before midnight.
  const allRows = (Array.isArray(options.rows) ? options.rows : collectPromaRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  // Keep the source JSONL's stable session id while aggregating streamed
  // messages by model. extractUsageFromTokscale() then merges all model rows
  // for the same session into one period.sessions entry.
  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, { sessionId: row.sessionId || 'unknown', model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0 });
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
      client: 'proma',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'proma',
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: 0,
      messageCount: m.messages,
      cost: m.cost,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
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
function buildPromaHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectPromaRows(options);
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue; // an undated row cannot be truthfully placed on a day
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model) || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: 'proma',
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
 * @param {{ now?: Date | number | string, allTimeSince?: number | string, roots?: string[] }} options
 */
function buildPromaPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectPromaRows(options);
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  PROMA_ROOT,
  collectSessionRows,
  collectPromaRows,
  parseSessionFile,
  estimatedRowCost,
  buildTokscaleJson,
  buildPromaHistoryGraph,
  buildPromaPeriods
};
