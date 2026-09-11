'use strict';

// Read Hermes Agent session timestamps from state.db (SQLite).
// Tokscale counts the tokens; this file only dates the session rows so Today
// / live rate can follow a Desktop conversation whose id is YYYYMMDD_HHMMSS_hex
// (not an ISO timestamp) and whose last_activity_at keeps moving mid-session.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveHermesHome, discoverHermesProfileScanPaths } = require('./profiles');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function isoFromUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* older bindings */ }
  return db;
}

function discoverDbPaths(deps = {}) {
  if (Array.isArray(deps.dbPaths) && deps.dbPaths.length) return deps.dbPaths;
  const homeDir = deps.homeDir || os.homedir();
  const hermesHome = resolveHermesHome({
    env: deps.env || process.env,
    homeDir,
    platform: deps.platform || process.platform,
    existsSync: deps.existsSync || fs.existsSync
  });
  const dirs = [hermesHome, ...discoverHermesProfileScanPaths(hermesHome, deps)];
  const existsSync = deps.existsSync || fs.existsSync;
  const paths = [];
  for (const dir of dirs) {
    const dbPath = path.join(dir, 'state.db');
    if (existsSync(dbPath)) paths.push(dbPath);
  }
  return paths;
}

function columnSet(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
  } catch (_) {
    return new Set();
  }
}

function readSessionMeta(sessionIds, deps = {}) {
  const ids = Array.from(sessionIds || []).filter(Boolean).map(String);
  const out = new Map();
  if (ids.length === 0) return out;
  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return out;

  const placeholders = ids.map(() => '?').join(',');
  for (const dbPath of discoverDbPaths(deps)) {
    let db;
    try {
      db = openDb(dbPath, sqliteMod);
      const columns = columnSet(db, 'sessions');
      if (!columns.has('id') || !columns.has('started_at')) continue;
      const lastActivity = columns.has('last_activity_at') ? 'last_activity_at' : 'NULL';
      const cwd = columns.has('cwd') ? "COALESCE(cwd,'')" : "''";
      const sql = `SELECT id,
                          started_at AS startedAt,
                          ${lastActivity} AS lastActivityAt,
                          ${cwd} AS cwd
                   FROM sessions WHERE id IN (${placeholders})`;
      for (const row of db.prepare(sql).all(...ids)) {
        const id = String(row.id);
        if (out.has(id)) continue;
        const startedAt = isoFromUnix(row.startedAt);
        const lastUsedAt = isoFromUnix(row.lastActivityAt) || startedAt;
        out.set(id, {
          startedAt,
          lastUsedAt,
          projectPath: String(row.cwd || '').trim()
        });
      }
    } catch (_) {
      /* live WAL / missing table / node:sqlite unavailable for this file */
    } finally {
      try { db?.close(); } catch (_) {}
    }
    if (out.size >= ids.length) break;
  }
  return out;
}

module.exports = {
  discoverDbPaths,
  isoFromUnix,
  readSessionMeta
};
