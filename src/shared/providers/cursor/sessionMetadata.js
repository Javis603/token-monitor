'use strict';

const fs = require('node:fs');
const { cursorDesktopStateCandidates } = require('./desktopState');

// Deferred like auth.js: importing this resolver must not emit Node's
// experimental node:sqlite warning for collectors that never see a Cursor row.
let defaultSqlite;
function resolveSqlite(deps) {
  if (deps.sqlite !== undefined) return deps.sqlite;
  if (defaultSqlite === undefined) {
    try { defaultSqlite = require('node:sqlite'); } catch (_) { defaultSqlite = null; }
  }
  return defaultSqlite;
}

const titleCache = new Map();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (_) {
    return '';
  }
}

function databaseStamp(dbPath) {
  const main = fileStamp(dbPath);
  return main ? `${main}|${fileStamp(`${dbPath}-wal`)}` : '';
}

function cleanTitle(value) {
  return typeof value === 'string'
    ? [...value.replace(/\s+/g, ' ').trim()].slice(0, 96).join('')
    : '';
}

// Older Cursor releases kept the sidebar index in the shared key/value store
// under 'composer.composerHeaders' (an {allComposers:[...]} list); current
// releases promote it to a first-class composerHeaders table. The table is the
// live schema and wins when both answer — the legacy key is only a fallback
// for rows the table does not cover, and it is read at most once per database
// fingerprint through cache.legacyTitles.
function legacyTitlesFor(db, cache) {
  if (cache.legacyTitles) return cache.legacyTitles;
  const titles = new Map();
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('composer.composerHeaders');
    const parsed = JSON.parse(row?.value || 'null');
    for (const header of Array.isArray(parsed?.allComposers) ? parsed.allComposers : []) {
      const id = String(header?.composerId || '').trim();
      const title = cleanTitle(header?.name);
      if (id && title) titles.set(id, title);
    }
    // Cache only a successful read — including an empty answer. A transient
    // failure leaves legacyTitles unset so the next lookup retries.
    cache.legacyTitles = titles;
  } catch (_) { /* Missing table/key or malformed payload: retry next lookup. */ }
  return titles;
}

function readTitles(dbPath, sqlite, wantedIds, cache) {
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* Read-only WAL reads still benefit on newer builds. */ }
    const titles = new Map();
    let headerById = null;
    try {
      headerById = db.prepare('SELECT value FROM composerHeaders WHERE composerId = ?');
    } catch (_) {
      // Older databases have no composerHeaders table at all: every id falls
      // through to the legacy ItemTable key below.
    }
    const unanswered = new Set(wantedIds);
    if (headerById) {
      for (const id of wantedIds) {
        try {
          const row = headerById.get(id);
          if (row === undefined) continue;
          let header;
          try { header = JSON.parse(row.value); } catch (_) { header = null; }
          const title = cleanTitle(header?.name);
          if (title) titles.set(id, title);
          unanswered.delete(id);
        } catch (_) { /* A transient row read error: leave it unanswered, not cached. */ }
      }
    }
    const legacy = legacyTitlesFor(db, cache);
    for (const id of unanswered) {
      const title = legacy.get(id);
      if (title) titles.set(id, title);
    }
    return titles;
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

function resolveSessionMetadata(sessionIds, { deps = {}, home } = {}) {
  const result = new Map();
  const sqlite = resolveSqlite(deps);
  if (typeof sqlite?.DatabaseSync !== 'function') return result;
  const candidates = cursorDesktopStateCandidates({
    home,
    platform: deps.platform || process.platform,
    env: deps.scopedHome ? {} : (deps.env || process.env)
  });
  const cache = deps.cursorTitleCache || titleCache;
  for (const dbPath of candidates) {
    const stamp = databaseStamp(dbPath);
    if (!stamp) continue;
    let cached = cache.get(dbPath);
    if (cached?.stamp !== stamp) cached = { stamp, titles: new Map(), legacyTitles: null };
    // Ask only for ids without a known answer on this fingerprint. A miss is
    // never cached as an answer, so a late-landing header or a transient read
    // error still resolves on the next lookup without waiting for the WAL.
    const wanted = new Set([...sessionIds].filter((id) => !cached.titles.has(id)));
    if (wanted.size > 0) {
      const read = readTitles(dbPath, sqlite, wanted, cached);
      if (read) for (const [id, title] of read) cached.titles.set(id, title);
    }
    cache.set(dbPath, cached);
    for (const sessionId of sessionIds) {
      const title = cached.titles.get(sessionId);
      if (title && !result.has(sessionId)) result.set(sessionId, { title });
    }
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata };
