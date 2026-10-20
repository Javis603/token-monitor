'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { readJson } = require('../../src/shared/config');

const {
  captureSessionUsageArchive,
  writeSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const {
  createSessionUsageArchiveStore,
  readSessionUsageArchiveSnapshot,
  sessionUsageArchiveDatabasePath
} = require('../../src/shared/usage/sessionUsageArchiveStore');

function summary(totalTokens = 100, sessionId = 'one', periodNames = ['today', 'month', 'allTime']) {
  const session = {
    client: 'codex',
    sessionId,
    totalTokens,
    costUsd: totalTokens / 100,
    models: { 'gpt-5': totalTokens },
    modelCosts: { 'gpt-5': totalTokens / 100 }
  };
  return Object.fromEntries(periodNames.map((period) => [period, {
    sessions: { [`codex:${sessionId}`]: { ...session } }
  }]));
}

function databaseWithExecHook(hook) {
  return class HookedDatabaseSync {
    constructor(filePath, options) {
      this.database = options === undefined
        ? new DatabaseSync(filePath)
        : new DatabaseSync(filePath, options);
    }

    exec(sql) {
      hook(sql);
      return this.database.exec(sql);
    }

    prepare(sql) {
      return this.database.prepare(sql);
    }

    close() {
      return this.database.close();
    }
  };
}

function databaseWithRowsHook(hook) {
  return class HookedDatabaseSync {
    constructor(filePath, options) {
      this.database = options === undefined
        ? new DatabaseSync(filePath)
        : new DatabaseSync(filePath, options);
    }

    exec(sql) {
      return this.database.exec(sql);
    }

    prepare(sql) {
      const statement = this.database.prepare(sql);
      if (!/SELECT session_key, entry_json FROM sessions/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property !== 'iterate') {
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return function* (...args) {
            yield* target.iterate(...args);
            hook();
          };
        }
      });
    }

    close() {
      return this.database.close();
    }
  };
}

// Wrap real SQLite cursors rather than materialized fixture rows. A next()
// failure deliberately leaves the native cursor open until return() is called.
function databaseWithIterationHook(hook, cursors = []) {
  return class HookedDatabaseSync extends DatabaseSync {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!/SELECT session_key, entry_json/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'all') return () => assert.fail('session rows must stream');
          if (property !== 'iterate') {
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args) => {
            const native = target.iterate(...args);
            const cursor = { sql, steps: 0, returned: false };
            cursors.push(cursor);
            return {
              [Symbol.iterator]() { return this; },
              next() {
                const row = native.next();
                cursor.steps += 1;
                hook(cursor, row);
                return row;
              },
              return() {
                cursor.returned = true;
                return native.return();
              }
            };
          };
        }
      });
    }
  };
}

function failingCommitDatabase() {
  let failNextCommit = false;
  return {
    DatabaseSync: databaseWithExecHook((sql) => {
      if (!failNextCommit || !/^\s*COMMIT\s*$/i.test(sql)) return;
      failNextCommit = false;
      const error = new Error('write failed');
      error.code = 'EIO';
      throw error;
    }),
    failNextCommit: () => { failNextCommit = true; }
  };
}

function migrationMarker(options) {
  const database = new DatabaseSync(sessionUsageArchiveDatabasePath(options), { readOnly: true });
  try {
    return database.prepare("SELECT value FROM metadata WHERE key = 'legacy-migrated'").get()?.value;
  } finally {
    database.close();
  }
}

test('strict snapshots distinguish absent and genuinely empty archives from read failures', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-strict-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir }, strict: true };
  const writer = createSessionUsageArchiveStore(options);
  const reader = createSessionUsageArchiveStore(options);
  t.after(() => { writer.close(); reader.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(readSessionUsageArchiveSnapshot(options).sessions, {});
  assert.deepEqual(reader.refresh(undefined, { strict: true }).sessions, {});
  assert.equal(fs.existsSync(reader.databasePath), false, 'read-only absent refresh does not create a DB');
  writer.read();
  writer.close();
  assert.deepEqual(readSessionUsageArchiveSnapshot(options).sessions, {});
  class UnreadableDatabase extends DatabaseSync {
    constructor() { throw new Error('temporary EIO'); }
  }
  assert.throws(() => readSessionUsageArchiveSnapshot({ ...options, DatabaseSync: UnreadableDatabase }), /temporary EIO/);
  assert.deepEqual(readSessionUsageArchiveSnapshot({ ...options, strict: false, DatabaseSync: UnreadableDatabase }).sessions, {}, 'legacy best-effort API is unchanged');
});

test('strict legacy reads reject I/O, malformed JSON and invalid shapes without migration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-strict-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir }, strict: true };
  const reader = createSessionUsageArchiveStore(options);
  t.after(() => { reader.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const content of ['{', 'null', '[]', '{"version":2,"sessions":{}}', '{"version":1,"sessions":null}']) {
    fs.writeFileSync(reader.legacyPath, content);
    assert.throws(() => reader.refresh(undefined, { strict: true }));
    assert.equal(fs.readFileSync(reader.legacyPath, 'utf8'), content);
    assert.equal(fs.existsSync(reader.databasePath), false);
  }
  fs.writeFileSync(reader.legacyPath, '{"version":1,"sessions":{}}');
  assert.throws(() => readSessionUsageArchiveSnapshot({ ...options, readFileSync() { throw new Error('temporary EIO'); } }), /temporary EIO/);
  assert.deepEqual(reader.refresh(undefined, { strict: true }).sessions, {});
});

