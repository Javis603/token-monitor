'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../../sqliteReadOnly');

// Tokscale reads usage from <home>/.zcode/projects but omits session titles
// and parentage. Join those by session id from the CLI database under the
// same collector home, including a scoped WSL home. Limits discovery's env
// overrides do not redirect Tokscale's home-relative source, so they must
// not select a different metadata store either.

// Deferred like the other SQLite readers: importing this module must not emit
// Node's experimental node:sqlite warning for collectors that never see a
// ZCode row.
let defaultSqlite;
function resolveSqlite(deps = {}) {
  if (deps?.sqlite !== undefined) return deps.sqlite;
  if (defaultSqlite === undefined) {
    try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }
  }
  return defaultSqlite;
}

const TITLE_MAX_CODE_POINTS = 96;

// Sessions a tool or a workflow spawned: their usage folds into the
// interactive row that started them. fork and selection_side_chat carry the
// same parent_id column but are conversations the user opened deliberately
// and whose titles already describe them, so they keep their own row.
const SUBAGENT_TASK_TYPES = new Set(['subagent_child', 'workflow_child']);

// Module-level on purpose: it outlives one collection tick, so an idle
// session does not reopen the database every pass.
const sessionRowCache = new Map();

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? chars.join('')
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

function zcodeDatabasePath(context = {}) {
  const home = context.home || os.homedir();
  return path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
}

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

// The main file plus -wal: while ZCode runs, a new title lands in WAL first,
// and a fingerprint of the main file alone would miss it until a checkpoint.
function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

// One primary-key lookup per id rather than a single IN list: it stays clear
// of the host-parameter limit on older SQLite builds, and it makes "the
// database exists but this row does not (yet)" a cacheable definite answer.
// Three outcomes are distinguished — supported:false means this table has no
// title column (definite), null means the open or the query failed
// (transient, the whole batch retries next tick).
function readSessionRows(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = openDb(dbPath, sqlite);
    const columns = new Set(
      db.prepare('PRAGMA table_info(session)').all().map((column) => String(column.name))
    );
    if (!columns.has('id') || !columns.has('title')) return { supported: false, rows: new Map(), misses: new Set() };
    // task_type with parent_id decides whether this session folds into a
    // parent: only the tool- and workflow-spawned children fold; a user's own
    // fork or side chat stays its own row. A schema without the columns is
    // treated as having no parentage at all.
    const selectParent = columns.has('parent_id') && columns.has('task_type');
    const statement = db.prepare(
      selectParent
        ? 'SELECT title, task_type, parent_id FROM session WHERE id = ?'
        : 'SELECT title FROM session WHERE id = ?'
    );
    const rows = new Map();
    const misses = new Set();
    for (const id of wantedIds) {
      const row = statement.get(id);
      if (row === undefined) { misses.add(id); continue; }
      const parentSessionId = selectParent && SUBAGENT_TASK_TYPES.has(String(row.task_type || ''))
        ? String(row.parent_id || '').trim()
        : '';
      rows.set(id, {
        title: cleanTitle(row.title),
        parentSessionId: parentSessionId && parentSessionId !== id ? parentSessionId : ''
      });
    }
    return { supported: true, rows, misses };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

function resolveSessionMetadata(sessionIds, context = {}) {
  const result = new Map();
  const sqlite = resolveSqlite(context.deps);
  if (typeof sqlite?.DatabaseSync !== 'function') return result;
  const dbPath = zcodeDatabasePath(context);
  const stamp = databaseStamp(dbPath);
  if (!stamp) return result;
  const cache = context.deps?.zcodeSessionRowCache || sessionRowCache;
  let cached = cache.get(dbPath);
  // A new fingerprint re-queries everything: a title is a mutable fact (the
  // user can rename a session), and keeping the cached value would freeze the
  // rename forever. The cost is one primary-key lookup per visible id per
  // tick.
  if (cached?.stamp !== stamp) {
    cached = { stamp, rows: new Map(), misses: new Set(), supported: null };
  }
  if (cached.supported !== false) {
    // An existing row settles the id — an empty title and an absent parent
    // link are both answers. Only "no such row in the database" and a
    // transient read failure leave the id for the next pass.
    const wanted = [...sessionIds].filter((id) => !cached.rows.has(id) && !cached.misses.has(id));
    if (wanted.length > 0) {
      const read = readSessionRows(dbPath, sqlite, wanted);
      if (read) {
        cached.supported = read.supported;
        for (const [id, row] of read.rows) cached.rows.set(id, row);
        for (const id of read.misses) cached.misses.add(id);
      }
    }
  }
  cache.set(dbPath, cached);
  for (const sessionId of sessionIds) {
    const row = cached.rows.get(sessionId);
    if (!row) continue;
    const meta = {};
    if (row.title) meta.title = row.title;
    if (row.parentSessionId) meta.parentSessionId = row.parentSessionId;
    if (Object.keys(meta).length > 0) result.set(sessionId, meta);
  }
  return result;
}

module.exports = { cleanTitle, readSessionRows, resolveSessionMetadata, zcodeDatabasePath };
