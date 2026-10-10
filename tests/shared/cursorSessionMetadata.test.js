'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { resolveSessionMetadata } = require('../../src/shared/providers/cursor/sessionMetadata');
const { sessionActivityState } = require('../../src/shared/sessionLive');

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

test('Cursor does not reopen the database for sessions the fingerprint already missed', () => {
  // A header-less session used to pay open + sqlite_master + per-id SELECT +
  // legacy check on every watch tick even while the database sat unchanged.
  // A definitive miss is an answer too, so the second lookup on the same DB
  // stamp must never touch SQLite — only failed reads retry.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-miss-'));
  const dbDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.vscdb');
  fs.writeFileSync(dbPath, 'stub');
  let opens = 0;
  let queries = 0;
  const fakeSqlite = {
    DatabaseSync: class {
      constructor() { opens += 1; }
      prepare(sql) {
        return {
          get: () => {
            queries += 1;
            if (sql.includes('sqlite_master')) return { 1: 1 };
            return undefined;
          }
        };
      }
      exec() {}
      close() {}
    }
  };

  const deps = { platform: 'darwin', sqlite: fakeSqlite, cursorTitleCache: new Map() };
  const first = resolveSessionMetadata(new Set(['no-header']), { home, deps });
  assert.equal(first.size, 0);
  assert.equal(opens, 1);

  const second = resolveSessionMetadata(new Set(['no-header']), { home, deps });
  assert.equal(second.size, 0);
  assert.equal(opens, 1, 'a definitive miss is cached per fingerprint, so the DB is not reopened');
  assert.ok(queries > 0);
});

test('Cursor WAL turn boundaries stop and reopen the indicator without changing accounting', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turns-'));
  const dbPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('s1', JSON.stringify({ name: 'Local turn' }));
  const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const now = Date.now();
  const row = { client: 'cursor', sessionId: 's1', totalTokens: 123, costUsd: 0.45,
    lastUsedAt: new Date(now - 3600_000).toISOString(), models: { model: { totalTokens: 123 } } };
  const periods = { today: { sessions: { 'cursor:s1': row } } };
  const deps = { platform: 'darwin', sqlite, cursorTitleCache: new Map(), metadataCache: new Map(), now };
  const update = (state) => {
    put.run('composerData:s1', Buffer.from(JSON.stringify({ composerId: 's1', ...state })));
    applySessionMetadata(periods, home, deps);
    assert.equal(row.totalTokens, 123);
    assert.equal(row.costUsd, 0.45);
    assert.deepEqual(row.models, { model: { totalTokens: 123 } });
    return sessionActivityState(row, now);
  };
  assert.equal(update({ status: 'aborted', unfinishedRunAt: now - 1000 }), 'running', 'persisted local generating state');
  assert.equal(update({ status: 'completed' }), 'ended', 'completion stops immediately after reading, inside the time window');
  assert.equal(update({ status: 'generating', lastUpdatedAt: now }), 'running', 'a subsequent prompt clears the old completion');
  assert.equal(update({ status: 'aborted' }), 'ended', 'cancellation stops the indicator');
  assert.equal(update({ status: 'aborted', unfinishedRunAt: now }), 'running');
  assert.equal(sessionActivityState(row, now + 11 * 60_000), 'idle', 'stale unfinished markers do not stay running');
});

test('Cursor rejects mismatched, missing and invalid turn identities and unknown states', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-identity-'));
  const dbPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const records = {
    mismatch: { composerId: 'other', status: 'completed' },
    missing: { status: 'generating' },
    unknown: { composerId: 'unknown', status: 'future-state' },
    none: { composerId: 'none', status: 'none' },
    valid: { composerId: 'valid', status: 'completed', text: 'private text is not returned' },
    malformed: '{broken'
  };
  for (const [id, value] of Object.entries(records)) put.run(`composerData:${id}`, typeof value === 'string' ? value : JSON.stringify(value));
  const deps = { platform: 'linux', sqlite, cursorTitleCache: new Map() };
  const read = () => resolveSessionMetadata(new Set(Object.keys(records)), { home, deps });
  assert.deepEqual([...read()], [['valid', { turnEnded: true }]], 'turns do not require a named header');
  assert.deepEqual([...read()], [['valid', { turnEnded: true }]], 'cached answers retain only scalars');
});

test('Cursor future activity timestamps cannot extend the running window', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-future-turn-'));
  const dbPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const now = Date.now();
  const future = now + 3600_000;
  const deps = { platform: 'linux', sqlite, now, cursorTitleCache: new Map(), metadataCache: new Map() };
  for (const state of [
    { status: 'aborted', unfinishedRunAt: future },
    { status: 'generating', lastUpdatedAt: future }
  ]) {
    const row = { client: 'cursor', sessionId: 's1', lastUsedAt: new Date(now).toISOString() };
    const periods = { today: { sessions: { 'cursor:s1': row } } };
    deps.now = now;
    put.run('composerData:s1', JSON.stringify({ composerId: 's1', ...state }));
    applySessionMetadata(periods, home, deps);
    assert.equal(row.lastUsedAt, new Date(now).toISOString(), 'future editor time does not replace usage time');
    assert.equal(sessionActivityState(row, now), 'running');
    deps.now = now + 11 * 60_000;
    // Even an unrelated WAL invalidation must not renew the same future marker.
    put.run('composerData:other', JSON.stringify({ composerId: 'other', ...state }));
    applySessionMetadata(periods, home, deps);
    assert.equal(sessionActivityState(row, deps.now), 'idle');
  }
});

for (const named of [false, true]) {
  test(`Cursor definitive unknown reads clear cached ${named ? 'named' : 'headerless'} boundaries but failed reads do not`, { skip: !sqlite }, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-clear-boundary-'));
    const dbPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
    if (named) db.prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('s1', JSON.stringify({ name: 'Original title' }));
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    const put = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
    let fail = false;
    let opens = 0;
    const countedSqlite = { DatabaseSync: class {
      constructor(...args) { opens++; this.db = new sqlite.DatabaseSync(...args); }
      exec(...args) { return this.db.exec(...args); }
      prepare(sql) {
        if (fail && sql.includes('FROM cursorDiskKV')) throw new Error('SQLITE_BUSY');
        return this.db.prepare(sql);
      }
      close() { this.db.close(); }
    } };
    const now = Date.now();
    const row = { client: 'cursor', sessionId: 's1', lastUsedAt: new Date(now).toISOString(), totalTokens: 123, costUsd: 0.45 };
    const periods = { today: { sessions: { 'cursor:s1': row } } };
    const deps = { platform: 'linux', sqlite: countedSqlite, now, cursorTitleCache: new Map(), metadataCache: new Map(), retryMisses: true };
    for (const record of [
      { composerId: 's1', status: 'future-state' },
      { composerId: 'other', status: 'completed' },
      '{broken',
      null
    ]) {
      put.run('composerData:s1', JSON.stringify({ composerId: 's1', status: 'completed' }));
      applySessionMetadata(periods, home, deps);
      assert.equal(sessionActivityState(row, now), 'ended');
      if (named) db.prepare('UPDATE composerHeaders SET value = ? WHERE composerId = ?').run(JSON.stringify({ name: 'Updated title' }), 's1');
      if (record === null) db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run('composerData:s1');
      else put.run('composerData:s1', typeof record === 'string' ? record : JSON.stringify(record));
      fail = true;
      applySessionMetadata(periods, home, deps);
      assert.equal(row.turnEnded, true, 'a transient SQL failure preserves the previous boundary');
      assert.equal(sessionActivityState(row, now), 'ended');
      if (named) assert.equal(row.title, 'Updated title', 'title updates survive a failed state read');
      fail = false;
      applySessionMetadata(periods, home, deps);
      assert.equal(row.turnEnded, undefined, 'a successful null read clears the previous boundary');
      assert.equal(deps.metadataCache.get('cursor:s1').turnEnded, undefined);
      assert.equal(sessionActivityState(row, now), 'running', 'fresh usage falls back normally');
      assert.equal(row.totalTokens, 123);
      assert.equal(row.costUsd, 0.45);
      const previousOpens = opens;
      applySessionMetadata(periods, home, deps);
      assert.equal(opens, previousOpens, 'the unchanged definitive answer is cached');
    }
  });
}

