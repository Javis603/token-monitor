'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// WorkBuddy session account attribution.
//
// WorkBuddy's local database stamps every chat session row with the user id
// of the account that created it. The usage collector only sees the session
// files tokscale scans, so when one account is signed out and replaced, the
// archived sessions would all blend into one anonymous pile. Reading the
// sessions table lets each collected session carry the account id that
// earned it, and the session-usage archive keeps that attribution after the
// source rows are gone.
//
// The database is read read-only with a short busy timeout: WorkBuddy keeps
// it open while running, and a locked or absent database must never fail a
// usage collection — the sessions just stay unattributed until the next tick.

const WORKBUDDY_DB_RELATIVE_PATH = path.join('.workbuddy', 'workbuddy.db');
const WORKBUDDY_SESSIONS_SQL = "SELECT id, user_id FROM sessions WHERE id IS NOT NULL AND TRIM(CAST(user_id AS TEXT)) != ''";

function workbuddyDbPath({ homeDir } = {}) {
  const home = homeDir || require('node:os').homedir();
  return path.join(home, WORKBUDDY_DB_RELATIVE_PATH);
}

function workbuddyAccountKey(userId) {
  const raw = String(userId || '').trim();
  if (!raw) return '';
  // The key lands in rollup maps keyed by string, so anything that is not a
  // plain identifier collapses to its alphanumeric prefix instead of shipping
  // punctuation through the summary, the hub and the archive.
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(raw)) return raw;
  const collapsed = raw.replace(/[^A-Za-z0-9]/g, '');
  return collapsed.slice(0, 16);
}

function accountMapFromRows(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = String(row?.id || '').trim();
    const accountKey = workbuddyAccountKey(row?.user_id);
    if (sessionId && accountKey) map.set(sessionId, accountKey);
  }
  return map;
}

function parseSqliteJsonRows(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

const accountMapCache = { dbPath: '', mtimeMs: 0, map: null };

function resetWorkbuddyAccountMapCache() {
  accountMapCache.dbPath = '';
  accountMapCache.mtimeMs = 0;
  accountMapCache.map = null;
}

async function readWorkbuddyAccountMap(options = {}) {
  const fsApi = options.fs || fs;
  const dbPath = workbuddyDbPath({ homeDir: options.homeDir });
  let mtimeMs;
  try {
    mtimeMs = fsApi.statSync(dbPath).mtimeMs;
  } catch (_) {
    return new Map();
  }
  if (accountMapCache.dbPath === dbPath && accountMapCache.mtimeMs === mtimeMs && accountMapCache.map) {
    return accountMapCache.map;
  }
  const rows = await readWorkbuddySessions(dbPath, options);
  const map = accountMapFromRows(rows);
  accountMapCache.dbPath = dbPath;
  accountMapCache.mtimeMs = mtimeMs;
  accountMapCache.map = map;
  return map;
}

async function readWorkbuddySessions(dbPath, options = {}) {
  const run = options.execFile || execFileAsync;
  if (typeof run === 'function') {
    try {
      const result = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', dbPath, WORKBUDDY_SESSIONS_SQL], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10_000, windowsHide: true
      });
      return parseSqliteJsonRows(result?.stdout);
    } catch (_) { /* fall through to node:sqlite */ }
  }
  try {
    const requireFn = options.requireFn || require;
    const { DatabaseSync } = requireFn('node:sqlite');
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 250');
      return database.prepare(WORKBUDDY_SESSIONS_SQL).all();
    } finally {
      database.close();
    }
  } catch (_) {
    return [];
  }
}

// Tags every WorkBuddy session in the given periods with its account key.
// Idempotent: a session that already carries an account key keeps it, so an
// account whose source rows were deleted stays attributed from the archive.
function applyWorkbuddyAccountKeys(periods, accountMap) {
  const map = accountMap instanceof Map ? accountMap : new Map();
  if (map.size === 0) return;
  const periodList = Array.isArray(periods) ? periods : Object.values(periods || {});
  for (const period of periodList) {
    for (const session of Object.values(period?.sessions || {})) {
      if (session?.client !== 'workbuddy' || session.accountKey) continue;
      const accountKey = map.get(String(session.sessionId || '').trim());
      if (accountKey) session.accountKey = accountKey;
    }
  }
}

module.exports = {
  WORKBUDDY_SESSIONS_SQL,
  accountMapFromRows,
  applyWorkbuddyAccountKeys,
  parseSqliteJsonRows,
  readWorkbuddyAccountMap,
  resetWorkbuddyAccountMapCache,
  workbuddyAccountKey,
  workbuddyDbPath
};
