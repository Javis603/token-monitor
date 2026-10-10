'use strict';

const fs = require('node:fs');
const { cursorDesktopStateCandidates } = require('./desktopState');
const { RUNNING_WINDOW_MS } = require('../../sessionLive');

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

function hasRecentUsage(periods, id, now) {
  if (!periods) return false;
  return ['today', 'month', 'allTime'].some((name) => {
    const timestamp = Date.parse(periods?.[name]?.sessions?.[`cursor:${id}`]?.lastUsedAt);
    return timestamp >= now - RUNNING_WINDOW_MS && timestamp <= now;
  });
}

function readTurnEnds(db, wantedIds, now) {
  const result = new Map();
  // Read scalar fields inside SQLite: composerData also contains conversation
  // text and encrypted checkpoints, which must not enter the metadata cache.
  const query = db.prepare(`SELECT
    json_extract(value, '$.composerId') AS composerId,
    json_extract(value, '$.status') AS status,
    json_extract(value, '$.unfinishedRunAt') AS unfinishedRunAt,
    json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt
    FROM cursorDiskKV WHERE key = ? AND json_valid(value)`);
  for (const id of wantedIds) {
    const row = query.get(`composerData:${id}`);
    result.set(id, null); // a successful absent/unknown answer is cacheable too
    if (row?.composerId !== id) continue;
    // Cursor serializes a local generating run as aborted + unfinishedRunAt.
    // A completed/cancelled turn drops that marker; aborted alone is terminal.
    const unfinished = typeof row.unfinishedRunAt === 'number'
      && row.unfinishedRunAt > 0 && Number.isFinite(new Date(row.unfinishedRunAt).getTime());
    if (row.status === 'completed' || (row.status === 'aborted' && !unfinished)) result.set(id, { turnEnded: true });
    else if (row.status === 'generating' || (row.status === 'aborted' && unfinished)) {
      const activeAt = unfinished ? row.unfinishedRunAt : row.lastUpdatedAt;
      result.set(id, { turnEnded: false,
        // Ignore a future editor clock instead of renewing it on each WAL read.
        ...(typeof activeAt === 'number' && activeAt > 0 && activeAt <= now && Number.isFinite(new Date(activeAt).getTime())
          ? { lastUsedAt: new Date(activeAt).toISOString() } : {}) });
    }
  }
  return result;
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

function readTitles(dbPath, sqlite, wantedIds, cache, now = Date.now(), periods) {
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
    const turnIds = new Set(wantedIds);
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
            // The header is already decoded for its name. Old known headers
            // cannot light a running indicator, so avoid opening their much
            // larger composerData values on every unrelated WAL change.
            if (!hasRecentUsage(periods, id, now) && typeof header?.lastUpdatedAt === 'number'
              && Number.isFinite(header.lastUpdatedAt) && header.lastUpdatedAt > 0
              && (header.lastUpdatedAt < now - RUNNING_WINDOW_MS || header.lastUpdatedAt > now)) turnIds.delete(id);
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
    let turnEnds = new Map();
    let turnReadFailed = false;
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'").get()) {
        turnEnds = readTurnEnds(db, turnIds, now);
      } else turnEnds = new Map([...turnIds].map((id) => [id, null]));
    } catch (_) { turnReadFailed = true; }
    return { titles, retries, misses, turnEnds, turnReadFailed };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) { /* A failed read must not fail collection. */ }
  }
}

function resolveSessionMetadata(sessionIds, { deps = {}, home, now = Date.now(), periods, metadata = deps.metadataCache } = {}) {
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
  const unknownTurns = new Set();
  for (const dbPath of candidates) {
    const stamp = databaseStamp(dbPath);
    if (!stamp) continue;
    let cached = cache.get(dbPath);
    if (cached?.stamp !== stamp) {
      // A partial Today pass cannot discard other periods' successful reads.
      // Revalidate retained scalar boundaries when their ids are requested.
      const turnEnds = cached?.turnEnds || new Map();
      cached = { stamp, titles: new Map(), misses: new Set(), legacyTitles: null,
        turnEnds, turnRetries: new Set(turnEnds.keys()) };
    }
    // Ask only for ids this fingerprint has not definitively answered. A
    // cached miss is a real answer (no open/query per tick for a header-less
    // session); only ids that failed to read are asked again, so a
    // late-landing header or transient error still resolves on the next
    // lookup without waiting for the WAL.
    const wanted = new Set([...sessionIds].filter((id) => cached.turnRetries.has(id)
      || (!cached.turnEnds.has(id) && hasRecentUsage(periods, id, now))
      || (!cached.titles.has(id) && !cached.misses.has(id))));
    if (wanted.size > 0) {
      const read = readTitles(dbPath, sqlite, wanted, cached, now, periods);
      if (read) {
        for (const [id, title] of read.titles) cached.titles.set(id, title);
        for (const [id, title] of read.retries) retries.set(id, title);
        for (const id of read.misses) cached.misses.add(id);
        if (!read.turnReadFailed) {
          for (const id of wanted) cached.turnEnds.delete(id);
        }
        for (const [id, state] of read.turnEnds) cached.turnEnds.set(id, state);
        for (const id of wanted) {
          if (read.turnReadFailed) cached.turnRetries.add(id);
          else cached.turnRetries.delete(id);
        }
      }
    }
    // Only the complete period set can establish that a session is gone.
    // Requested ids alone can be narrowed by per-pass metadata resolution.
    if (periods?.today && periods?.month && periods?.allTime) {
      for (const entries of [cached.turnEnds, cached.turnRetries]) {
        for (const id of entries.keys()) {
          if (!['today', 'month', 'allTime'].some((name) => periods[name].sessions?.[`cursor:${id}`])) entries.delete(id);
        }
      }
    }
    cache.set(dbPath, cached);
    for (const sessionId of sessionIds) {
      const title = cached.titles.get(sessionId) || retries.get(sessionId);
      const state = cached.turnEnds.get(sessionId);
      const existing = result.get(sessionId);
      // Candidate order selects titles and valid boundaries independently: an
      // absent conversation in one store cannot hide another store's answer.
      if (title && !existing?.title) result.set(sessionId, { ...existing, title });
      if (state && typeof existing?.turnEnded !== 'boolean') result.set(sessionId, { ...result.get(sessionId), ...state });
      if (state === null) unknownTurns.add(sessionId);
    }
  }
  for (const sessionId of unknownTurns) {
    if (!result.has(sessionId) && typeof metadata?.get(`cursor:${sessionId}`)?.turnEnded === 'boolean') result.set(sessionId, {});
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata };
