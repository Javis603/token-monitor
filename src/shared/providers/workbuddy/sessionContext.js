// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSessionContext } = require('../../sessionContext');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');

/** @typedef {{ contextTokens: number, contextWindow: number }} SessionContext */
/** @typedef {{ stamp: string, entries: Map<string, SessionContext | null | undefined> }} CachedDatabase */

/** @type {Map<string, CachedDatabase>} */
const dbContextCache = new Map();

/** @param {string} dbPath */
function databaseStamp(dbPath) {
  /** @param {string} target */
  const statStamp = (target) => {
    try {
      const stat = fs.statSync(target);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch (_) { return ''; }
  };
  const main = statStamp(dbPath);
  return main ? `${main}|${statStamp(`${dbPath}-wal`)}` : '';
}

/**
 * @param {string} dbPath
 * @param {string[]} sessionIds
 * @param {any} sqliteMod
 * @param {Map<string, CachedDatabase>} cache
 * @returns {Map<string, SessionContext | null | undefined> | null}
 */
function readUsageRows(dbPath, sessionIds, sqliteMod, cache) {
  const stamp = databaseStamp(dbPath);
  if (!stamp) return null;
  let cached = cache.get(dbPath);
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, entries: new Map() };
  }

  const missing = sessionIds.filter((id) => !cached.entries.has(id));
  if (!missing.length) return cached.entries;

  /** @type {any} */
  let db;
  /** @type {Array<[string, SessionContext | null | undefined]>} */
  const fetched = [];
  try {
    db = openDb(dbPath, sqliteMod);
    const stmt = db.prepare('SELECT used, size FROM session_usage WHERE session_id = ?');
    for (const id of missing) {
      const row = stmt.get(id);
      fetched.push([id, row ? normalizeSessionContext({
        contextTokens: row.used,
        contextWindow: row.size
      }) : undefined]);
    }
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) {}
  }

  if (databaseStamp(dbPath) === stamp) {
    for (const [id, context] of fetched) cached.entries.set(id, context);
    cache.set(dbPath, cached);
    return cached.entries;
  }
  return new Map([...cached.entries, ...fetched]);
}

/**
 * @param {Iterable<string>} sessionIds
 * @param {{ home?: string, deps?: Record<string, any> }} [options]
 * @returns {Map<string, SessionContext>}
 */
function readWorkBuddySessionContexts(sessionIds, options = {}) {
  let remaining = [...new Set(sessionIds || [])];
  /** @type {Map<string, SessionContext>} */
  const contexts = new Map();
  if (!remaining.length) return contexts;

  const deps = options.deps || {};
  const sqliteMod = resolveSqlite(deps);
  if (typeof sqliteMod?.DatabaseSync !== 'function') return contexts;

  const home = options.home || os.homedir();
  const cache = deps.workbuddyDbCache || dbContextCache;
  for (const dir of ['.workbuddy-ai', '.workbuddy']) {
    if (!remaining.length) break;
    const entries = readUsageRows(path.join(home, dir, 'workbuddy.db'), remaining, sqliteMod, cache);
    if (!entries) continue;
    remaining = remaining.filter((id) => {
      const context = entries.get(id);
      if (context === undefined) return true;
      if (context) contexts.set(id, context);
      return false;
    });
  }
  return contexts;
}

module.exports = { readWorkBuddySessionContexts };
