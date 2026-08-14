'use strict';

/**
 * Proma session usage parser.
 *
 * Reads session transcripts from ~/.proma/agent-sessions/*.jsonl and
 * aggregates token usage reported in assistant-message 'usage' fields.
 * Returns data shaped like a tokscale JSON response so it can be fed
 * directly into extractUsageFromTokscale or merged alongside tokscale
 * results.
 *
 * The tokscale-shaped builders (periods / history graph / estimated cost)
 * live in the shared localSessionAdapter pipeline; this module only owns the
 * Proma-specific transcript extraction.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const {
  buildHistoryGraph,
  buildPeriods,
  buildTokscaleJson,
  estimatedRowCost
} = require('./localSessionAdapter');

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

function sourceNamespace(root) {
  return createHash('sha256').update(path.normalize(String(root || ''))).digest('hex').slice(0, 12);
}

function collectSessionRows(filePath, options = {}) {
  const sourceId = options.sourceId || sourceNamespace(path.dirname(filePath));
  const sessionId = path.basename(filePath, path.extname(filePath)) + '@' + sourceId;
  const content = String(fs.readFileSync(filePath, 'utf8') || '');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const msgGroups = new Map(); // message.id -> [{ usage, model, createdAt }]

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg || !msg.usage) continue;
      // Message ID: some tools set msg.id, Proma uses obj.uuid instead.
      const msgId = msg?.id || obj.uuid;
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

function promaRows(options = {}) {
  return Array.isArray(options.rows) ? options.rows : collectPromaRows(options);
}

function buildPromaTokscaleJson(windows = {}, options = {}) {
  return buildTokscaleJson(windows, { ...options, client: 'proma', provider: 'proma', rows: promaRows(options) });
}

function buildPromaHistoryGraph(options = {}) {
  return buildHistoryGraph({ ...options, client: 'proma', rows: promaRows(options) });
}

function buildPromaPeriods(options = {}) {
  return buildPeriods({ ...options, client: 'proma', provider: 'proma', rows: promaRows(options) });
}

module.exports = {
  PROMA_ROOT,
  collectSessionRows,
  collectPromaRows,
  parseSessionFile,
  estimatedRowCost,
  buildTokscaleJson: buildPromaTokscaleJson,
  buildPromaHistoryGraph,
  buildPromaPeriods
};
