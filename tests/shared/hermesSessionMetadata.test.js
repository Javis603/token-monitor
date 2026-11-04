'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { resolveSessionMetadata } = require('../../src/shared/providers/hermes/sessionMetadata');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const SESSIONS_TABLE = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, input_tokens INTEGER)';

function createStateDb(dir, rows, schema = SESSIONS_TABLE) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'state.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(schema);
  const columns = schema.includes('source') ? '(id, source, parent_session_id)' : '(id, parent_session_id)';
  const put = db.prepare(`INSERT INTO sessions ${columns} VALUES (${schema.includes('source') ? '?, ?, ?' : '?, ?'})`);
  for (const row of rows) put.run(...row);
  return db;
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('only delegated subagents link to their parent session', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-links-');
  const hermesHome = path.join(root, 'hermes');
  createStateDb(hermesHome, [
    ['main', 'cli', null],
    ['sub', 'subagent', 'main'],
    // A context-compression continuation keeps its parent's source.
    ['continued', 'cli', 'main'],
    ['self', 'subagent', 'self']
  ]).close();
  const session = (id) => ({ client: 'hermes', sessionId: id, totalTokens: 1 });
  const periods = { today: { sessions: Object.fromEntries(
    ['main', 'sub', 'continued', 'self', 'unknown'].map((id) => [`hermes:${id}`, session(id)])
  ) } };

  applySessionMetadata(periods, root, { sqlite, env: { HERMES_HOME: hermesHome }, hermesDatabaseCache: new Map() });

  const parents = Object.fromEntries(Object.values(periods.today.sessions).map((row) => [row.sessionId, row.parentSessionId]));
  assert.deepEqual(parents, { main: undefined, sub: 'main', continued: undefined, self: undefined, unknown: undefined });
});

test('profile databases resolve their own subagents', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-profiles-');
  const hermesHome = path.join(root, 'hermes');
  createStateDb(hermesHome, [['main', 'cli', null]]).close();
  createStateDb(path.join(hermesHome, 'profiles', 'work'), [['work-sub', 'subagent', 'work-main']]).close();

  const result = resolveSessionMetadata(new Set(['main', 'work-sub']), {
    home: root, deps: { sqlite, env: { HERMES_HOME: hermesHome }, hermesDatabaseCache: new Map() }
  });

  assert.deepEqual([...result], [['work-sub', { parentSessionId: 'work-main' }]]);
});

test('a scoped WSL home ignores the host HERMES_HOME', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-scoped-');
  createStateDb(path.join(root, '.hermes'), [['sub', 'subagent', 'scanned-parent']]).close();
  const hostHome = path.join(root, 'host');
  createStateDb(hostHome, [['sub', 'subagent', 'host-parent']]).close();

  const result = resolveSessionMetadata(new Set(['sub']), {
    home: root, deps: { sqlite, scopedHome: true, env: { HERMES_HOME: hostHome }, hermesDatabaseCache: new Map() }
  });

  assert.equal(result.get('sub')?.parentSessionId, 'scanned-parent');
});

test('a schema without source infers no relationship', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-legacy-');
  const hermesHome = path.join(root, 'hermes');
  createStateDb(hermesHome, [['sub', 'main']], 'CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)').close();

  const result = resolveSessionMetadata(new Set(['sub']), {
    home: root, deps: { sqlite, env: { HERMES_HOME: hermesHome }, hermesDatabaseCache: new Map() }
  });

  assert.equal(result.size, 0);
});

test('a legacy home database neither shadows a profile nor outlives its migration', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-migrate-');
  const hermesHome = path.join(root, 'hermes');
  const home = createStateDb(hermesHome, [['home-sub', 'main']], 'CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)');
  createStateDb(path.join(hermesHome, 'profiles', 'work'), [['work-sub', 'subagent', 'work-main']]).close();
  const deps = { sqlite, env: { HERMES_HOME: hermesHome }, hermesDatabaseCache: new Map() };
  const resolve = () => resolveSessionMetadata(new Set(['home-sub', 'work-sub']), { home: root, deps });
  try {
    assert.deepEqual([...resolve()], [['work-sub', { parentSessionId: 'work-main' }]]);
    home.exec("ALTER TABLE sessions ADD COLUMN source TEXT; UPDATE sessions SET source = 'subagent'");
    assert.equal(resolve().get('home-sub')?.parentSessionId, 'main');
  } finally {
    home.close();
  }
});

test('a missing database adds nothing and a late subagent row is found after the database changes', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-late-');
  const hermesHome = path.join(root, 'hermes');
  const deps = { sqlite, env: { HERMES_HOME: hermesHome }, hermesDatabaseCache: new Map() };
  const resolve = () => resolveSessionMetadata(new Set(['late']), { home: root, deps });
  assert.equal(resolve().size, 0, 'no database yet');

  const db = createStateDb(hermesHome, [['main', 'cli', null]]);
  try {
    assert.equal(resolve().size, 0, 'the row has not landed yet');
    db.prepare('INSERT INTO sessions (id, source, parent_session_id) VALUES (?, ?, ?)').run('late', 'subagent', 'main');
    assert.equal(resolve().get('late')?.parentSessionId, 'main');
  } finally {
    db.close();
  }
});

test('custom scan roots resolve state.db at any depth, but not for a scoped home', { skip: !sqlite }, (t) => {
  const root = tempRoot(t, 'hermes-custom-');
  const configured = path.join(root, 'backup');
  const inherited = path.join(root, 'inherited');
  createStateDb(path.join(configured, 'a', 'b'), [['custom-sub', 'subagent', 'custom-main']]).close();
  createStateDb(inherited, [['env-sub', 'subagent', 'env-main']]).close();
  const ids = new Set(['custom-sub', 'env-sub']);
  const deps = (extra) => ({ sqlite, env: { TOKSCALE_EXTRA_DIRS: `claude:${root},hermes:${inherited}` },
    customScanPaths: { hermes: [configured] }, hermesDatabaseCache: new Map(), ...extra });

  const host = resolveSessionMetadata(ids, { home: root, deps: deps() });
  assert.equal(host.get('custom-sub')?.parentSessionId, 'custom-main');
  assert.equal(host.get('env-sub')?.parentSessionId, 'env-main');
  assert.equal(resolveSessionMetadata(ids, { home: root, deps: deps({ scopedHome: true }) }).size, 0);
});

test('an unreadable directory below a custom root does not hide the rest of it', {
  skip: !sqlite || process.platform === 'win32' || process.getuid?.() === 0
}, (t) => {
  const root = tempRoot(t, 'hermes-locked-');
  const custom = path.join(root, 'custom');
  createStateDb(path.join(custom, 'open'), [['open-sub', 'subagent', 'open-main']]).close();
  const locked = path.join(custom, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  let result;
  try {
    result = resolveSessionMetadata(new Set(['open-sub']), {
      home: root, deps: { sqlite, env: {}, customScanPaths: { hermes: [custom] }, hermesDatabaseCache: new Map() }
    });
  } finally {
    // Restored before the temp-root cleanup hook runs.
    fs.chmodSync(locked, 0o755);
  }

  assert.equal(result.get('open-sub')?.parentSessionId, 'open-main');
});
