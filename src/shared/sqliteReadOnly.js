'use strict';

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

function resolveSqlite(deps) {
  return deps.sqlite !== undefined ? deps.sqlite : sqlite;
}

function openDb(dbPath, sqliteMod) {
  const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 250');
  db.exec('PRAGMA query_only = ON');
  return db;
}

module.exports = { resolveSqlite, openDb };
