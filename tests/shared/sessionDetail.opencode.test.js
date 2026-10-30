'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const { readSessionDetail } = require('../../src/shared/sessionDetail');

const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 5, 4, 10, 0, 0);
const T1 = Date.UTC(2026, 5, 4, 10, 0, 5);
const T2 = Date.UTC(2026, 5, 4, 10, 1, 0);
const T3 = Date.UTC(2026, 5, 4, 10, 1, 5);
const T4 = Date.UTC(2026, 5, 4, 10, 1, 9);

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdetail-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('s1', null, 'Greeting', T0, T2);
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const asst = (cost, tokens, createdMs) => JSON.stringify({ role: 'assistant', providerID: 'opencode', cost, tokens, time: { created: createdMs } });
  const user = (createdMs) => JSON.stringify({ role: 'user', time: { created: createdMs } });
  insM.run('m0', 's1', T0, T0, user(T0));
  insM.run('m1', 's1', T1, T1, asst(0.5, { total: 9441, input: 9416, output: 9, reasoning: 16, cache: { read: 0, write: 0 } }, T1));
  insM.run('m2', 's1', T2, T2, user(T2));
  insM.run('m3', 's1', T3, T3, asst(0.25, { total: 100, input: 50, output: 30, reasoning: 5, cache: { read: 15, write: 0 } }, T3));
  insM.run('m4', 's1', T4, T4, asst(0.1, { total: 200, input: 120, output: 40, reasoning: 0, cache: { read: 40, write: 0 } }, T4));
  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  insP.run('p0', 'm0', 's1', T0, T0, JSON.stringify({ type: 'text', text: 'Hello there' }));
  insP.run('p1', 'm2', 's1', T2, T2, JSON.stringify({ type: 'text', text: 'Do a search' }));
  insP.run('p2', 'm3', 's1', T3, T3, JSON.stringify({ type: 'tool', tool: 'websearch' }));
  db.close();
  return file;
}

maybe('readSessionDetail(opencode) groups exchanges with real per-turn cost', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'total',
    deps: { dbPaths: [file], sqlite, now: () => T4 + 1000 }
  });
  assert.strictEqual(detail.found, true);
  assert.strictEqual(detail.exchanges.length, 2);

  const [ex1, ex2] = detail.exchanges;
  assert.strictEqual(ex1.promptPreview, 'Hello there');
  assert.strictEqual(ex1.turnCount, 1);
  assert.strictEqual(ex1.tokens.total, 9425); // 9416 + 9 (+0 cache); reasoning 16 excluded
  assert.strictEqual(ex1.costEstimate, 0.5);

  assert.strictEqual(ex2.promptPreview, 'Do a search');
  assert.strictEqual(ex2.turnCount, 2);
  assert.strictEqual(ex2.tokens.total, 295); // (50+30+15) + (120+40+40)
  assert.ok(Math.abs(ex2.costEstimate - 0.35) < 1e-9);
});

maybe('readSessionDetail(opencode) totals use real cost + DB token totals', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'total',
    deps: { dbPaths: [file], sqlite, now: () => T4 + 1000 }
  });
  assert.strictEqual(detail.totals.totalTokens, 9720); // 9425 + 295
  assert.strictEqual(detail.totals.turnCount, 3);
  assert.strictEqual(detail.totals.exchangeCount, 2);
  assert.ok(Math.abs(detail.totals.costUsd - 0.85) < 1e-9);
});

maybe('readSessionDetail(opencode) filters by period (now in a later month → empty)', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'today',
    deps: { dbPaths: [file], sqlite, now: () => Date.UTC(2026, 6, 1, 12, 0, 0) }
  });
  assert.strictEqual(detail.found, true);
  assert.strictEqual(detail.exchanges.length, 0);
  assert.strictEqual(detail.totals.totalTokens, 0);
  assert.strictEqual(detail.totals.costUsd, 0);
});

maybe('readSessionDetail(opencode) returns not-found for an unknown session', () => {
  const file = makeFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 'nope', period: 'total',
    deps: { dbPaths: [file], sqlite }
  });
  assert.strictEqual(detail.found, false);
  assert.deepStrictEqual(detail.exchanges, []);
});