test('Cursor retries a transient turn read without waiting for another WAL change', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-turn-retry-'));
  const dbPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('s1', JSON.stringify({ name: 'Known title' }));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:s1', JSON.stringify({ composerId: 's1', status: 'completed' }));
  let fail = true;
  let opens = 0;
  const flakySqlite = { DatabaseSync: class {
    constructor(...args) { opens++; this.db = new sqlite.DatabaseSync(...args); }
    exec(...args) { return this.db.exec(...args); }
    prepare(sql) {
      if (fail && sql.includes('FROM cursorDiskKV')) throw new Error('SQLITE_BUSY');
      return this.db.prepare(sql);
    }
    close() { this.db.close(); }
  } };
  const deps = { platform: 'linux', sqlite: flakySqlite, cursorTitleCache: new Map() };
  const read = () => resolveSessionMetadata(new Set(['s1']), { home, deps }).get('s1');
  assert.deepEqual(read(), { title: 'Known title' });
  fail = false;
  assert.deepEqual(read(), { title: 'Known title', turnEnded: true });
  assert.equal(opens, 2);
  assert.deepEqual(read(), { title: 'Known title', turnEnded: true });
  assert.equal(opens, 2, 'unchanged successful state reads reuse the existing fingerprint cache');
});

test('Cursor skips old composer payloads but resumes them when their header changes', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-history-turns-'));
  const dbPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const putHeader = db.prepare('INSERT OR REPLACE INTO composerHeaders VALUES (?, ?)');
  const putState = db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)');
  const now = Date.now();
  for (const id of ['old', 'recent']) {
    putHeader.run(id, JSON.stringify({ name: id, lastUpdatedAt: now - (id === 'old' ? 86400_000 : 0) }));
    putState.run(`composerData:${id}`, JSON.stringify({ composerId: id, status: 'aborted', unfinishedRunAt: now }));
  }
  let stateReads = 0;
  const countedSqlite = { DatabaseSync: class {
    constructor(...args) { this.db = new sqlite.DatabaseSync(...args); }
    exec(...args) { return this.db.exec(...args); }
    prepare(sql) {
      const statement = this.db.prepare(sql);
      return { get: (...args) => { if (sql.includes('FROM cursorDiskKV')) stateReads++; return statement.get(...args); } };
    }
    close() { this.db.close(); }
  } };
  const deps = { platform: 'linux', sqlite: countedSqlite, cursorTitleCache: new Map() };
  const read = () => resolveSessionMetadata(new Set(['old', 'recent']), { home, deps, now });
  assert.deepEqual(read().get('old'), { title: 'old' });
  assert.equal(stateReads, 1, 'history titles are read, history payloads are not');
  read();
  assert.equal(stateReads, 1, 'unchanged DB does not reread either payload');
  const freshUsage = { today: { sessions: { 'cursor:old': { lastUsedAt: new Date(now).toISOString() } } } };
  assert.equal(resolveSessionMetadata(new Set(['old']), { home, deps, now, periods: freshUsage }).get('old').turnEnded, false,
    'delayed cloud usage admits a previously skipped payload even without a WAL change');
  assert.equal(stateReads, 2);
  putHeader.run('old', JSON.stringify({ name: 'resumed', lastUpdatedAt: now }));
  const resumed = read().get('old');
  assert.equal(resumed.turnEnded, false);
  assert.equal(resumed.title, 'resumed');
  assert.equal(stateReads, 4, 'WAL invalidation admits the resumed historical ID');
  putHeader.run('old', JSON.stringify({ name: 'long turn', lastUpdatedAt: now - 86400_000 }));
  putState.run('composerData:old', JSON.stringify({ composerId: 'old', status: 'completed' }));
  const periods = { today: { sessions: { 'cursor:old': { lastUsedAt: new Date(now).toISOString() } } } };
  assert.equal(resolveSessionMetadata(new Set(['old']), { home, deps, now, periods }).get('old').turnEnded, true,
    'recent usage still reads completion when a long turn has an older prompt timestamp');
});
