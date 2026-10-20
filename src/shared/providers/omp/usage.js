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
const OMP_HEADER_PROBE_BYTES = 4 * 1024;
const OMP_MAX_GROUP_ROWS = 100_000;
const OMP_MAX_SESSION_ROWS = 50_000;
const UUID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i;
const OMP_SESSION_IDENTITY_CACHE_LIMIT = 10_000;
const sessionIdentityCache = new Map();
// OMP ingests its transcripts into stats.db only while its own dashboard or
// `/usage` view is open. Nothing in Token Monitor can trigger that ingest, so a
// closed dashboard means `today` silently freezes at whatever was indexed last.
// A healthy ingest re-syncs a changed transcript within a debounce (~1 s) and
// full-scans every 5 minutes, so an hour of unread growth is unambiguously
// abnormal for an index that is running at all. Reporting earlier than that
// would flag the ordinary case of OMP having been used with its dashboard
// closed, which the note would then describe as a fresh problem on every scan.
const OMP_INDEX_LAG_THRESHOLD_MS = 60 * 60 * 1000;
// Only sessions that were actually touched recently are worth reporting: once the
// user stops using OMP the index stays behind forever, and a note about a
// yesterday-only gap would outlive the problem it describes.
const OMP_INDEX_LAG_ACTIVE_MS = 24 * 60 * 60 * 1000;
// An hour is the honest bound for a cursor that merely fell behind, but it is a
// slow way to notice the failure that actually costs data: a large transcript
// accumulating unread bytes while the cursor inches forward a line at a time.
// A megabyte of backlog that has survived ten minutes has no import burst to
// explain it (a healthy database sampled repeatedly on a busy machine never
// held more than ~26 KB), so both bounds are reported. The ten-minute floor is
// what keeps a single large record being written right now from firing the byte
// test before OMP's debounce has had a chance to pick it up.
const OMP_INDEX_LAG_BACKLOG_GRACE_MS = 10 * 60 * 1000;
const OMP_INDEX_LAG_BACKLOG_BYTES = 4 * 1024 * 1024;
// Reading every cursor row and stat'ing the transcript it points at costs a few
// hundred milliseconds - more than a usage tick should spend on a diagnostic,
// and the default five-minute tick would otherwise pay it every time. A healthy
// sweep is therefore reused for one grace window: onset cannot be reported
// before that window has elapsed anyway, so a cached sweep never delays a real
// finding by more than the window that finding already waits for. A *stale*
// sweep is reused only briefly, so opening OMP's dashboard clears the note
// within a tick or two instead of lingering for ten minutes. Thresholds are
// still applied per call, so a cached sweep answers the caller's own question.
const OMP_INDEX_LAG_CACHE_MS = 10 * 60 * 1000;
const OMP_INDEX_LAG_CACHE_STALE_MS = 60 * 1000;
const OMP_INDEX_LAG_CACHE_LIMIT = 8;
const OMP_INDEX_LAG_CACHE_MAX_FILES = 5_000;
// A cursor table this large means something other than the observed install is
// on disk; reporting nothing is better than spending seconds on a stat sweep.
const OMP_MAX_OFFSET_ROWS = 200_000;
const indexLagCache = new Map();

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

function parseSessionHeader(buffer) {
  const text = buffer.toString('utf8');
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
  return null;
}

