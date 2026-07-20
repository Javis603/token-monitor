'use strict';

/**
 * Trae Work (TRAE SOLO CN / Trae CN) usage parser.
 *
 * Reads token usage from the SQLCipher-encrypted local database at:
 *   %APPDATA%/TRAE SOLO CN/ModularData/ai-agent/database.db  (Windows)
 *   ~/Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/database.db  (macOS)
 *   ~/.config/TRAE SOLO CN/ModularData/ai-agent/database.db  (Linux)
 *
 * The database is SQLCipher 4 encrypted. The raw key (64-char hex) must be
 * provided via one of:
 *   1. TOKEN_MONITOR_TRAE_KEY environment variable
 *   2. A trae-key.json file in the shared data dir ({ "key": "<64hex>" })
 *   3. The scripts/extract-trae-key.py helper (Windows, writes trae-key.json)
 *
 * Token data lives in the `history_v2` table:
 *   - token_usage: per-turn output token count (plain integer)
 *   - messages JSON → raw_messages[].extra_info.model: model identifier
 *   - messages JSON → raw_messages[].extra_info.input_token: input tokens
 *   - session_id: links to chat_session for titles
 *   - created_at: unix timestamp (seconds)
 *
 * Returns data shaped like a tokscale JSON response so it can be fed
 * directly into extractUsageFromTokscale or merged alongside tokscale results.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

// ---------------------------------------------------------------------------
// Database path resolution
// ---------------------------------------------------------------------------

function traeDataRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'TRAE SOLO CN', 'ModularData', 'ai-agent'));
    roots.push(path.join(appData, 'Trae CN', 'ModularData', 'ai-agent'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'TRAE SOLO CN', 'ModularData', 'ai-agent'));
    roots.push(path.join(home, 'Library', 'Application Support', 'Trae CN', 'ModularData', 'ai-agent'));
  } else {
    roots.push(path.join(home, '.config', 'TRAE SOLO CN', 'ModularData', 'ai-agent'));
    roots.push(path.join(home, '.config', 'Trae CN', 'ModularData', 'ai-agent'));
  }
  return roots;
}

function traeDbPath() {
  for (const root of traeDataRoots()) {
    const dbFile = path.join(root, 'database.db');
    try {
      if (fs.existsSync(dbFile) && fs.statSync(dbFile).isFile()) return dbFile;
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function resolveTraeKey(sharedDataDir) {
  // 1. Environment variable
  const envKey = (process.env.TOKEN_MONITOR_TRAE_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(envKey)) return envKey.toLowerCase();

  // 2. trae-key.json in shared data dir
  if (sharedDataDir) {
    try {
      const keyFile = path.join(sharedDataDir, 'trae-key.json');
      const data = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      const key = String(data.key || data.enc_key || '').trim();
      if (/^[0-9a-fA-F]{64}$/.test(key)) return key.toLowerCase();
    } catch (_) {}
  }

  // 3. trae-key.json next to the database
  const dbPath = traeDbPath();
  if (dbPath) {
    try {
      const keyFile = path.join(path.dirname(dbPath), 'trae-key.json');
      const data = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      const key = String(data.key || data.enc_key || '').trim();
      if (/^[0-9a-fA-F]{64}$/.test(key)) return key.toLowerCase();
    } catch (_) {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Database reading (via sqlcipher CLI or better-sqlite3)
// ---------------------------------------------------------------------------

function queryViaSqlcipherCli(dbPath, key, sql) {
  const { execFileSync } = require('node:child_process');
  const commands = [
    `PRAGMA key = "x'${key}'";`,
    'PRAGMA cipher_compatibility = 4;',
    sql
  ].join('\n');
  try {
    const stdout = execFileSync('sqlcipher', [dbPath, commands], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  } catch (_) {
    return null;
  }
}

function queryViaBetterSqlite(dbPath, key, sql) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma(`key = "x'${key}'"`);
    db.pragma('cipher_compatibility = 4');
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (_) {
    return null;
  }
}

/**
 * Query history_v2 rows from the Trae database.
 * Returns an array of { token_usage, messages, session_id, created_at } or null.
 */
