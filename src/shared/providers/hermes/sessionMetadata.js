'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDb, resolveSqlite } = require('../../sqliteReadOnly');
const { discoverHermesProfileScanPaths, resolveHermesHome } = require('./profiles');

// Tokscale reads Hermes usage from each state.db without the parent links.
// A delegated subagent is its own `sessions` row with source 'subagent' and
// parent_session_id naming the session that spawned it. A context-compression
// continuation carries parent_session_id too, but keeps its parent's source:
// it is the same conversation, not a delegated child, so it keeps its own row.
const SUBAGENT_SOURCE = 'subagent';

// Module-level on purpose: it outlives one collection tick. A row's parent
// link never changes once written, so a found row is settled for the process;
// only ids the database does not (yet) hold are retried when it changes.
const databaseCache = new Map();

// The collector forwards Hermes custom scan paths, plus inherited `hermes:`
// TOKSCALE_EXTRA_DIRS entries, to Tokscale, which reads every state.db below
// them at any depth. A scoped WSL home scans neither, like the other resolvers.
function extraScanRoots(deps, env) {
  if (deps.scopedHome) return [];
  const configured = Array.isArray(deps.customScanPaths?.hermes) ? deps.customScanPaths.hermes : [];
  const inherited = String(env.TOKSCALE_EXTRA_DIRS || '').split(',').map((entry) => {
    const separator = entry.indexOf(':');
    return separator !== -1 && entry.slice(0, separator).trim() === 'hermes' ? entry.slice(separator + 1).trim() : '';
  });
  return [...configured, ...inherited].filter((dir) => typeof dir === 'string' && dir.trim());
}

// ponytail: walks each extra root on every lookup, as Tokscale does per scan;
// cache by root fingerprint if a large custom root makes this measurable.
function stateDatabasesBelow(root) {
  try {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'state.db')
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch (_) {
    return [];
  }
}

function hermesDatabasePaths(context = {}) {
  const deps = context.deps || {};
  const env = deps.scopedHome ? {} : (deps.env || process.env);
  const home = resolveHermesHome({
    env,
    homeDir: context.home,
    platform: deps.scopedHome ? 'linux' : (deps.platform || process.platform)
  });
  return [...new Set([
    ...[home, ...discoverHermesProfileScanPaths(home)].map((dir) => path.join(dir, 'state.db')),
    ...extraScanRoots(deps, env).flatMap(stateDatabasesBelow)
  ])];
}

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

// The main file plus -wal: while Hermes runs, a new subagent row lands in WAL
// first, and a fingerprint of the main file alone would miss it.
function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

// Returns Map<id, parentSessionId | ''> for the ids the database holds, or
// null when the open or the query failed (the ids retry next pass). A schema
// without the columns holds no answers: its ids stay misses, so a later
// database is still consulted and a migrated file is re-read once it changes.
function readParentLinks(dbPath, sqlite, wantedIds) {
  let db;
  try {
    db = openDb(dbPath, sqlite);
    const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => String(column.name)));
    const rows = new Map();
    if (!columns.has('id') || !columns.has('source') || !columns.has('parent_session_id')) return rows;
    const statement = db.prepare('SELECT source, parent_session_id FROM sessions WHERE id = ?');
    for (const id of wantedIds) {
      const row = statement.get(id);
      if (row === undefined) continue;
      const parent = row.source === SUBAGENT_SOURCE ? String(row.parent_session_id || '').trim() : '';
      rows.set(id, parent !== id ? parent : '');
    }
    return rows;
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

function resolveSessionMetadata(sessionIds, context = {}) {
  const result = new Map();
  const sqlite = resolveSqlite(context.deps || {});
  if (typeof sqlite?.DatabaseSync !== 'function') return result;
  const cache = context.deps?.hermesDatabaseCache || databaseCache;
  const settled = new Map();
  for (const dbPath of hermesDatabasePaths(context)) {
    const stamp = databaseStamp(dbPath);
    if (!stamp) continue;
    let cached = cache.get(dbPath);
    if (!cached) cache.set(dbPath, cached = { stamp, rows: new Map(), misses: new Set() });
    if (cached.stamp !== stamp) {
      cached.stamp = stamp;
      cached.misses.clear();
    }
    const wanted = [];
    for (const id of sessionIds) {
      if (settled.has(id)) continue;
      if (cached.rows.has(id)) settled.set(id, cached.rows.get(id));
      else if (!cached.misses.has(id)) wanted.push(id);
    }
    if (wanted.length === 0) continue;
    const read = readParentLinks(dbPath, sqlite, wanted);
    if (!read) continue;
    for (const id of wanted) {
      if (!read.has(id)) { cached.misses.add(id); continue; }
      cached.rows.set(id, read.get(id));
      settled.set(id, read.get(id));
    }
  }
  for (const [id, parentSessionId] of settled) {
    if (parentSessionId) result.set(id, { parentSessionId });
  }
  return result;
}

module.exports = { hermesDatabasePaths, readParentLinks, resolveSessionMetadata };
