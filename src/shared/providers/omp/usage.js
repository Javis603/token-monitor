'use strict';

// Oh My Pi owns a durable usage database in addition to its transcript tree.
// This adapter is intentionally Node-only: the portable Hub/Worker closure must
// never open a local SQLite file. The database is read through one SQLite
// snapshot so periods, sessions, and the consistency checks cannot observe
// different WAL generations.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractUsageFromTokscale } = require('../../usage');

const OMP_CLIENT = 'omp';
const OMP_STATS_SOURCE_CHECK_ID = 'omp-stats-db';
const OMP_STATS_ADAPTER_VERSION = 1;
const OMP_READ_BUSY_TIMEOUT_MS = 250;
const OMP_HEADER_READ_BYTES = 64 * 1024;
const OMP_MAX_GROUP_ROWS = 100_000;
const OMP_MAX_SESSION_ROWS = 50_000;
const UUID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;

const REQUIRED_MESSAGE_COLUMNS = Object.freeze([
  'session_file', 'model', 'provider', 'timestamp',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'total_tokens', 'cost_total', 'agent_type'
]);
const REQUIRED_SESSION_COLUMNS = Object.freeze([
  'session_file', 'started_at', 'ended_at', 'total_tokens', 'cost_total'
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integerNumber(value) {
  const number = finiteNumber(value);
  return Math.max(0, Math.round(number));
}

function ompStatsDbPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const explicit = String(options.statsDbPath || options.ompStatsDbPath || '').trim();
  return path.resolve(explicit || path.join(homeDir, '.omp', 'stats.db'));
}

function ompStatsDbPathForClients(clientsCsv, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase());
  return clients.includes(OMP_CLIENT) ? ompStatsDbPath(options) : '';
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localStartMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const number = finiteNumber(value);
  return number > 0 ? new Date(number).toISOString() : '';
}

function pathBasenameCrossPlatform(value) {
  const raw = String(value || '').replace(/[\\]+$/, '');
  const index = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return index >= 0 ? raw.slice(index + 1) : raw;
}

function fallbackSessionId(sessionFile) {
  const raw = String(sessionFile || '');
  const basename = pathBasenameCrossPlatform(raw);
  const match = basename.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i)
    || raw.match(UUID_RE);
  if (match) return match[1];
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `file-${digest}`;
}

function parentSessionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/[\\/]/.test(raw) && raw.length <= 256) return raw.replace(/\.jsonl$/i, '');
  return fallbackSessionId(raw);
}

function readSessionHeader(sessionFile, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const maxBytes = positiveInteger(options.headerReadBytes, OMP_HEADER_READ_BYTES);
  let fd = null;
  try {
    fd = fsImpl.openSync(sessionFile, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytes = fsImpl.readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytes).toString('utf8');
    for (const line of text.split(/\r?\n/).slice(0, 64)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value?.type !== 'session') continue;
        return {
          id: String(value.id || '').trim(),
          parentSession: String(value.parentSession || value.parent_session || '').trim()
        };
      } catch (_) {
        // A non-JSON title or a truncated line before the session record does not
        // make the whole database unreadable; the filename remains a stable key.
      }
    }
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
  }
  return null;
}


function sessionIdentity(sessionFile, options = {}) {
  const header = readSessionHeader(sessionFile, options);
  const sessionId = header?.id || fallbackSessionId(sessionFile);
  const parentId = parentSessionId(header?.parentSession);
  return {
    sessionId,
    parentSessionId: parentId,
    sessionRole: parentId ? 'child' : 'root'
  };
}

function statementRows(statement, params = [], maxRows, label) {
  const rows = [];
  for (const row of statement.iterate(...params)) {
    if (rows.length >= maxRows) throw new Error(`omp stats read exceeded ${label} budget (${maxRows} rows)`);
    rows.push(row);
  }
  return rows;
}

function withStatement(database, sql, callback) {
  const statement = database.prepare(sql);
  try {
    return callback(statement);
  } finally {
    if (typeof statement.close === 'function') statement.close();
  }
}

function allStatementRows(database, sql) {
  return withStatement(database, sql, (statement) => statement.all());
}

function boundedStatementRows(database, sql, params, maxRows, label) {
  return withStatement(database, sql, (statement) => statementRows(statement, params, maxRows, label));
}