function readSessionHeader(sessionFile, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const maxBytes = positiveInteger(options.headerReadBytes, OMP_HEADER_READ_BYTES);
  const probeBytes = Math.min(maxBytes, OMP_HEADER_PROBE_BYTES);
  let fd = null;
  try {
    fd = fsImpl.openSync(sessionFile, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    let bytes = fsImpl.readSync(fd, buffer, 0, probeBytes, 0);
    let header = parseSessionHeader(buffer.subarray(0, bytes));
    if (header || bytes >= maxBytes) return header;
    bytes += fsImpl.readSync(fd, buffer, bytes, maxBytes - bytes, bytes);
    header = parseSessionHeader(buffer.subarray(0, bytes));
    return header;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
  }
}


function sessionIdentity(sessionFile, options = {}) {
  const raw = String(sessionFile || '');
  const fsImpl = options.fsImpl || fs;
  let stat = null;
  if (typeof fsImpl.statSync === 'function') {
    try { stat = fsImpl.statSync(raw); } catch (_) {}
  }
  const cached = sessionIdentityCache.get(raw);
  if (stat && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    sessionIdentityCache.delete(raw);
    sessionIdentityCache.set(raw, cached);
    return cached.identity;
  }
  const header = readSessionHeader(raw, options);
  const sessionId = header?.id || fallbackSessionId(raw);
  const parentId = parentSessionId(header?.parentSession);
  const identity = {
    sessionId,
    parentSessionId: parentId,
    sessionRole: parentId ? 'child' : 'root'
  };
  if (stat) {
    sessionIdentityCache.set(raw, { mtimeMs: stat.mtimeMs, size: stat.size, identity });
    while (sessionIdentityCache.size > OMP_SESSION_IDENTITY_CACHE_LIMIT) {
      sessionIdentityCache.delete(sessionIdentityCache.keys().next().value);
    }
  }
  return identity;
}

function sessionIdentityForRow(sessionFile, identities, options) {
  const existing = identities.get(sessionFile);
  if (existing?.sessionId) return existing;
  const identity = sessionIdentity(sessionFile, options);
  const merged = { ...(existing || {}), ...identity };
  identities.set(sessionFile, merged);
  return merged;
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

// OMP ingests only while its own dashboard (or the `/usage` view) is open, so the
// observable failure is a transcript that keeps growing while its `file_offsets`
// cursor stands still. Comparing the file's mtime with the cursor's own
// `last_modified` is per-file, so one session being ingested does not mask
// another that is hours behind; requiring unread bytes (`size > offset`) keeps a
// touch without new content out of the signal.
//
// Every cursor row is read, never a newest-first window: a stalled file is
// defined by a cursor that stopped advancing, so ordering by cursor recency
// pushes exactly the files worth reporting outside any bounded window while
// healthy files fill it.
//
// Returns null when the schema carries no cursor table (or the table is too
// large to be this installation's), which is the same "cannot tell" answer a
// missing column produces elsewhere in this adapter.
//
// The same transcript can have more than one cursor row: OMP's session tree is
// reachable through both `~/.omp/agent/sessions` and a profile directory that
// symlinks to it, and a row left behind under the abandoned spelling keeps its
// old offset forever. Grouping by the file's device+inode *before* any
// comparison means a superseded row cannot claim a lag the live row does not
// have - filtering by cursor age first would resurrect precisely that artifact.
function readFileOffsetRows(database) {
  return boundedStatementRows(
    database,
    'SELECT session_file, offset, last_modified FROM file_offsets',
    [],
    OMP_MAX_OFFSET_ROWS,
    'file offset'
  );
}

// One entry per physical transcript: `offset` is the furthest byte any cursor
// has consumed, `cursorMs` the newest import time, `mtimeMs` the file's own.
function unreadTranscripts(rows) {
  const files = new Map();
  for (const row of rows) {
    const sessionFile = String(row.session_file || '');
    const cursorMs = finiteNumber(row.last_modified);
    // A row that recorded no import time cannot describe a lag; treating the
    // epoch as the cursor would report a fifty-year gap.
    if (!sessionFile || cursorMs <= 0) continue;
    let stat;
    try { stat = fs.statSync(sessionFile, { throwIfNoEntry: false }); } catch (_) { stat = null; }
    // A transcript OMP has already deleted cannot be behind anything.
    if (!stat || !stat.isFile()) continue;
    // Some filesystems (network shares, and some Windows volumes) report no
    // inode. Merging every such row onto a single `0:0` key would fold unrelated
    // transcripts into one and hide the backlog, so those fall back to the path,
    // which at worst misses an alias rather than inventing a healthy file.
    const key = stat.ino ? `${stat.dev}:${stat.ino}` : `path:${sessionFile}`;
    const offset = finiteNumber(row.offset);
    const seen = files.get(key);
    if (!seen) {
      files.set(key, { offset, cursorMs, mtimeMs: stat.mtimeMs, size: stat.size });
      continue;
    }
    seen.offset = Math.max(seen.offset, offset);
    seen.cursorMs = Math.max(seen.cursorMs, cursorMs);
  }
  const candidates = [];
  for (const file of files.values()) {
    if (file.size > file.offset) candidates.push(file);
  }
  return candidates;
}

function evaluateIndexLag(candidates, options = {}) {
  const nowMs = finiteNumber(options.nowMs) || Date.now();
  const activeMs = positiveInteger(options.activeMs, OMP_INDEX_LAG_ACTIVE_MS);
  const thresholdMs = positiveInteger(options.thresholdMs, OMP_INDEX_LAG_THRESHOLD_MS);
  const graceMs = positiveInteger(options.backlogGraceMs, OMP_INDEX_LAG_BACKLOG_GRACE_MS);
  const backlogBytes = positiveInteger(options.backlogBytes, OMP_INDEX_LAG_BACKLOG_BYTES);
  let lagMs = 0;
  let stalledSessions = 0;
  let unreadBytes = 0;
  let maxUnreadBytes = 0;
  let backlogStale = false;
  for (const file of candidates) {
    // Only a transcript still being written can make the index stale. Once this
    // client stops being used its files stop growing and the gap stops mattering.
    if (nowMs - file.mtimeMs > activeMs) continue;
    const unread = file.size - file.offset;
    stalledSessions += 1;
    unreadBytes += unread;
    maxUnreadBytes = Math.max(maxUnreadBytes, unread);
    // Negative when a file was rewritten shorter than its cursor; that is a
    // separate oddity, not a lag.
    const lag = Math.max(0, file.mtimeMs - file.cursorMs);
    lagMs = Math.max(lagMs, lag);
    if (unread >= backlogBytes && lag >= graceMs) backlogStale = true;
  }
  return {
    active: stalledSessions > 0,
    lagMs,
    stale: stalledSessions > 0 && (lagMs >= thresholdMs || backlogStale),
    stalledSessions,
    unreadBytes,
    maxUnreadBytes
  };
}

function detectOmpIndexLag(database, options = {}) {
  const nowMs = finiteNumber(options.nowMs) || Date.now();
  const explicitCacheMs = Number(options.cacheMs);
  const baseCacheMs = Number.isFinite(explicitCacheMs) ? explicitCacheMs : OMP_INDEX_LAG_CACHE_MS;
  const dbPath = String(options.dbPath || '').trim();
  let cacheKey = '';
  if (dbPath && baseCacheMs > 0) {
    let stat;
    try { stat = fs.statSync(dbPath, { throwIfNoEntry: false }); } catch (_) { stat = null; }
    // Keyed on the database's identity, not just its path: replacing the file
    // must invalidate observations of the old one.
    if (stat) cacheKey = `${dbPath}\0${stat.dev}:${stat.ino}`;
  }
  if (cacheKey) {
    const cached = indexLagCache.get(cacheKey);
    // A caller-supplied `nowMs` that moves backwards must not extend the entry's
    // life, so a negative age is treated as a miss.
    const ageMs = cached ? nowMs - cached.at : -1;
    const ttlMs = cached?.stale ? Math.min(baseCacheMs, OMP_INDEX_LAG_CACHE_STALE_MS) : baseCacheMs;
    if (cached && ageMs >= 0 && ageMs < ttlMs) {
      indexLagCache.delete(cacheKey);
      indexLagCache.set(cacheKey, cached);
      return { ...evaluateIndexLag(cached.candidates, options), checked: cached.checked };
    }
  }
  let rows;
  try {
    rows = readFileOffsetRows(database);
  } catch (_) {
    return null;
  }
  const candidates = unreadTranscripts(rows);
  const result = { ...evaluateIndexLag(candidates, options), checked: rows.length };
  // Only a pathological database has thousands of genuinely unread transcripts;
  // caching that would trade a bounded read for unbounded memory, so such a
  // result is computed but not retained.
  if (cacheKey && candidates.length <= OMP_INDEX_LAG_CACHE_MAX_FILES) {
    indexLagCache.set(cacheKey, { at: nowMs, candidates, checked: rows.length, stale: result.stale });
    while (indexLagCache.size > OMP_INDEX_LAG_CACHE_LIMIT) {
      indexLagCache.delete(indexLagCache.keys().next().value);
    }
  }
  return result;
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
  let read;
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
      const sessionCount = identities.size;
      for (const row of rows) {
        const sessionFile = String(row.session_file || '');
        if (sessionFile) sessionIdentityForRow(sessionFile, identities, options);
      }
      read = {
        dbPath,
        schema,
        rows: rows.map((row) => normalizeMessageRow(row, identities, options)),
        sessionCount
      };
    } finally {
      database.exec('ROLLBACK');
    }
    // The cursor sweep runs after the snapshot is released: it only stats the
    // filesystem, and holding the WAL read transaction across a 39k-file stat
    // pass would pin pages for a diagnostic that every usage row already waits
    // on. A diagnostic that fails must not fail the read - the rows are already
    // in hand, and reporting a parse failure here would switch the whole client
    // to Tokscale over a health note.
    try {
      read.indexLag = detectOmpIndexLag(database, { ...options, dbPath });
    } catch (_) {
      read.indexLag = null;
    }
    return read;
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
  detectOmpIndexLag,
  ompStatsDbPath,
  ompStatsDbPathForClients,
  readOmpStatsRows,
  readSessionHeader,
  sessionIdentity
};
