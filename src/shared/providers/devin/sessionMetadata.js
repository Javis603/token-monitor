'use strict';

const fs = require('node:fs');
const { devinCliDbPaths } = require('./paths');

// node:sqlite is absent on some runtimes (packaged Electron builds, older Node
// for the agent on non-supported platforms). The resolver then quietly answers
// nothing and the scan's own session metadata still carries the timestamps.
let defaultSqlite = null;
try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }

// One sessions.db holds every CLI session, so the whole row set is cached per
// database. The fingerprint covers the -wal sibling too: under WAL mode writes
// land there and the main file's own mtime can stay put while a live session
// grows.
const dbRowsCache = new Map();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return 'missing';
  }
}

function dbFingerprint(dbPath) {
  const main = fileStamp(dbPath);
  if (main === 'missing') return '';
  return `${main}|${fileStamp(`${dbPath}-wal`)}`;
}

// null = could not read (locked db, transient IO); only a successful read —
// including an empty one — may be cached, or one failed open would serve as
// the answer for the whole fingerprint lifetime.
function readRows(dbPath, sqliteMod) {
  let db;
  try {
    db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  } catch (_) {
    return null;
  }
  try {
    let rows;
    try {
      rows = db.prepare(
        'SELECT id, title, working_directory, created_at, last_activity_at FROM sessions'
      ).all();
    } catch (_) {
      // Older databases predate the title / working_directory columns; fall
      // back to the columns every schema version has.
      rows = db.prepare('SELECT id, created_at, last_activity_at FROM sessions').all();
    }
    const map = new Map();
    for (const row of rows) {
      const id = String(row.id || '').trim();
      if (id) map.set(id, row);
    }
    return map;
  } catch (_) {
    return null;
  } finally {
    try { db.close(); } catch (_) { /* close on a failed open is best-effort */ }
  }
}

function rowsForDb(dbPath, sqliteMod, cache) {
  const fingerprint = dbFingerprint(dbPath);
  if (!fingerprint) return new Map();
  const cached = cache.get(dbPath);
  if (cached && cached.fingerprint === fingerprint) return cached.rows;
  const rows = readRows(dbPath, sqliteMod);
  if (rows === null) return new Map();
  cache.set(dbPath, { fingerprint, rows });
  return rows;
}

// Devin CLI session ids are opaque generated names ("lavender-flock"); the
// sessions table's own title and working directory are the only friendly
// labels. created_at / last_activity_at are Unix seconds.
function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, isoFromDate, projectIdentity } = context;
  const result = new Map();
  const sqliteMod = deps.sqlite !== undefined ? deps.sqlite : defaultSqlite;
  if (!sqliteMod) return result;
  // A scoped home is a WSL distro; host env roots must not redirect the lookup
  // away from it, matching tokscale's use_env_roots: false under --home.
  const env = deps.scopedHome ? {} : (deps.env || process.env);
  const platform = deps.platform || process.platform;
  const cache = deps.devinDbRowsCache || dbRowsCache;
  const wanted = new Set(sessionIds);
  for (const dbPath of devinCliDbPaths({ homeDir: home, platform, env })) {
    const rows = rowsForDb(dbPath, sqliteMod, cache);
    if (rows.size === 0) continue;
    for (const sessionId of wanted) {
      if (result.has(sessionId)) continue;
      const row = rows.get(sessionId);
      if (!row) continue;
      const meta = {};
      const startedAt = isoFromDate(Number(row.created_at) * 1000);
      const lastUsedAt = isoFromDate(Number(row.last_activity_at) * 1000);
      if (startedAt) meta.startedAt = startedAt;
      if (lastUsedAt) meta.lastUsedAt = lastUsedAt;
      const title = String(row.title || '').trim();
      if (title) meta.title = title;
      if (context.resolveProjects !== false && typeof projectIdentity === 'function') {
        const identity = projectIdentity(row.working_directory);
        if (identity.projectId) {
          meta.projectId = identity.projectId;
          if (identity.projectLabel) meta.projectLabel = identity.projectLabel;
        }
      }
      if (Object.keys(meta).length > 0) result.set(sessionId, meta);
    }
  }
  return result;
}

module.exports = { resolveSessionMetadata };
