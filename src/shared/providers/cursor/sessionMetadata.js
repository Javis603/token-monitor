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

function readTitles(dbPath, sqlite) {
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 250'); } catch (_) { /* Read-only WAL reads still benefit on newer builds. */ }
    const rows = db.prepare('SELECT composerId, value FROM composerHeaders').all();
    const titles = new Map();
    for (const row of rows) {
      let header;
      try { header = JSON.parse(row.value); } catch (_) { continue; }
      const id = String(row.composerId || '').trim();
      const title = cleanTitle(header?.name);
      if (id && title) titles.set(id, title);
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
    const cached = cache.get(dbPath);
    const titles = cached?.stamp === stamp ? cached.titles : readTitles(dbPath, sqlite);
    if (!titles) continue;
    if (titles !== cached?.titles) cache.set(dbPath, { stamp, titles });
    for (const sessionId of sessionIds) {
      const title = titles.get(sessionId);
      if (title && !result.has(sessionId)) result.set(sessionId, { title });
    }
  }
  return result;
}

module.exports = { cleanTitle, readTitles, resolveSessionMetadata };
