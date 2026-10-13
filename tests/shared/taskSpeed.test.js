'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { parseCodexTasks, summarize, readTaskSpeedStats } = require('../../src/shared/taskSpeed');
const event = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload });

test('identical last usage is counted once in each task', () => {
  const lines = [];
  for (const turn_id of ['first', 'second']) {
    lines.push(event('2026-10-04T10:00:00Z', { type: 'task_started', turn_id }));
    const usage = event('2026-10-04T10:00:01Z', { type: 'token_count', info: { last_token_usage: { output_tokens: 20 } } });
    lines.push(usage, usage, event('2026-10-04T10:00:02Z', { type: 'task_complete', turn_id, duration_ms: 2000 }));
  }
  assert.deepEqual(parseCodexTasks(lines.join('\n')).map(task => task.outputTokens), [20, 20]);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-speed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexRoot = path.join(home, 'custom-codex');
  fs.mkdirSync(codexRoot);
  return { home, codexRoot };
}

function rollout(codexRoot, sessionId, { turnId, output = 20, archived = false } = {}) {
  const dir = path.join(codexRoot, archived ? 'archived_sessions' : 'sessions/2026/10/04');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread' } }),
    event('2026-10-04T10:00:00Z', { type: 'task_started', turn_id: turnId }),
    event('2026-10-04T10:00:00Z', { type: 'user_message', message: 'fixture task' }),
    event('2026-10-04T10:00:01Z', { type: 'token_count', info: { last_token_usage: { output_tokens: output } } }),
    event('2026-10-04T10:00:02Z', { type: 'task_complete', turn_id: turnId, duration_ms: 2000 })
  ].join('\n'));
}

test('the public reader includes archived sessions and counts repeated or forked task ids once', t => {
  const roots = fixture(t);
  const first = '12345678-1234-1234-1234-123456789abc';
  const second = '22345678-1234-1234-1234-123456789abc';
  rollout(roots.codexRoot, 'original', { turnId: first });
  rollout(roots.codexRoot, 'fork', { turnId: first });
  rollout(roots.codexRoot, 'archived', { turnId: second, output: 40, archived: true });
  const result = readTaskSpeedStats({ ...roots,
    sessions: ['original', 'original', 'fork', 'archived'].map(sessionId => ({ client: 'codex', sessionId })) });
  assert.equal(result.sessions.at(-1).speed, 20);
  assert.equal(result.overall.taskCount, 2);
  assert.equal(result.overall.outputTokens, 60);
  assert.equal(result.overall.durationMs, 4000);
  assert.equal(result.overall.speed, 15);
});

test('each refresh scans each fallback root once, including cached, missing and archived sessions', t => {
  const roots = fixture(t);
  rollout(roots.codexRoot, 'rollout-2026-10-04T10-00-00-direct', { turnId: 'direct', output: 10 });
  rollout(roots.codexRoot, 'live', { turnId: 'live', output: 20 });
  rollout(roots.codexRoot, 'live', { turnId: 'wrong-archive', output: 900, archived: true });
  rollout(roots.codexRoot, 'archive', { turnId: 'archive', output: 30, archived: true });
  const reads = new Map();
  const countedFs = { ...fs, readdirSync(dir, options) {
    reads.set(dir, (reads.get(dir) || 0) + 1);
    return fs.readdirSync(dir, options);
  } };
  const sessionFile = require.resolve('../../src/shared/sessionFiles');
  const sessionModule = { exports: {} };
  const sessionRequire = createRequire(sessionFile);
  vm.runInNewContext(fs.readFileSync(sessionFile, 'utf8'), {
    module: sessionModule, process, require: id => id === 'node:fs' ? countedFs : sessionRequire(id)
  });
  const file = require.resolve('../../src/shared/taskSpeed');
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, Buffer, process,
    require: id => id === './sessionFiles' ? sessionModule.exports : nativeRequire(id) });
  const sessions = ['rollout-2026-10-04T10-00-00-direct', 'live', 'archive',
    ...Array.from({ length: 100 }, (_, i) => `missing-${i}`), '../unsafe'].map(sessionId => ({ client: 'codex', sessionId }));
  for (let refresh = 0; refresh < 2; refresh++) {
    reads.clear();
    const result = module.exports.readTaskSpeedStats({ ...roots, sessions });
    assert.equal(result.sessions.length, 103);
    assert.deepEqual(Array.from(result.sessions.slice(0, 3), session => session.outputTokens), [10, 20, 30]);
    assert.equal(result.overall.outputTokens, 60);
    for (const root of ['sessions', 'archived_sessions']) {
      assert.equal(reads.get(path.join(roots.codexRoot, root)), 1, `${root}: one walk on refresh ${refresh}`);
    }
  }
});