// The same conversation in the shape OpenCode 2.x writes. Without the current
// tables every session created after that upgrade reached this path as
// found:false, which the renderer shows as "Transcript not found on this machine".
function makeCurrentFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdetail-v2-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('s1', 'Greeting', 'D:/repo', T0, T4);
  const ins = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const asst = (cost, tokens, createdMs, content) => JSON.stringify({
    time: { created: createdMs }, agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, content, cost, tokens, finish: 'stop'
  });
  const user = (createdMs, text) => JSON.stringify({ time: { created: createdMs }, text });
  ins.run('m0', 's1', 'user', 0, T0, T0, user(T0, 'Hello there'));
  ins.run('m1', 's1', 'assistant', 1, T1, T1, asst(0.5, { input: 9416, output: 9, reasoning: 16, cache: { read: 0, write: 0 } }, T1, [{ type: 'text', text: 'Hi, reply text' }]));
  ins.run('m2', 's1', 'user', 2, T2, T2, user(T2, 'Do a search'));
  ins.run('m3', 's1', 'assistant', 3, T3, T3, asst(0.25, { input: 50, output: 30, reasoning: 5, cache: { read: 15, write: 0 } }, T3, [{ type: 'tool', name: 'websearch' }]));
  ins.run('m4', 's1', 'assistant', 4, T4, T4, asst(0.1, { input: 120, output: 40, reasoning: 0, cache: { read: 40, write: 0 } }, T4, []));
  db.close();
  return file;
}

maybe('readSessionDetail(opencode) reads the current shape OpenCode 2.x writes', () => {
  const file = makeCurrentFixture();
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'total',
    deps: { dbPaths: [file], sqlite, now: () => T4 + 1000 }
  });
  assert.strictEqual(detail.found, true);
  assert.strictEqual(detail.exchanges.length, 2);

  const [ex1, ex2] = detail.exchanges;
  assert.strictEqual(ex1.promptPreview, 'Hello there');
  assert.strictEqual(ex1.turnCount, 1);
  assert.strictEqual(ex1.tokens.total, 9425);
  assert.strictEqual(ex1.costEstimate, 0.5);

  assert.strictEqual(ex2.promptPreview, 'Do a search');
  assert.strictEqual(ex2.turnCount, 2);
  assert.strictEqual(detail.totals.totalTokens, 9720);
  assert.strictEqual(detail.totals.turnCount, 3);
  assert.ok(Math.abs(detail.totals.costUsd - 0.85) < 1e-9);
});

// Match upstream transformSession: the compaction USER id survives, the paired
// summary assistant id does not, and its usage survives only in the old message
// row and session aggregates. Ordinary assistants retain their original id.
function makeMigratedFixture({ representedSummary = false, currentCompactionUsage = false, summaryTime = T4, omittedCompaction = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdetail-migrated-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, cost REAL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('s1', 'Migrated', T0, summaryTime);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('s1', 'Migrated', T0, summaryTime, 300, 3);
  const usage = (input, cost) => ({ cost, tokens: { input, output: 0, cache: { read: 0, write: 0 } } });
  const old = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const legacy = (id, created, data, sessionId = 's1') => old.run(id, sessionId, created, created, JSON.stringify({ ...data, time: { created, completed: created + 1 } }));
  legacy('user', T0, { role: 'user' });
  legacy('answer', T1, { role: 'assistant', ...usage(100, 1) });
  legacy('compact', T2, { role: 'user' });
  legacy('summary', summaryTime, { role: 'assistant', parentID: 'compact', summary: true, ...usage(200, 2) });
  // Unrelated legacy rows are not permission to add a second copy of history.
  legacy('unmapped', T3, { role: 'assistant', ...usage(400, 4) });
  legacy('other-summary', T3, { role: 'assistant', parentID: 'compact', summary: true, ...usage(800, 8) }, 'other-session');
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('compact-part', 'compact', 's1', T2, T2, JSON.stringify({ type: 'compaction', auto: true }));
  const current = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const add = (id, type, seq, created, data) => current.run(id, 's1', type, seq, created, created, JSON.stringify({ time: { created }, ...data }));
  add('user', 'user', 0, T0, { text: 'Original prompt' });
  add('answer', 'assistant', 1, T1, { content: [{ type: 'tool', name: 'shell' }], ...usage(100, 1), finish: 'stop' });
  if (!omittedCompaction) add('compact', 'compaction', 2, T2, {
    status: 'completed', reason: 'auto', summary: 'Summary', recent: '',
    ...(currentCompactionUsage ? usage(250, 2.5) : {})
  });
  if (representedSummary) add('summary', 'assistant', 3, summaryTime, { content: [], ...usage(200, 2), finish: 'stop' });
  db.close();
  return file;
}

maybe('migrated compaction summaries preserve usage without duplicating history or prompts', () => {
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [makeMigratedFixture()], sqlite } });
  assert.equal(detail.totals.totalTokens, 300);
  assert.equal(detail.totals.costUsd, 3);
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'Original prompt');
  assert.equal(detail.totals.turnCount, 1, 'a paid compaction is not another assistant reply');
  assert.deepEqual(detail.exchanges[0].turns.map((turn) => turn.tokens.total), [100, 200]);
  assert.equal(detail.exchanges[0].turns[1].type, 'compaction-summary');
});

