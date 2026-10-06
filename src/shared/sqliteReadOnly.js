'use strict';

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 250');
    db.exec('PRAGMA query_only = ON');
    return db;
  } catch (error) {
    // The caller only owns the connection after initialization succeeds.
    try { db.close(); } catch (_) { /* preserve the initialization error */ }
    throw error;
  }
}

module.exports = { resolveSqlite, openDb };
