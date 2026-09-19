'use strict';

const path = require('node:path');
const os = require('node:os');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function resolveDevinDbPath(home = os.homedir(), env = process.env) {
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && typeof xdgData === 'string' && xdgData.trim()) {
    return path.join(xdgData.trim(), 'devin', 'cli', 'sessions.db');
  }
  return path.join(home, '.local', 'share', 'devin', 'cli', 'sessions.db');
}

function isoFromEpoch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1e11 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function resolveSessionMetadata(sessionIds, context = {}) {
  const { deps = {}, home = os.homedir(), projectIdentity, resolveProjects } = context;
  const wanted = Array.from(sessionIds || []).filter(Boolean).map(String);
  const result = new Map();
  if (wanted.length === 0) return result;

  const sqliteMod = resolveSqlite(deps);
  if (!sqliteMod) return result;

  const dbPath = deps.dbPath || resolveDevinDbPath(home, deps.env || process.env);
  let db;
  try {
    db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 250');
    const placeholders = wanted.map(() => '?').join(',');
    const sql = `SELECT id, COALESCE(title, '') AS title, working_directory AS cwd, created_at AS createdAt, last_activity_at AS lastActivityAt FROM sessions WHERE id IN (${placeholders})`;
    for (const row of db.prepare(sql).all(...wanted)) {
      const id = String(row.id || '').trim();
      if (!id) continue;
      const startedAt = isoFromEpoch(row.createdAt);
      const lastUsedAt = isoFromEpoch(row.lastActivityAt) || startedAt;
      const title = String(row.title || '').trim();
      const cwd = String(row.cwd || '').trim();
      const identity = resolveProjects && cwd && typeof projectIdentity === 'function' ? projectIdentity(cwd) : {};
      result.set(id, {
        ...(title ? { title } : {}),
        ...(identity.projectId ? identity : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(lastUsedAt ? { lastUsedAt } : {})
      });
    }
  } catch (_) {
    // Ignore unreadable or locked db
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
  return result;
}

module.exports = {
  isoFromEpoch,
  resolveDevinDbPath,
  resolveSessionMetadata
};
