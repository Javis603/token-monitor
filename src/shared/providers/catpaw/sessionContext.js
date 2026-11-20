// @ts-check
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSessionContext } = require('../../sessionContext');
const { resolveSqlite, openDb } = require('../../sqliteReadOnly');
const { catpawDataSources } = require('./paths');

const CATPAW_SESSION_PATTERN = /^catpaw:([0-9a-f]{12}:[^:]+:[0-9a-f]{12}):(.+)$/;

/** @typedef {{ contextTokens: number, contextWindow: number }} SessionContext */
/** @typedef {{ stamp: string, entries: Map<string, SessionContext | null> }} CachedDatabase */

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
 * @param {unknown} payload
 * @returns {SessionContext | null}
 */
function contextFromPayload(payload) {
  if (typeof payload !== 'string' || !payload) return null;
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(payload); } catch (_) { return null; }
  const info = parsed?.extra?.contextInfo;
  const usage = info?.usage;
  if (!usage || typeof usage !== 'object') return null;
  /** @param {unknown} value */
  const tokenCount = (value) => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  );
  const contextTokens = tokenCount(usage.promptTokens)
    + tokenCount(usage.cacheReadTokens)
    + tokenCount(usage.cacheWriteTokens);
  return normalizeSessionContext({
    contextTokens,
    contextWindow: info.contextWindowTokens
  });
}

/**
 * @param {string} dbPath
 * @param {string[]} conversationIds
 * @param {any} sqliteMod
 * @param {Map<string, CachedDatabase>} cache
 * @returns {Map<string, SessionContext | null> | null}
 */
function readConversations(dbPath, conversationIds, sqliteMod, cache) {
  const stamp = databaseStamp(dbPath);
  if (!stamp) return null;
  let cached = cache.get(dbPath);
  if (!cached || cached.stamp !== stamp) cached = { stamp, entries: new Map() };

  const missing = [...new Set(conversationIds)].filter((id) => !cached.entries.has(id));
  if (!missing.length) return cached.entries;

  /** @type {any} */
  let db;
  /** @type {Array<[string, SessionContext | null]>} */
  const fetched = [];
  try {
    db = openDb(dbPath, sqliteMod);
    const stmt = db.prepare(
      "SELECT payload FROM ui_sdk_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 20"
    );
    for (const id of missing) {
      /** @type {SessionContext | null} */
      let found = null;
      for (const row of stmt.all(id)) {
        const context = contextFromPayload(row?.payload);
        if (context) { found = context; break; }
      }
      fetched.push([id, found]);
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
function readCatPawSessionContexts(sessionIds, options = {}) {
  /** @type {Map<string, SessionContext>} */
  const result = new Map();
  /** @type {Map<string, Array<{ sessionId: string, conversationId: string }>>} */
  const wantedByDbKey = new Map();
  for (const sessionId of sessionIds || []) {
    const match = CATPAW_SESSION_PATTERN.exec(String(sessionId || ''));
    if (!match) continue;
    const dbKey = match[1];
    const list = wantedByDbKey.get(dbKey) || [];
    list.push({ sessionId, conversationId: match[2] });
    wantedByDbKey.set(dbKey, list);
  }
  if (!wantedByDbKey.size) return result;

  const deps = options.deps || {};
  const sqliteMod = resolveSqlite(deps);
  if (typeof sqliteMod?.DatabaseSync !== 'function') return result;

  /** @param {string} value */
  const shortHash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  const sources = catpawDataSources({
    homeDir: options.home,
    platform: deps.platform,
    env: deps.env,
    useEnvRoots: deps.scopedHome !== true,
    windowsFolders: deps.windowsFolders
  });
  const cache = deps.catpawDbCache || dbContextCache;
  for (const dbPath of sources.dbPaths) {
    const edition = path.basename(path.dirname(dbPath));
    const support = path.dirname(path.dirname(dbPath));
    const targets = wantedByDbKey.get(`${shortHash(support)}:${edition}:${shortHash(dbPath)}`);
    if (!targets) continue;
    const entries = readConversations(dbPath, targets.map((item) => item.conversationId), sqliteMod, cache);
    if (!entries) continue;
    for (const item of targets) {
      const context = entries.get(item.conversationId);
      if (context) result.set(item.sessionId, context);
    }
  }
  return result;
}

module.exports = { readCatPawSessionContexts };