maybe('a summary represented in the current messages is counted once', () => {
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [makeMigratedFixture({ representedSummary: true })], sqlite } });
  assert.equal(detail.totals.totalTokens, 300);
  assert.equal(detail.totals.costUsd, 3);
  assert.equal(detail.exchanges[0].turns.length, 2);
});

maybe('current compaction usage takes precedence over its migrated summary copy', () => {
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [makeMigratedFixture({ currentCompactionUsage: true })], sqlite } });
  assert.equal(detail.totals.totalTokens, 350);
  assert.equal(detail.totals.costUsd, 3.5);
  assert.equal(detail.totals.turnCount, 1);
});

maybe('migrated summary usage keeps its own timestamp for period filtering', () => {
  const summaryTime = T4 + 24 * 60 * 60 * 1000;
  const detail = readSessionDetail({
    client: 'opencode', sessionId: 's1', period: 'today',
    deps: { dbPaths: [makeMigratedFixture({ summaryTime })], sqlite, now: () => summaryTime + 1000 }
  });
  assert.equal(detail.totals.totalTokens, 200);
  assert.equal(detail.totals.costUsd, 2);
  assert.equal(detail.exchanges[0].turns[0].timestamp, new Date(summaryTime).toISOString());
});

maybe('summary reconciliation uses one SQLite snapshot while OpenCode writes', () => {
  const file = makeMigratedFixture();
  const setup = new sqlite.DatabaseSync(file);
  setup.exec('PRAGMA journal_mode = WAL');
  setup.close();
  let inserted = false;
  const concurrentSqlite = {
    DatabaseSync: function (...args) {
      const db = new sqlite.DatabaseSync(...args);
      return new Proxy(db, {
        get(target, key) {
          if (key === 'prepare') return (sql) => {
            // Publish a current copy after legacy reconciliation but before the
            // current transcript query. Either complete snapshot totals $3.
            if (!inserted && /FROM session_message\s+WHERE/.test(sql)) {
              inserted = true;
              const writer = new sqlite.DatabaseSync(file);
              writer.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
                'summary', 's1', 'assistant', 3, T4, T4,
                JSON.stringify({ time: { created: T4 }, content: [], tokens: { input: 200 }, cost: 2 })
              );
              writer.close();
            }
            return target.prepare(sql);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  for (const sqliteModule of [concurrentSqlite, sqlite]) {
    const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite: sqliteModule } });
    assert.equal(detail.totals.totalTokens, 300);
    assert.equal(detail.totals.costUsd, 3);
  }
  assert.equal(inserted, true);
});

maybe('failed and incomplete migrated compactions retain paid usage before the next prompt', () => {
  for (const kind of ['failed', 'incomplete']) {
    const file = makeMigratedFixture({ omittedCompaction: true });
    const db = new sqlite.DatabaseSync(file);
    if (kind === 'failed') db.exec(`UPDATE message SET data = json_set(data, '$.error', json('{"name":"UnknownError","data":{"message":"failed"}}')) WHERE id = 'summary'`);
    else db.exec("UPDATE message SET data = json_remove(data, '$.time.completed') WHERE id = 'summary'");
    // A summary flag alone is insufficient evidence of a compaction request.
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('unverified', 's1', T3, T3, JSON.stringify({
      role: 'assistant', summary: true, parentID: 'user', tokens: { input: 800 }, cost: 8
    }));
    const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    // Deliberately invert clocks; the shared legacy message id anchors usage
    // before this new prompt without sorting the current stream by timestamps.
    add.run('next', 's1', 'user', 2, T0, T0, JSON.stringify({ time: { created: T0 }, text: 'Next prompt' }));
    add.run('next-answer', 's1', 'assistant', 3, T0 + 1, T0 + 1, JSON.stringify({ time: { created: T0 + 1 }, content: [], tokens: { input: 50 }, cost: 0.5 }));
    db.close();
    const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite } });
    assert.equal(detail.totals.totalTokens, 350, kind);
    assert.equal(detail.totals.costUsd, 3.5, kind);
    assert.deepEqual(detail.exchanges.map((exchange) => exchange.promptPreview), ['Original prompt', 'Next prompt']);
    assert.deepEqual(detail.exchanges.map((exchange) => exchange.turns.map((turn) => turn.tokens.total)), [[100, 200], [50]]);
    assert.equal(detail.exchanges[0].turns[1].type, 'compaction-summary');
    assert.equal(detail.exchanges[0].turns[1].timestamp, new Date(T4).toISOString());
  }
});

