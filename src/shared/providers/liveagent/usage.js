'use strict';

/**
 * LiveAgent usage parser.
 *
 * LiveAgent persists chat history in a SQLite database:
 *   ~/.liveagent/chat-history.sqlite3
 * The chatHistorySegment table carries `messages_json`, a JSON array of chat
 * messages where assistant replies include a Claude-style `usage` object
 * (input / output / cacheRead / cacheWrite / totalTokens) plus `model` and
 * a millisecond `timestamp`. Costs are estimated from the model-price catalog
 * rather than trusted from the transcript, mirroring the other local adapters.
 *
 * Reads are done via node:sqlite (Node >= 22.15), so no sqlite3 CLI
 * is required. Returns data shaped like a tokscale JSON response so it
 * can be fed directly into extractUsageFromTokscale.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const LIVEAGENT_ROOT = path.join(os.homedir(), '.liveagent');
const LIVEAGENT_DB_SUFFIX = 'chat-history.sqlite3';
const LIVEAGENT_READ_BUSY_TIMEOUT_MS = 250;

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizedModelId(value) {
  // Model ids can carry display prefixes such as `[free]claude-opus-5` or
  // brackets like `[]glm-5.3`. Strip the bracketed prefix so pricing
  // lookup and the Models view see the canonical vendor id.
  return String(value || '')
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .toLowerCase() || 'unknown';
}

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

function sourceId(dbPath) {
  return createHash('sha256').update(path.normalize(String(dbPath || ''))).digest('hex').slice(0, 12);
}

function liveAgentDataPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const explicitDb = String(env.TOKEN_MONITOR_LIVEAGENT_DB_PATH || '').trim();
  return {
    dbPaths: explicitDb ? [path.resolve(explicitDb)] : [path.join(home, '.liveagent', LIVEAGENT_DB_SUFFIX)]
  };
}

function jsonParseArray(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeLiveAgentRow(dbRow, source) {
  const conversation = String(dbRow.conversation_id || dbRow.conversationId || 'unknown');
  const segment = String(dbRow.segment_id || dbRow.segmentId || '');
  const messages = jsonParseArray(dbRow.messages_json || dbRow.messagesJson);
  const out = [];
  for (const [index, msg] of messages.entries()) {
    if (!msg || typeof msg !== 'object') continue;
    if (String(msg.role || '').trim() !== 'assistant') continue;
    const usage = msg.usage;
    if (!usage) continue;
    const input = numberValue(usage.input);
    const output = numberValue(usage.output);
    const cacheRead = numberValue(usage.cacheRead);
    const cacheWrite = numberValue(usage.cacheWrite);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const model = normalizedModelId(msg.model || 'unknown');
    const messageId = String(msg.id || `${conversation}:${segment}:${index}`);
    out.push({
      sessionId: `liveagent:${source}:${conversation}`,
      messageId: `liveagent:${source}:${messageId}`,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      createdAt: timestampMs(msg.timestamp || msg.created_at || msg.createdAt || 0),
      messages: 1
    });
  }
  return out;
}

function collectLiveAgentRows(options = {}) {
  const paths = liveAgentDataPaths(options);
  const dbPaths = Array.isArray(options.dbPaths) ? options.dbPaths : paths.dbPaths;
  const rows = [];
  for (const dbPath of dbPaths) {
    if (!options.dbPaths && !fs.existsSync(dbPath)) continue;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${LIVEAGENT_READ_BUSY_TIMEOUT_MS}`);
      const sinceMs = options.sinceMs;
      const sql = sinceMs
        ? 'SELECT conversation_id,segment_id,messages_json FROM chatHistorySegment WHERE updated_at >= ? ORDER BY updated_at'
        : 'SELECT conversation_id,segment_id,messages_json FROM chatHistorySegment ORDER BY updated_at';
      const statement = db.prepare(sql);
      const segRows = sinceMs ? statement.iterate(sinceMs) : statement.iterate();
      const source = sourceId(dbPath);
      for (const segRow of segRows) rows.push(...normalizeLiveAgentRow(segRow, source));
    } finally {
      db.close();
    }
  }
  return rows;
}

function buildTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.messageId || row.sessionId}\u0000${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = `${row.sessionId}\u0000${row.model}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        sessionId: row.sessionId,
        model: row.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        messages: 0,
        startedAt: 0,
        lastUsedAt: 0,
        cost: 0
      });
    }
    const group = grouped.get(groupKey);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += Number(row.messages || 1);
    const cost = estimatedRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }
  const entries = [...grouped.values()].map((row) => ({
    client: 'liveagent',
    mergedClients: null,
    sessionId: row.sessionId,
    model: row.model,
    provider: 'liveagent',
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: 0,
    messageCount: row.messages,
    cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: sum('input'),
    totalOutput: sum('output'),
    totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'),
    totalMessages: sum('messageCount'),
    totalCost: sum('cost'),
    processingTimeMs: 0
  };
}

function buildLiveAgentPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectLiveAgentRows(options);
  const pricingByModel = options.pricingByModel;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTokscaleJson(todayStart, rows, pricingByModel),
    month: buildTokscaleJson(monthStart, rows, pricingByModel),
    allTime: buildTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildLiveAgentHistoryGraph(options = {}) {
  const days = new Map();
  // Same message identity as buildTokscaleJson: repeated rows (streamed
  // segment rewrites, overlapping custom + default reads) must count once.
  const seen = new Set();
  for (const row of (Array.isArray(options.rows) ? options.rows : collectLiveAgentRows(options))) {
    const dedupeKey = `${row.messageId || row.sessionId}\u0000${row.model}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = {
        client: 'liveagent',
        modelId: row.model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(model);
    }
    const cost = estimatedRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += Number(row.messages || 1);
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  LIVEAGENT_ROOT,
  collectLiveAgentRows,
  liveAgentDataPaths,
  estimatedRowCost,
  normalizedModelId,
  buildTokscaleJson,
  buildLiveAgentHistoryGraph,
  buildLiveAgentPeriods
};