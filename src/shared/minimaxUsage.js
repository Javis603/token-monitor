'use strict';

/**
 * MiniMax Code (Mavis) local usage parser.
 *
 * Reads token usage from the MiniMax data root (default ~/.minimax):
 *   - sqlite.db → token_usage
 *   - v2/sqlite/runtime-state.sqlite → local_runtime_token_usage
 *
 * Returns tokscale-shaped JSON so collector can extractUsageFromTokscale /
 * mergePeriods the same way Proma is handled. Client id is always `minimax`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  numberValue,
  timestampMs,
  normalizedModelId,
  localDateKey,
  windowStartMs,
  localPeriodBounds
} = require('./localUsageHelpers');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const CLIENT_ID = 'minimax';

function resolveMinimaxHome(options = {}) {
  const env = options.env || process.env;
  const explicit = String(options.homeDir || env.MINIMAX_HOME || env.MAVIS_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.minimax');
}

function legacyDbPath(homeDir) {
  return path.join(homeDir, 'sqlite.db');
}

function runtimeDbPath(homeDir) {
  return path.join(homeDir, 'v2', 'sqlite', 'runtime-state.sqlite');
}

function openReadOnlyDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* ignore */ }
  return db;
}

function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name);
    return Boolean(row && row.ok);
  } catch (_) {
    return false;
  }
}

/**
 * Map a raw DB row (either store) into a normalized usage record.
 * Pure — no I/O. Accepts either snake_case column names or already-normalized keys.
 *
 * Important: a single turn_id can own many rows (multi-step model calls inside
 * one agent turn). Those must SUM — never collapse to one row per turn_id.
 * Cross-store overlap is handled separately in mergeUsageStores / dedupeUsageRows.
 */
function normalizeUsageRow(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = String(raw.session_id || raw.sessionId || '').trim() || 'unknown';
  const turnId = String(raw.turn_id || raw.turnId || '').trim();
  const model = normalizedModelId(raw.model);
  const createdAt = timestampMs(raw.ts ?? raw.createdAt ?? raw.created_at);
  const input = numberValue(raw.input_tokens ?? raw.input);
  const output = numberValue(raw.output_tokens ?? raw.output);
  const reasoning = numberValue(raw.reasoning_tokens ?? raw.reasoning);
  const cacheRead = numberValue(raw.cache_read_tokens ?? raw.cacheRead);
  const cacheWrite = numberValue(raw.cache_write_tokens ?? raw.cacheWrite);
  const cost = numberValue(raw.cost_usd ?? raw.cost);
  // Prefer explicit total from raw JSON when present; otherwise sum additive components.
  // reasoning is informational (often subset of output) — do not add into total.
  let total = numberValue(raw.total_tokens ?? raw.totalTokens);
  if (!total) total = input + output + cacheRead + cacheWrite;
  const source = String(raw._source || raw.source || '');
  const rowId = raw.id != null && raw.id !== '' ? String(raw.id) : '';
  // Per-step identity (never turn_id alone — multi-step turns must all survive).
  const rowKey = rowId
    ? `${source || 'row'}:id:${rowId}`
    : `${source || 'row'}|${sessionId}|${createdAt}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}|${reasoning}|${turnId}|${cost}`;
  // Least privilege: do not carry agent_name / framework_type / raw. They are
  // unused on the wire and not needed for token aggregation.
  return {
    sessionId,
    turnId,
    model,
    createdAt,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
    cost,
    messages: 1,
    rowKey,
    // Back-compat alias used by older tests / call sites.
    dedupeKey: rowKey,
    source
  };
}

/**
 * Merge usage rows from one or both MiniMax stores.
 *
 * Rules:
 * 1. Within a store, keep every distinct step (same turn_id, different tokens/ts/id → SUM).
 * 2. Cross-store: if a non-empty turn_id appears in any legacy row, drop ALL runtime
 *    rows with that turn_id (legacy wins after migration). Do not collapse multi-step
 *    legacy rows for that turn.
 * 3. Exact rowKey duplicates (true clones) are kept once.
 */
function dedupeUsageRows(rows) {
  // Always re-run normalizeUsageRow so injected/pre-built rows get canonical
  // source + lowercased model ids (legacy-wins and aggregation stay correct).
  const normalized = [];
  for (const row of rows || []) {
    const n = normalizeUsageRow(row);
    if (n) normalized.push(n);
  }

  const legacyTurnIds = new Set();
  for (const row of normalized) {
    if (row.source === 'legacy' && row.turnId) legacyTurnIds.add(row.turnId);
  }

  const seenRowKeys = new Set();
  const out = [];
  for (const row of normalized) {
    if (row.source === 'runtime' && row.turnId && legacyTurnIds.has(row.turnId)) continue;
    if (seenRowKeys.has(row.rowKey)) continue;
    seenRowKeys.add(row.rowKey);
    out.push(row);
  }
  return out;
}

