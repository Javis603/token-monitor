'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const hermesSession = require('../../src/shared/providers/hermes/session');

const maybe = sqlite ? test : test.skip;
const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb({ rows }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sess-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'state.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at REAL NOT NULL,
    last_activity_at REAL,
    cwd TEXT
  )`);
  const insert = db.prepare('INSERT INTO sessions (id, started_at, last_activity_at, cwd) VALUES (?,?,?,?)');
  for (const row of rows) {
    insert.run(row.id, row.startedAt, row.lastActivityAt ?? null, row.cwd || '');
  }
  db.close();
  return file;
}

maybe('readSessionMeta converts Hermes epoch-second timestamps and cwd', () => {
  const started = Date.UTC(2026, 8, 11, 3, 56, 18, 697) / 1000;
  const last = Date.UTC(2026, 8, 11, 4, 24, 19, 108) / 1000;
  const file = makeDb({
    rows: [{
      id: '20260911_115516_2cedb0',
      startedAt: started,
      lastActivityAt: last,
      cwd: 'D:\\Hermes'
    }]
  });

  const meta = hermesSession.readSessionMeta(['20260911_115516_2cedb0', 'missing'], {
    dbPaths: [file],
    sqlite
  });
  assert.equal(meta.size, 1);
  assert.deepEqual(meta.get('20260911_115516_2cedb0'), {
    startedAt: '2026-09-11T03:56:18.697Z',
    lastUsedAt: '2026-09-11T04:24:19.108Z',
    projectPath: 'D:\\Hermes'
  });
});

maybe('readSessionMeta falls back to started_at when last_activity_at is missing', () => {
  const started = Date.UTC(2026, 8, 11, 3, 56, 18) / 1000;
  const file = makeDb({
    rows: [{ id: 's1', startedAt: started, lastActivityAt: null }]
  });
  const meta = hermesSession.readSessionMeta(['s1'], { dbPaths: [file], sqlite });
  assert.equal(meta.get('s1').startedAt, '2026-09-11T03:56:18.000Z');
  assert.equal(meta.get('s1').lastUsedAt, '2026-09-11T03:56:18.000Z');
});

maybe('readSessionMeta returns an empty map when sqlite is unavailable', () => {
  const file = makeDb({ rows: [{ id: 's1', startedAt: 1, lastActivityAt: 2 }] });
  const meta = hermesSession.readSessionMeta(['s1'], { dbPaths: [file], sqlite: null });
  assert.equal(meta.size, 0);
});

test('isoFromUnix accepts seconds and millisecond timestamps', () => {
  const ms = Date.UTC(2026, 8, 11, 3, 56, 18, 697);
  assert.equal(hermesSession.isoFromUnix(ms / 1000), new Date(ms).toISOString());
  assert.equal(hermesSession.isoFromUnix(ms), new Date(ms).toISOString());
  assert.equal(hermesSession.isoFromUnix(0), '');
  assert.equal(hermesSession.isoFromUnix('nope'), '');
});
