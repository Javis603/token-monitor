'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const {
  cleanTitle,
  readSessionRows,
  resolveSessionMetadata,
  zcodeDatabasePath
} = require('../../src/shared/providers/zcode/sessionMetadata');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

test('cleanTitle strips whitespace and truncates with an ellipsis', () => {
  assert.equal(cleanTitle('  帮我  分析  这个项目  '), '帮我 分析 这个项目');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle(42), '');
  const long = 'a'.repeat(120);
  const truncated = cleanTitle(long);
  assert.equal(truncated.length, 96);
  assert.ok(truncated.endsWith('…'));
});

test('zcodeDatabasePath follows the collector home rather than limits discovery', () => {
  const home = '/fake/home';
  assert.equal(
    zcodeDatabasePath({ home, deps: { env: {} } }),
    path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  );
  assert.equal(
    zcodeDatabasePath({ home, deps: { env: { ZCODE_DATA_BASE_DIR: '/custom/base', HOME: '/host/home' } } }),
    path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  );
  // A scoped (WSL) home ignores host env, matching the other resolvers
  assert.equal(
    zcodeDatabasePath({ home, deps: { scopedHome: true, env: { ZCODE_DATA_BASE_DIR: '/custom/base' } } }),
    path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  );
});

test('ZCode metadata stays with the scanned home when host paths contain matching ids', { skip: !sqlite }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-home-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'scanned-home');
  const hostHome = path.join(root, 'host-home');
  const customBase = path.join(root, 'custom-base');
  for (const [base, title] of [[home, 'Scanned session'], [hostHome, 'Host session'], [customBase, 'Redirected session']]) {
    const dbDir = path.join(base, '.zcode', 'cli', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec('CREATE TABLE session (id text primary key, title text not null, task_type text, parent_id text)');
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('sess_shared', title, 'subagent_child', `${title} parent`);
    } finally { db.close(); }
  }

  for (const [name, env, scopedHome] of [
    ['HOME override', { HOME: hostHome }, false],
    ['ZCODE_DATA_BASE_DIR override', { HOME: hostHome, ZCODE_DATA_BASE_DIR: customBase }, false],
    ['scoped WSL home', { HOME: hostHome, ZCODE_DATA_BASE_DIR: customBase }, true]
  ]) {
    await t.test(name, () => {
      const periods = { today: { sessions: { 'zcode:sess_shared': { client: 'zcode', sessionId: 'sess_shared' } } } };
      applySessionMetadata(periods, home, { sqlite, env, scopedHome, zcodeSessionRowCache: new Map() });
      assert.equal(periods.today.sessions['zcode:sess_shared'].title, 'Scanned session');
      assert.equal(periods.today.sessions['zcode:sess_shared'].parentSessionId, 'Scanned session parent');
    });
  }
});