maybe('a compaction-only legacy prefix stays before new v2 messages without inventing a prompt', () => {
  const file = makeMigratedFixture({ omittedCompaction: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec("DELETE FROM message WHERE id IN ('user', 'answer'); DELETE FROM session_message; UPDATE session_v2 SET tokens_input = 9999, cost = 9999");
  const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  add.run('new-user', 's1', 'user', 0, T0, T0, JSON.stringify({ time: { created: T0 }, text: 'After upgrade' }));
  add.run('new-answer', 's1', 'assistant', 1, T1, T1, JSON.stringify({ time: { created: T1 }, content: [], tokens: { input: 50 }, cost: 0.5 }));
  db.close();
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite } });
  assert.equal(detail.totals.totalTokens, 250, 'read the identified summary, never the aggregate difference');
  assert.equal(detail.totals.costUsd, 2.5);
  assert.deepEqual(detail.exchanges.map((exchange) => exchange.promptPreview), ['', 'After upgrade']);
  assert.deepEqual(detail.exchanges.map((exchange) => exchange.turns.map((turn) => turn.tokens.total)), [[200], [50]]);
});

// Mirror the fixed upstream test that omits a task assistant and incomplete
// compaction together: task = 28 tokens/$4, summary = 16 tokens/$1 (reasoning
// remains informational). Only the mixed text/subtask user survives migration.
function makeSubtaskFixture() {
  const file = makeMigratedFixture({ omittedCompaction: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('DELETE FROM message; DELETE FROM part; DELETE FROM session_message; UPDATE session_v2 SET tokens_input = 7, cost = 5');
  const old = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const add = (id, created, data) => old.run(id, 's1', created, created + 1, JSON.stringify({ time: { created }, ...data }));
  add('mixed', T0, { role: 'user' });
  add('task', T1, { role: 'assistant', parentID: 'mixed', cost: 4, tokens: { input: 5, output: 6, reasoning: 7, cache: { read: 8, write: 9 } } });
  add('compact', T2, { role: 'user' });
  add('summary', T3, { role: 'assistant', parentID: 'compact', summary: true, cost: 1, tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } } });
  add('unrelated', T2, { role: 'assistant', parentID: 'mixed', cost: 9, tokens: { input: 900 } });
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  for (const [id, messageId, data] of [
    ['mixed-text', 'mixed', { type: 'text', text: 'Keep' }],
    ['request', 'mixed', { type: 'subtask', prompt: 'work', description: 'work', agent: 'build' }],
    ['task-tool', 'task', { type: 'tool', tool: 'task', callID: 'task', state: { status: 'pending', input: {}, raw: '{}' } }],
    ['compaction', 'compact', { type: 'compaction', auto: true }]
  ]) part.run(id, messageId, 's1', T0, T0, JSON.stringify(data));
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('mixed', 's1', 'user', 0, T0, T0, JSON.stringify({ time: { created: T0 }, text: 'Keep' }));
  db.close();
  return file;
}