test('strict snapshots refuse an uncommitted migration without a legacy fallback', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-strict-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir }, strict: true };
  const reader = createSessionUsageArchiveStore(options);
  const database = new DatabaseSync(reader.databasePath);
  database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  t.after(() => { reader.close(); database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => reader.refresh(undefined, { strict: true }), /not ready/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM metadata').get().count, 0);
});

test('strict read-only snapshots close failed cursors, reject partial rows and recover', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-strict-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const writer = createSessionUsageArchiveStore(options);
  const now = new Date();
  writer.capture(summary(100, 'one'), now);
  writer.capture(summary(200, 'two'), now);
  writer.close();
  let fail = true;
  const cursors = [];
  const strict = { ...options, strict: true, DatabaseSync: databaseWithIterationHook((cursor) => {
    if (fail && cursor.steps === 2) throw new Error('temporary EIO');
  }, cursors) };
  t.after(() => { writer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => readSessionUsageArchiveSnapshot(strict), /temporary EIO/);
  assert.ok(cursors.at(-1).returned);
  fail = false;
  assert.deepEqual(Object.keys(readSessionUsageArchiveSnapshot(strict).sessions).sort(), ['codex:one', 'codex:two']);
});

test('release drops the archive identity and fallback reloads worker writes and prune frontiers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-release-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const main = createSessionUsageArchiveStore(options);
  const worker = createSessionUsageArchiveStore(options);
  t.after(() => { main.close(); worker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = new Date(2026, 8, 30, 23, 59);
  const after = new Date(2026, 9, 1, 0, 1);
  const prime = main.capture(summary(), before).archive;
  main.close();
  assert.equal(main.refresh(), prime, 'close alone retains the complete archive');
  main.release();
  main.release();
  assert.ok(fs.existsSync(main.databasePath));
  worker.capture(summary(200), after);
  worker.capture(summary(300, 'two'), after);
  worker.close();

  const fallback = main.read(after);
  assert.notEqual(fallback, prime, 'the released object must not be reused');
  assert.equal(fallback.sessions['codex:one'].periods.allTime.totalTokens, 200);
  assert.equal(fallback.sessions['codex:two'].periods.allTime.totalTokens, 300);
  assert.equal(fallback.prunedDay, '2026-10-01');
  assert.equal(fallback.prunedMonth, '2026-10');
  assert.equal(main.capture(summary(400, 'three'), after).error, null);
  main.release();
  const persisted = readSessionUsageArchiveSnapshot(options);
  assert.equal(persisted.sessions['codex:one'].periods.allTime.totalTokens, 200);
  assert.equal(persisted.sessions['codex:three'].periods.allTime.totalTokens, 400);
});

test('release of a read-only legacy snapshot neither migrates nor deletes it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-release-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const store = createSessionUsageArchiveStore(options);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  writeSessionUsageArchive(captureSessionUsageArchive({}, summary()), options);
  const bytes = fs.readFileSync(store.legacyPath);
  const prime = store.refresh();
  store.release();
  assert.deepEqual(fs.readFileSync(store.legacyPath), bytes);
  assert.equal(fs.existsSync(store.databasePath), false);
  const reloaded = store.refresh();
  assert.notEqual(reloaded, prime);
  assert.deepEqual(reloaded, prime);
});

test('a close failure during release still invalidates materialized rows for fallback', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-release-'));
  let failClose = true;
  class CloseFailureDatabase extends DatabaseSync {
    close() {
      if (failClose) throw new Error('close failed');
      return super.close();
    }
  }
  const store = createSessionUsageArchiveStore({
    env: { TOKEN_MONITOR_SHARED_DIR: dir },
    DatabaseSync: CloseFailureDatabase
  });
  t.after(() => { failClose = false; store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = new Date('2026-10-15T08:00:00Z');
  const prime = store.capture(summary(), now).archive;
  const persisted = readSessionUsageArchiveSnapshot({ env: { TOKEN_MONITOR_SHARED_DIR: dir } });
  assert.throws(() => store.release(), /close failed/);
  const reloaded = store.read(now);
  assert.notEqual(reloaded, prime);
  assert.deepEqual(reloaded, persisted);
});

test('fallback after release rejects interrupted reloads and retries the complete revision', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-release-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const writer = createSessionUsageArchiveStore(options);
  const now = new Date('2026-10-15T08:00:00Z');
  writer.capture(summary(), now);
  let fail = false;
  const cursors = [];
  const reader = createSessionUsageArchiveStore({
    ...options,
    DatabaseSync: databaseWithIterationHook((cursor) => {
      if (fail && cursor.steps === 2) throw new Error('interrupted reload');
    }, cursors)
  });
  t.after(() => { reader.close(); writer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  reader.read(now);
  reader.release();
  writer.capture(summary(200, 'two'), now);
  fail = true;
  assert.match(reader.capture(summary(300, 'three'), now).error.message, /interrupted reload/);
  assert.ok(cursors.at(-1).returned);
  fail = false;
  const result = reader.capture(summary(300, 'three'), now);
  assert.equal(result.error, null);
  assert.deepEqual(Object.keys(result.archive.sessions).sort(), ['codex:one', 'codex:three', 'codex:two']);
});

test('migrates the legacy JSON only after verified row storage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacy = captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z'));
  writeSessionUsageArchive(legacy, options);

  const store = createSessionUsageArchiveStore(options);
  const loaded = store.read(new Date('2026-09-15T08:01:00.000Z'));
  assert.equal(loaded.sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(fs.existsSync(path.join(dir, 'session-usage-archive.json')), false);
  assert.equal(fs.existsSync(sessionUsageArchiveDatabasePath(options)), true);

  const database = new DatabaseSync(sessionUsageArchiveDatabasePath(options), { readOnly: true });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count), 1);
  assert.deepEqual(
    database.prepare("PRAGMA index_info('sessions_revision_idx')").all().map((column) => column.name),
    ['revision', 'session_key']
  );
  database.close();
  store.close();
});

