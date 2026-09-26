'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MIMO_ACCOUNT_COOKIE_NAMES,
  MIMO_DESKTOP_READ_REASONS,
  mimoDesktopCookieCandidates,
  readMimoDesktopAccount
} = require('../../src/shared/providers/mimo/desktopSession');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const hasSqlite = typeof sqlite?.DatabaseSync === 'function';

// The store's real shape, measured on the machine this was built against: the
// account cookies sit on `.account.xiaomi.com` alone, `.xiaomi.com` carries a
// second `cUserId` beside its own rows, and the same partition also holds a full
// set of unrelated Tencent login cookies. Values here are synthetic; the hosts,
// names, count and plaintext-ness are not.
const PARTITION_ROWS = [
  ['.account.xiaomi.com', 'cUserId', 'account-cuser-id'],
  ['.account.xiaomi.com', 'passToken', 'account-pass-token'],
  ['.account.xiaomi.com', 'userId', '1234567890'],
  ['.graph.qq.com', 'ui', 'qq-ui'],
  ['.ptlogin2.qq.com', 'pt2gguin', 'qq-guin'],
  ['.ptlogin2.qq.com', 'pt_guid_sig', 'qq-guid-sig'],
  ['.ptlogin2.qq.com', 'pt_recent_uins', 'qq-recent-uins'],
  ['.qq.com', 'RK', 'qq-rk'],
  ['.qq.com', 'ptcz', 'qq-ptcz'],
  ['.qq.com', 'qlogin_uid', 'qq-qlogin-uid'],
  ['.xiaomi.com', 'cUserId', 'platform-cuser-id'],
  ['.xiaomi.com', 'uLocale', 'en_US'],
  ['.xui.ptlogin2.qq.com', '__aegis_uid', 'qq-aegis']
];

function writeCookieStore(dir, rows = PARTITION_ROWS, overrides = {}) {
  const dbPath = path.join(dir, 'Cookies');
  fs.mkdirSync(dir, { recursive: true });
  const database = new sqlite.DatabaseSync(dbPath);
  try {
    database.exec(`CREATE TABLE cookies (
      creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT,
      value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER,
      has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER,
      source_scheme INTEGER, source_port INTEGER, last_update_utc INTEGER,
      source_type INTEGER, has_cross_site_ancestor INTEGER)`);
    const insert = database.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)');
    for (const [host, name, value] of rows) {
      const sealed = overrides.seal?.includes(name);
      insert.run(host, name, sealed ? '' : value, sealed ? Buffer.from('v10sealed-envelope') : null);
    }
  } finally {
    database.close();
  }
  return dbPath;
}

function partitionDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-desktop-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'Partitions', 'xiaomi-account');
}

test('the account cookies are carried and nothing else in the store is', { skip: !hasSqlite }, (t) => {
  const dir = partitionDir(t);
  writeCookieStore(dir);

  const read = readMimoDesktopAccount({ candidates: [path.join(dir, 'Cookies')], sqlite });
  assert.equal(read.ok, true);
  // Exactly the allowlist, in its own order — not the store's.
  assert.equal(read.cookieHeader, 'passToken=account-pass-token; userId=1234567890');
  assert.equal(read.userId, '1234567890');

  // The partition is not only MiMo's. A read that swept the store, or a
  // forward list wider than the allowlist, would put another service's session
  // on a Xiaomi request.
  const forwarded = read.cookieHeader.split('; ').map((pair) => pair.split('=')[0]);
  assert.ok(forwarded.every((name) => MIMO_ACCOUNT_COOKIE_NAMES.includes(name)));
  for (const foreign of ['ui', 'pt2gguin', 'pt_guid_sig', 'RK', 'ptcz', 'qlogin_uid', '__aegis_uid', 'uLocale', 'cUserId']) {
    assert.equal(read.cookieHeader.includes(foreign), false, `${foreign} must not be carried`);
  }
});

test('a store whose rows arrive sealed is refused rather than read as signed out', { skip: !hasSqlite }, (t) => {
  const dir = partitionDir(t);
  writeCookieStore(dir, PARTITION_ROWS, { seal: ['passToken', 'userId'] });

  const read = readMimoDesktopAccount({ candidates: [path.join(dir, 'Cookies')], sqlite });
  // The at-rest key belongs to the app's own runtime; reporting this as a
  // signed-out app would send the user to a sign-in that cannot change it.
  assert.deepEqual(read, { ok: false, reason: MIMO_DESKTOP_READ_REASONS.encrypted });
});

test('half a sign-in is a signed-out app and a missing store is nothing configured', { skip: !hasSqlite }, (t) => {
  const dir = partitionDir(t);
  writeCookieStore(dir, PARTITION_ROWS.filter(([, name]) => name !== 'userId'));

  assert.deepEqual(
    readMimoDesktopAccount({ candidates: [path.join(dir, 'Cookies')], sqlite }),
    { ok: false, reason: MIMO_DESKTOP_READ_REASONS.incomplete }
  );
  assert.deepEqual(
    readMimoDesktopAccount({ candidates: [path.join(dir, 'missing', 'Cookies')], sqlite }),
    { ok: false, reason: MIMO_DESKTOP_READ_REASONS.absent }
  );
});

test('a runtime without node:sqlite reports that instead of throwing', (t) => {
  const dir = partitionDir(t);
  writeCookieStore(dir);
  assert.deepEqual(
    readMimoDesktopAccount({ candidates: [path.join(dir, 'Cookies')], sqlite: null }),
    { ok: false, reason: MIMO_DESKTOP_READ_REASONS.sqliteUnavailable }
  );
});

test('the partition resolves on macOS and Windows and nowhere else', () => {
  const home = '/Users/fixture';
  assert.deepEqual(mimoDesktopCookieCandidates({ home, platform: 'darwin' }), [
    path.join(home, 'Library', 'Application Support', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Cookies')
  ]);
  assert.deepEqual(
    mimoDesktopCookieCandidates({ home, platform: 'win32', env: { APPDATA: '/Users/fixture/Roaming' } }),
    [
      path.join('/Users/fixture/Roaming', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Cookies'),
      path.join(home, 'AppData', 'Roaming', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Cookies')
    ]
  );
  assert.deepEqual(mimoDesktopCookieCandidates({ home, platform: 'linux', env: {} }), []);
  assert.deepEqual(
    readMimoDesktopAccount({ platform: 'linux', home, env: {} }),
    { ok: false, reason: MIMO_DESKTOP_READ_REASONS.unsupportedPlatform }
  );
});
