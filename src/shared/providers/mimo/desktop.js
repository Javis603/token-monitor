'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { errorWithStatus } = require('../../limits/providerHelpers');

// The app's own Electron session partition: `persist:xiaomi-account` is a literal
// in its bundle, and `Partitions/<name>/` under userData is Electron's rule for
// one. The app ships on all three desktop platforms, so each root is Electron's
// rule for that platform rather than a guess — `%APPDATA%` (then Roaming under
// the home directory), `$XDG_CONFIG_HOME` or `~/.config`, Application Support —
// under the `Xiaomi MiMo` root its `productName` gives. macOS is the one measured
// on disk; elsewhere a wrong path reads nothing, the same answer as no store.
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
  const configHome = String(env?.XDG_CONFIG_HOME || '').trim() || path.join(home, '.config');
  return [path.join(configHome, 'Xiaomi MiMo', MIMO_PARTITION_DIR, MIMO_COOKIE_FILE)];
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

// The signed-in MiMo Desktop's account cookie, or the refusal that says which of
// two situations this is — the shape `readClineSession` establishes: a store that
// cannot be read is `notConfigured`, a store that reads and carries half a
// sign-in is `unauthorized`. A sealed row is the first case, never the second:
// at-rest encryption is a property of the store, and reading it as a signed-out
// app would tell a user with a working login to sign in again. Nothing is written
// back, and no value leaves here but the two allowlisted cookies.
function readMimoDesktopAccount(options = {}) {
  const fsApi = options.fs || fs;
  // `node:sqlite` is absent on some runtimes (packaged Electron, older Node).
  const sqlite = options.sqlite !== undefined
    ? options.sqlite
    : (() => { try { return require('node:sqlite'); } catch { return null; } })();
  const candidates = options.candidates || mimoDesktopCookieCandidates(options);
  if (!candidates.length) throw errorWithStatus('notConfigured', 'MiMo Desktop does not run on this platform');

  const dbPath = candidates.find((candidate) => {
    try {
      return fsApi.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  });
  if (!dbPath) throw errorWithStatus('notConfigured', 'MiMo Desktop cookie store not found');
  if (typeof sqlite?.DatabaseSync !== 'function') {
    throw errorWithStatus('notConfigured', 'node:sqlite is unavailable in this runtime');
  }

  let rows;
  try {
    rows = readAccountCookieRows(dbPath, sqlite);
  } catch (_) {
    throw errorWithStatus('notConfigured', 'MiMo Desktop cookie store could not be read');
  }

  const values = new Map();
  let sealed = false;
  for (const row of rows || []) {
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    if (value) {
      values.set(row.name, value);
      continue;
    }
    if (row?.encrypted_value && row.encrypted_value.length > 0) sealed = true;
  }
  if (sealed) throw errorWithStatus('notConfigured', 'MiMo Desktop stores this cookie encrypted');

  const userId = values.get('userId') || '';
  // Never carrying either cookie is an app nobody signed into — the same answer
  // as no store. Half of one is a session that ended, and the account id travels
  // with the refusal so the caller can attribute the row.
  if (!values.size) throw errorWithStatus('notConfigured', 'MiMo Desktop has never been signed in');
  if (values.size < MIMO_ACCOUNT_COOKIE_NAMES.length) {
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