test('makes the migration durable before deleting legacy JSON, then restores normal sync', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  const legacy = captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z'));
  writeSessionUsageArchive(legacy, options);

  const events = [];
  const store = createSessionUsageArchiveStore({
    ...options,
    DatabaseSync: databaseWithExecHook((sql) => events.push(sql.trim())),
    unlinkSync(filePath) {
      events.push(`UNLINK ${path.basename(filePath)}`);
      fs.unlinkSync(filePath);
    }
  });
  store.read(new Date('2026-09-15T08:01:00.000Z'));

  const fullIndex = events.indexOf('PRAGMA synchronous = FULL');
  const beginIndex = events.indexOf('BEGIN IMMEDIATE');
  const commitIndex = events.indexOf('COMMIT');
  const unlinkIndex = events.indexOf(`UNLINK ${path.basename(legacyPath)}`);
  const normalIndex = events.lastIndexOf('PRAGMA synchronous = NORMAL');
  assert.ok(fullIndex >= 0 && fullIndex < beginIndex);
  assert.ok(beginIndex < commitIndex);
  assert.ok(commitIndex < unlinkIndex);
  assert.ok(unlinkIndex < normalIndex);

  store.close();
});

test('persists and refreshes only revised session rows between processes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const writer = createSessionUsageArchiveStore(options);
  const reader = createSessionUsageArchiveStore(options);

  assert.equal(writer.capture(summary(100), new Date('2026-09-15T08:00:00.000Z')).error, null);
  assert.equal(reader.read(new Date('2026-09-15T08:01:00.000Z')).sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(writer.capture(summary(125), new Date('2026-09-15T08:02:00.000Z')).changedKeys.size, 1);
  assert.equal(reader.refresh(new Date('2026-09-15T08:03:00.000Z')).sessions['codex:one'].periods.allTime.totalTokens, 125);

  writer.close();
  reader.close();
});

test('reopening a reader keeps its archive revision instead of skipping newer rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const writer = createSessionUsageArchiveStore(options);
  const reader = createSessionUsageArchiveStore(options);

  writer.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  assert.equal(reader.read(new Date('2026-09-15T08:00:30.000Z')).sessions['codex:one'].periods.allTime.totalTokens, 100);
  reader.close();
  writer.capture(summary(125), new Date('2026-09-15T08:01:00.000Z'));

  assert.equal(reader.refresh(new Date('2026-09-15T08:01:30.000Z')).sessions['codex:one'].periods.allTime.totalTokens, 125);
  writer.close();
  reader.close();
});

test('a full reload cannot advance past a row committed after its scan', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const seed = createSessionUsageArchiveStore(options);
  seed.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  seed.close();
  const writer = createSessionUsageArchiveStore(options);
  let interleaved = false;
  const reader = createSessionUsageArchiveStore({
    ...options,
    DatabaseSync: databaseWithRowsHook(() => {
      if (interleaved) return;
      interleaved = true;
      assert.equal(writer.capture(summary(125), new Date('2026-09-15T08:01:00.000Z')).error, null);
    })
  });

  assert.equal(
    reader.read(new Date('2026-09-15T08:01:30.000Z')).sessions['codex:one'].periods.allTime.totalTokens,
    125
  );
  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 125);
  reader.close();
  writer.close();
});

test('writers allocate global revisions under the SQLite lock and absorb intervening rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const first = createSessionUsageArchiveStore(options);
  const second = createSessionUsageArchiveStore(options);

  first.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  second.read(new Date('2026-09-15T08:00:30.000Z'));
  first.capture(summary(125), new Date('2026-09-15T08:01:00.000Z'));
  second.capture(summary(50, 'two'), new Date('2026-09-15T08:01:30.000Z'));

  const database = new DatabaseSync(sessionUsageArchiveDatabasePath(options), { readOnly: true });
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, '3');
  database.close();
  assert.equal(second.refresh().sessions['codex:one'].periods.allTime.totalTokens, 125);
  assert.equal(first.refresh().sessions['codex:two'].periods.allTime.totalTokens, 50);
  first.close();
  second.close();
});

