'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMimoAccountMetadataReader } = require('../../src/electron/providers/mimo/accountMetadata');
const { readMimoDesktopAccount } = require('../../src/shared/providers/mimo/desktop');
const { fetchMimoLimits, mimoAccountKey } = require('../../src/shared/providers/mimo/limits');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { /* Same runtime boundary as the Desktop reader. */ }

(sqlite ? test : test.skip)('MiMo Settings caches only identity, invalidates on WAL/path changes and retries empty or failed reads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-account-metadata-'));
  const file = path.join(root, 'Cookies');
  const database = new sqlite.DatabaseSync(file);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)');
  const insert = database.prepare('INSERT INTO cookies VALUES (?, ?, ?, NULL)');
  let revision = 0;
  function writeAccount(userId, token = 'private-cookie') {
    database.exec('DELETE FROM cookies');
    if (userId) {
      insert.run('.account.xiaomi.com', 'userId', userId);
      if (token) insert.run('.account.xiaomi.com', 'passToken', token);
    }
    fs.utimesSync(`${file}-wal`, new Date(), new Date(Date.UTC(2026, 9, 4) + ++revision * 1000));
  }
  let opens = 0;
  let failure = false;
  let candidates = [file];
  const read = createMimoAccountMetadataReader({
    cookieCandidates: () => candidates,
    readAccount: (options) => {
      opens += 1;
      if (failure) throw new Error('reader unavailable');
      return readMimoDesktopAccount({ ...options, sqlite });
    }
  });
  writeAccount('42');
  for (let i = 0; i < 10; i += 1) assert.equal(read(), mimoAccountKey('', { userId: '42' }));
  assert.equal(opens, 1, 'unrelated Settings reads open the healthy store once');

  const dbStamp = fs.statSync(file).mtimeMs;
  writeAccount('7', 'rotated-cookie');
  assert.equal(fs.statSync(file).mtimeMs, dbStamp, 'the account switch lives only in WAL');
  const cookies = [];
  await fetchMimoLimits({}, {
    desktopSessionOptions: { candidates: [file], sqlite },
    fetch: async (url, init) => {
      const accountHost = new URL(url).hostname === 'account.xiaomi.com';
      if (accountHost) cookies.push(init.headers.Cookie || init.headers.cookie || '');
      return {
        status: 401,
        text: async () => accountHost ? '' : JSON.stringify({ loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' })
      };
    }
  });
  assert.ok(cookies.length > 0);
  assert.ok(cookies.every((cookie) => cookie.includes('userId=7') && cookie.includes('rotated-cookie')));
  assert.equal(opens, 1, 'quota collection reads its own current credentials');
  assert.equal(read(), mimoAccountKey('', { userId: '7' }));
  assert.equal(opens, 2);

  writeAccount('');
  assert.equal(read(), '');
  assert.equal(read(), '');
  assert.equal(opens, 4, 'empty results are not retained');
  writeAccount('42', '');
  assert.equal(read(), '');
  assert.equal(read(), '');
  assert.equal(opens, 6, 'an incomplete session is not retained');

  writeAccount('42');
  failure = true;
  assert.equal(read(), '');
  assert.equal(read(), '');
  failure = false;
  assert.equal(read(), mimoAccountKey('', { userId: '42' }), 'recovery needs no file change');
  candidates = [path.join(root, 'missing-store')];
  assert.equal(read(), '');
  candidates = [file];
  assert.equal(read(), mimoAccountKey('', { userId: '42' }));

  const stat = fs.statSync;
  let denied = true;
  t.mock.method(fs, 'statSync', (candidate, ...args) => {
    if (candidate === file && denied) throw Object.assign(new Error('temporary inspection failure'), { code: 'EACCES' });
    return stat(candidate, ...args);
  });
  assert.equal(read(), '');
  denied = false;
  assert.equal(read(), mimoAccountKey('', { userId: '42' }));
});