function tableColumns(database, table) {
  return new Set(allStatementRows(database, `SELECT name FROM pragma_table_info('${table}')`)
    .map((row) => String(row.name || '').trim()).filter(Boolean));
}

function assertSchema(database) {
  const tables = new Set(allStatementRows(database, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => String(row.name || '').trim()));
  for (const table of ['messages', 'session_rollup']) {
    if (!tables.has(table)) throw new Error(`omp stats schema missing table ${table}`);
  }
  for (const [table, required] of [
    ['messages', REQUIRED_MESSAGE_COLUMNS],
    ['session_rollup', REQUIRED_SESSION_COLUMNS]
  ]) {
    const columns = tableColumns(database, table);
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) throw new Error(`omp stats schema missing ${table} columns: ${missing.join(',')}`);
  }
  return {
    hasMessageRollup: tables.has('message_rollup'),
    hasMeta: tables.has('meta'),
    hasToolCalls: tables.has('tool_calls')
  };
}

function openDatabase(dbPath, options = {}) {
  if (typeof options.openDatabase === 'function') return options.openDatabase(dbPath);
  const requireFn = options.requireFn || require;
  const { DatabaseSync } = requireFn('node:sqlite');
  const database = new DatabaseSync(dbPath, { readOnly: true });
  database.exec(`PRAGMA busy_timeout = ${OMP_READ_BUSY_TIMEOUT_MS}`);
  return database;
}

function normalizeMessageRow(row, identities, options = {}) {
  const sessionFile = String(row.session_file || '');
  const identity = identities.get(sessionFile) || sessionIdentity(sessionFile, options);
  const input = integerNumber(row.input_tokens);
  const output = integerNumber(row.output_tokens);
  const cacheRead = integerNumber(row.cache_read_tokens);
  const cacheWrite = integerNumber(row.cache_write_tokens);
  const totalTokens = integerNumber(row.total_tokens);
  const components = input + output + cacheRead + cacheWrite;
  // OMP's total_tokens is the source of truth. The residual is assigned to input
  // only when a version adds a component that this adapter does not know yet; it
  // keeps the public period exact without inventing a model price.
  const exactInput = input + Math.max(0, totalTokens - components);
  return {
    day: String(row.day || '').slice(0, 10),
    sessionFile,
    sessionId: identity.sessionId,
    parentSessionId: identity.parentSessionId,
    sessionRole: identity.sessionRole,
    model: String(row.model || '').trim(),
    provider: String(row.provider || '').trim(),
    agentType: String(row.agent_type || '').trim(),
    input: exactInput,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: Math.max(0, finiteNumber(row.cost_total)),
    messages: integerNumber(row.messages),
    startedAt: finiteNumber(row.started_at),
    lastUsedAt: finiteNumber(row.last_used_at)
  };
}