test('writers rebase the same session before applying changes to different periods', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const first = createSessionUsageArchiveStore(options);
  const second = createSessionUsageArchiveStore(options);

  first.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  second.read(new Date('2026-09-15T08:00:30.000Z'));
  first.capture(summary(125, 'one', ['allTime']), new Date('2026-09-15T08:01:00.000Z'));
  second.capture(summary(150, 'one', ['today']), new Date('2026-09-15T08:01:30.000Z'));

  const retained = second.refresh().sessions['codex:one'].periods;
  assert.equal(retained.allTime.totalTokens, 125);
  assert.equal(retained.today.totalTokens, 150);
  first.close();
  second.close();
});

test('an older capture cannot overwrite a newer snapshot for the same period', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const first = createSessionUsageArchiveStore(options);
  const second = createSessionUsageArchiveStore(options);

  first.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  second.read(new Date('2026-09-15T08:00:30.000Z'));
  second.capture(summary(150, 'one', ['allTime']), new Date('2026-09-15T08:02:00.000Z'));
  first.capture(summary(125, 'one', ['allTime']), new Date('2026-09-15T08:01:00.000Z'));

  const retained = first.refresh().sessions['codex:one'];
  assert.equal(retained.periods.allTime.totalTokens, 150);
  assert.equal(retained.periodWindows.allTime.capturedAt, '2026-09-15T08:02:00.000Z');
  first.close();
  second.close();
});

test('an older capture cannot prune or replace newer day and month windows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const current = createSessionUsageArchiveStore(options);
  const stale = createSessionUsageArchiveStore(options);
  const currentAt = new Date(2026, 9, 1, 8, 2);
  const staleAt = new Date(2026, 8, 30, 8, 1);

  assert.equal(current.capture(summary(150), currentAt).error, null);
  assert.equal(stale.capture(summary(125), staleAt).error, null);

  const retained = current.refresh().sessions['codex:one'];
  for (const periodName of ['today', 'month', 'allTime']) {
    assert.equal(retained.periods[periodName].totalTokens, 150);
    assert.equal(retained.periodWindows[periodName].capturedAt, currentAt.toISOString());
  }
  current.close();
  stale.close();
});

test('migration ownership is rechecked after acquiring the SQLite write lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(100), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const first = createSessionUsageArchiveStore(options);
  let interleaved = false;
  const second = createSessionUsageArchiveStore({
    ...options,
    DatabaseSync: databaseWithExecHook((sql) => {
      if (interleaved || !/^\s*BEGIN IMMEDIATE\s*$/i.test(sql)) return;
      interleaved = true;
      assert.equal(first.capture(summary(125), new Date('2026-09-15T08:01:00.000Z')).error, null);
    })
  });

  assert.equal(
    second.read(new Date('2026-09-15T08:01:30.000Z')).sessions['codex:one'].periods.allTime.totalTokens,
    125
  );
  const database = new DatabaseSync(sessionUsageArchiveDatabasePath(options), { readOnly: true });
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, '2');
  database.close();
  first.close();
  second.close();
});

test('read-only refresh leaves legacy migration to the active writer', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacy = captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z'));
  writeSessionUsageArchive(legacy, options);
  const reader = createSessionUsageArchiveStore(options);

  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(fs.existsSync(sessionUsageArchiveDatabasePath(options)), false);
  assert.equal(fs.existsSync(path.join(dir, 'session-usage-archive.json')), true);
  reader.close();
});

test('a reader reloads SQLite after serving legacy during another writer migration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(100), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const reader = createSessionUsageArchiveStore(options);
  const writer = createSessionUsageArchiveStore(options);

  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(writer.capture(summary(125), new Date('2026-09-15T08:01:00.000Z')).error, null);
  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 125);

  writer.close();
  reader.close();
});

test('refresh switches to SQLite if migration removes legacy during handoff', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(100), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const writer = createSessionUsageArchiveStore(options);
  let interleaved = false;
  const reader = createSessionUsageArchiveStore({
    ...options,
    readJson(filePath, fallback) {
      if (!interleaved) {
        interleaved = true;
        assert.equal(writer.capture(summary(125), new Date('2026-09-15T08:01:00.000Z')).error, null);
      }
      return readJson(filePath, fallback);
    }
  });

  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 125);
  assert.equal(interleaved, true);
  writer.close();
  reader.close();
});

test('read-only snapshots keep dry-run history after JSON migration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  const databasePath = sessionUsageArchiveDatabasePath(options);

  assert.deepEqual(readSessionUsageArchiveSnapshot(options).sessions, {});
  assert.equal(fs.existsSync(databasePath), false);
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(100), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const writer = createSessionUsageArchiveStore(options);
  writer.read(new Date('2026-09-15T08:01:00.000Z'));
  writer.close();

  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(
    readSessionUsageArchiveSnapshot(options).sessions['codex:one'].periods.allTime.totalTokens,
    100
  );
});

