'use strict';

/**
 * OpenClacky billing usage parser.
 *
 * Reads ~/.clacky/billing/YYYY-MM.jsonl — one JSON usage event per line,
 * already normalized by OpenClacky (no transcript parsing needed):
 *   { id, session_id, timestamp, model, prompt_tokens, completion_tokens,
 *     cache_read_tokens, cache_write_tokens, cost_usd, cost_source }
 * Returns data shaped like a tokscale JSON response so it can be fed directly
 * into extractUsageFromTokscale, mirroring promaUsage. Unlike Proma (whose
 * transcripts carry no cost), OpenClacky ships cost_usd per event, so no
 * model-price lookup is involved.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLACKY_ROOT = path.join(os.homedir(), '.clacky', 'billing');

function numberValue(value) {
  const n = Number(value);
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

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function jsonlFiles(root) {
  try {
    return fs.readdirSync(root)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => path.join(root, n));
  } catch (_) {
    return [];
  }
}

/**
 * Parse one billing JSONL file into usage rows. Events are keyed by their
 * billing id so a rewritten/duplicated line cannot double-count: the last
 * occurrence wins, matching append-only ledger semantics.
 *
 * @param {string} filePath Absolute path to a YYYY-MM.jsonl file
 * @param {{ sinceMs?: number, includeUndated?: boolean }} options
 * @returns {Array<{ id: string, sessionId: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, messages: number, createdAt: number }>}
 */
function collectClackyFileRows(filePath, options = {}) {
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const byId = new Map();
  let content;
  try {
    content = String(fs.readFileSync(filePath, 'utf8') || '');
  } catch (_) {
    return [];
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue; // skip malformed lines
    }
    if (!obj || typeof obj !== 'object') continue;
    const createdAt = timestampMs(obj.timestamp ?? obj.createdAt ?? obj.created_at);
    if (sinceMs && createdAt && createdAt < sinceMs) continue;
    if (!createdAt && options.includeUndated !== true && sinceMs) continue;
    const id = String(obj.id || `${obj.session_id || ''}:${obj.timestamp || ''}:${obj.prompt_tokens || 0}:${obj.completion_tokens || 0}`).trim();
    if (!id) continue;
    byId.set(id, {
      id,
      sessionId: `clacky:${String(obj.session_id || 'unknown').trim()}`,
      model: String(obj.model || 'unknown').trim(),
      input: numberValue(obj.prompt_tokens ?? obj.input_tokens ?? obj.inputTokens),
      output: numberValue(obj.completion_tokens ?? obj.output_tokens ?? obj.outputTokens),
      cacheRead: numberValue(obj.cache_read_tokens ?? obj.cacheReadTokens ?? obj.cacheReadInputTokens),
      cacheWrite: numberValue(obj.cache_write_tokens ?? obj.cacheWriteTokens ?? obj.cacheCreationInputTokens),
      cost: numberValue(obj.cost_usd ?? obj.costUsd ?? obj.cost),
      messages: 1,
      createdAt
    });
  }
  return [...byId.values()];
}

function collectClackyRows(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [CLACKY_ROOT];
  const rows = [];
  for (const root of roots) {
    for (const filePath of jsonlFiles(root)) {
      rows.push(...collectClackyFileRows(filePath, options));
    }
  }
  return rows;
}

function windowStartMs(windows) {
  return Math.max(0, timestampMs(windows.todayStart), timestampMs(windows.monthStart), timestampMs(windows.allTimeSince));
}

/**
 * Build a tokscale-compatible JSON object from OpenClacky billing data.
 * Cost comes straight from the billing events (cost_usd), never estimated.
 *
 * @param {{ todayStart?: number, monthStart?: number, allTimeSince?: number }} windows
 * @returns {{ entries: Array, totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number, totalMessages: number, totalCost: number }}
 */
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  const allRows = (Array.isArray(options.rows) ? options.rows : collectClackyRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  // Aggregate by session+model. extractUsageFromTokscale() then merges all
  // model rows for the same session into one period.sessions entry.
  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, { sessionId: row.sessionId, model: row.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0 });
    }
    const m = bySessionModel.get(key);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.messages += Number(row.messages || 1);
    m.cost += row.cost;
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  for (const m of bySessionModel.values()) {
    entries.push({
      client: 'clacky',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'clacky',
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

// Return raw graph-compatible contributions so collector.js can merge this
// local adapter with tokscale's graph output through the shared history core.
function buildClackyHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectClackyRows(options);
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
        client: 'clacky',
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
    client.cost += row.cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * Compute local midnight for today and month start, then build
 * tokscale-compatible JSON for today / month / allTime.
 *
 * @param {{ now?: Date | number | string, allTimeSince?: number | string, roots?: string[] }} options
 */
function buildClackyPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectClackyRows(options);
  const buildOptions = { rows };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();

  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  CLACKY_ROOT,
  collectClackyFileRows,
  collectClackyRows,
  buildTokscaleJson,
  buildClackyHistoryGraph,
  buildClackyPeriods
};