test('readSessionRows answers per id and reports a missing title column', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-titles-'));
  const dbDir = path.join(home, '.zcode', 'cli', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'db.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE session (
    id text primary key, project_id text not null, slug text not null,
    directory text not null, title text not null, version text not null,
    time_created integer not null, time_updated integer not null
  )`);
  const put = db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  put.run('sess_a', 'p', 's', '/repo', '  增加  Kyan  生图适配器  ', '1', 1, 2);
  put.run('sess_b', 'p', 's', '/repo', '', '1', 1, 2);

  const read = readSessionRows(dbPath, sqlite, ['sess_a', 'sess_b', 'sess_missing']);
  assert.equal(read.supported, true);
  assert.equal(read.rows.get('sess_a')?.title, '增加 Kyan 生图适配器');
  assert.equal(read.misses.has('sess_b'), false, 'an empty title is still a definitive row');
  assert.equal(read.rows.get('sess_b')?.title, '');
  assert.equal(read.misses.has('sess_missing'), true, 'a missing row is a definitive non-answer');

  const legacyDir = path.join(home, '.zcode', 'cli', 'db');
  const legacyPath = path.join(legacyDir, 'legacy.sqlite');
  const legacyDb = new sqlite.DatabaseSync(legacyPath);
  legacyDb.exec('CREATE TABLE session (id text primary key, name text not null)');
  legacyDb.close();
  const legacyRead = readSessionRows(legacyPath, sqlite, ['sess_a']);
  assert.equal(legacyRead.supported, false);
  assert.equal(legacyRead.rows.size, 0);
});

test('ZCode titles join by session id and see later updates', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-metadata-'));
  const dbDir = path.join(home, '.zcode', 'cli', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'db.sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE session (
    id text primary key, project_id text not null, slug text not null,
    directory text not null, title text not null, version text not null,
    time_created integer not null, time_updated integer not null,
    task_type text not null default 'interactive', parent_id text
  )`);
  const put = db.prepare(`INSERT INTO session
    (id, project_id, slug, directory, title, version, time_created, time_updated, task_type, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  put.run('sess_1', 'p', 's', '/repo', '帮我分析下这个项目', '1', 1, 2, 'interactive', null);
  put.run('sess_dwf-dwfrun-5d819c2c-actor_13_1', 'p', 's', '/repo', 'workflow subagent actor#13@1', '1', 1, 2, 'workflow_child', 'sess_1');
  put.run('sess_sub', 'p', 's', '/repo', 'Explore the project', '1', 1, 2, 'subagent_child', 'sess_1');
  // A user's own fork and side chat carry the same parent_id but do not fold
  put.run('sess_fork', 'p', 's', '/repo', 'Fork of 帮我分析下这个项目', '1', 1, 2, 'fork', 'sess_1');
  put.run('sess_side', 'p', 's', '/repo', '侧聊标题', '1', 1, 2, 'selection_side_chat', 'sess_1');

  const deps = { sqlite, env: {}, zcodeSessionRowCache: new Map() };
  const context = { home, deps };

  const first = resolveSessionMetadata(new Set(['sess_1', 'sess_dwf-dwfrun-5d819c2c-actor_13_1', 'sess_sub', 'sess_fork', 'sess_side', 'sess_gone']), context);
  assert.equal(first.get('sess_1')?.title, '帮我分析下这个项目');
  assert.equal(first.get('sess_1')?.parentSessionId, undefined, 'an interactive session has no parent');
  assert.equal(first.get('sess_dwf-dwfrun-5d819c2c-actor_13_1')?.parentSessionId, 'sess_1');
  assert.equal(first.get('sess_sub')?.parentSessionId, 'sess_1');
  assert.equal(first.get('sess_fork')?.parentSessionId, undefined, 'a fork stays a row of its own');
  assert.equal(first.get('sess_side')?.parentSessionId, undefined, 'a side chat stays a row of its own');
  assert.equal(first.has('sess_gone'), false, 'an unknown id resolves no metadata');

  // A rename lands in WAL; the next tick's fingerprint picks it up
  const rename = db.prepare('UPDATE session SET title = ? WHERE id = ?');
  rename.run('重命名后的标题', 'sess_1');
  const second = resolveSessionMetadata(new Set(['sess_1']), context);
  assert.equal(second.get('sess_1')?.title, '重命名后的标题');

  const periods = {
    today: {
      sessions: {
        'zcode:sess_1': { client: 'zcode', sessionId: 'sess_1', title: '' },
        'zcode:sess_sub': { client: 'zcode', sessionId: 'sess_sub', title: '' },
        'zcode:sess_fork': { client: 'zcode', sessionId: 'sess_fork', title: '' },
        'zcode:sess_gone': { client: 'zcode', sessionId: 'sess_gone' }
      }
    }
  };
  applySessionMetadata(periods, home, {
    ...deps,
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set()
  });
  assert.equal(periods.today.sessions['zcode:sess_1'].title, '重命名后的标题');
  assert.equal(periods.today.sessions['zcode:sess_sub'].parentSessionId, 'sess_1');
  assert.equal(periods.today.sessions['zcode:sess_fork'].parentSessionId, undefined, 'a fork keeps no parent link');
  assert.equal(periods.today.sessions['zcode:sess_gone'].title, undefined, 'a scan-only row keeps its empty title');
});

test('a missing database leaves collection untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-empty-'));
  try {
    const resolved = resolveSessionMetadata(new Set(['sess_1']), { home, deps: { sqlite, env: {} } });
    assert.equal(resolved.size, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
