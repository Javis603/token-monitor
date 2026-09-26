'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The app's own Electron session partition. It is a Chromium SQLite cookie
// store, so the read is a read-only DatabaseSync open — the shape
// providers/cursor/auth.js already establishes for another app's SQLite store.
//
// The three pieces of this path are each confirmed against the app rather than
// assumed: `persist:xiaomi-account` is a literal in its main bundle and every
// account call goes through `session.fromPartition` on it; `Partitions/<name>/`
// under the userData root is Electron's rule for a `persist:` partition; and the
// root is `<appData>/Xiaomi MiMo` because the app declares
// `productName: "Xiaomi MiMo"` and never calls `app.setName` or
// `app.setPath('userData')`, so Electron's default applies. macOS is the one
// measured on disk; Windows follows from the same rule and the app carries its
// own win32 branches, while Linux resolves nothing — there is no evidence the
// desktop app ships there, and a wrong path would only ever read some other
// install's cookies.
const MIMO_PARTITION_DIR = path.join('Partitions', 'xiaomi-account');
const MIMO_COOKIE_FILE = 'Cookies';

// The account cookies are host-scoped, and this is the only host carrying them.
// Selecting by cookie name alone is ambiguous: `.xiaomi.com` holds its own
// `cUserId`, and the same store also carries a full set of unrelated third-party
// login cookies, so the read is scoped rather than swept and nothing outside the
// allowlist below can reach a request.
const MIMO_ACCOUNT_COOKIE_HOST = '.account.xiaomi.com';

// Dropping either one stops the exchange at the login page and mints nothing.
// `cUserId` is deliberately absent: dropping it was measured to change nothing,
// so it is not carried. This allowlist is not the console lane's — that one
// requires `api-platform_serviceToken`, which does not exist on this host and
// must not be produced by a read of it.
const MIMO_ACCOUNT_COOKIE_NAMES = Object.freeze(['passToken', 'userId']);

const MIMO_DESKTOP_READ_REASONS = Object.freeze({
  unsupportedPlatform: 'unsupported-platform',
  sqliteUnavailable: 'sqlite-unavailable',
  absent: 'absent',
  encrypted: 'encrypted',
  incomplete: 'incomplete'
});

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

function readCookieRows(dbPath, sqlite) {
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

// Reads the account cookie the signed-in MiMo Desktop already holds. Nothing is
// written back to the partition and no value leaves this function except the two
// allowlisted cookies, which live only as long as the exchange that consumes
// them.
//
// The refusals are told apart because they ask for different answers: a machine
// with no store has nothing configured, while a store that reads and carries
// half a sign-in is an app the user is signed out of.
function readMimoDesktopAccount(options = {}) {
  const fsApi = options.fs || fs;
  // `node:sqlite` is absent on some runtimes (packaged Electron builds, older
  // Node), and that is a state this reader reports rather than throws on.
  const sqlite = options.sqlite !== undefined
    ? options.sqlite
    : (() => { try { return require('node:sqlite'); } catch { return null; } })();
  const candidates = options.candidates || mimoDesktopCookieCandidates(options);
  if (!candidates.length) return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.unsupportedPlatform };

  const dbPath = candidates.find((candidate) => {
    try {
      return fsApi.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  });
  if (!dbPath) return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.absent };
  if (typeof sqlite?.DatabaseSync !== 'function') {
    return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.sqliteUnavailable };
  }

  let rows;
  try {
    rows = readCookieRows(dbPath, sqlite);
  } catch (_) {
    return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.absent };
  }

  const values = new Map();
  let sealed = false;
  for (const row of rows) {
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    if (!value) {
      // A row that exists but arrives sealed is not a signed-out app; the at-rest
      // key belongs to the app's own runtime and no supported surface exposes it.
      if (row?.encrypted_value && row.encrypted_value.length > 0) sealed = true;
      continue;
    }
    values.set(row.name, value);
  }

  const missing = MIMO_ACCOUNT_COOKIE_NAMES.filter((name) => !values.has(name));
  // The account id travels with every refusal it can: a refusal the lanes cannot
  // attribute to an account would have to be reported provider-wide, and a
  // provider-wide row is read as the whole provider's.
  const userId = values.get('userId') || '';
  if (missing.length === MIMO_ACCOUNT_COOKIE_NAMES.length && sealed) {
    return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.encrypted, userId };
  }
  if (missing.length) return { ok: false, reason: MIMO_DESKTOP_READ_REASONS.incomplete, userId };

  return {
    ok: true,
    userId: values.get('userId'),
    cookieHeader: MIMO_ACCOUNT_COOKIE_NAMES.map((name) => `${name}=${values.get(name)}`).join('; ')
  };
}

module.exports = {
  MIMO_ACCOUNT_COOKIE_NAMES,
  MIMO_DESKTOP_READ_REASONS,
  mimoDesktopCookieCandidates,
  readMimoDesktopAccount
};
