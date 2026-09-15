'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  captureSessionUsageArchive,
  writeSessionUsageArchive
} = require('../../src/shared/sessionUsageArchive');
const {
  createSessionUsageArchiveStore,
  sessionUsageArchiveDatabasePath
} = require('../../src/shared/sessionUsageArchiveStore');

function summary(totalTokens = 100) {
  const session = {
    client: 'codex',
    sessionId: 'one',
    totalTokens,
    costUsd: totalTokens / 100,
    models: { 'gpt-5': totalTokens },
    modelCosts: { 'gpt-5': totalTokens / 100 }
  };
  return Object.fromEntries(['today', 'month', 'allTime'].map((period) => [period, {
    sessions: { 'codex:one': { ...session } }
  }]));
}

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
  database.close();
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

test('clear removes SQLite sidecars and any legacy archive', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: dir } };
  const store = createSessionUsageArchiveStore(options);
  store.capture(summary(), new Date('2026-09-15T08:00:00.000Z'));
  assert.equal(store.clear(), true);
  assert.equal(fs.existsSync(sessionUsageArchiveDatabasePath(options)), false);
});
