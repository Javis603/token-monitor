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
  // null distinguishes a failed read from a successful-but-empty index: the
  // former is retried, the latter is a definitive answer.
  if (cache.legacyTitles !== null && cache.legacyTitles !== undefined) return cache.legacyTitles;
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
    return titles;
  } catch (_) {
    return null;
  }
}

function readTitles(dbPath, sqlite, wantedIds, cache) {
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* Read-only WAL reads still benefit on newer builds. */ }
    const titles = new Map();
    // Legacy answers for ids whose modern read failed this call: they may be
    // returned to the caller but must never enter the cached title map.
    const retries = new Map();
    // Three distinct outcomes per id: a usable modern title wins outright;
    // a definitive non-answer (missing, malformed or empty-named row) is
    // legacy-eligible and cacheable; a read failure is retry-only.
    const eligible = new Set();
    const failed = new Set();
    const misses = new Set();
    let hasHeaderTable;
    try {
      hasHeaderTable = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'").get()
      );
    } catch (_) {
      // Cannot even introspect the database: treat the whole read as transient
      // so nothing is cached and every id is retried on the next lookup.
      return null;
    }
    if (!hasHeaderTable) {
      // Older databases genuinely lack the table: every id falls through to
      // the legacy ItemTable key below.
      for (const id of wantedIds) eligible.add(id);
    } else {
      let headerById = null;
      try {
        headerById = db.prepare('SELECT value FROM composerHeaders WHERE composerId = ?');
      } catch (_) {
        // The table exists but the prepare failed: a transient error, not an
        // old schema, so nothing becomes legacy-eligible this call.
        for (const id of wantedIds) failed.add(id);
      }
      if (headerById) {
        for (const id of wantedIds) {
          try {
            const row = headerById.get(id);
            if (row === undefined) { eligible.add(id); continue; }
            let header;
            try { header = JSON.parse(row.value); } catch (_) { header = null; }
            const title = cleanTitle(header?.name);
            // Only a usable title counts as the table's answer. A malformed or
            // empty-named row stays unanswered so the legacy index — which may
            // still carry this conversation's name — gets its turn below.
            if (!title) { eligible.add(id); continue; }
            titles.set(id, title);
          } catch (_) { failed.add(id); }
        }
      }
    }
    if (eligible.size > 0 || failed.size > 0) {
      const legacy = legacyTitlesFor(db, cache);
      for (const id of eligible) {
        const title = legacy?.get(id);
        if (title) titles.set(id, title);
        else if (legacy) misses.add(id); // both stores definitively answered nothing
      }
      for (const id of failed) {
        const title = legacy?.get(id);
        if (title) retries.set(id, title);
      }
    }
    return { titles, retries, misses };
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
  const retries = new Map();
  for (const dbPath of candidates) {
    const stamp = databaseStamp(dbPath);
    if (!stamp) continue;
    let cached = cache.get(dbPath);
    if (cached?.stamp !== stamp) cached = { stamp, titles: new Map(), misses: new Set(), legacyTitles: null };
    // Ask only for ids this fingerprint has not definitively answered. A
    // cached miss is a real answer (no open/query per tick for a header-less
    // session); only ids that failed to read are asked again, so a
    // late-landing header or transient error still resolves on the next
    // lookup without waiting for the WAL.
    const wanted = new Set([...sessionIds].filter((id) => !cached.titles.has(id) && !cached.misses.has(id)));
    if (wanted.size > 0) {
      const read = readTitles(dbPath, sqlite, wanted, cached);
      if (read) {
        for (const [id, title] of read.titles) cached.titles.set(id, title);
        for (const [id, title] of read.retries) retries.set(id, title);
        for (const id of read.misses) cached.misses.add(id);
      }
    }
    cache.set(dbPath, cached);
    for (const sessionId of sessionIds) {
      const title = cached.titles.get(sessionId) || retries.get(sessionId);
      if (title && !result.has(sessionId)) result.set(sessionId, { title });
    }
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata };
