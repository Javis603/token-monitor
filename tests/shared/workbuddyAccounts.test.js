'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  accountMapFromRows,
  applyWorkbuddyAccountKeys,
  parseSqliteJsonRows,
  readWorkbuddyAccountMap,
  resetWorkbuddyAccountMapCache,
  workbuddyAccountKey,
  workbuddyDbPath
} = require('../../src/shared/workbuddyAccounts');

function workbuddySession(client, sessionId, extra = {}) {
  return { client, sessionId, totalTokens: 100, costUsd: 0.01, ...extra };
}

function createWorkbuddyFixtureDb(dir, rows) {
  const home = fs.mkdtempSync(path.join(dir, 'workbuddy-home-'));
  const dbDir = path.join(home, '.workbuddy');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'workbuddy.db');
  const database = new sqlite.DatabaseSync(dbPath);
  database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT)');
  const insert = database.prepare('INSERT INTO sessions VALUES (?, ?)');
  for (const [id, userId] of rows) insert.run(id, userId);
  database.close();
  return { home, dbPath };
}

test('workbuddyAccountKey keeps identifier-shaped ids and collapses anything else', () => {
  assert.equal(workbuddyAccountKey('user-123_abc'), 'user-123_abc');
  assert.equal(workbuddyAccountKey('  7012345678901234567  '), '7012345678901234567');
  assert.equal(workbuddyAccountKey(''), '');
  assert.equal(workbuddyAccountKey(null), '');
  // Non-identifier punctuation collapses to its alphanumeric prefix.
  assert.equal(workbuddyAccountKey('ou_腾讯用户!'), 'ou');
});

test('accountMapFromRows maps sessions to accounts and drops unusable rows', () => {
  const map = accountMapFromRows([
    { id: 'session-1', user_id: 'user-a' },
    { id: 'session-2', user_id: 'user-b' },
    { id: 'session-3', user_id: '' },
    { id: '', user_id: 'user-a' },
    { id: 'session-4', user_id: '  user-c  ' },
    null
  ]);
  assert.equal(map.size, 3);
  assert.equal(map.get('session-1'), 'user-a');
  assert.equal(map.get('session-2'), 'user-b');
  assert.equal(map.get('session-4'), 'user-c');
});

test('parseSqliteJsonRows parses the sqlite3 CLI -json output shape', () => {
  assert.deepEqual(parseSqliteJsonRows('[{"id":"s1","user_id":"u1"}]'), [{ id: 's1', user_id: 'u1' }]);
  assert.deepEqual(parseSqliteJsonRows('  []  '), []);
  assert.deepEqual(parseSqliteJsonRows(''), []);
  assert.deepEqual(parseSqliteJsonRows(null), []);
  assert.deepEqual(parseSqliteJsonRows('{"object":true}'), []);
});

test('applyWorkbuddyAccountKeys tags only untagged workbuddy sessions', () => {
  const today = {
    sessions: {
      'workbuddy:s1': workbuddySession('workbuddy', 's1'),
      'workbuddy:s2': workbuddySession('workbuddy', 's2', { accountKey: 'user-kept' }),
      'workbuddy:s3': workbuddySession('workbuddy', 's3'),
      'claude:c1': workbuddySession('claude', 'c1')
    }
  };
  const month = { sessions: { 'workbuddy:s1': workbuddySession('workbuddy', 's1') } };
  applyWorkbuddyAccountKeys({ today, month }, new Map([['s1', 'user-a'], ['s2', 'user-b'], ['s3', '']]));
  assert.equal(today.sessions['workbuddy:s1'].accountKey, 'user-a');
  assert.equal(today.sessions['workbuddy:s2'].accountKey, 'user-kept');
  assert.equal(today.sessions['workbuddy:s3'].accountKey, undefined);
  assert.equal(today.sessions['claude:c1'].accountKey, undefined);
  assert.equal(month.sessions['workbuddy:s1'].accountKey, 'user-a');
});

