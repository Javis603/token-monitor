'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const ocs = require('../../src/shared/providers/opencode/session');
const { pickRecentUsageActivity } = require('../../src/shared/trayText');

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
      // `finish` is OpenCode's turn-end signal; omitted means "not recorded",
      // which is the pre-v2 shape and must not read as a finished turn.
      ? JSON.stringify({
        role: 'assistant',
        modelID: m.model || 'big-pickle',
        providerID: 'opencode',
        cost: m.cost,
        tokens: m.tokens,
        time: { created: m.createdMs, ...(m.completedMs === undefined ? {} : { completed: m.completedMs }) },
        ...(m.finish === undefined ? {} : { finish: m.finish })
      })
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

// Build the shape OpenCode 2.x writes: the session row lives in `session_v2` and
// every message in `session_message`, carrying its own content items. The legacy
// triple above stops receiving writes at the 2.x upgrade, so a session created
// after it has no `session`/`message`/`part` rows at all.
function makeCurrentDb({ session, messages = [], extraRows = [] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocsess-v2-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session_v2 (id, title, directory, time_created, time_updated) VALUES (?,?,?,?,?)')
    .run(session.id, session.title || '', session.directory || '', session.created, session.updated);

  const ins = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  let seq = 0;
  for (const m of messages) {
    const data = m.role === 'assistant'
      ? JSON.stringify({
        time: { created: m.createdMs },
        agent: 'build',
        model: { id: m.model || 'big-pickle', providerID: 'opencode' },
        content: m.content || [],
        // An interrupted turn records neither, and the row still has to report.
        ...(m.cost === undefined ? {} : { cost: m.cost }),
        ...(m.tokens === undefined ? {} : { tokens: m.tokens }),
        ...(m.finish === undefined ? {} : { finish: m.finish })
      })
      : JSON.stringify({ time: { created: m.createdMs }, text: m.text || '' });
    ins.run(m.id, session.id, m.role, seq++, m.createdMs, m.createdMs, data);
  }
  for (const row of extraRows) ins.run(row.id, session.id, row.type, seq++, row.createdMs, row.createdMs, row.data);

  db.close();
  return file;
}

// Token sample lifted from a real opencode.db row. The DB's stored total (9441) ADDS reasoning
// (16) on top of input+output+cache (9425). We total the tokscale way (9425, reasoning excluded)
// so the detail matches the session card.
const T0 = Date.UTC(2026, 5, 4, 10, 0, 0);

maybe('readSessionMeta reports a finished turn only when the newest assistant message stopped', () => {
  // `stop` is the model finishing its answer; `tool-calls` is a pause to run
  // tools, which is still mid-turn. Getting this backwards would mark every
  // working session as finished.
  const file = makeDb({
    session: { id: 'done', title: 'done', created: T0, updated: T0 + 1000 },
    messages: [
      { id: 'a1', role: 'assistant', createdMs: T0, finish: 'tool-calls', tokens: {}, cost: 0 },
      { id: 'a2', role: 'assistant', createdMs: T0 + 1000, finish: 'stop', tokens: {}, cost: 0 }
    ]
  });
  const meta = ocs.readSessionMeta(['done'], { dbPaths: [file], sqlite }).get('done');
  assert.equal(meta.turnEnded, true);

  const midTurn = makeDb({
    session: { id: 'mid', title: 'mid', created: T0, updated: T0 + 1000 },
    messages: [
      { id: 'b1', role: 'assistant', createdMs: T0, finish: 'stop', tokens: {}, cost: 0 },
      { id: 'b2', role: 'assistant', createdMs: T0 + 1000, finish: 'tool-calls', tokens: {}, cost: 0 }
    ]
  });
  const mid = ocs.readSessionMeta(['mid'], { dbPaths: [midTurn], sqlite }).get('mid');
  // The newer tool-calls message wins, so the turn is not over. Reported as an
  // explicit false rather than omitted: an omitted boundary cannot clear a
  // `true` that an earlier tick wrote.
  assert.equal(mid.turnEnded, false);

  // A transcript that never recorded a finish reports nothing, which leaves the
  // caller on its own time window rather than guessing either way.
  const silent = makeDb({
    session: { id: 'silent', title: 'silent', created: T0, updated: T0 },
    messages: [{ id: 'c1', role: 'assistant', createdMs: T0, tokens: {}, cost: 0 }]
  });
  assert.equal(ocs.readSessionMeta(['silent'], { dbPaths: [silent], sqlite }).get('silent').turnEnded, undefined);

  // A prompt accepted after the last completion starts the next turn, so the
  // previous `stop` no longer describes it. Reporting the stale completion here
  // marked a session that had just been prompted as finished.
  const trailing = makeDb({
    session: { id: 'trail', title: 'trail', created: T0, updated: T0 + 2000 },
    messages: [
      { id: 'd1', role: 'assistant', createdMs: T0, finish: 'stop', tokens: {}, cost: 0 },
      { id: 'd2', role: 'user', createdMs: T0 + 2000 }
    ]
  });
  // The newest row is the user's, so the previous completion is not the current
  // turn: an explicit false, which is what lets it clear an earlier true.
  assert.equal(ocs.readSessionMeta(['trail'], { dbPaths: [trailing], sqlite }).get('trail').turnEnded, false);
  // A tool-calls pause is still mid-turn, and only the newest row decides.
  const paused = makeDb({
    session: { id: 'pause', title: 'pause', created: T0, updated: T0 + 2000 },
    messages: [
      { id: 'e1', role: 'assistant', createdMs: T0, finish: 'tool-calls', tokens: {}, cost: 0 },
      { id: 'e2', role: 'assistant', createdMs: T0 + 1000, finish: 'stop', tokens: {}, cost: 0 }
    ]
  });
  assert.equal(ocs.readSessionMeta(['pause'], { dbPaths: [paused], sqlite }).get('pause').turnEnded, true);

  // Every reason other than a tool pause ends the turn. `length` is the output
  // budget running out and `content-filter` a refusal — OpenCode stops the loop
  // on both and waits for the next prompt, so treating them as "still
  // generating" held the running mark for the whole recency window.
  for (const finish of ['length', 'content-filter', 'error']) {
    const terminal = makeDb({
      session: { id: 'term', title: 'term', created: T0, updated: T0 + 1000 },
      messages: [{ id: 't1', role: 'assistant', createdMs: T0 + 1000, finish, tokens: {}, cost: 0 }]
    });
    assert.equal(
      ocs.readSessionMeta(['term'], { dbPaths: [terminal], sqlite }).get('term').turnEnded,
      true,
      `finish: '${finish}' ends the turn`
    );
  }
});

maybe('the reader still answers for every session after the turn-end query', () => {
  // A syntax error inside that one query is swallowed by the caller's catch and
  // reads as "this session has no metadata", so a regression here silently
  // blanks timestamps and titles for every OpenCode session rather than failing.
  const file = makeDb({
    session: { id: 's1', title: 'Keep me', created: T0, updated: T0 + 1000 },
    messages: [{ id: 'a1', role: 'assistant', createdMs: T0 + 1000, finish: 'stop', tokens: {}, cost: 0 }]
  });
  const meta = ocs.readSessionMeta(['s1'], { dbPaths: [file], sqlite }).get('s1');
  assert.equal(meta.title, 'Keep me');
  assert.equal(meta.startedAt, new Date(T0).toISOString());
  assert.equal(meta.lastUsedAt, new Date(T0 + 1000).toISOString());
  assert.equal(meta.turnEnded, true);
});
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

maybe('readSessionMeta returns the latest actual message timestamp', () => {
  const file = fixture();
  const meta = ocs.readSessionMeta(['s1', 'missing'], { dbPaths: [file], sqlite });
  assert.strictEqual(meta.size, 1);
  assert.deepStrictEqual(meta.get('s1'), {
    startedAt: new Date(T0).toISOString(),
    lastUsedAt: new Date(T4).toISOString(),
    title: 'Greeting'
  });
});

maybe('readSessionMeta ignores a newer metadata timestamp without a new message', () => {
  const file = makeDb({
    session: { id: 'stale', title: 'Renamed', created: T0, updated: T4 + 60_000 },
    messages: [{ id: 'old-message', role: 'user', createdMs: T1 }]
  });

  const meta = ocs.readSessionMeta(['stale'], { dbPaths: [file], sqlite });

  assert.equal(meta.get('stale').lastUsedAt, new Date(T1).toISOString());
});

maybe('OpenCode metadata updates cannot steal recent activity from a newer real message', () => {
  const file = makeDb({
    session: { id: 'stale', title: 'Renamed', created: T0, updated: T4 + 60_000 },
    messages: [{ id: 'old-message', role: 'user', createdMs: T1 }]
  });
  const opencode = ocs.readSessionMeta(['stale'], { dbPaths: [file], sqlite }).get('stale');

  const activity = pickRecentUsageActivity({
    periods: {
      today: {
        sessions: {
          'opencode:stale': { client: 'opencode', sessionId: 'stale', ...opencode },
          'claude:active': { client: 'claude', lastUsedAt: new Date(T2).toISOString() }
        }
      }
    }
  });

  assert.equal(activity.provider, 'claude');
});

maybe('readSessionMeta falls back to session creation when no message exists', () => {
  const file = makeDb({
    session: { id: 'empty', title: 'Empty', created: T0, updated: T4 + 60_000 }
  });

  const meta = ocs.readSessionMeta(['empty'], { dbPaths: [file], sqlite });

  assert.equal(meta.get('empty').lastUsedAt, new Date(T0).toISOString());
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

// The same conversation written in the shape OpenCode 2.x uses. Reading only the
// frozen legacy triple reported every session created after that upgrade as
// "Transcript not found on this machine".
function currentFixture() {
  return makeCurrentDb({
    session: { id: 's1', title: 'Greeting', directory: 'D:/repo', created: T0, updated: T2 },
    messages: [
      { id: 'm0', role: 'user', createdMs: T0, text: 'Hello there' },
      {
        id: 'm1', role: 'assistant', createdMs: T1, cost: 0.5, finish: 'stop',
        tokens: { input: 9416, output: 9, reasoning: 16, cache: { read: 0, write: 0 } },
        content: [{ type: 'text', text: 'Hi, reply text' }, { type: 'tool', name: 'bash' }]
      },
      { id: 'm2', role: 'user', createdMs: T2, text: 'Do a search' },
      {
        id: 'm3', role: 'assistant', createdMs: T3, cost: 0.25, finish: 'stop',
        tokens: { input: 50, output: 30, reasoning: 5, cache: { read: 15, write: 0 } },
        content: [{ type: 'tool', name: 'websearch' }]
      },
      {
        id: 'm4', role: 'assistant', createdMs: T4, cost: 0.1, finish: 'stop',
        tokens: { input: 120, output: 40, reasoning: 0, cache: { read: 40, write: 0 } },
        content: []
      }
    ]
  });
}

maybe('readSessionEvents reads the current shape OpenCode 2.x writes', () => {
  const current = ocs.readSessionEvents('s1', { dbPaths: [currentFixture()], sqlite });
  const legacy = ocs.readSessionEvents('s1', { dbPaths: [fixture()], sqlite });
  assert.strictEqual(current.found, true);
  // Both shapes describe one conversation, so the neutral events must be
  // identical: same prompts, turns, tools, tokens and cost.
  assert.deepStrictEqual(current, legacy);
  assert.strictEqual(current.sessionCost, 0.85);
});

maybe('readSessionMeta reads the current shape OpenCode 2.x writes', () => {
  const meta = ocs.readSessionMeta(['s1', 'missing'], { dbPaths: [currentFixture()], sqlite });
  assert.strictEqual(meta.size, 1);
  assert.deepStrictEqual(meta.get('s1'), {
    startedAt: new Date(T0).toISOString(),
    lastUsedAt: new Date(T4).toISOString(),
    title: 'Greeting',
    projectPath: 'D:/repo',
    turnEnded: true
  });
});

maybe('the current tables answer when both shapes hold the same session', () => {
  // A database upgraded mid-session holds the early rows in the legacy triple and
  // everything after it in `session_message`. The current tables are the superset,
  // so they describe the session and the frozen triple must not win.
  const file = fixture();
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)');
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('s1', 'Renamed', 'D:/repo', T0, T4);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
    'later', 's1', 'user', 0, T4 + 1000, T4 + 1000,
    JSON.stringify({ time: { created: T4 + 1000 }, text: 'Second prompt' })
  );
  db.close();

  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  assert.deepStrictEqual(out.events.map((e) => e.text), ['Second prompt']);
  const meta = ocs.readSessionMeta(['s1'], { dbPaths: [file], sqlite }).get('s1');
  assert.strictEqual(meta.title, 'Renamed');
  assert.strictEqual(meta.lastUsedAt, new Date(T4 + 1000).toISOString());
});

maybe('the current shape reads its idle row as the turn boundary', () => {
  const stopped = makeCurrentDb({
    session: { id: 's1', title: 'Stopped', created: T0, updated: T2 },
    messages: [{ id: 'a1', role: 'assistant', createdMs: T1, finish: 'tool-calls', tokens: {}, cost: 0, content: [] }],
    extraRows: [{ id: 'i1', type: 'idle', createdMs: T2, data: JSON.stringify({ time: { created: T2 }, outcome: 'succeeded' }) }]
  });
  // The idle row lands after the paused assistant row, so the pause is over.
  assert.equal(ocs.readSessionMeta(['s1'], { dbPaths: [stopped], sqlite }).get('s1').turnEnded, true);

  const prompted = makeCurrentDb({
    session: { id: 's1', title: 'Prompted', created: T0, updated: T3 },
    messages: [{ id: 'a1', role: 'assistant', createdMs: T1, finish: 'stop', tokens: {}, cost: 0, content: [] }],
    extraRows: [
      { id: 'i1', type: 'idle', createdMs: T2, data: JSON.stringify({ time: { created: T2 }, outcome: 'succeeded' }) },
      { id: 'u1', type: 'user', createdMs: T3, data: JSON.stringify({ time: { created: T3 }, text: 'again' }) }
    ]
  });
  // A prompt accepted after the idle row starts the next turn, so it waits again.
  assert.equal(ocs.readSessionMeta(['s1'], { dbPaths: [prompted], sqlite }).get('s1').turnEnded, false);

  // A session with no idle row after its last assistant message still reports
  // the boundary that row itself states.
  const finished = makeCurrentDb({
    session: { id: 's1', title: 'Finished', created: T0, updated: T2 },
    messages: [{ id: 'a1', role: 'assistant', createdMs: T2, finish: 'stop', tokens: {}, cost: 0, content: [] }]
  });
  assert.equal(ocs.readSessionMeta(['s1'], { dbPaths: [finished], sqlite }).get('s1').turnEnded, true);
});

maybe('a current-shape transcript of non-exchange rows still reports found', () => {
  // Gating on message rows rather than on prompts keeps a session whose newest
  // word is a system/idle marker from reading as "no transcript at all".
  const file = makeCurrentDb({
    session: { id: 's1', title: 'Quiet', created: T0, updated: T1 },
    extraRows: [{ id: 'sys1', type: 'system', createdMs: T1, data: JSON.stringify({ time: { created: T1 } }) }]
  });
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  assert.deepStrictEqual(out, { found: true, events: [], sessionCost: 0 });
});

maybe('an interrupted assistant turn keeps its row with zeroed usage', () => {
  const file = makeCurrentDb({
    session: { id: 's1', title: 'Aborted', created: T0, updated: T1 },
    messages: [{ id: 'a1', role: 'assistant', createdMs: T1, content: [{ type: 'text', text: 'partial answer' }] }]
  });
  const out = ocs.readSessionEvents('s1', { dbPaths: [file], sqlite });
  assert.strictEqual(out.found, true);
  assert.deepStrictEqual(out.events[0].tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
  assert.strictEqual(out.events[0].cost, 0);
  assert.deepStrictEqual(out.events[0].tools, []);
  assert.strictEqual(out.sessionCost, 0);
});
