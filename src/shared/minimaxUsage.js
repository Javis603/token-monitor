'use strict';

/**
 * MiniMax session usage parser.
 *
 * Reads session transcripts from ~/.minimax/v2/sessions/<YYYY>/<MM>/<DD>/
 * <timestamp>-session_<id>/messages.jsonl and aggregates the token usage the
 * CLI records on every assistant message. Returns data shaped like a tokscale
 * JSON response so it can be fed straight into extractUsageFromTokscale or
 * merged alongside tokscale results, matching promaUsage.js and qoderCnUsage.js.
 *
 * Tokscale has no MiniMax reader, so without this the usage is invisible even
 * though the CLI records it in full.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const MINIMAX_ROOT = path.join(os.homedir(), '.minimax', 'v2', 'sessions');

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds-vs-milliseconds is ambiguous only below year 2001 in ms terms,
    // which no session transcript can predate.
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function rowTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
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
  for (const [tokens, unit] of components) {
    const rate = Number(unit);
    if (!Number.isFinite(rate)) continue;
    cost += numberValue(tokens) * rate;
  }
  return cost;
}

function sourceNamespace(root) {
  return createHash('sha256').update(path.normalize(String(root || ''))).digest('hex').slice(0, 12);
}

/**
 * MiniMax stores one directory per session, named
 * "<HH-mm-ss-SSS>-session_<opaque id>", holding a single messages.jsonl.
 * The directory name is the only stable session identity available.
 */
function collectSessionRows(filePath, options = {}) {
  const sessionDir = path.basename(path.dirname(filePath));
  const sourceId = options.sourceId || sourceNamespace(path.dirname(path.dirname(filePath)));
  const sessionId = `${sessionDir}@${sourceId}`;
  const content = String(fs.readFileSync(filePath, 'utf8') || '');
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const msgGroups = new Map(); // message_id -> [{ usage, model, createdAt }]

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const msg = obj?.message;
      // MiniMax has no top-level `type`; the role lives on the message, and
      // toolResult/user records carry no usage at all.
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
      const msgId = obj.message_id || msg.id;
      if (!msgId) continue;

      const model = msg.model || 'unknown';
      const u = msg.usage;
      // MiniMax already reports normalised camelCase counters; the snake_case
      // fallbacks keep this working if it ever adopts the Anthropic wire names.
      const input = numberValue(u.input ?? u.input_tokens ?? u.inputTokens);
      const output = numberValue(u.output ?? u.output_tokens ?? u.outputTokens);
      const cacheRead = numberValue(u.cacheRead ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens);
      const cacheWrite = numberValue(u.cacheWrite ?? u.cache_creation_input_tokens ?? u.cacheCreationInputTokens);
      const createdAt = timestampMs(msg.timestamp || obj.timestamp);

      if (!msgGroups.has(msgId)) msgGroups.set(msgId, []);
      msgGroups.get(msgId).push({ sessionId, model, input, output, cacheRead, cacheWrite, createdAt });
    } catch (_) {
      // skip malformed lines
    }
  }

  // One message id can appear more than once when a reply is streamed in parts;
  // keep the largest total rather than summing the partials.
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

// Sessions are nested under year/month/day directories, so a flat readdir is
// not enough. Depth is bounded by that layout; guard anyway against loops.
function messageFiles(root, depth = 0) {
  if (depth > 5) return [];
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const found = [];
  for (const entry of dirents) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...messageFiles(full, depth + 1));
    else if (entry.name === 'messages.jsonl') found.push(full);
  }
  return found;
}

function collectMinimaxRows(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [MINIMAX_ROOT];
  const rows = [];
  for (const root of roots) {
    const sourceId = sourceNamespace(root);
    for (const filePath of messageFiles(root)) {
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

function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const entries = [];
  let allInput = 0, allOutput = 0, allCacheRead = 0, allCacheWrite = 0, allMessages = 0, allCost = 0;

  // Filter per message, not per aggregated model: a session that started before
  // midnight still has messages that belong to today.
  const allRows = (Array.isArray(options.rows) ? options.rows : collectMinimaxRows(options))
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}::${row.model}`;
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
      client: 'minimax',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'minimax',
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

function buildMinimaxHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : collectMinimaxRows(options);
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
        client: 'minimax',
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

function buildMinimaxPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : collectMinimaxRows(options);
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
  MINIMAX_ROOT,
  collectSessionRows,
  collectMinimaxRows,
  estimatedRowCost,
  buildTokscaleJson,
  buildMinimaxHistoryGraph,
  buildMinimaxPeriods
};