function historyDb(root) {
  const db = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, started_at TEXT, duration_ms INTEGER,
    status TEXT, first_user_item_id TEXT, rollout_ordinal INTEGER);
    CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT)`);
  db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)').run('thread', 'turn', '2026-10-04T10:00:00Z', 2000, 'completed', 'user', 1);
  db.prepare('INSERT INTO thread_items VALUES (?,?,?)').run('thread', 'user', JSON.stringify({ content: [{ type: 'text', text: 'fixture' }] }));
  return db;
}

test('fallback task cache invalidates when the main history database changes without a WAL', t => {
  const roots = fixture(t);
  const db = historyDb(roots.codexRoot);
  db.close();
  const args = { ...roots, sessions: [{ client: 'codex', sessionId: 'thread' }] };
  assert.equal(readTaskSpeedStats(args).sessions[0].tasks[0].durationMs, 2000);
  const updated = new DatabaseSync(path.join(roots.codexRoot, 'thread_history_1.sqlite'));
  updated.exec('UPDATE thread_turns SET duration_ms=5000');
  updated.close();
  const file = path.join(roots.codexRoot, 'thread_history_1.sqlite');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  assert.equal(fs.existsSync(`${file}-wal`), false);
  assert.equal(readTaskSpeedStats(args).sessions[0].tasks[0].durationMs, 5000);
});

test('the timing map reuses unchanged scans and refreshes after database or WAL changes', t => {
  const roots = fixture(t);
  const db = historyDb(roots.codexRoot);
  db.close();
  let scans = 0;
  class CountedDatabase extends DatabaseSync {
    prepare(sql) {
      if (sql === 'SELECT thread_id,turn_id,status,duration_ms FROM thread_turns') scans++;
      return super.prepare(sql);
    }
  }
  const file = require.resolve('../../src/shared/taskSpeed');
  const nativeRequire = createRequire(file);
  const requireFixture = id => id === 'node:sqlite' ? { DatabaseSync: CountedDatabase } : nativeRequire(id);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: requireFixture, module, Buffer, process });
  const read = () => module.exports.readTaskSpeedStats({ ...roots, sessions: [] });
  read(); read();
  assert.equal(scans, 1);
  const database = path.join(roots.codexRoot, 'thread_history_1.sqlite');
  fs.utimesSync(database, new Date(), new Date(Date.now() + 1000));
  read();
  assert.equal(scans, 2);
  const writer = new DatabaseSync(database);
  try {
    writer.exec('PRAGMA journal_mode=WAL; UPDATE thread_turns SET duration_ms=6000');
    read();
    assert.equal(scans, 3);
    read();
    assert.equal(scans, 3);
  } finally { writer.close(); }
});

test('one user task includes all model requests, ignores duplicate usage, and uses its real execution duration', () => {
  const usage = (output) => ({ type: 'token_count', info: {
    total_token_usage: { output_tokens: output },
    last_token_usage: { input_tokens: 10000, output_tokens: 20 }
  } });
  const tasks = parseCodexTasks([
    event('2026-10-04T10:00:00Z', usage(100)),
    event('2026-10-04T10:01:00Z', { type: 'task_started', turn_id: 'a' }),
    event('2026-10-04T10:01:00Z', { type: 'user_message', message: 'first task' }),
    event('2026-10-04T10:01:01Z', usage(120)),
    event('2026-10-04T10:01:02Z', usage(120)),
    event('2026-10-04T10:01:03Z', usage(140)),
    event('2026-10-04T10:01:04Z', { type: 'task_complete', turn_id: 'a', duration_ms: 4000 }),
    event('2026-10-04T12:00:00Z', { type: 'task_started', turn_id: 'b' }),
    event('2026-10-04T12:00:00Z', { type: 'user_message', message: 'second task' }),
    event('2026-10-04T12:00:02Z', usage(180)),
    event('2026-10-04T12:00:04Z', { type: 'task_complete', turn_id: 'b', duration_ms: 4000 })
  ].join('\n'));
  const result = summarize(tasks);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.outputTokens, 80);
  assert.equal(result.durationMs, 8000);
  assert.equal(result.speed, 10);
});

test('conversation averages use summed output and elapsed time rather than averaging speeds', () => {
  const result = summarize([
    { status: 'completed', outputTokens: 1000, durationMs: 10000, tokensAvailable: true },
    { status: 'completed', outputTokens: 1000, durationMs: 100000, tokensAvailable: true },
    { status: 'completed', outputTokens: 0, durationMs: 10000, tokensAvailable: false }
  ]);
  assert.equal(result.speed, 2000 / 110);
  assert.equal(result.measuredCount, 2);
  assert.equal(result.tasks[2].speed, null);
});

test('a running task reports elapsed execution time and does not include gaps between tasks', () => {
  const result = summarize([{ status: 'running', startedAt: 1000, outputTokens: 20, tokensAvailable: true }], 3000);
  assert.equal(result.tasks[0].speed, 10);
  assert.equal(result.speed, null);
  assert.equal(result.tasks[0].durationMs, 2000);
});
