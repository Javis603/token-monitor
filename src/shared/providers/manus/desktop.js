'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { errorWithStatus } = require('../../limits/providerHelpers');

// Manus Studio uses the Manus userData directory. The Windows Store build
// redirects appData to its package LocalCache; its Chromium store is in Network.
const MANUS_COOKIE_FILE = 'Cookies';

// The app's API session lives in one host-only cookie on the API host. Reading
// by name alone could pick up an unrelated `session_id` from another site the
// in-app browser visited, so the read is scoped to this host and name.
const MANUS_SESSION_COOKIE_HOST = 'api.manus.im';
const MANUS_SESSION_COOKIE_NAME = 'session_id';

// A JWT: three base64url segments. Anything else is not a session this module
// can forward, and keeping the charset tight means nothing header-unsafe ever
// reaches a request.
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function manusDesktopCookieCandidates(options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Manus', MANUS_COOKIE_FILE)];
  }
  if (platform === 'win32') {
    const env = options.env || process.env;
    const appData = String(env.APPDATA || '').trim() || path.join(home, 'AppData', 'Roaming');
    const localData = String(env.LOCALAPPDATA || '').trim() || path.join(home, 'AppData', 'Local');
    return [
      path.join(localData, 'Packages', 'ManusAI.Manus_vajzd2mq3s8wj', 'LocalCache', 'Roaming', 'Manus', 'Network', MANUS_COOKIE_FILE),
      path.join(appData, 'Manus', 'Network', MANUS_COOKIE_FILE)
    ];
  }
  // Manus has no official Linux desktop client. Manual web sessions still work.
  return [];
}

function readSessionCookieRow(dbPath, sqlite) {
  const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return database
      .prepare('SELECT value, encrypted_value FROM cookies WHERE host_key = ? AND name = ? LIMIT 1')
      .get(MANUS_SESSION_COOKIE_HOST, MANUS_SESSION_COOKIE_NAME);
  } finally {
    database.close();
  }
}

// Windows Chromium holds its cookie database open exclusively. Read a private
// snapshot (including committed WAL data) instead; never open or change the
// source database's SQLite sidecars. A racing/unreadable copy fails unavailable.
function readWindowsSessionCookieRow(dbPath, sqlite, fsApi) {
  const scratch = fsApi.mkdtempSync(path.join(os.tmpdir(), 'tm-manus-cookies-'));
  try {
    const copy = path.join(scratch, MANUS_COOKIE_FILE);
    fsApi.copyFileSync(dbPath, copy);
    try { fsApi.copyFileSync(`${dbPath}-wal`, `${copy}-wal`); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return readSessionCookieRow(copy, sqlite);
  } finally {
    fsApi.rmSync(scratch, { recursive: true, force: true });
  }
}

// The JWT payload carries the account's user id, which is stable across token
// refreshes and devices. It is only decoded to derive a hashed identity and a
// display email; the signature is the server's business, not ours.
function manusSessionClaims(token) {
  const payload = String(token || '').split('.')[1];
  if (!payload) return {};
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The signed-in Manus desktop app's session. A missing store or cookie is an
// app nobody signed into; a store that cannot be read, or a cookie available
// only as ciphertext, keeps the last reading rather than proving a logout.
// Nothing is written back.
function readManusDesktopSession(options = {}) {
  const fsApi = options.fs || fs;
  // `node:sqlite` is absent on some runtimes (packaged Electron, older Node).
  const sqlite = options.sqlite !== undefined
    ? options.sqlite
    : (() => { try { return require('node:sqlite'); } catch { return null; } })();
  const candidates = options.candidates || manusDesktopCookieCandidates(options);
  if (!candidates.length) throw errorWithStatus('notConfigured', 'Manus desktop session is not supported on this platform');

  let statFailure = null;
  const dbPath = candidates.find((candidate) => {
    try {
      return fsApi.statSync(candidate).isFile();
    } catch (error) {
      if (error?.code !== 'ENOENT') statFailure = error;
      return false;
    }
  });
  if (!dbPath) {
    if (statFailure) throw errorWithStatus('unavailable', 'Manus cookie store could not be read');
    throw errorWithStatus('notConfigured', 'Manus cookie store not found');
  }
  if (typeof sqlite?.DatabaseSync !== 'function') {
    throw errorWithStatus('unavailable', 'node:sqlite is unavailable in this runtime');
  }

  let row;
  try {
    row = (options.platform || process.platform) === 'win32'
      ? readWindowsSessionCookieRow(dbPath, sqlite, fsApi)
      : readSessionCookieRow(dbPath, sqlite);
  } catch (_) {
    throw errorWithStatus('unavailable', 'Manus cookie store could not be read');
  }

  const value = typeof row?.value === 'string' ? row.value.trim() : '';
  if (!value) {
    if (row?.encrypted_value && row.encrypted_value.length > 0) {
      throw errorWithStatus('unavailable', 'Manus stores its session cookie encrypted');
    }
    throw errorWithStatus('notConfigured', 'Manus desktop app is not signed in');
  }
  if (!SESSION_TOKEN_PATTERN.test(value)) {
    throw errorWithStatus('unauthorized', 'Manus session cookie is not a usable session');
  }

  const claims = manusSessionClaims(value);
  return {
    token: value,
    userId: typeof claims.user_id === 'string' || typeof claims.user_id === 'number' ? String(claims.user_id) : '',
    email: typeof claims.email === 'string' ? claims.email.trim() : ''
  };
}

module.exports = {
  SESSION_TOKEN_PATTERN,
  MANUS_SESSION_COOKIE_HOST,
  MANUS_SESSION_COOKIE_NAME,
  manusDesktopCookieCandidates,
  manusSessionClaims,
  readManusDesktopSession
};
