'use strict';

// MiniMax Code Desktop-app usage adapter (parse-local, mirrors qoderCnUsage).
//
// The MiniMax Code Desktop app (Mac/Windows) keeps its session store under
// `~/.minimax/v2/sessions/<yyyy>/<MM>/<dd>/<timestamp>-session_<id>/`. Each
// session dir contains `messages.jsonl` — one JSON object per line, where
// assistant messages carry authoritative per-call usage:
//
//   {"message_id":"...","turn_id":"...","message":{"role":"assistant",...},
//    "api":"anthropic-messages","provider":"minimax","model":"MiniMax-M3",
//    "usage":{"input":20505,"output":412,"cacheRead":4903,"cacheWrite":0,
//             "totalTokens":25820,"cost":{...}},
//    "stopReason":"toolUse","timestamp":1787713165942,"responseId":"..."}
//
// `timestamp` is epoch milliseconds; `usage.totalTokens` equals
// input + output + cacheRead + cacheWrite. The Desktop store is separate from
// tokscale's headless-capture root for the `mcode` CLI, so both can coexist:
// the headless root keeps feeding the tokscale scan, and this adapter merges
// the Desktop app's sessions into the same `mcode` client (usage.js's
// mergePeriods sums the two).
//
// Only `~/.minimax/v2/sessions/**/messages.jsonl` is read. Earlier layout
// (`~/.minimax/sessions/mvs_*`) holds empty workspace stubs, and the v1
// SQLite runtime-state store is the Desktop app's own ledger, not a
// per-call-usage transcript — parsing it would double-count what the
// transcripts already contain.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCODE_DESKTOP_SESSIONS_DIR = path.join('.minimax', 'v2', 'sessions');
const MCODE_DESKTOP_READ_MAX_BYTES = 64 * 1024 * 1024;
const MCODE_DESKTOP_READ_MAX_ROWS = 100_000;
const MCODE_DESKTOP_MESSAGE_FILE = 'messages.jsonl';

function mcodeDesktopSessionsRoot(options = {}) {
  const home = options.homeDir || os.homedir();
  return path.join(home, MCODE_DESKTOP_SESSIONS_DIR);
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(0, parsed) : 0;
}

function timestampMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // Epoch seconds are possible in some legacy exports; session timestamps are
  // epoch milliseconds (13 digits).
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

// Session id from the manifest (v2 layout). Falls back to the dir name so a
// missing manifest still yields a stable, unique session key.
function sessionIdForDir(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const id = String(manifest?.sessionId || '').trim();
    if (id) return id;
  } catch (_) {}
  const base = path.basename(dir);
  return base.replace(/^\d{2}-\d{2}-\d{2}-\d{3}-session_/, '') || base;
}

// Parse one assistant-message line into a usage row. Returns null for user
// messages, tool results, or assistant messages without usage. In the Desktop
// store the usage-bearing fields live inside `message` (role, model, usage,
// timestamp, responseId), unlike the CLI's stream-json where they are peers
// of `message` — both spellings are accepted.
function normalizeMcodeDesktopLine(line, sessionId, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_) {
    return null;
  }
  const message = jsonObject(parsed.message);
  if (!message || message.role !== 'assistant') return null;
  const usage = jsonObject(message.usage) || jsonObject(parsed.usage);
  if (!usage) return null;
  const input = numeric(usage.input);
  const output = numeric(usage.output);
  const cacheRead = numeric(usage.cacheRead);
  const cacheWrite = numeric(usage.cacheWrite);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const model = String(message.model || parsed.model || '').trim();
  if (!model) return null;
  const createdAt = timestampMs(message.timestamp ?? parsed.timestamp);
  const messageId = String(message.message_id || message.responseId || parsed.message_id || parsed.responseId || '');
  const turnId = String(message.turn_id || parsed.turn_id || '');
  return {
    sessionId: `mcode:desktop:${sessionId}`,
    messageId: `mcode:desktop:${sessionId}:${turnId}:${messageId}:${filePath}`,
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    createdAt,
    messages: 1
  };
}

function walkMessageFiles(root, options = {}) {
  const out = [];
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MCODE_DESKTOP_READ_MAX_BYTES;
  const budget = { bytes: 0, exhausted: false };
  const walk = (dir) => {
    if (budget.exhausted) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (budget.exhausted) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === MCODE_DESKTOP_MESSAGE_FILE) {
        out.push(full);
        try {
          budget.bytes += fs.statSync(full).size;
        } catch (_) {}
        if (budget.bytes > maxBytes) {
          // `return` alone only exits this frame; the flag stops every sibling
          // and ancestor recursion from adding more files after the cap.
          budget.exhausted = true;
          return;
        }
      }
    }
  };
  walk(root);
  return out;
}