function queryHistoryRows(dbPath, key, sinceTimestamp) {
  const sinceClause = sinceTimestamp ? `AND created_at >= ${sinceTimestamp}` : '';
  const sql = `SELECT token_usage, messages, session_id, created_at FROM history_v2 WHERE token_usage IS NOT NULL AND token_usage != '' AND token_usage != '0' ${sinceClause}`;

  // Try better-sqlite3 first (programmatic, faster for large result sets)
  const rows = queryViaBetterSqlite(dbPath, key, sql);
  if (rows) return rows;

  // Fallback: sqlcipher CLI (parse CSV-like output)
  const csvSql = `.mode json\n${sql};`;
  const output = queryViaSqlcipherCli(dbPath, key, csvSql);
  if (output) {
    try {
      return JSON.parse(output);
    } catch (_) {
      // Try line-by-line JSON
      return output.trim().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_e) { return null; }
      }).filter(Boolean);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function extractModelFromMessages(messagesRaw) {
  if (!messagesRaw) return { model: 'unknown', inputToken: 0 };
  try {
    const parsed = typeof messagesRaw === 'string' ? JSON.parse(messagesRaw) : messagesRaw;
    const rawMsgs = parsed?.raw_messages || parsed?.messages || [];
    for (const msg of rawMsgs) {
      if (msg && msg.role === 'assistant' && msg.extra_info) {
        let extra = msg.extra_info;
        if (typeof extra === 'string') {
          try { extra = JSON.parse(extra); } catch (_) { continue; }
        }
        if (extra && typeof extra === 'object' && extra.model) {
          return { model: String(extra.model), inputToken: numberValue(extra.input_token) };
        }
      }
    }
  } catch (_) {}
  return { model: 'unknown', inputToken: 0 };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Collect all usage rows from the Trae database.
 * @param {{ sharedDataDir?: string, dbPath?: string, key?: string }} options
 * @returns {Array<{ sessionId: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, messages: number, createdAt: number }>}
 */
function collectTraeRows(options = {}) {
  const dbPath = options.dbPath || traeDbPath();
  if (!dbPath) return [];

  const key = options.key || resolveTraeKey(options.sharedDataDir);
  if (!key) return [];

  const rows = queryHistoryRows(dbPath, key, 0);
  if (!rows || !Array.isArray(rows)) return [];

  const result = [];
  for (const row of rows) {
    const output = numberValue(row.token_usage);
    if (!output) continue;

    const { model, inputToken } = extractModelFromMessages(row.messages);
    const createdAt = numberValue(row.created_at) * 1000; // seconds → ms
    const sessionId = String(row.session_id || 'unknown');

    result.push({
      sessionId,
      model,
      input: inputToken,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      messages: 1,
      createdAt
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tokscale-compatible output
// ---------------------------------------------------------------------------

function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = Math.max(
    0,
    Number(windows.todayStart || 0),
    Number(windows.monthStart || 0),
    Number(windows.allTimeSince || 0)
  );
  const sinceTimestamp = sinceMs ? Math.floor(sinceMs / 1000) : 0;

  const dbPath = options.dbPath || traeDbPath();
  if (!dbPath) return emptyTokscaleJson();

  const key = options.key || resolveTraeKey(options.sharedDataDir);
  if (!key) return emptyTokscaleJson();

  const rows = queryHistoryRows(dbPath, key, sinceTimestamp);
  if (!rows || !Array.isArray(rows)) return emptyTokscaleJson();

  // Aggregate by session + model
  const bySessionModel = new Map();
  let allInput = 0, allOutput = 0, allMessages = 0;

  for (const row of rows) {
    const output = numberValue(row.token_usage);
    if (!output) continue;

    const { model, inputToken } = extractModelFromMessages(row.messages);
    const createdAt = numberValue(row.created_at) * 1000;
    const sessionId = String(row.session_id || 'unknown');
    const mapKey = `${sessionId}\u0000${model}`;

    if (!bySessionModel.has(mapKey)) {
      bySessionModel.set(mapKey, {
        sessionId, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        messages: 0, cost: 0, startedAt: 0, lastUsedAt: 0
      });
    }
    const m = bySessionModel.get(mapKey);
    m.input += inputToken;
    m.output += output;
    m.messages += 1;
    if (createdAt && (!m.startedAt || createdAt < m.startedAt)) m.startedAt = createdAt;
    if (createdAt > m.lastUsedAt) m.lastUsedAt = createdAt;

    allInput += inputToken;
    allOutput += output;
    allMessages += 1;
  }

  const entries = [];
  for (const m of bySessionModel.values()) {
    entries.push({
      client: 'trae',
      mergedClients: null,
      sessionId: m.sessionId,
      model: m.model,
      provider: 'trae',
      input: m.input,
      output: m.output,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      messageCount: m.messages,
      cost: 0,
      startedAt: m.startedAt ? new Date(m.startedAt).toISOString() : '',
      lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : '',
      performance: null
    });
  }

  return {
    groupBy: 'client,session,model',
    entries,
    totalInput: allInput,
    totalOutput: allOutput,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: allMessages,
    totalCost: 0,
    processingTimeMs: 0
  };
}

function emptyTokscaleJson() {
  return {
    groupBy: 'client,session,model',
    entries: [],
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost: 0,
    processingTimeMs: 0
  };
}

/**
 * Build today / month / allTime periods from the Trae database.
 */
function buildTraePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  const allTimeSince = options.allTimeSince ? new Date(options.allTimeSince).getTime() : 0;

  return {
    today: buildTokscaleJson({ todayStart }, options),
    month: buildTokscaleJson({ monthStart }, options),
    allTime: buildTokscaleJson({ allTimeSince }, options)
  };
}

// ---------------------------------------------------------------------------
// History graph (for trends dashboard)
// ---------------------------------------------------------------------------

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildTraeHistoryGraph(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : collectTraeRows(options);
  const byDate = new Map();

  for (const row of rows) {
    const date = row.createdAt ? localDateKey(row.createdAt) : '';
    if (!date) continue;
    let day = byDate.get(date);
    if (!day) {
      day = { date, clients: [] };
      byDate.set(date, day);
    }
    const modelId = String(row.model || 'unknown').trim().toLowerCase() || 'unknown';
    let client = day.clients.find((entry) => entry.modelId === modelId);
    if (!client) {
      client = {
        client: 'trae',
        modelId,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        messages: 0
      };
      day.clients.push(client);
    }
    client.tokens.input += row.input;
    client.tokens.output += row.output;
    client.messages += 1;
  }

  return { contributions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

function isTraeAvailable(options = {}) {
  const dbPath = options.dbPath || traeDbPath();
  if (!dbPath) return { available: false, reason: 'database not found' };
  const key = options.key || resolveTraeKey(options.sharedDataDir);
  if (!key) return { available: false, reason: 'key not configured' };
  return { available: true, dbPath };
}

module.exports = {
  traeDataRoots,
  traeDbPath,
  resolveTraeKey,
  collectTraeRows,
  buildTokscaleJson,
  buildTraePeriods,
  buildTraeHistoryGraph,
  isTraeAvailable
};
