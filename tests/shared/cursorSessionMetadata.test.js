'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { resolveSessionMetadata } = require('../../src/shared/providers/cursor/sessionMetadata');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

test('Cursor joins desktop header names by conversation id and sees later renames', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-titles-'));
  const dbPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  // Windows cannot remove the temp dir while the handle is open, so one
  // teardown closes before unlinking; separate t.after hooks would run the
  // removal first.
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  const put = db.prepare('INSERT OR REPLACE INTO composerHeaders (composerId, value) VALUES (?, ?)');
  put.run('session-1', JSON.stringify({ name: '  Model   inquiry  ' }));
  put.run('session-2', '{malformed');
  put.run('session-3', JSON.stringify({ name: 'Unrelated' }));

  const cache = new Map();
  const deps = { platform: 'darwin', sqlite, cursorTitleCache: cache };
  const read = () => resolveSessionMetadata(new Set(['session-1', 'session-2', 'missing']), { home, deps });
  assert.deepEqual([...read()], [['session-1', { title: 'Model inquiry' }]]);

  const periods = { today: { sessions: {
    'cursor:session-1': { client: 'cursor', sessionId: 'session-1' },
    'cursor:missing': { client: 'cursor', sessionId: 'missing' }
  } } };
  const metadataCache = new Map();
  const sharedDeps = { ...deps, metadataCache, resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(), retryMisses: true };
  applySessionMetadata(periods, home, sharedDeps);
  assert.equal(periods.today.sessions['cursor:session-1'].title, 'Model inquiry');
  assert.equal(periods.today.sessions['cursor:missing'].title, undefined);

  put.run('session-1', JSON.stringify({ name: 'Renamed conversation with a longer title' }));
  applySessionMetadata(periods, home, sharedDeps);
  assert.equal(periods.today.sessions['cursor:session-1'].title, 'Renamed conversation with a longer title');
});

test('Cursor falls back to the legacy ItemTable composer index for old schemas', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-legacy-titles-'));
  const dbPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // Old schema: no composerHeaders table, only the ItemTable index key.
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerHeaders',
    JSON.stringify({ allComposers: [
      { composerId: 'old-session', name: 'Legacy named chat' },
      { composerId: 'unnamed', name: '' }
    ] })
  );

  const deps = { platform: 'darwin', sqlite, cursorTitleCache: new Map() };
  const resolved = resolveSessionMetadata(new Set(['old-session', 'unnamed', 'missing']), { home, deps });
  assert.deepEqual([...resolved], [['old-session', { title: 'Legacy named chat' }]]);
});

test('Cursor legacy index fills ids the current table cannot answer', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-legacy-gap-'));
  const dbPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // A migrated install can hold both shapes. The current table's malformed or
  // empty-named rows must not block the legacy index for the same id.
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const put = db.prepare('INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)');
  put.run('broken', '{malformed');
  put.run('empty', JSON.stringify({ name: '' }));
  put.run('modern', JSON.stringify({ name: 'Current title wins' }));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerHeaders',
    JSON.stringify({ allComposers: [
      { composerId: 'broken', name: 'Legacy broken name' },
      { composerId: 'empty', name: 'Legacy empty-gap name' },
      { composerId: 'modern', name: 'Legacy stale name' }
    ] })
  );

  const deps = { platform: 'darwin', sqlite, cursorTitleCache: new Map() };
  const resolved = resolveSessionMetadata(new Set(['broken', 'empty', 'modern']), { home, deps });
  assert.deepEqual([...resolved], [
    ['broken', { title: 'Legacy broken name' }],
    ['empty', { title: 'Legacy empty-gap name' }],
    ['modern', { title: 'Current title wins' }]
  ]);
});

test('Cursor retries a failed header read instead of pinning the legacy title', () => {
  // First lookup: the current-table row read throws; the legacy index still
  // answers so this call may show the old name, but it must not be cached.
  // Second lookup (same DB stamp): the row read succeeds and the current
  // title wins.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-retry-'));
  const dbDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.vscdb');
  fs.writeFileSync(dbPath, 'stub');
  const legacyValue = JSON.stringify({ allComposers: [{ composerId: 's1', name: 'Old name' }] });
  let failGets = true;
  const fakeSqlite = {
    DatabaseSync: class {
      prepare(sql) {
        if (sql.includes('sqlite_master')) return { get: () => ({ 1: 1 }) };
        if (sql.includes('ItemTable')) return { get: () => ({ value: legacyValue }) };
        return {
          get: () => {
            if (failGets) throw new Error('SQLITE_BUSY');
            return { value: JSON.stringify({ name: 'New name' }) };
          }
        };
      }
      exec() {}
      close() {}
    }
  };

  const deps = { platform: 'darwin', sqlite: fakeSqlite, cursorTitleCache: new Map() };
  const first = resolveSessionMetadata(new Set(['s1']), { home, deps });
  assert.equal(first.get('s1')?.title, 'Old name', 'a failed modern read may show the legacy title once');

  failGets = false;
  const second = resolveSessionMetadata(new Set(['s1']), { home, deps });
  assert.equal(second.get('s1')?.title, 'New name', 'the legacy title must not pin the id against a later modern read');
});
