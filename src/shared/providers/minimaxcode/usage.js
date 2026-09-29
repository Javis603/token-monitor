'use strict';

// MiniMax Code desktop and CLI share one local usage ledger. Tokscale's
// `mcode` client only reads a headless capture directory, so this adapter
// reads `local_runtime_token_usage` directly and stays out of `--client`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { projectIdentity } = require('../../sessionMetadata');

const CLIENT_ID = 'minimaxcode';
const DATABASE_RELATIVE = path.join('v2', 'sqlite', 'runtime-state.sqlite');
const MAX_USAGE_ROWS = 200_000;
const MAX_RESULT_CHARS = 32 * 1024 * 1024;
const BUSY_TIMEOUT_MS = 250;
const CLI_TIMEOUT_MS = 10_000;

const USAGE_COLUMNS = [
  'session_id',
  'turn_id',
  'model',
  'ts',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens'
];

const USAGE_SQL = `SELECT ${USAGE_COLUMNS.join(', ')} FROM local_runtime_token_usage`;
const SESSION_SQL = 'SELECT session_id, workspace_dir, extra_data_json FROM local_runtime_sessions';
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM local_runtime_token_usage';

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function canonicalPath(file) {
  try { return fs.realpathSync.native(file); } catch (_) { return path.resolve(file); }
}

// Explicit env wins even when that directory is missing: falling through would
// read a different install. Otherwise the first home directory that exists.
function resolveMiniMaxCodeRoot(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const explicit = nonBlank(env.MINIMAX_DATA_DIR) || nonBlank(env.MAVIS_DATA_DIR);
  if (explicit) return { root: explicit, explicit: true };
  for (const name of ['.minimax', '.mavis']) {
    const dir = path.join(home, name);
    if (dirExists(dir)) return { root: dir, explicit: false };
  }
  return { root: path.join(home, '.minimax'), explicit: false, absent: true };
}

function minimaxCodeDatabaseLocation(options = {}) {
  const resolved = resolveMiniMaxCodeRoot(options);
  return {
    ...resolved,
    databasePath: path.join(resolved.root, DATABASE_RELATIVE)
  };
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function effectiveModel(extra) {
  if (!extra || typeof extra !== 'string') return '';
  try {
    const parsed = JSON.parse(extra);
    const model = parsed?.effectiveModel;
    return typeof model === 'string' ? model.trim() : '';
  } catch (_) {
    return '';
  }
}

function rowsFromUsage(usageRows, sessionRows) {
  const sessions = new Map();
  for (const session of sessionRows || []) {
    const id = String(session?.session_id || '').trim();
    if (id) sessions.set(id, session);
  }
  const rows = [];
  for (const raw of usageRows || []) {
    const sessionId = String(raw?.session_id || '').trim() || 'unknown';
    const session = sessions.get(sessionId);
    const ownModel = String(raw?.model || '').trim();
    const model = ownModel || effectiveModel(session?.extra_data_json) || 'unknown';
    const workspace = String(session?.workspace_dir || '').trim();
    const project = workspace ? projectIdentity(workspace) : {};
    const input = Math.max(0, Math.round(numberValue(raw?.input_tokens)));
    const output = Math.max(0, Math.round(numberValue(raw?.output_tokens)));
    const cacheRead = Math.max(0, Math.round(numberValue(raw?.cache_read_tokens)));
    const cacheWrite = Math.max(0, Math.round(numberValue(raw?.cache_write_tokens)));
    const reasoning = Math.max(0, Math.round(numberValue(raw?.reasoning_tokens)));
    rows.push({
      sessionId,
      turnId: String(raw?.turn_id || '').trim(),
      model,
      createdAt: timestampMs(raw?.ts),
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      projectId: project.projectId || '',
      projectLabel: project.projectLabel || ''
    });
  }
  return rows;
}

function missingSessionStore(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no such table') && message.includes('local_runtime_sessions');
}

function queryLimitFailure(count, maxRows = MAX_USAGE_ROWS) {
  return Number(count) > maxRows;
}

function closeQuietly(database) {
  try { database?.close(); } catch (_) {}
}

function rollbackQuietly(database) {
  try { database?.exec('ROLLBACK'); } catch (_) {}
}

function readWithNodeSqlite(databasePath, deps) {
  const sqlite = deps.sqlite || require('node:sqlite');
  const DatabaseSync = sqlite.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    const error = new Error('node:sqlite DatabaseSync is unavailable');
    error.code = 'ERR_SQLITE_UNAVAILABLE';
    throw error;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.exec('BEGIN');
    const count = Number(database.prepare(COUNT_SQL).get()?.n || 0);
    if (queryLimitFailure(count, deps.maxRows)) {
      rollbackQuietly(database);
      return { ok: false, code: 'read-failed', reason: 'row-limit' };
    }
    const usageRows = database.prepare(USAGE_SQL).all();
    let sessionRows = [];
    let metadata = 'joined';
    try {
      sessionRows = database.prepare(SESSION_SQL).all();
    } catch (error) {
      if (!missingSessionStore(error)) throw error;
      metadata = 'usage-only';
    }
    rollbackQuietly(database);
    return { ok: true, rows: rowsFromUsage(usageRows, sessionRows), metadata };
  } catch (error) {
    rollbackQuietly(database);
    return { ok: false, code: 'read-failed', reason: 'query', error };
  } finally {
    closeQuietly(database);
  }
}