function queryTokenUsageTable(db, tableName, sourceTag) {
  if (!tableExists(db, tableName)) return [];
  // Only token/accounting columns — no agent_name, framework_type, or raw payload.
  // Prefer selecting id when present so multi-step turns stay distinct even if
  // token counters collide. Fall back without id for very old schemas.
  const withId = `SELECT id, session_id, turn_id, model, ts,
                         input_tokens, output_tokens, reasoning_tokens,
                         cache_read_tokens, cache_write_tokens, cost_usd
                  FROM ${tableName}`;
  const withoutId = `SELECT session_id, turn_id, model, ts,
                            input_tokens, output_tokens, reasoning_tokens,
                            cache_read_tokens, cache_write_tokens, cost_usd
                     FROM ${tableName}`;
  let rows;
  try {
    rows = db.prepare(withId).all();
  } catch (_) {
    try {
      rows = db.prepare(withoutId).all();
    } catch (__) {
      return [];
    }
  }
  return (rows || []).map((row) => normalizeUsageRow({ ...row, _source: sourceTag })).filter(Boolean);
}

function readRowsFromDbPath(dbPath, tableName, sourceTag, sqliteMod) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  if (!sqliteMod) return [];
  let db;
  try {
    db = openReadOnlyDb(dbPath, sqliteMod);
    return queryTokenUsageTable(db, tableName, sourceTag);
  } catch (_) {
    return [];
  } finally {
    if (db) {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Collect normalized, deduped usage rows from the MiniMax data root.
 * Injectable seams: options.rows (skip I/O), options.sqlite, options.homeDir/env.
 */
function collectMinimaxRows(options = {}) {
  if (Array.isArray(options.rows)) {
    return dedupeUsageRows(options.rows);
  }
  const sqliteMod = options.sqlite !== undefined ? options.sqlite : sqlite;
  if (!sqliteMod) return [];
  const homeDir = resolveMinimaxHome(options);
  const legacyRows = readRowsFromDbPath(legacyDbPath(homeDir), 'token_usage', 'legacy', sqliteMod);
  const runtimeRows = readRowsFromDbPath(runtimeDbPath(homeDir), 'local_runtime_token_usage', 'runtime', sqliteMod);
  // Within each store keep multi-step rows; cross-store legacy wins by turn_id.
  return dedupeUsageRows([...legacyRows, ...runtimeRows]);
}

/**
 * Build a tokscale-compatible JSON object from MiniMax usage rows.
 */
function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const allRows = collectMinimaxRows(options).filter((row) => {
    if (!sinceMs) return true;
    if (!row.createdAt) return options.includeUndated === true;
    return row.createdAt >= sinceMs;
  });

  const bySessionModel = new Map();
  for (const row of allRows) {
    const key = `${row.sessionId || 'unknown'}\u0000${row.model}`;
    if (!bySessionModel.has(key)) {
      bySessionModel.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0
      });
    }
    const m = bySessionModel.get(key);
    m.input += row.input;
    m.output += row.output;
    m.cacheRead += row.cacheRead;
    m.cacheWrite += row.cacheWrite;
    m.reasoning += row.reasoning;
    m.messages += Number(row.messages || 1);
    m.cost += numberValue(row.cost);
    if (row.createdAt && (!m.startedAt || row.createdAt < m.startedAt)) m.startedAt = row.createdAt;
    if (row.createdAt > m.lastUsedAt) m.lastUsedAt = row.createdAt;
  }

  const entries = [];
  let allInput = 0;
  let allOutput = 0;
  let allCacheRead = 0;
  let allCacheWrite = 0;
  let allMessages = 0;
  let allCost = 0;

  for (const m of bySessionModel.values()) {
    entries.push({
      client: CLIENT_ID,
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: CLIENT_ID,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      reasoning: m.reasoning,
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

function buildMinimaxHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = collectMinimaxRows(options);
  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = normalizedModelId(row.model);
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: CLIENT_ID,
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
    client.cost += numberValue(row.cost);
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function buildMinimaxPeriods(options = {}) {
  const { todayStart, monthStart } = localPeriodBounds(options.now);
  const rows = Array.isArray(options.rows) ? dedupeUsageRows(options.rows) : collectMinimaxRows(options);
  const buildOptions = { rows, sqlite: options.sqlite, homeDir: options.homeDir, env: options.env };
  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

module.exports = {
  CLIENT_ID,
  resolveMinimaxHome,
  legacyDbPath,
  runtimeDbPath,
  normalizeUsageRow,
  dedupeUsageRows,
  collectMinimaxRows,
  buildTokscaleJson,
  buildMinimaxHistoryGraph,
  buildMinimaxPeriods
};
