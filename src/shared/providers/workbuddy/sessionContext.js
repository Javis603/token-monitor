'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../../sqliteReadOnly');
const { normalizeSessionContext } = require('../../sessionContext');

/**
 * WorkBuddy keeps the live context window in its own SQLite app database, not
 * in the JSONL transcript tokscale scans. `session_usage.used` is what the
 * window currently holds and `session_usage.size` is the window the running
 * model was configured with; WorkBuddy rewrites both on every turn, so the row
 * is the live fact rather than a value derived from the transcript.
 *
 * The transcript cannot answer this on its own: it carries per-request
 * `prompt_tokens` but never the window size, which is a per-session runtime
 * option (1,000,000 for DeepSeek-V4.1-Flash, 960,000 for models capped lower).
 * A model-name table would therefore be wrong for exactly the sessions users
 * watch — the same reason the Codex reader uses Codex's own
 * `model_context_window` instead of a catalog.
 *
 * Read-only by contract: Token Monitor does not write any WorkBuddy file.
 */

// Deferred like the other SQLite readers: importing this module must not emit
// Node's experimental node:sqlite warning for collectors that never see a
// WorkBuddy row.
let defaultSqlite;
function resolveSqlite(deps = {}) {
  if (deps?.sqlite !== undefined) return deps.sqlite;
  if (defaultSqlite === undefined) {
    try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }
  }
  return defaultSqlite;
}

function workbuddyDatabasePath(context = {}) {
  const home = context.home || os.homedir();
  return path.join(home, '.workbuddy', 'workbuddy.db');
}

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

// The main file plus -wal: WorkBuddy writes the usage row through WAL, so a
// fingerprint of the main file alone would miss the turn until a checkpoint.
function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

// One primary-key lookup per id rather than a single IN list: it stays clear of
// the host-parameter limit on older SQLite builds, and it makes "the database
// exists but this session has no row (yet)" a cacheable definite answer.
// Three outcomes are distinguished — supported:false means this WorkBuddy
// build keeps no usage table (definite), null means the open or the query
// failed (transient, the whole batch retries next tick).
function readUsageRows(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = openDb(dbPath, sqlite);
    const columns = new Set(
      db.prepare('PRAGMA table_info(session_usage)').all().map((column) => String(column.name))
    );
    if (!columns.has('used') || !columns.has('size')) {
      return { supported: false, rows: new Map(), misses: new Set() };
    }
    const statement = db.prepare('SELECT used, size FROM session_usage WHERE session_id = ?');
    const rows = new Map();
    const misses = new Set();
    for (const id of wantedIds) {
      const row = statement.get(id);
      if (row === undefined) { misses.add(id); continue; }
      // A half-filled row (a session that has not made its first request yet)
      // is a definite miss: neither half can be drawn without the other.
      const context = normalizeSessionContext({ contextTokens: row.used, contextWindow: row.size });
      if (context) rows.set(id, context);
      else misses.add(id);
    }
    return { supported: true, rows, misses };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

const usageCache = new Map();

/**
 * Reads the live occupancy pair for the given session ids.
 *
 * Returns `{ supported, rows: Map<id, {contextTokens, contextWindow}>, misses }`
 * so the caller can tell a definite miss (clear the badge) from a transient
 * read failure (leave the previous reading alone).
 */
function readWorkbuddySessionUsage(sessionIds, context = {}) {
  const empty = { supported: true, rows: new Map(), misses: new Set() };
  if (!sessionIds || sessionIds.length === 0) return empty;
  const sqlite = resolveSqlite(context.deps);
  if (typeof sqlite?.DatabaseSync !== 'function') return empty;
  const dbPath = workbuddyDatabasePath(context);
  const stamp = databaseStamp(dbPath);
  if (!stamp) return empty;
  const cache = context.deps?.workbuddyUsageCache || usageCache;
  let cached = cache.get(dbPath);
  // A new fingerprint re-queries everything: `used` changes on every turn, so
  // a cached value is only valid while the file itself is unchanged.
  if (cached?.stamp !== stamp) cached = { stamp, rows: new Map(), misses: new Set(), supported: null };
  if (cached.supported !== false) {
    // An existing row settles the id. Only "no such row in the database" and a
    // transient read failure leave the id for the next pass.
    const wanted = sessionIds.filter((id) => !cached.rows.has(id) && !cached.misses.has(id));
    if (wanted.length > 0) {
      const read = readUsageRows(dbPath, sqlite, wanted);
      if (read) {
        cached.supported = read.supported;
        for (const [id, row] of read.rows) cached.rows.set(id, row);
        for (const id of read.misses) cached.misses.add(id);
      }
    }
  }
  cache.set(dbPath, cached);
  const rows = new Map();
  const misses = new Set();
  for (const sessionId of sessionIds) {
    const row = cached.rows.get(sessionId);
    if (row) rows.set(sessionId, row);
    else if (cached.misses.has(sessionId)) misses.add(sessionId);
  }
  return { supported: cached.supported !== false, rows, misses };
}

module.exports = {
  databaseStamp,
  readUsageRows,
  readWorkbuddySessionUsage,
  resolveSqlite,
  workbuddyDatabasePath
};