function sqliteCliScript(databasePath, script) {
  const stdout = execFileSync('sqlite3', ['-readonly', databasePath], {
    input: script,
    encoding: 'utf8',
    maxBuffer: MAX_RESULT_CHARS,
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true
  });
  if (String(stdout || '').length > MAX_RESULT_CHARS) {
    const error = new Error('sqlite result exceeded the byte budget');
    error.code = 'ERR_RESULT_TOO_LARGE';
    throw error;
  }
  return String(stdout || '');
}

// One sqlite3 process and one transaction. Separate processes would each see
// their own snapshot, so a delete between them could pair new tokens with an
// old session model.
function readWithSqliteCli(databasePath, deps = {}) {
  const scriptFor = (includeSessions) => `
.timeout ${BUSY_TIMEOUT_MS}
BEGIN;
SELECT 'COUNT|' || COUNT(*) FROM local_runtime_token_usage;
SELECT 'USAGE|' || json_object(
  'session_id', session_id,
  'turn_id', turn_id,
  'model', model,
  'ts', ts,
  'input_tokens', input_tokens,
  'output_tokens', output_tokens,
  'reasoning_tokens', reasoning_tokens,
  'cache_read_tokens', cache_read_tokens,
  'cache_write_tokens', cache_write_tokens
) FROM local_runtime_token_usage;
${includeSessions ? `SELECT 'SESSION|' || json_object(
  'session_id', session_id,
  'workspace_dir', workspace_dir,
  'extra_data_json', extra_data_json
) FROM local_runtime_sessions;` : ''}
ROLLBACK;
`;
  const parseScript = (text) => {
    let count = 0;
    const usageRows = [];
    const sessionRows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('COUNT|')) count = Number(line.slice('COUNT|'.length));
      else if (line.startsWith('USAGE|')) usageRows.push(JSON.parse(line.slice('USAGE|'.length)));
      else if (line.startsWith('SESSION|')) sessionRows.push(JSON.parse(line.slice('SESSION|'.length)));
    }
    return { count, usageRows, sessionRows };
  };
  try {
    let metadata = 'joined';
    let parsed;
    try {
      parsed = parseScript(sqliteCliScript(databasePath, scriptFor(true)));
    } catch (error) {
      if (!missingSessionStore(error)) throw error;
      metadata = 'usage-only';
      parsed = parseScript(sqliteCliScript(databasePath, scriptFor(false)));
    }
    if (queryLimitFailure(parsed.count, deps.maxRows)) {
      return { ok: false, code: 'read-failed', reason: 'row-limit' };
    }
    return { ok: true, rows: rowsFromUsage(parsed.usageRows, parsed.sessionRows), metadata };
  } catch (error) {
    return { ok: false, code: 'read-failed', reason: 'cli', error };
  }
}

function sqliteModuleMissing(error) {
  const code = error?.code;
  return code === 'ERR_SQLITE_UNAVAILABLE' || code === 'MODULE_NOT_FOUND' || code === 'ERR_UNKNOWN_BUILTIN_MODULE';
}

// One read-only transaction. node:sqlite keeps the connection; the sqlite3
// fallback keeps one process inside BEGIN/ROLLBACK. Usage and session
// metadata are not read as separate autocommit snapshots.
function readMiniMaxCodeDatabase(databasePath, deps = {}) {
  const sourcePath = canonicalPath(databasePath);
  if (!fileExists(databasePath)) {
    return { ok: false, code: 'no-database', sourcePath };
  }
  let result;
  try {
    result = readWithNodeSqlite(databasePath, deps);
  } catch (error) {
    if (!sqliteModuleMissing(error)) return { ok: false, code: 'read-failed', sourcePath, reason: 'open' };
    result = readWithSqliteCli(databasePath, deps);
  }
  return { ...result, sourcePath };
}