test('applyWorkbuddyAccountKeys accepts an array of periods and tolerates empty maps', () => {
  const period = { sessions: { 'workbuddy:s1': workbuddySession('workbuddy', 's1') } };
  applyWorkbuddyAccountKeys([period], new Map());
  assert.equal(period.sessions['workbuddy:s1'].accountKey, undefined);
  applyWorkbuddyAccountKeys([period], null);
  assert.equal(period.sessions['workbuddy:s1'].accountKey, undefined);
});

test('applyWorkbuddyAccountKeys skips missing session shapes', () => {
  const period = { sessions: { 'weird': null } };
  applyWorkbuddyAccountKeys([period], new Map([['weird', 'user-a']]));
  assert.equal(period.sessions.weird, null);
});

test('readWorkbuddyAccountMap returns an empty map when the database is missing', async () => {
  resetWorkbuddyAccountMapCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-missing-'));
  const map = await readWorkbuddyAccountMap({ homeDir: home, execFile: null });
  assert.equal(map.size, 0);
});

test('readWorkbuddyAccountMap reads sessions through node:sqlite when sqlite3 CLI is unavailable', { skip: !sqlite }, async () => {
  resetWorkbuddyAccountMapCache();
  const { home } = createWorkbuddyFixtureDb(os.tmpdir(), [
    ['session-1', 'user-a'],
    ['session-2', 'user-b'],
    ['session-3', null]
  ]);
  const map = await readWorkbuddyAccountMap({
    homeDir: home,
    execFile: async () => { throw new Error('sqlite3 unavailable'); }
  });
  assert.equal(map.size, 2);
  assert.equal(map.get('session-1'), 'user-a');
  assert.equal(map.get('session-2'), 'user-b');
  assert.equal(map.has('session-3'), false);
});

test('readWorkbuddyAccountMap prefers sqlite3 CLI json output when it works', async () => {
  resetWorkbuddyAccountMapCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-cli-'));
  const dbPath = workbuddyDbPath({ homeDir: home });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'placeholder');
  const execFile = async (command, args) => {
    assert.equal(command, 'sqlite3');
    assert.ok(args.includes(dbPath));
    assert.ok(args.some((arg) => String(arg).includes('SELECT id, user_id')));
    return { stdout: JSON.stringify([{ id: 'session-1', user_id: 'user-cli' }]) };
  };
  const map = await readWorkbuddyAccountMap({ homeDir: home, execFile });
  assert.equal(map.size, 1);
  assert.equal(map.get('session-1'), 'user-cli');
});

test('readWorkbuddyAccountMap caches per database mtime', async () => {
  resetWorkbuddyAccountMapCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-cache-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-cache-2-'));
  const dbPath = workbuddyDbPath({ homeDir: home });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'placeholder');
  const otherDbPath = workbuddyDbPath({ homeDir: other });
  fs.mkdirSync(path.dirname(otherDbPath), { recursive: true });
  fs.writeFileSync(otherDbPath, 'placeholder');
  let calls = 0;
  const execFile = async () => {
    calls += 1;
    return { stdout: JSON.stringify([{ id: 'session-1', user_id: 'user-a' }]) };
  };
  const first = await readWorkbuddyAccountMap({ homeDir: home, execFile });
  const second = await readWorkbuddyAccountMap({ homeDir: home, execFile });
  assert.equal(calls, 1);
  assert.equal(first.get('session-1'), 'user-a');
  assert.equal(second.get('session-1'), 'user-a');
  // A different home dir (different database path) busts the cache.
  const third = await readWorkbuddyAccountMap({ homeDir: other, execFile });
  assert.equal(calls, 2);
  assert.equal(third.get('session-1'), 'user-a');
  resetWorkbuddyAccountMapCache();
  // An explicit reset also busts the cache.
  await readWorkbuddyAccountMap({ homeDir: home, execFile });
  assert.equal(calls, 3);
});

test('readWorkbuddyAccountMap swallows locked or unreadable databases', async () => {
  resetWorkbuddyAccountMapCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-locked-'));
  const dbPath = workbuddyDbPath({ homeDir: home });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'not a database');
  const map = await readWorkbuddyAccountMap({
    homeDir: home,
    execFile: async () => { throw new Error('sqlite3 unavailable'); },
    requireFn: () => { throw new Error('node:sqlite failed: SQLITE_NOTADB'); }
  });
  assert.equal(map.size, 0);
});
