'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const {
  readWorkbuddySessionUsage,
  workbuddyDatabasePath
} = require('../../src/shared/providers/workbuddy/sessionContext');

// The reader is built on node:sqlite through the shared sqliteReadOnly helper;
// a runtime without it (older Node) must skip these cases instead of failing
// the suite.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite is unavailable on this runtime';

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = '104ae982fbaa4e6383d9e0843b145ced';

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function transcript(timestamp) {
  return [
    JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp,
      sessionId: SESSION,
      cwd: '/repo/demo',
      content: [{ type: 'input_text', text: '<user_query>hi</user_query>' }]
    }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      timestamp: timestamp + 1000,
      sessionId: SESSION,
      providerData: { messageId: 'm1' },
      content: [{ type: 'output_text', text: 'ok' }]
    })
  ].join('\n') + '\n';
}

function makeHome(timestamp) {
  const home = tmpDir('workbuddy-context-');
  const dir = path.join(home, '.workbuddy', 'projects', 'c-Users-me-WorkBuddy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), transcript(timestamp));
  return home;
}

function seedUsage(home, rows, { table = true } = {}) {
  const db = new sqlite.DatabaseSync(workbuddyDatabasePath({ home }));
  if (table) {
    db.exec(`CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY,
      used INTEGER NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      credit_json TEXT
    )`);
    const statement = db.prepare(
      'INSERT INTO session_usage (session_id, used, size, updated_at) VALUES (?, ?, ?, ?)'
    );
    for (const [id, used, size] of rows) statement.run(id, used, size, Date.now());
  }
  db.close();
}

function periodsFor() {
  return {
    today: { sessions: { [`workbuddy:${SESSION}`]: { client: 'workbuddy', sessionId: SESSION } } },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
}

test('reads the pair WorkBuddy writes for an open session', { skip }, () => {
  const home = makeHome(Date.now());
  seedUsage(home, [[SESSION, 138916, 1000000]]);

  const read = readWorkbuddySessionUsage([SESSION], { home, deps: { sqlite } });
  assert.equal(read.supported, true);
  assert.deepEqual(read.rows.get(SESSION), { contextTokens: 138916, contextWindow: 1000000 });
  assert.equal(read.misses.size, 0);
});

test('stamps occupancy on the session row only while it could still be open', { skip }, () => {
  const live = makeHome(Date.now());
  seedUsage(live, [[SESSION, 123456, 950000]]);
  const livePeriods = periodsFor();
  applySessionMetadata(livePeriods, live, { sqlite });
  const stamped = livePeriods.today.sessions[`workbuddy:${SESSION}`];
  assert.equal(stamped.contextTokens, 123456);
  assert.equal(stamped.contextWindow, 950000);

  // The same database row for a session last touched two hours ago is not a
  // live fact; reading it would put a gauge on a conversation nobody has open.
  const stale = makeHome(Date.now() - 2 * 60 * 60 * 1000);
  seedUsage(stale, [[SESSION, 123456, 950000]]);
  const stalePeriods = periodsFor();
  applySessionMetadata(stalePeriods, stale, { sqlite });
  const untouched = stalePeriods.today.sessions[`workbuddy:${SESSION}`];
  assert.equal(untouched.contextTokens, undefined);
  assert.equal(untouched.contextWindow, undefined);
});

test('a half-filled row is a miss, not a gauge', { skip }, () => {
  const home = makeHome(Date.now());
  seedUsage(home, [[SESSION, 0, 1000000]]);

  const read = readWorkbuddySessionUsage([SESSION], { home, deps: { sqlite } });
  assert.equal(read.rows.size, 0);
  assert.equal(read.misses.has(SESSION), true);
});

test('a missing usage table degrades to no badge instead of failing collection', { skip }, () => {
  const home = makeHome(Date.now());
  seedUsage(home, [], { table: false });

  const read = readWorkbuddySessionUsage([SESSION], { home, deps: { sqlite } });
  assert.equal(read.supported, false);
  assert.equal(read.rows.size, 0);

  const periods = periodsFor();
  applySessionMetadata(periods, home, { sqlite });
  const session = periods.today.sessions[`workbuddy:${SESSION}`];
  assert.equal(session.title, undefined);
  assert.equal(session.contextTokens, undefined);
});

test('a runtime without node:sqlite leaves every session untouched', () => {
  const home = makeHome(Date.now());
  const periods = periodsFor();
  applySessionMetadata(periods, home, { sqlite: null });
  const session = periods.today.sessions[`workbuddy:${SESSION}`];
  assert.equal(session.contextTokens, undefined);
  assert.equal(session.contextWindow, undefined);
});