function readMiniMaxCodeSnapshot(options = {}) {
  const location = minimaxCodeDatabaseLocation(options);
  if (location.absent && !location.explicit) {
    return { ok: false, code: 'absent', sourcePath: canonicalPath(location.databasePath), location };
  }
  if (location.explicit && !dirExists(location.root) && !fileExists(location.databasePath)) {
    return { ok: false, code: 'absent', sourcePath: canonicalPath(location.databasePath), location };
  }
  const read = readMiniMaxCodeDatabase(location.databasePath, options);
  return { ...read, location };
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
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function windowStartMs(windows) {
  const values = [windows.todayStart, windows.monthStart, windows.allTimeSince]
    .map((value) => timestampMs(value))
    .filter((value) => value > 0);
  return values.length ? Math.max(...values) : 0;
}

function buildTokscaleJson(windows = {}, options = {}) {
  const sinceMs = windowStartMs(windows);
  const rows = (Array.isArray(options.rows) ? options.rows : [])
    .filter((row) => {
      if (!sinceMs) return true;
      if (!row.createdAt) return options.includeUndated === true;
      return row.createdAt >= sinceMs;
    });
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.sessionId || 'unknown'}\u0000${normalizedModelId(row.model) || 'unknown'}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        sessionId: row.sessionId || 'unknown',
        model: row.model || 'unknown',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        messages: 0,
        cost: 0,
        startedAt: 0,
        lastUsedAt: 0,
        projectId: row.projectId || '',
        projectLabel: row.projectLabel || ''
      });
    }
    const entry = grouped.get(key);
    const cost = estimatedRowCost(row, options.pricingByModel);
    entry.input += row.input;
    entry.output += row.output;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite;
    entry.reasoning += row.reasoning;
    entry.messages += 1;
    entry.cost += cost === null ? 0 : cost;
    if (!entry.projectId && row.projectId) {
      entry.projectId = row.projectId;
      entry.projectLabel = row.projectLabel || '';
    }
    if (row.createdAt && (!entry.startedAt || row.createdAt < entry.startedAt)) entry.startedAt = row.createdAt;
    if (row.createdAt > entry.lastUsedAt) entry.lastUsedAt = row.createdAt;
  }
  const entries = [];
  for (const entry of grouped.values()) {
    const total = entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
    entries.push({
      client: CLIENT_ID,
      sessionId: entry.sessionId,
      model: entry.model,
      provider: 'minimax',
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      reasoning: entry.reasoning,
      totalTokens: total,
      messageCount: entry.messages,
      cost: entry.cost,
      projectId: entry.projectId,
      projectLabel: entry.projectLabel,
      startedAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : '',
      lastUsedAt: entry.lastUsedAt ? new Date(entry.lastUsedAt).toISOString() : ''
    });
  }
  return { groupBy: 'client,session,model', entries };
}

function buildMiniMaxCodePeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const buildOptions = { rows, pricingByModel: options.pricingByModel };
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
  return {
    today: buildTokscaleJson({ todayStart }, buildOptions),
    month: buildTokscaleJson({ monthStart }, buildOptions),
    allTime: buildTokscaleJson({ allTimeSince: options.allTimeSince }, { ...buildOptions, includeUndated: true })
  };
}

function buildMiniMaxCodeHistoryGraph(options = {}) {
  const byDate = new Map();
  const rows = Array.isArray(options.rows) ? options.rows : [];
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
        client: CLIENT_ID,
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
    client.tokens.reasoning += row.reasoning;
    client.cost += cost === null ? 0 : cost;
    client.messages += 1;
  }
  return { contributions: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)) };
}

function sameSource(stored, sourcePath) {
  return Boolean(stored && sourcePath && canonicalPath(stored.sourcePath || '') === canonicalPath(sourcePath));
}

// Same database and same window only. A failed read must not publish
// yesterday's today, or last month's month, as the current window.
function reusableMiniMaxPeriods(stored, options = {}) {
  const empty = { today: null, month: null, allTime: null };
  if (!sameSource(stored, options.sourcePath)) return empty;
  const todayKey = String(options.todayKey || '');
  const monthKey = String(options.monthKey || '');
  const allTimeSince = String(options.allTimeSince || '');
  return {
    today: stored.todayKey === todayKey ? (stored.today || null) : null,
    month: stored.monthKey === monthKey ? (stored.month || null) : null,
    allTime: String(stored.allTimeSince || '') === allTimeSince ? (stored.allTime || null) : null
  };
}

function commitMiniMaxCodeAnchor(anchor, captured) {
  if (!captured || captured.ok !== true) return anchor;
  const next = anchor && typeof anchor === 'object' ? { ...anchor } : {};
  next.minimaxCodePeriods = {
    sourcePath: captured.sourcePath,
    todayKey: captured.todayKey,
    monthKey: captured.monthKey,
    allTimeSince: String(captured.allTimeSince || ''),
    today: captured.periods.today,
    month: captured.periods.month,
    allTime: captured.periods.allTime
  };
  return next;
}

module.exports = {
  BUSY_TIMEOUT_MS,
  CLIENT_ID,
  DATABASE_RELATIVE,
  MAX_RESULT_CHARS,
  MAX_USAGE_ROWS,
  buildMiniMaxCodeHistoryGraph,
  buildMiniMaxCodePeriods,
  buildTokscaleJson,
  canonicalPath,
  commitMiniMaxCodeAnchor,
  estimatedRowCost,
  minimaxCodeDatabaseLocation,
  readMiniMaxCodeDatabase,
  readMiniMaxCodeSnapshot,
  resolveMiniMaxCodeRoot,
  reusableMiniMaxPeriods,
  rowsFromUsage
};