maybe('migrated subtask assistants and incomplete summaries both retain their own paid usage', () => {
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [makeSubtaskFixture()], sqlite } });
  assert.equal(detail.totals.totalTokens, 44);
  assert.equal(detail.totals.costUsd, 5);
  assert.equal(detail.totals.turnCount, 1);
  assert.deepEqual(detail.exchanges.map((exchange) => exchange.promptPreview), ['Keep']);
  assert.deepEqual(detail.exchanges[0].turns.map((turn) => turn.tokens.total), [28, 16]);
  assert.deepEqual(detail.exchanges[0].turns[0].tools, ['task']);
  assert.equal(detail.exchanges[0].turns[0].tokens.reasoning, 7);
  assert.equal(detail.exchanges[0].turns[0].timestamp, new Date(T1).toISOString());
  assert.equal(detail.exchanges[0].turns[1].type, 'compaction-summary');
});

maybe('subtask supplementation requires both same-session parent request and owned task tool', () => {
  for (const mutation of [
    "DELETE FROM part WHERE id = 'request'",
    "DELETE FROM part WHERE id = 'task-tool'",
    "UPDATE part SET session_id = 'other' WHERE id = 'request'",
    "UPDATE part SET session_id = 'other' WHERE id = 'task-tool'",
    "UPDATE message SET session_id = 'other' WHERE id = 'mixed'",
    "UPDATE part SET data = json_set(data, '$.tool', 'shell') WHERE id = 'task-tool'"
  ]) {
    const file = makeSubtaskFixture();
    const db = new sqlite.DatabaseSync(file);
    db.exec(mutation);
    db.close();
    const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite } });
    assert.equal(detail.totals.totalTokens, 16, mutation);
    assert.equal(detail.totals.costUsd, 1, mutation);
  }
});

maybe('a current subtask assistant id wins over its legacy copy', () => {
  const file = makeSubtaskFixture();
  const db = new sqlite.DatabaseSync(file);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('task', 's1', 'assistant', 1, T1, T1, JSON.stringify({
    time: { created: T1 }, content: [{ type: 'tool', name: 'task' }], tokens: { input: 30 }, cost: 6
  }));
  db.close();
  const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite } });
  assert.equal(detail.totals.totalTokens, 46);
  assert.equal(detail.totals.costUsd, 7);
  assert.deepEqual(detail.exchanges[0].turns.map((turn) => turn.tokens.total), [30, 16]);
  assert.deepEqual(detail.exchanges[0].turns[0].tools, ['task']);
});

maybe('omitted subtask usage stays at its surviving id anchor or legacy-only prefix', () => {
  for (const prefix of [false, true]) {
    const file = makeSubtaskFixture();
    const db = new sqlite.DatabaseSync(file);
    if (prefix) db.exec('DELETE FROM session_message');
    const add = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    // New v2 clocks precede old usage; seq and the surviving legacy ids define
    // placement. No aggregate difference is used, even with bogus aggregates.
    db.exec('UPDATE session_v2 SET tokens_input = 9999, cost = 9999');
    add.run('next', 's1', 'user', 1, T0 - 2, T0 - 2, JSON.stringify({ time: { created: T0 - 2 }, text: 'Next' }));
    add.run('next-answer', 's1', 'assistant', 2, T0 - 1, T0 - 1, JSON.stringify({ time: { created: T0 - 1 }, content: [], tokens: { input: 50 }, cost: 0.5 }));
    db.close();
    const detail = readSessionDetail({ client: 'opencode', sessionId: 's1', deps: { dbPaths: [file], sqlite } });
    assert.equal(detail.totals.totalTokens, 94);
    assert.equal(detail.totals.costUsd, 5.5);
    assert.deepEqual(detail.exchanges.map((exchange) => exchange.promptPreview), [prefix ? '' : 'Keep', 'Next']);
    assert.deepEqual(detail.exchanges.map((exchange) => exchange.turns.map((turn) => turn.tokens.total)), [[28, 16], [50]]);
  }
});
