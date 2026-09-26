'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { errorWithStatus } = require('../../limits/providerHelpers');

// The app's own Electron session partition: `persist:xiaomi-account` is a literal
// in its bundle, and `Partitions/<name>/` under userData is Electron's rule for
// one. macOS is measured on disk. Windows follows Electron's `%APPDATA%` rule;
// Linux discovery remains disabled until its shipped storage shape is verified.
const MIMO_PARTITION_DIR = path.join('Partitions', 'xiaomi-account');
const MIMO_COOKIE_FILE = 'Cookies';

// The account cookies live on this host alone. Selecting by name is ambiguous —
// `.xiaomi.com` has its own `cUserId`, and the store also carries unrelated
// third-party logins — so the read is scoped, and nothing outside the allowlist
// below can reach a request.
const MIMO_ACCOUNT_COOKIE_HOST = '.account.xiaomi.com';

// Dropping either one stops the exchange at the login page; `cUserId` is absent
// because dropping it was measured to change nothing. The console lane's
// `api-platform_serviceToken` does not exist here and must not be produced by a
// read of this host.
const MIMO_ACCOUNT_COOKIE_NAMES = Object.freeze(['passToken', 'userId']);

function mimoDesktopCookieCandidates(options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Xiaomi MiMo', MIMO_PARTITION_DIR, MIMO_COOKIE_FILE)];
  }
  if (platform === 'win32') {
    const candidates = [];
    const appData = String(env?.APPDATA || '').trim();
    if (appData) candidates.push(path.join(appData, 'Xiaomi MiMo', MIMO_PARTITION_DIR, MIMO_COOKIE_FILE));
    candidates.push(path.join(home, 'AppData', 'Roaming', 'Xiaomi MiMo', MIMO_PARTITION_DIR, MIMO_COOKIE_FILE));
    return candidates;
  }
  return [];
}

function readAccountCookieRows(dbPath, sqlite) {
  const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = MIMO_ACCOUNT_COOKIE_NAMES.map(() => '?').join(', ');
    return database
      .prepare(`SELECT name, value, encrypted_value FROM cookies WHERE host_key = ? AND name IN (${placeholders})`)
      .all(MIMO_ACCOUNT_COOKIE_HOST, ...MIMO_ACCOUNT_COOKIE_NAMES);
  } finally {
    database.close();
  }
}

// The signed-in MiMo Desktop's account cookie. Missing or sealed storage falls
// back silently; an incomplete plaintext session is unauthorized; an I/O or
// SQLite failure is transient so the runtime can retain the last good reading.
// Nothing is written back, and only the two allowlisted cookies leave this file.
function readMimoDesktopAccount(options = {}) {
  const fsApi = options.fs || fs;
  // `node:sqlite` is absent on some runtimes (packaged Electron, older Node).
  const sqlite = options.sqlite !== undefined
    ? options.sqlite
    : (() => { try { return require('node:sqlite'); } catch { return null; } })();
  const candidates = options.candidates || mimoDesktopCookieCandidates(options);
  if (!candidates.length) throw errorWithStatus('notConfigured', 'MiMo Desktop does not run on this platform');

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
    // A store we cannot even inspect may still exist, so retain last-good data.
    if (statFailure) throw errorWithStatus('unavailable', 'MiMo Desktop cookie store could not be read');
    throw errorWithStatus('notConfigured', 'MiMo Desktop cookie store not found');
  }
  if (typeof sqlite?.DatabaseSync !== 'function') {
    throw errorWithStatus('notConfigured', 'node:sqlite is unavailable in this runtime');
  }

  let rows;
  try {
    rows = readAccountCookieRows(dbPath, sqlite);
  } catch (_) {
    // The store is there and could not be read: a lock, a permission, a corrupt
    // database. That keeps the previous reading rather than clearing it.
    throw errorWithStatus('unavailable', 'MiMo Desktop cookie store could not be read');
  }

  const values = new Map();
  const sealedNames = new Set();
  for (const row of rows || []) {
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    if (value) {
      values.set(row.name, value);
      continue;
    }
    if (row?.encrypted_value && row.encrypted_value.length > 0) sealedNames.add(row.name);
  }
  const missingNames = MIMO_ACCOUNT_COOKIE_NAMES.filter((name) => !values.has(name));
  if (missingNames.some((name) => sealedNames.has(name))) {
    throw errorWithStatus('notConfigured', 'MiMo Desktop stores this cookie encrypted');
  }

  const userId = values.get('userId') || '';
  // Never carrying either cookie is an app nobody signed into — the same answer
  // as no store. Half of one is a session that ended, and the account id travels
  // with the refusal so the caller can attribute the row.
  if (!values.size) throw errorWithStatus('notConfigured', 'MiMo Desktop has never been signed in');
  if (missingNames.length) {
    const refused = errorWithStatus('unauthorized', 'MiMo Desktop session is incomplete');
    refused.userId = userId;
    throw refused;
  }

  return {
    userId,
    cookieHeader: MIMO_ACCOUNT_COOKIE_NAMES.map((name) => `${name}=${values.get(name)}`).join('; ')
  };
}

module.exports = {
  MIMO_ACCOUNT_COOKIE_NAMES,
  mimoDesktopCookieCandidates,
  readMimoDesktopAccount
};
