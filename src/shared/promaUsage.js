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

const PROMA_ROOT = path.join(os.homedir(), '.proma', 'agent-sessions');
const PROMA_CONVERSATIONS_ROOT = path.join(os.homedir(), '.proma', 'conversations');

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

function collectSessionRows(filePath) {
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
      msgGroups.get(msgId).push({ model, input, output, cacheRead, cacheWrite, createdAt });
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
    collapsed.push(row);
  }
  return collapsed;
}

/**
 * Parse a single JSONL session file, returning per-model usage rows.
 *
 * @param {string} filePath  Absolute path to a .jsonl file
 * @param {{ sinceMs?: number }} options
 * @returns {{ model: string, input: number, output: number, cacheRead: number, cacheWrite: number, messages: number, cost: number, _createdAt: number }}
 */
function parseSessionFile(filePath, options = {}) {
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const collapsed = collectSessionRows(filePath)
    .filter((row) => !sinceMs || !row.createdAt || row.createdAt >= sinceMs);

  // Aggregate by model
  const byModel = new Map();
  for (const entry of collapsed) {
    if (!byModel.has(entry.model)) {
      byModel.set(entry.model, { model: entry.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, _createdAt: entry.createdAt });
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
  const roots = Array.isArray(options.roots) ? options.roots : [PROMA_ROOT];
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  // Collect all session files
  const files = roots.flatMap(jsonlFiles);

  // Parse each file after filtering at message granularity. Filtering after
  // per-model aggregation would use the model's earliest timestamp and drop
  // today's usage from a session that began before midnight.
  const allRows = [];
  for (const filePath of files) {
    try {
      allRows.push(...parseSessionFile(filePath, { sinceMs }));
    } catch (_) {
      // skip unreadable files
    }
  }

  // Aggregate by model
  const byModel = new Map();
  for (const row of allRows) {
    if (!byModel.has(row.model)) {
      byModel.set(row.model, { model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
    }
    const m = byModel.get(row.model);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.messages += row.messages;
  }

  for (const m of byModel.values()) {
    entries.push({
      client: 'proma',
      mergedClients: null,
      model: m.model,
      provider: 'proma',
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: 0,
      messageCount: m.messages,
      cost: 0,
      performance: null
    });
    allInput += m.input;
    allOutput += m.output;
    allCacheRead += m.cacheRead;
    allCacheWrite += m.cacheWrite;
    allMessages += m.messages;
  }

  return {
    groupBy: 'client,model',
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

/**
 * Compute local midnight for today and month start, then build
 * tokscale-compatible JSON.
 *
 * @param {{ now?: Date | number | string, allTimeSince?: number | string, roots?: string[] }} options
 */
function buildPromaPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const buildOptions = options.roots ? { roots: options.roots } : {};
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, buildOptions)
  };
}

module.exports = {
  PROMA_ROOT,
  PROMA_CONVERSATIONS_ROOT,
  collectSessionRows,
  parseSessionFile,
  buildTokscaleJson,
  buildPromaPeriods
};