test('read-only snapshots prefer SQLite when failed cleanup retains legacy JSON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(100), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const writer = createSessionUsageArchiveStore({
    ...options,
    unlinkSync() {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    }
  });
  let interleaved = false;
  const archive = readSessionUsageArchiveSnapshot({
    ...options,
    readJson(filePath, fallback) {
      const legacy = readJson(filePath, fallback);
      if (!interleaved) {
        interleaved = true;
        assert.equal(writer.capture(summary(125), new Date('2026-09-15T08:01:00.000Z')).error, null);
      }
      return legacy;
    }
  });

  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(archive.sessions['codex:one'].periods.allTime.totalTokens, 125);
  writer.close();
});

test('malformed legacy JSON cannot be marked as migrated or removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  fs.writeFileSync(legacyPath, '{"version":1,"sessions":');
  const store = createSessionUsageArchiveStore(options);

  assert.throws(() => store.read(), SyntaxError);
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(migrationMarker(options), undefined);
  store.close();
});

test('capture reports a strict migration failure without blocking current usage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  fs.writeFileSync(legacyPath, '{"version":1,"sessions":');
  const store = createSessionUsageArchiveStore(options);

  const result = store.capture(summary(), new Date('2026-09-15T08:00:00.000Z'));
  assert.equal(result.error instanceof SyntaxError, true);
  assert.equal(result.changedKeys.size, 0);
  assert.deepEqual(result.archive.sessions, {});
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(migrationMarker(options), undefined);
  store.close();
});

test('legacy read errors cannot be marked as migrated or remove the source', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacyPath = path.join(dir, 'session-usage-archive.json');
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const store = createSessionUsageArchiveStore({
    ...options,
    readFileSync: (filePath, encoding) => {
      if (filePath === legacyPath) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(filePath, encoding);
    }
  });

  assert.throws(() => store.read(), { code: 'EACCES' });
  assert.equal(fs.existsSync(legacyPath), true);
  assert.equal(migrationMarker(options), undefined);
  store.close();
});