function readOmpStatsRows(options = {}) {
  const dbPath = ompStatsDbPath(options);
  const nowMs = finiteNumber(options.nowMs) || Date.now();
  const explicitSinceMs = Number(options.sinceMs);
  const sinceMs = Number.isFinite(explicitSinceMs) && explicitSinceMs >= 0
    ? explicitSinceMs
    : Math.max(0, localStartMs(options.allTimeSince));
  const maxGroups = positiveInteger(options.maxGroupRows, OMP_MAX_GROUP_ROWS);
  const maxSessions = positiveInteger(options.maxSessionRows, OMP_MAX_SESSION_ROWS);
  const database = openDatabase(dbPath, options);
  const identities = new Map();
  try {
    const schema = assertSchema(database);
    database.exec('BEGIN');
    try {
      const sessionRows = boundedStatementRows(
        database,
        `
          SELECT session_file, started_at, ended_at, total_tokens, cost_total
          FROM session_rollup
          ORDER BY session_file
        `,
        [],
        maxSessions,
        'session'
      );
      for (const row of sessionRows) {
        const sessionFile = String(row.session_file || '');
        if (!sessionFile) continue;
        identities.set(sessionFile, {
          ...sessionIdentity(sessionFile, options),
          startedAt: finiteNumber(row.started_at) * (finiteNumber(row.started_at) < 10 ** 12 ? 1000 : 1),
          lastUsedAt: finiteNumber(row.ended_at) * (finiteNumber(row.ended_at) < 10 ** 12 ? 1000 : 1)
        });
      }

      const rows = boundedStatementRows(
        database,
        `
          SELECT
            strftime('%Y-%m-%d', timestamp / 1000.0, 'unixepoch', 'localtime') AS day,
            session_file,
            model,
            provider,
            agent_type,
            COUNT(*) AS messages,
            MIN(timestamp) AS started_at,
            MAX(timestamp) AS last_used_at,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cost_total) AS cost_total
          FROM messages
          WHERE timestamp >= ?
            AND timestamp <= ?
            AND (total_tokens > 0 OR cost_total > 0)
          GROUP BY day, session_file, model, provider, agent_type
          ORDER BY day, session_file, model, provider, agent_type
        `,
        [sinceMs, nowMs],
        maxGroups,
        'message group'
      );
      return {
        dbPath,
        schema,
        rows: rows.map((row) => normalizeMessageRow(row, identities, options)),
        sessionCount: identities.size
      };
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
}

function rowToUsageEntry(row) {
  return {
    client: OMP_CLIENT,
    sessionId: row.sessionId,
    parentSessionId: row.parentSessionId,
    sessionRole: row.sessionRole,
    agentType: row.agentType,
    model: row.model,
    provider: row.provider,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    totalTokens: row.totalTokens,
    cost: row.cost,
    messageCount: row.messages,
    startedAt: isoTimestamp(row.startedAt),
    lastUsedAt: isoTimestamp(row.lastUsedAt)
  };
}

function rowsForPeriod(rows, predicate) {
  return rows.filter(predicate).map(rowToUsageEntry);
}

function buildOmpPeriods({ rows = [], now = new Date() } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const today = localDateKey(date);
  const month = today.slice(0, 7);
  return {
    today: extractUsageFromTokscale({ entries: rowsForPeriod(rows, (row) => row.day === today) }),
    month: extractUsageFromTokscale({ entries: rowsForPeriod(rows, (row) => row.day.startsWith(month)) }),
    allTime: extractUsageFromTokscale({ entries: rowsForPeriod(rows, () => true) })
  };
}

function buildOmpHistoryGraph({ rows = [] } = {}) {
  const days = new Map();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue;
    if (!days.has(row.day)) days.set(row.day, new Map());
    const key = `${row.model}\0${row.provider}`;
    const current = days.get(row.day).get(key) || {
      client: OMP_CLIENT,
      modelId: row.model || 'unknown',
      providerId: row.provider || '',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      totalTokens: 0,
      cost: 0,
      messages: 0
    };
    current.tokens.input += row.input;
    current.tokens.output += row.output;
    current.tokens.cacheRead += row.cacheRead;
    current.tokens.cacheWrite += row.cacheWrite;
    current.totalTokens += row.totalTokens;
    current.cost += row.cost;
    current.messages += row.messages;
    days.get(row.day).set(key, current);
  }
  return {
    contributions: [...days.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({
      date,
      clients: [...values.values()].map((value) => {
        const components = value.tokens.input + value.tokens.output + value.tokens.cacheRead + value.tokens.cacheWrite;
        if (components < value.totalTokens) value.tokens.input += value.totalTokens - components;
        return {
          client: value.client,
          modelId: value.modelId,
          ...(value.providerId ? { providerId: value.providerId } : {}),
          tokens: value.tokens,
          cost: value.cost,
          messages: value.messages,
          tokenComponentsAvailable: true
        };
      })
    }))
  };
}

function collectOmpUsage(options = {}) {
  const read = readOmpStatsRows(options);
  const periods = buildOmpPeriods({ rows: read.rows, now: options.now || new Date() });
  return {
    ...read,
    ...periods,
    historyGraph: buildOmpHistoryGraph({ rows: read.rows }),
    adapterVersion: OMP_STATS_ADAPTER_VERSION
  };
}

module.exports = {
  OMP_CLIENT,
  OMP_STATS_ADAPTER_VERSION,
  OMP_STATS_SOURCE_CHECK_ID,
  buildOmpHistoryGraph,
  buildOmpPeriods,
  collectOmpUsage,
  ompStatsDbPath,
  ompStatsDbPathForClients,
  readOmpStatsRows,
  readSessionHeader,
  sessionIdentity
};
