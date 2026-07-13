'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const ocs = require('../../src/shared/opencodeSession');

// The whole suite needs node:sqlite (Node >= 22.5 / Electron 42). Skip cleanly when absent.
const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Build a synthetic opencode.db with a session, its messages, and their parts.
function makeDb({ session, messages = [], parts = [] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocsess-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');

  db.prepare('INSERT INTO session (id, parent_id, title, time_created, time_updated) VALUES (?,?,?,?,?)')
    .run(session.id, session.parentId || null, session.title || '', session.created, session.updated);

  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  for (const m of messages) {
    const data = m.role === 'assistant'
      ? JSON.stringify({ role: 'assistant', modelID: m.model || 'big-pickle', providerID: 'opencode', cost: m.cost, tokens: m.tokens, time: { created: m.createdMs } })
      : JSON.stringify({ role: 'user', time: { created: m.createdMs } });
    insM.run(m.id, session.id, m.createdMs, m.createdMs, data);
  }

  const insP = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  let i = 0;
  for (const p of parts) {
    const data = p.type === 'tool'
      ? JSON.stringify({ type: 'tool', tool: p.tool, callID: 'c' + i })
      : JSON.stringify({ type: p.type, text: p.text });
    insP.run('p' + (i++), p.messageId, session.id, p.createdMs, p.createdMs, data);
  }

  db.close();
  return file;
}

// Token sample lifted from a real opencode.db row. The DB's stored total (9441) ADDS reasoning
// (16) on top of input+output+cache (9425). We total the tokscale way (9425, reasoning excluded)
// so the detail matches the session card.
const T0 = Date.UTC(2026, 5, 4, 10, 0, 0);
const T1 = Date.UTC(2026, 5, 4, 10, 0, 5);
const T2 = Date.UTC(2026, 5, 4, 10, 1, 0);
const T3 = Date.UTC(2026, 5, 4, 10, 1, 5);
const T4 = Date.UTC(2026, 5, 4, 10, 1, 9);

function fixture() {
  return makeDb({
    session: { id: 's1', title: 'Greeting', created: T0, updated: T2 },
    messages: [
      { id: 'm0', role: 'user', createdMs: T0 },
      { id: 'm1', role: 'assistant', createdMs: T1, cost: 0.5, tokens: { total: 9441, input: 9416, output: 9, reasoning: 16, cache: { read: 0, write: 0 } } },
      { id: 'm2', role: 'user', createdMs: T2 },
      { id: 'm3', role: 'assistant', createdMs: T3, cost: 0.25, tokens: { total: 100, input: 50, output: 30, reasoning: 5, cache: { read: 15, write: 0 } } },
      { id: 'm4', role: 'assistant', createdMs: T4, cost: 0.1, tokens: { total: 200, input: 120, output: 40, reasoning: 0, cache: { read: 40, write: 0 } } }
    ],
    parts: [
      { messageId: 'm0', type: 'text', text: 'Hello there', createdMs: T0 },
      { messageId: 'm1', type: 'text', text: 'Hi, reply text', createdMs: T1 },
      { messageId: 'm1', type: 'tool', tool: 'bash', createdMs: T1 },
      { messageId: 'm2', type: 'text', text: 'Do a search', createdMs: T2 },
      { messageId: 'm3', type: 'tool', tool: 'websearch', createdMs: T3 }
    ]
  });
}

maybe('readSessionMeta returns ISO timestamps + title from the session table', () => {
  const file = fixture();
  const meta = ocs.readSessionMeta(['s1', 'missing'], { dbPaths: [file], sqlite });
  assert.strictEqual(meta.size, 1);
  assert.deepStrictEqual(meta.get('s1'), {
    startedAt: new Date(T0).toISOString(),
    lastUsedAt: new Date(T2).toISOString(),
    title: 'Greeting'
  });
});

maybe('readSessionMeta returns an empty map when sqlite is unavailable', () => {
  const file = fixture();
  const meta = ocs.readSessionMeta(['s1'], { dbPaths: [file], sqlite: null });
  assert.strictEqual(meta.size, 0);
});

maybe('readSessionMeta honors a custom OPENCODE_DB path', () => {
  const file = fixture();
  const meta = ocs.readSessionMeta(['s1'], {
    sqlite,
    env: { OPENCODE_DB: file, XDG_DATA_HOME: '/ignored' }
  });
  assert.equal(meta.get('s1').title, 'Greeting');
});

maybe('readSessionMetaForHome discovers stable and channel databases inside that home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocsess-home-'));
  tmpDirs.push(home);
  const dataDir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [filename, id] of [['opencode.db', 'stable'], ['opencode-beta.db', 'beta']]) {
    const db = new sqlite.DatabaseSync(path.join(dataDir, filename));
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER)');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(id, id, T0, T1);
    db.close();
  }
  const meta = ocs.readSessionMetaForHome(['stable', 'beta'], home, {
    sqlite,
    env: { OPENCODE_DB: 'C:\\host\\opencode.db', XDG_DATA_HOME: 'C:\\host\\data' }
  });
  assert.deepEqual([...meta.keys()].sort(), ['beta', 'stable']);
});

maybe('readSessionEvents builds prompt/turn events in time order', () => {
  const file = fixture();
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  assert.strictEqual(out.found, true);
  assert.deepStrictEqual(out.events.map((e) => e.kind), ['prompt', 'turn', 'prompt', 'turn', 'turn']);
  assert.strictEqual(out.events[0].text, 'Hello there');
  assert.strictEqual(out.events[2].text, 'Do a search');
  assert.deepStrictEqual(out.events[1].tools, ['bash']);
  assert.deepStrictEqual(out.events[3].tools, ['websearch']);
  assert.deepStrictEqual(out.events[4].tools, []);
  assert.strictEqual(out.events[1].timestamp, new Date(T1).toISOString());
});

maybe('readSessionEvents totals the tokscale way (reasoning excluded), matching the session card', () => {
  const file = fixture();
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  const turn = out.events[1].tokens;
  assert.deepStrictEqual(turn, { input: 9416, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 16, total: 9425 });
  // reasoning is informational only; total excludes it (DB's stored total of 9441 would over-count):
  assert.strictEqual(turn.total, turn.input + turn.output + turn.cacheRead + turn.cacheWrite);
});

maybe('readSessionEvents carries real per-message cost and sums sessionCost', () => {
  const file = fixture();
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  assert.strictEqual(out.events[1].cost, 0.5);
  assert.strictEqual(out.events[3].cost, 0.25);
  assert.strictEqual(out.events[4].cost, 0.1);
  assert.strictEqual(out.sessionCost, 0.85);
});

maybe('readSessionEvents returns found:false for an unknown session', () => {
  const file = fixture();
  const out = ocs.readSessionEvents('nope', { dbPaths: [file], sqlite });
  assert.deepStrictEqual(out, { found: false, events: [], sessionCost: 0 });
});

maybe('readSessionEvents returns found:false when sqlite is unavailable', () => {
  const file = fixture();
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite: null });
  assert.deepStrictEqual(out, { found: false, events: [], sessionCost: 0 });
});