test('read-only refresh does not claim an SQLite file before its migration commits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const legacy = captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z'));
  writeSessionUsageArchive(legacy, options);
  const databasePath = sessionUsageArchiveDatabasePath(options);
  new DatabaseSync(databasePath).close();
  const reader = createSessionUsageArchiveStore(options);

  assert.equal(reader.refresh().sessions['codex:one'].periods.allTime.totalTokens, 100);
  const incomplete = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(incomplete.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = 'metadata'
  `).get().count, 0);
  incomplete.close();

  const writer = createSessionUsageArchiveStore(options);
  assert.equal(writer.read().sessions['codex:one'].periods.allTime.totalTokens, 100);
  writer.close();
  reader.close();
});

test('a committed migration stays usable when legacy cleanup is denied', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  writeSessionUsageArchive(
    captureSessionUsageArchive({}, summary(), new Date('2026-09-15T08:00:00.000Z')),
    options
  );
  const errors = [];
  const store = createSessionUsageArchiveStore({
    ...options,
    unlinkSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
    onError: (error, phase) => errors.push({ error, phase })
  });

  assert.equal(store.read().sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(errors[0]?.phase, 'legacy-cleanup');
  assert.equal(fs.existsSync(path.join(dir, 'session-usage-archive.json')), true);
  store.close();

  const reopened = createSessionUsageArchiveStore(options);
  assert.equal(reopened.read().sessions['codex:one'].periods.allTime.totalTokens, 100);
  reopened.close();
});

test('prunes expired day and month payloads while retaining all-time', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const store = createSessionUsageArchiveStore(options);
  store.capture(summary(), new Date(2026, 7, 31, 23, 59));

  const nextMonth = store.read(new Date(2026, 8, 1, 0, 1));
  assert.equal(nextMonth.sessions['codex:one'].periods.today, undefined);
  assert.equal(nextMonth.sessions['codex:one'].periods.month, undefined);
  assert.equal(nextMonth.sessions['codex:one'].periods.allTime.totalTokens, 100);
  store.close();
});

test('persisted prune frontiers prevent stale writers from restoring expired periods', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const current = createSessionUsageArchiveStore(options);
  const stale = createSessionUsageArchiveStore(options);
  const oldDate = new Date(2026, 8, 30, 8, 0);
  const newDate = new Date(2026, 9, 1, 8, 0);

  current.capture(summary(100), oldDate);
  stale.read(new Date(2026, 8, 30, 8, 1));
  const pruned = current.read(newDate).sessions['codex:one'].periods;
  assert.equal(pruned.today, undefined);
  assert.equal(pruned.month, undefined);

  assert.equal(stale.capture(summary(125), new Date(2026, 8, 30, 9, 0)).error, null);
  const retained = current.refresh().sessions['codex:one'].periods;
  assert.equal(retained.today, undefined);
  assert.equal(retained.month, undefined);
  assert.equal(retained.allTime.totalTokens, 125);
  current.close();
  stale.close();
});

test('incremental replay treats fully pruned session rows as tombstones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const current = createSessionUsageArchiveStore(options);
  const refreshed = createSessionUsageArchiveStore(options);
  const rebased = createSessionUsageArchiveStore(options);
  const oldDate = new Date(2026, 8, 15, 8, 0);
  const newDate = new Date(2026, 8, 16, 8, 0);

  current.capture(summary(100, 'one', ['today']), oldDate);
  refreshed.read(new Date(2026, 8, 15, 8, 1));
  rebased.read(new Date(2026, 8, 15, 8, 2));

  current.read(newDate);
  assert.equal(refreshed.refresh().sessions['codex:one'], undefined);

  assert.equal(rebased.capture(
    summary(125, 'one', ['allTime']),
    new Date(2026, 8, 16, 8, 1)
  ).error, null);
  const retained = current.refresh().sessions['codex:one'].periods;
  assert.equal(retained.today, undefined);
  assert.equal(retained.allTime.totalTokens, 125);

  current.close();
  refreshed.close();
  rebased.close();
});

test('clear removes SQLite sidecars and any legacy archive', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const store = createSessionUsageArchiveStore(options);
  store.capture(summary(), new Date('2026-09-15T08:00:00.000Z'));
  assert.equal(store.clear(), true);
  assert.equal(fs.existsSync(sessionUsageArchiveDatabasePath(options)), false);
});

test('close does not retry a failed row over another writer update', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const seed = createSessionUsageArchiveStore(options);
  seed.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  seed.close();
  const failure = failingCommitDatabase();
  const first = createSessionUsageArchiveStore({ ...options, DatabaseSync: failure.DatabaseSync });
  const second = createSessionUsageArchiveStore(options);
  first.read(new Date('2026-09-15T08:00:10.000Z'));
  second.read(new Date('2026-09-15T08:00:10.000Z'));

  failure.failNextCommit();
  assert.equal(
    first.capture(summary(125, 'one', ['allTime']), new Date('2026-09-15T08:01:00.000Z')).error?.code,
    'EIO'
  );
  assert.equal(
    second.capture(summary(150, 'one', ['today']), new Date('2026-09-15T08:02:00.000Z')).error,
    null
  );
  first.close();
  second.close();

  const reopened = createSessionUsageArchiveStore(options);
  const periods = reopened.read(new Date('2026-09-15T08:03:00.000Z')).sessions['codex:one'].periods;
  assert.equal(periods.today.totalTokens, 150);
  assert.equal(periods.allTime.totalTokens, 100);
  reopened.close();
});

test('the next capture reloads SQLite after a failed archive mutation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const seed = createSessionUsageArchiveStore(options);
  seed.capture(summary(100), new Date('2026-09-15T08:00:00.000Z'));
  seed.close();
  const failure = failingCommitDatabase();
  const first = createSessionUsageArchiveStore({ ...options, DatabaseSync: failure.DatabaseSync });
  const second = createSessionUsageArchiveStore(options);
  first.read(new Date('2026-09-15T08:00:10.000Z'));
  second.read(new Date('2026-09-15T08:00:10.000Z'));

  failure.failNextCommit();
  assert.equal(
    first.capture(summary(125, 'one', ['allTime']), new Date('2026-09-15T08:01:00.000Z')).error?.code,
    'EIO'
  );
  second.capture(summary(150, 'one', ['today']), new Date('2026-09-15T08:02:00.000Z'));
  const recovered = first.capture({}, new Date('2026-09-15T08:03:00.000Z'));
  assert.equal(recovered.error, null);
  assert.equal(recovered.archive.sessions['codex:one'].periods.today.totalTokens, 150);
  assert.equal(recovered.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  first.close();
  second.close();
});

test('clear remains available after a failed archive mutation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const failure = failingCommitDatabase();
  const store = createSessionUsageArchiveStore({ ...options, DatabaseSync: failure.DatabaseSync });

  assert.equal(store.capture(summary(100), new Date('2026-09-15T08:00:00.000Z')).error, null);
  failure.failNextCommit();
  const failed = store.capture(summary(125), new Date('2026-09-15T08:01:00.000Z'));
  assert.equal(failed.changedKeys.size, 1);
  assert.equal(failed.error?.code, 'EIO');
  assert.equal(store.clear(), true);
  assert.equal(fs.existsSync(sessionUsageArchiveDatabasePath(options)), false);
});

test('a legacy Cursor session link is committed and survives reopening the store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacyId = 'cursor-active-2026-08-13T02:42:39.510Z';
  const cursorSession = (sessionId, totalTokens) => ({
    client: 'cursor',
    sessionId,
    totalTokens,
    costUsd: 1,
    models: { default: totalTokens },
    modelCosts: { default: 1 }
  });
  const capturedAt = new Date('2026-09-15T08:00:00.000Z');
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };

  const first = createSessionUsageArchiveStore(options);
  first.capture({ allTime: { sessions: { [`cursor:${legacyId}`]: cursorSession(legacyId, 700) } } }, capturedAt);
  first.close();

  const cursorUsageEvents = () => ({
    signature: 'synced',
    sessionsAt: (time, totalTokens) => (time === Date.parse('2026-08-13T02:42:39.510Z') && totalTokens === 700 ? ['conv-1'] : [])
  });
  const linking = createSessionUsageArchiveStore({ ...options, cursorUsageEvents });
  linking.capture({ allTime: { sessions: { 'cursor:conv-1': cursorSession('conv-1', 700) } } }, capturedAt);
  linking.close();

  const reopened = createSessionUsageArchiveStore(options);
  const linked = reopened.read(capturedAt).sessions[`cursor:${legacyId}`].supersededBy;
  // Windows cannot remove the directory while the database is open, and the
  // cleanup hook above runs first.
  reopened.close();
  assert.equal(linked, 'cursor:conv-1');
});

test('a legacy Cursor row another writer added is linked by this process', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacyId = 'cursor-active-2026-08-13T02:42:39.510Z';
  const cursorSession = (sessionId, totalTokens) => ({
    client: 'cursor',
    sessionId,
    totalTokens,
    costUsd: 1,
    models: { default: totalTokens },
    modelCosts: { default: 1 }
  });
  const capturedAt = new Date('2026-09-15T08:00:00.000Z');
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const cursorUsageEvents = () => ({
    signature: 'synced',
    sessionsAt: (time, tokens) => (
      time === Date.parse('2026-08-13T02:42:39.510Z') && tokens === 700 ? ['conv-1'] : []
    )
  });

  // This process scans the archive before the row exists.
  const reader = createSessionUsageArchiveStore({ ...options, cursorUsageEvents });
  reader.capture({ allTime: { sessions: {} } }, capturedAt);

  const writer = createSessionUsageArchiveStore(options);
  writer.capture({ allTime: { sessions: { [`cursor:${legacyId}`]: cursorSession(legacyId, 700) } } }, capturedAt);
  writer.close();

  reader.capture({ allTime: { sessions: {} } }, capturedAt);
  const linked = reader.read(capturedAt).sessions[`cursor:${legacyId}`].supersededBy;
  reader.close();
  assert.equal(linked, 'cursor:conv-1');
});

for (const scan of ['full', 'revision']) {
  test(`${scan} iteration retains its revision boundary across an active WAL writer`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
    const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
    const now = new Date('2026-09-15T08:00:00.000Z');
    const writer = createSessionUsageArchiveStore(options);
    writer.capture(summary(100, 'one'), now);
    writer.capture(summary(200, 'two'), now);
    let armed = scan === 'full';
    let interleaved = false;
    const cursors = [];
    const reader = createSessionUsageArchiveStore({
      ...options,
      DatabaseSync: databaseWithIterationHook((cursor, row) => {
        if (!armed || interleaved || row.done || cursor.steps !== 1) return;
        if (/WHERE revision/.test(cursor.sql) !== (scan === 'revision')) return;
        interleaved = true;
        assert.equal(writer.capture(summary(250, 'two'), now).error, null);
        assert.equal(writer.capture(summary(300, 'three'), now).error, null);
      }, cursors)
    });
    t.after(() => {
      reader.close();
      writer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    if (scan === 'revision') {
      reader.refresh();
      writer.capture(summary(125, 'one'), now);
      writer.capture(summary(225, 'two'), now);
      armed = true;
    }
    const first = reader.refresh();
    assert.equal(interleaved, true);
    assert.equal(first.sessions['codex:two'].periods.allTime.totalTokens, scan === 'full' ? 250 : 225);
    const caughtUp = reader.refresh();
    assert.equal(caughtUp.sessions['codex:two'].periods.allTime.totalTokens, 250);
    assert.equal(caughtUp.sessions['codex:three'].periods.allTime.totalTokens, 300);
    assert.equal(cursors.every((cursor) => cursor.returned), true);
  });
}

for (const operation of ['refresh', 'capture']) {
  for (const scan of ['full', 'revision']) {
    test(`${operation} rejects partial ${scan} iteration and retries after cursor cleanup`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
      const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
      const now = new Date('2026-09-15T08:00:00.000Z');
      const writer = createSessionUsageArchiveStore(options);
      writer.capture(summary(100, 'one'), now);
      writer.capture(summary(200, 'two'), now);
      let armed = false;
      const cursors = [];
      const failure = new Error('interrupted SQLite cursor');
      const reader = createSessionUsageArchiveStore({
        ...options,
        DatabaseSync: databaseWithIterationHook((cursor) => {
          if (!armed || cursor.steps !== 2) return;
          armed = false;
          throw failure;
        }, cursors)
      });
      t.after(() => {
        reader.close();
        writer.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      let baseline;
      if (scan === 'revision') {
        baseline = reader.refresh();
        writer.capture(summary(125, 'one'), now);
        writer.capture(summary(225, 'two'), now);
      }
      armed = true;
      if (operation === 'refresh') {
        assert.throws(() => reader.refresh(), (error) => error === failure);
      } else {
        const failed = reader.capture(summary(400, 'uncommitted'), now);
        assert.equal(failed.error, failure);
        assert.equal(failed.changedKeys.size, 0);
        assert.equal(failed.archive.sessions['codex:uncommitted'], undefined);
        if (baseline) assert.equal(failed.archive, baseline);
        else assert.deepEqual(failed.archive.sessions, {});
      }
      if (baseline) {
        assert.equal(baseline.sessions['codex:one'].periods.allTime.totalTokens, 100);
        assert.equal(baseline.sessions['codex:two'].periods.allTime.totalTokens, 200);
      }
      assert.equal(cursors.at(-1).returned, true);
      // A second connection can still commit, and the retry must include it.
      // capture's BEGIN IMMEDIATE must also have been rolled back on failure.
      assert.equal(writer.capture(summary(300, 'three'), now).error, null);
      const recovered = operation === 'refresh' ? reader.refresh() : reader.capture({}, now).archive;
      assert.equal(recovered.sessions['codex:one'].periods.allTime.totalTokens, scan === 'full' ? 100 : 125);
      assert.equal(recovered.sessions['codex:two'].periods.allTime.totalTokens, scan === 'full' ? 200 : 225);
      assert.equal(recovered.sessions['codex:three'].periods.allTime.totalTokens, 300);
      assert.equal(recovered.sessions['codex:uncommitted'], undefined);
      assert.equal(cursors.every((cursor) => cursor.returned), true);
    });
  }
}

test('read-only snapshot discards a partial scan, closes its cursor and retries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const now = new Date('2026-09-15T08:00:00.000Z');
  const writer = createSessionUsageArchiveStore(options);
  writer.capture(summary(100, 'one'), now);
  writer.capture(summary(200, 'two'), now);
  writer.close();
  const cursors = [];
  let failing = true;
  const hooked = {
    ...options,
    DatabaseSync: databaseWithIterationHook((cursor) => {
      if (failing && cursor.steps === 2) throw new Error('interrupted SQLite cursor');
    }, cursors)
  };
  assert.deepEqual(readSessionUsageArchiveSnapshot(hooked).sessions, {});
  assert.equal(cursors.every((cursor) => cursor.returned), true);
  failing = false;
  const recovered = readSessionUsageArchiveSnapshot(hooked);
  assert.equal(recovered.sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(recovered.sessions['codex:two'].periods.allTime.totalTokens, 200);
  assert.equal(cursors.every((cursor) => cursor.returned), true);
});

test('streamed full scans skip malformed rows and revision catch-up deletes them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const now = new Date('2026-09-15T08:00:00.000Z');
  const writer = createSessionUsageArchiveStore(options);
  writer.capture(summary(100, 'one'), now);
  writer.capture(summary(200, 'two'), now);
  writer.close();
  const cursors = [];
  const hooked = { ...options, DatabaseSync: databaseWithIterationHook(() => {}, cursors) };
  const reader = createSessionUsageArchiveStore(hooked);
  const database = new DatabaseSync(sessionUsageArchiveDatabasePath(options));
  t.after(() => {
    reader.close();
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  reader.refresh();
  database.exec(`
    BEGIN IMMEDIATE;
    UPDATE sessions SET entry_json = '{', revision = 3 WHERE session_key = 'codex:one';
    INSERT INTO sessions VALUES ('codex:bad', '{}', 3);
    UPDATE metadata SET value = '3' WHERE key = 'revision';
    COMMIT;
  `);
  const revised = reader.refresh();
  assert.equal(revised.sessions['codex:one'], undefined);
  assert.equal(revised.sessions['codex:bad'], undefined);
  assert.equal(revised.sessions['codex:two'].periods.allTime.totalTokens, 200);
  const snapshot = readSessionUsageArchiveSnapshot(hooked);
  assert.deepEqual(Object.keys(snapshot.sessions), ['codex:two']);
  const reopened = createSessionUsageArchiveStore(hooked);
  try {
    assert.deepEqual(Object.keys(reopened.refresh().sessions), ['codex:two']);
  } finally {
    reopened.close();
  }
  assert.equal(cursors.every((cursor) => cursor.returned), true);
});

test('a failed full reload preserves the prior archive and stays pending for retry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const now = new Date('2026-09-15T08:00:00.000Z');
  const writer = createSessionUsageArchiveStore(options);
  writer.capture(summary(100, 'one'), now);
  writer.capture(summary(200, 'two'), now);
  let failCommit = false;
  let failScan = false;
  const cursors = [];
  const HookedDatabase = databaseWithIterationHook((cursor) => {
    if (!failScan || cursor.steps !== 2) return;
    failScan = false;
    throw new Error('interrupted full reload');
  }, cursors);
  const reader = createSessionUsageArchiveStore({
    ...options,
    DatabaseSync: class extends HookedDatabase {
      exec(sql) {
        if (failCommit && /^\s*COMMIT\s*$/i.test(sql)) {
          failCommit = false;
          throw new Error('failed commit');
        }
        return super.exec(sql);
      }
    }
  });
  t.after(() => {
    reader.close();
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  reader.refresh();
  failCommit = true;
  const failedWrite = reader.capture(summary(125, 'one'), now);
  assert.equal(failedWrite.error.message, 'failed commit');
  writer.capture(summary(225, 'two'), now);
  failScan = true;
  const failedReload = reader.capture({}, now);
  assert.equal(failedReload.error.message, 'interrupted full reload');
  assert.equal(failedReload.archive, failedWrite.archive);
  assert.equal(failedReload.archive.sessions['codex:two'].periods.allTime.totalTokens, 200);
  assert.equal(failedReload.changedKeys.size, 0);
  assert.equal(cursors.at(-1).returned, true);
  const recovered = reader.capture({}, now);
  assert.equal(recovered.error, null);
  assert.equal(recovered.archive.sessions['codex:one'].periods.allTime.totalTokens, 100);
  assert.equal(recovered.archive.sessions['codex:two'].periods.allTime.totalTokens, 225);
});