// Collect usage rows from every session transcript under the Desktop store.
// Mirrors collectQoderCnRows: returns one row per assistant message, deduped by
// messageId, bounded by the same byte/row budgets.
function collectMcodeDesktopRows(options = {}) {
  const root = mcodeDesktopSessionsRoot(options);
  if (!fs.existsSync(root)) return [];
  const sinceMs = Math.max(0, Number(options.sinceMs || 0));
  const maxRows = Number.isFinite(options.maxRows) ? options.maxRows : MCODE_DESKTOP_READ_MAX_ROWS;
  const rows = [];
  // One budget shared across every transcript: each file may read only the
  // remaining allowance, not the full per-file cap, so a deep session tree
  // cannot exceed the intended total.
  let budget = Number.isFinite(options.maxBytes) ? options.maxBytes : MCODE_DESKTOP_READ_MAX_BYTES;
  for (const file of walkMessageFiles(root, options)) {
    if (budget <= 0) break;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch (_) {
      continue;
    }
    // Synchronous line read with a size budget: the transcripts are small (the
    // largest active session observed is ~1.3 MB), and a bounded read keeps a
    // pathological store from stalling a tick.
    let content;
    try {
      const stat = fs.fstatSync(fd);
      const bytes = Math.min(stat.size, budget);
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, 0);
      content = buffer.toString('utf8');
    } catch (_) {
      try { fs.closeSync(fd); } catch (_) {}
      continue;
    }
    try { fs.closeSync(fd); } catch (_) {}
    const consumed = Buffer.byteLength(content, 'utf8');
    budget -= consumed;
    const sessionId = sessionIdForDir(path.dirname(file));
    for (const line of content.split('\n')) {
      const row = normalizeMcodeDesktopLine(line, sessionId, file);
      if (row && (!sinceMs || row.createdAt >= sinceMs)) rows.push(row);
    }
    if (rows.length >= maxRows) break;
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.messageId, row);
  return [...unique.values()];
}

function estimatedMcodeDesktopRowCost(row, pricingByModel) {
  const pricing = pricingByModel?.[String(row.model || '').trim().toLowerCase()];
  if (!pricing || typeof pricing !== 'object') return null;
  const inputRate = Number(pricing.inputCostPerToken ?? pricing.input_cost_per_token);
  const outputRate = Number(pricing.outputCostPerToken ?? pricing.output_cost_per_token);
  const cacheReadRate = Number(pricing.cacheReadCostPerToken ?? pricing.cache_read_cost_per_token ?? pricing.inputCostPerToken);
  const cacheWriteRate = Number(pricing.cacheWriteCostPerToken ?? pricing.cache_write_cost_per_token ?? 0);
  if (![inputRate, outputRate, cacheReadRate, cacheWriteRate].some(Number.isFinite)) return null;
  return (Number.isFinite(inputRate) ? row.input * inputRate : 0)
    + (Number.isFinite(outputRate) ? row.output * outputRate : 0)
    + (Number.isFinite(cacheReadRate) ? row.cacheRead * cacheReadRate : 0)
    + (Number.isFinite(cacheWriteRate) ? row.cacheWrite * cacheWriteRate : 0);
}

function buildMcodeDesktopTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0 });
    }
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimatedMcodeDesktopRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: 'mcode',
    mergedClients: null,
    sessionId: row.sessionId,
    model: row.model,
    provider: 'minimax-desktop',
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: 0,
    messageCount: row.messages,
    cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: '',
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

function buildMcodeDesktopPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildMcodeDesktopTokscaleJson(todayStart, rows, pricingByModel),
    month: buildMcodeDesktopTokscaleJson(monthStart, rows, pricingByModel),
    allTime: buildMcodeDesktopTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildMcodeDesktopHistoryGraph(options = {}) {
  const days = new Map();
  for (const row of options.rows || []) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client: 'mcode', modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimatedMcodeDesktopRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

module.exports = {
  MCODE_DESKTOP_SESSIONS_DIR,
  buildMcodeDesktopHistoryGraph,
  buildMcodeDesktopPeriods,
  collectMcodeDesktopRows,
  mcodeDesktopSessionsRoot,
  normalizeMcodeDesktopLine,
  sessionIdForDir,
  walkMessageFiles
};
