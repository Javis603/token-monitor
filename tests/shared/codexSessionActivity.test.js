'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const activity = require('../../src/shared/providers/codex/sessionActivity');
const live = require('../../src/shared/sessionLive');
const usage = require('../../src/shared/usage');
const { collectUsageOnce, startCollector } = require('../../src/shared/collector');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');
const rows = require('../../src/electron/renderer/sessionRows');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

const now = Date.parse('2026-10-08T12:00:00Z');
const boot = now - 120_000;
const nativeId = '11111111-1111-4111-8111-111111111111';
const entry = (type, payload) => JSON.stringify({ type, payload });
const question = entry('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'question', arguments: 'private question' });
const started = entry('event_msg', { type: 'task_started' });
const answer = entry('response_item', { type: 'function_call_output', call_id: 'question', output: 'private answer' });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-activity-'));
  const codexRoot = path.join(home, '.codex', 'sessions');
  const dir = path.join(codexRoot, '2026', '10', '08');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-08T12-00-00-${nativeId}.jsonl`);
  const id = path.basename(file, '.jsonl');
  const write = (lines) => {
    fs.writeFileSync(file, [entry('session_meta', { id: nativeId }), ...lines].join('\n') + '\n');
    fs.utimesSync(file, new Date(now), new Date(now));
  };
  const t3Dir = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(t3Dir, { recursive: true });
  const runtimeFile = path.join(t3Dir, 'server-runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ version: 1, pid: 1234, startedAt: new Date(boot).toISOString() }));
  const db = new DatabaseSync(path.join(t3Dir, 'statev2.sqlite'));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, provider TEXT, status TEXT, last_run_ordinal INTEGER, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, provider_thread_id TEXT, ordinal INTEGER, status TEXT, requested_at TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, provider_thread_id TEXT, run_id TEXT, status TEXT, completed_at TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (node_id TEXT, thread_id TEXT, status TEXT, resolved_at TEXT, kind TEXT, created_at TEXT, payload_json TEXT);
  `);
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)').run('app', 'T3 title', new Date(now).toISOString());
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'provider', 'app', 'codex', 'custom-codex', 'active', 1, new Date(now).toISOString(), JSON.stringify({ nativeThreadRef: { nativeId } }));
  db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?)').run('run', 'provider', 1, 'running', new Date(now - 5000).toISOString());
  db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?, NULL)').run('node', 'app', 'provider', 'run', 'waiting');
  db.prepare('INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?, NULL, ?, ?, ?)').run(
    'node', 'app', 'pending', 'user_input', new Date(now - 1000).toISOString(), JSON.stringify({ responseCapability: { type: 'live' }, prompt: 'PRIVATE' }));
  const catalog = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  catalog.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at INTEGER, title TEXT)');
  catalog.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(nativeId, file, Math.floor(now / 1000), 'Native title');
  t.after(() => { if (db.isOpen) db.close(); catalog.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const options = { homeDir: home, env: {}, now, readProcessStarts: async () => new Map([[1234, boot - 1000]]) };
  const key = 'codex:' + id;
  const session = { client: 'codex', sessionId: id, totalTokens: 100, lastUsedAt: new Date(now).toISOString() };
  const summary = () => Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, { sessions: { [key]: { ...session } } }]));
  return { home, db, catalog, file, id, key, write, options, summary, runtimeFile };
}

test('T3 formal request kinds wait and resolution/cancellation/expiry clear without transcript writes', async t => {
  const f = fixture(t);
  for (const kind of ['command', 'file-read', 'file-change', 'permission', 'mcp-elicitation', 'user_input']) {
    f.db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET kind = ?, status = ?').run(kind, 'pending');
    assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'waiting', kind);
  }
  for (const status of ['resolved', 'cancelled', 'expired']) {
    f.db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET status = ?').run(status);
    assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'running', status);
  }
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET kind = 'dynamic_tool_call', status = 'pending'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'running');
  f.db.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'idle');
  assert.equal(JSON.stringify([...await activity.readT3Activity(f.options)]).includes('PRIVATE'), false);
});

test('T3 requests belong to the native provider, current run and server incarnation', async t => {
  const f = fixture(t);
  f.db.exec("UPDATE orchestration_v2_projection_nodes SET provider_thread_id = 'other'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'running');
  f.db.exec("UPDATE orchestration_v2_projection_nodes SET provider_thread_id = 'provider', run_id = 'old-run'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'running');
  f.db.exec("UPDATE orchestration_v2_projection_nodes SET run_id = 'run'; UPDATE orchestration_v2_projection_runtime_requests SET created_at = '2020-01-01T00:00:00Z'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'running');
  for (const readProcessStarts of [async () => new Map(), async () => new Map([[1234, now]]), async () => { throw new Error('ps unavailable'); }]) {
    assert.equal((await activity.readT3Activity({ ...f.options, readProcessStarts })).size, 0);
  }
  assert.equal((await activity.readT3Activity({ ...f.options, scopedHome: true })).size, 0);
  f.db.exec("UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{'");
  assert.equal((await activity.readT3Activity(f.options)).size, 0);
});

test('T3 request evaluation is bounded before sorting a large set of recent runs', async t => {
  const f = fixture(t);
  const insertProvider = f.db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertRun = f.db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?)');
  f.db.exec('BEGIN');
  for (let i = 0; i < 600; i += 1) {
    const id = `recent-${i}`;
    insertProvider.run(id, 'app', 'codex', 'codex', 'active', 1, new Date(now - 600 + i).toISOString(), JSON.stringify({ nativeThreadRef: { nativeId: id } }));
    insertRun.run(`run-${i}`, id, 1, 'running', new Date(now - 1000).toISOString());
  }
  f.db.exec('COMMIT');
  let decodedIds = 0;
  const sqlite = { DatabaseSync: class extends DatabaseSync {
    constructor(...args) {
      super(...args);
      this.function('json_extract', (json, field) => {
        const value = JSON.parse(json);
        if (field === '$.nativeThreadRef.nativeId') { decodedIds += 1; return value.nativeThreadRef?.nativeId ?? null; }
        if (field === '$.responseCapability.type') return value.responseCapability?.type ?? null;
        throw new Error('Unexpected JSON field');
      });
    }
  } };
  const result = await activity.readT3Activity({ ...f.options, sqlite });
  assert.equal(result.size, 256);
  assert.equal(result.get(nativeId).state, 'waiting');
  assert.equal(result.has('recent-0'), false);
  assert.equal(decodedIds, 256); // dropped candidates never evaluate outer expressions
});

test('a missing T3 database with a leftover runtime marker never probes a process', async t => {
  const f = fixture(t);
  const file = path.join(f.home, '.t3', 'userdata', 'statev2.sqlite');
  f.db.close(); // Windows cannot rename a database while its handle is open.
  fs.renameSync(file, file + '.removed');
  let probes = 0;
  const result = await activity.readT3Activity({ ...f.options, readProcessStarts: async () => { probes += 1; return new Map(); } });
  assert.equal(result.size, 0);
  assert.equal(probes, 0);
});

test('without T3 evidence pre-token discovery skips known usage files and still finds a new question', async t => {
  const f = fixture(t); f.write([started, question]);
  fs.unlinkSync(f.runtimeFile);
  const fresh = path.join(path.dirname(f.file), 'rollout-2026-10-08T12-00-01-new-native.jsonl');
  fs.writeFileSync(fresh, entry('session_meta', { id: 'new-native' }) + '\n' + started + '\n' + question + '\n');
  fs.utimesSync(fresh, new Date(now), new Date(now));
  const open = fs.openSync;
  const knownFile = fs.realpathSync(f.file);
  let knownReads = 0;
  fs.openSync = (file, ...args) => { if (file === f.file || file === knownFile) knownReads += 1; return open(file, ...args); };
  let read;
  try { read = await activity.readSessionActivity(f.summary(), f.options); }
  finally { fs.openSync = open; }
  assert.equal(knownReads, 0);
  assert.equal(read.readings.size, 0);
  assert.equal(read.sessions[`codex:${path.basename(fresh, '.jsonl')}`].waitingForInput, true);
  assert.equal(read.sessions[f.key], undefined);
  assert.equal(require('../../src/shared/providers/codex/sessionContext').readCodexSessionState(f.file).waitingForInput, true);
});

test('unchanged Codex discovery reuses locations while T3 state and process validation stay fresh', async t => {
  const f = fixture(t); f.write([started]);
  let catalogReads = 0;
  let probes = 0;
  const catalogPath = path.join(f.home, '.codex', 'state_5.sqlite');
  const sqlite = { DatabaseSync: class extends DatabaseSync {
    constructor(file, options) { super(file, options); if (file === catalogPath) catalogReads += 1; }
  } };
  const options = { ...f.options, sqlite, readProcessStarts: async (...args) => { probes += 1; return f.options.readProcessStarts(...args); } };
  const summary = f.summary();
  assert.equal((await activity.readSessionActivity(summary, options)).readings.get(f.id).state, 'waiting');
  const cold = catalogReads;
  f.db.exec("UPDATE orchestration_v2_projection_threads SET title = 'Unrelated display change'");
  assert.equal((await activity.readSessionActivity(summary, { ...options, now: now + 1000 })).readings.get(f.id).state, 'waiting');
  assert.equal(catalogReads, cold);
  assert.equal(probes, 2);
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  assert.equal((await activity.readSessionActivity(summary, { ...options, now: now + 2000 })).readings.get(f.id).state, 'running');
  assert.ok(catalogReads > cold);
  const changed = catalogReads;
  await activity.readSessionActivity(summary, { ...options, now: now + 12_000 });
  assert.ok(catalogReads > changed); // timed reconciliation notices missed events
  fs.unlinkSync(f.runtimeFile);
  assert.equal((await activity.readSessionActivity(summary, { ...options, now: now + 13_000 })).readings.size, 0);
});

test('native file and catalog changes invalidate cached discovery before its reconciliation deadline', async t => {
  const f = fixture(t); f.write([started]);
  f.catalog.exec('PRAGMA journal_mode = WAL');
  const summary = f.summary();
  await activity.readSessionActivity(summary, f.options);
  const file = path.join(path.dirname(f.file), 'rollout-2026-10-08T12-00-02-new-question.jsonl');
  fs.writeFileSync(file, entry('session_meta', { id: 'new-question' }) + '\n' + started + '\n' + question + '\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  const key = `codex:${path.basename(file, '.jsonl')}`;
  const found = await activity.readSessionActivity(summary, { ...f.options, now: now + 1000 });
  assert.equal(found.sessions[key].waitingForInput, true);
  fs.appendFileSync(file, answer + '\n' + entry('event_msg', { type: 'task_complete' }) + '\n');
  fs.utimesSync(file, new Date(now), new Date(now));
  assert.equal((await activity.readSessionActivity(summary, { ...f.options, now: now + 2000 })).sessions[key], undefined);
  const external = path.join(f.home, '.codex', 'sessions', '2025', '10', '01');
  fs.mkdirSync(external, { recursive: true });
  const old = path.join(external, 'rollout-2025-10-01T12-00-00-catalog-addition.jsonl');
  fs.writeFileSync(old, entry('session_meta', { id: 'catalog-addition' }) + '\n' + started + '\n' + question + '\n');
  fs.utimesSync(old, new Date(now), new Date(now));
  f.catalog.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('catalog-addition', old, Math.floor(now / 1000), 'New catalog row');
  const added = await activity.readSessionActivity(summary, { ...f.options, now: now + 3000 });
  assert.equal(added.sessions[`codex:${path.basename(old, '.jsonl')}`].waitingForInput, true);
});

test('live Codex observations normalize, merge by their clock and expire independently of transcript time', async t => {
  const f = fixture(t); f.write([started]);
  const before = f.summary();
  const observed = await activity.readSessionActivity(before, f.options);
  const next = activity.projectSessionActivity(before, observed, now);
  assert.equal(before.today.sessions[f.key].liveActivity, undefined);
  assert.equal(next.today.sessions[f.key].totalTokens, 100);
  assert.equal(live.sessionActivityState(live.sessionWithActivity(next.today, f.key), now), 'waiting');
  const p = usage.normalizePeriod(next.today);
  assert.equal(p.sessions[f.key].liveActivity.state, 'waiting');
  const cleared = usage.normalizePeriod({ sessions: { [f.key]: { ...p.sessions[f.key], liveActivity: { state: 'idle', observedAt: new Date(now + 1000).toISOString() } } } });
  for (const parts of [[p, cleared], [cleared, p]]) assert.equal(usage.mergePeriods(...parts).sessions[f.key].liveActivity.state, 'idle');
  assert.equal(live.sessionActivityState({ ...p.sessions[f.key], turnEnded: true }, now + live.LIVE_ACTIVITY_TTL_MS), 'ended');
  const lost = activity.projectSessionActivity(next, { readings: new Map(), sessions: {} }, now + 1000);
  assert.equal(live.sessionWithActivity(lost.today, f.key).liveActivity.state, 'unknown');
  assert.equal(live.sessionActivityState(lost.today.sessions[f.key], now + 1000), 'running');
});

test('a no-token native question reaches local Sessions and Dock without accounting rows', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.runtimeFile); // Exercise the native transcript, independently of T3.
  f.write([started, question]);
  const empty = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, usage.emptyPeriod()]));
  const observed = await activity.readSessionActivity(empty, f.options);
  const next = activity.projectSessionActivity(empty, observed, now);
  assert.equal(Object.keys(next.today.sessions).length, 0);
  assert.equal(next.today.totalTokens, 0);
  const display = { periods: { month: next.month }, nativeSessions: next.nativeSessions };
  const saved = Date.now; Date.now = () => now;
  try {
    const [row] = rows.sessionRowsForPeriod(next.today, { nativeSessions: next.nativeSessions.today, now: new Date(now) });
    assert.equal(row.activityState, 'waiting');
    assert.equal(row.tokenDataUnavailable, true);
    assert.equal(presentation.waitingSessionSummary(presentation.recentSessionRows(display), now).count, 1);
  } finally { Date.now = saved; }
  f.write([started, question, answer, entry('event_msg', { type: 'task_complete' })]);
  const ended = activity.projectSessionActivity(next, await activity.readSessionActivity(next, f.options), now + 1000);
  assert.equal(Object.keys(ended.nativeSessions.today).length, 0);
});

test('date-folder discovery and its cache follow local midnight without a catalog', async t => {
  const prior = process.env.TZ;
  process.env.TZ = 'Asia/Hong_Kong';
  t.after(() => { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; });
  const f = fixture(t);
  const clock = new Date(2026, 9, 8, 23, 59, 58).getTime();
  const summary = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, usage.emptyPeriod()]));
  const options = { ...f.options, now: clock, sqlite: null, t3DbPaths: [] };
  assert.equal(Object.keys((await activity.readSessionActivity(summary, options)).sessions).length, 0);
  const dir = path.join(f.home, '.codex', 'sessions', '2026', '10', '09');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'rollout-2026-10-09T00-00-02-local-midnight';
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, entry('session_meta', { id: 'local-midnight' }) + '\n' + started + '\n' + question + '\n');
  fs.utimesSync(file, new Date(clock + 4000), new Date(clock + 4000));
  const observed = await activity.readSessionActivity(summary, { ...options, now: clock + 4000 });
  assert.equal(observed.sessions['codex:' + id].waitingForInput, true);
});

test('previous date-folder discovery uses calendar subtraction across daylight saving', async t => {
  const prior = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; });
  const f = fixture(t);
  const clock = new Date(2026, 2, 9, 0, 1).getTime();
  const dir = path.join(f.home, '.codex', 'sessions', '2026', '03', '08');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'rollout-2026-03-08T23-59-00-previous-local-day';
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, entry('session_meta', { id: 'previous-local-day' }) + '\n' + started + '\n' + question + '\n');
  fs.utimesSync(file, new Date(clock - 120000), new Date(clock - 120000));
  const summary = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, usage.emptyPeriod()]));
  const observed = await activity.readSessionActivity(summary, { ...f.options, now: clock, sqlite: null, t3DbPaths: [] });
  assert.equal(observed.sessions['codex:' + id].waitingForInput, true);
});

test('no-token discovery respects root scope, archive suppression and transcript freshness', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.runtimeFile);
  f.write([started, question]);
  const empty = {};
  assert.equal(Object.keys((await activity.readSessionActivity(empty, f.options)).sessions).length, 1);
  assert.equal(Object.keys((await activity.readSessionActivity(empty, { ...f.options, now: now + live.RUNNING_WINDOW_MS + 1 })).sessions).length, 0);
  const archived = f.summary(); archived.today.sessions[f.key].archived = true;
  assert.equal(Object.keys((await activity.readSessionActivity(archived, f.options)).sessions).length, 0);
  if (process.platform === 'win32') return;
  const outside = path.join(f.home, 'outside.jsonl'); fs.writeFileSync(outside, started + '\n' + question);
  fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file);
  assert.equal(Object.keys((await activity.readSessionActivity(empty, f.options)).sessions).length, 0);
});

test('native asynchronous ACK or shell escalation arguments never invent an unresolved UI request', async t => {
  const f = fixture(t); fs.unlinkSync(f.runtimeFile);
  f.write([started, entry('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'async' }),
    entry('response_item', { type: 'function_call_output', call_id: 'async', output: '{"accepted":true}' }),
    entry('event_msg', { type: 'task_complete' })]);
  assert.equal(Object.keys((await activity.readSessionActivity({}, f.options)).sessions).length, 0);
  f.write([started, entry('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'shell', input: 'require_escalated' })]);
  const [session] = Object.values((await activity.readSessionActivity({}, f.options)).sessions);
  assert.equal(live.sessionActivityState(session, now), 'running');
});

test('collector discovers a native question before token_count and preserves exact scan anchors', async t => {
  const f = fixture(t); fs.unlinkSync(f.runtimeFile); f.write([started, question]);
  // Keep the file's local date folder and observation clock aligned in every TZ.
  const clock = new Date(2026, 9, 8, 12);
  t.mock.method(Date, 'now', () => clock.getTime());
  fs.utimesSync(f.file, clock, clock);
  let captured;
  const summary = await collectUsageOnce({ clients: 'codex', deviceId: 'zero', agentVersion: 'test',
    homeDir: f.home, env: {}, now: clock, projectsEnabled: false, limitsEnabled: false, historyEnabled: false,
    codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    runTokscale: async () => ({ entries: [] }), onAnchorComputed: value => { captured = value; },
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] }) });
  assert.equal(Object.keys(summary.nativeSessions.today).length, 1);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].totalTokens, 0);
    assert.equal(Object.keys(summary[name].sessions).length, 0);
    assert.equal(Object.keys(captured.windowsPeriods[name].sessions).length, 0);
  }
  const { payload } = serializeSyncPayload(summary);
  assert.equal(Object.hasOwn(payload, 'nativeSessions'), false);
  // Local presentation carries metadata; the wire never uploads it.
  assert.equal(payload.today.totalTokens, 0);
});

test('T3 polling updates waiting, response and terminal states without rescanning token usage', { timeout: 15_000 }, async t => {
  const f = fixture(t); f.write([started]);
  const updates = [];
  let scans = 0;
  let nextUpdate;
  const collector = startCollector({
    clients: 'codex', allTimeSince: '2024-01-01', deviceId: 'poll', agentVersion: 'test',
    historyEnabled: false, projectsEnabled: false, limitsEnabled: false, watchEnabled: false,
    intervalMs: 300_000, codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    homeDir: f.home, env: {}, sessionMetadataDeps: { readProcessStarts: f.options.readProcessStarts },
    runTokscale: async () => { scans += 1; return { entries: [{ client: 'codex', sessionId: f.id, model: 'gpt-6-luna', input: 100, output: 0, cost: 0 }] }; },
    onUpdate: (summary, reason) => { updates.push({ summary, reason }); nextUpdate?.(); },
    onError: error => { throw error; }
  });
  t.after(async () => { collector.stop(); await collector.whenIdle(); });
  await collector.whenIdle();
  assert.equal(scans, 3);
  const first = updates[0].summary;
  assert.equal(first.today.sessions[f.key].liveActivity.state, 'waiting');
  let changed = new Promise(resolve => { nextUpdate = resolve; });
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  await changed;
  assert.equal(updates[1].reason, 'session-activity');
  assert.equal(updates[1].summary.today.sessions[f.key].liveActivity.state, 'running');
  assert.equal(scans, 3);
  changed = new Promise(resolve => { nextUpdate = resolve; });
  f.db.exec("UPDATE orchestration_v2_projection_runs SET status = 'cancelled'");
  await changed;
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(updates[2].summary[name].sessions[f.key].liveActivity.state, 'idle');
    assert.equal(updates[2].summary[name].totalTokens, first[name].totalTokens);
    assert.equal(first[name].sessions[f.key].liveActivity.state, 'waiting');
  }
  assert.equal(scans, 3);
});

test('local display deduplicates no-token activity once usage arrives and omits it from remote stats', async t => {
  const f = fixture(t); f.write([started, question]);
  const first = activity.projectSessionActivity({}, await activity.readSessionActivity({}, f.options), now);
  const known = f.summary(); known.nativeSessions = first.nativeSessions;
  const next = activity.projectSessionActivity(known, await activity.readSessionActivity(known, f.options), now + 1000);
  assert.equal(Object.keys(next.nativeSessions.today).length, 0);
  assert.equal(next.today.sessions[f.key].totalTokens, 100);
  const { attachLocalNativeViews, composeLocalOnlySummary } = require('../../src/electron/syncDisplayStats');
  const local = { deviceId: 'local', updatedAt: new Date(now).toISOString(), ...first, today: usage.emptyPeriod(), month: usage.emptyPeriod(), allTime: usage.emptyPeriod() };
  const stats = composeLocalOnlySummary(local, stats => attachLocalNativeViews(stats, local), { nowMs: now });
  assert.equal(stats.periods.today.totalTokens, 0);
  assert.equal(Object.keys(stats.nativeSessions.today).length, 1);
  assert.equal(Object.keys(attachLocalNativeViews({ nativeSessions: first.nativeSessions }, {}).nativeSessions || {}).length, 0);
  assert.equal(rows.sessionRowsForPeriod(known.today, { nativeSessions: first.nativeSessions.today, now: new Date(now) }).length, 1);
});

test('T3 answerable message questions survive model completion until actually answered', async t => {
  const f = fixture(t);
  f.db.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed'; UPDATE orchestration_v2_projection_provider_threads SET status = 'idle'");
  f.db.prepare('UPDATE orchestration_v2_projection_runtime_requests SET payload_json = ?').run(JSON.stringify({ responseCapability: { type: 'message' } }));
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'waiting');
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'idle');
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'pending'; UPDATE orchestration_v2_projection_runs SET status = 'cancelled'");
  assert.equal((await activity.readT3Activity(f.options)).get(nativeId).state, 'idle');
});


test('activity identity uses session_meta, not incidental UUIDs in rollout filenames', async t => {
  const f = fixture(t);
  const other = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(f.file, [entry('session_meta', { id: other }), started].join('\n') + '\n');
  fs.utimesSync(f.file, new Date(now), new Date(now));
  const observed = await activity.readSessionActivity(f.summary(), f.options);
  assert.equal(observed.readings.size, 0);
  assert.equal(Object.values((await activity.readSessionActivity({}, f.options)).sessions)[0].liveActivity, undefined);
});

test('a catalog-confirmed historical activity candidate is verified by its header even when its basename hint differs', async t => {
  const f = fixture(t); f.write([started]);
  const old = now - 86400_000;
  const differentFile = path.join(path.dirname(f.file), 'rollout-2026-10-08T12-00-00-external-label.jsonl');
  fs.renameSync(f.file, differentFile);
  fs.utimesSync(differentFile, new Date(old), new Date(old));
  f.catalog.prepare('UPDATE threads SET rollout_path = ?, updated_at = ?').run(differentFile, Math.floor(old / 1000));
  const id = path.basename(differentFile, '.jsonl');
  const summary = { allTime: { sessions: { [`codex:${id}`]: { client: 'codex', sessionId: id, totalTokens: 10 } } } };
  const read = await activity.readSessionActivity(summary, f.options);
  assert.equal(read.readings.get(id).state, 'waiting');
  assert.deepEqual(read.sessions, {});
  const next = activity.projectSessionActivity(summary, read, now);
  assert.equal(live.sessionWithActivity(next.allTime, `codex:${id}`).liveActivity.state, 'waiting');
  fs.writeFileSync(differentFile, entry('session_meta', { id: 'unrelated-native-session' }) + '\n' + started + '\n');
  fs.utimesSync(differentFile, new Date(old), new Date(old));
  assert.equal((await activity.readSessionActivity(summary, f.options)).readings.has(id), false);
});

test('activity discovery accepts a custom root when the default native root is absent', async t => {
  const f = fixture(t); f.write([started, question]);
  const custom = path.join(f.home, 'custom');
  fs.mkdirSync(custom);
  const target = path.join(custom, '2026', '10', '08');
  fs.mkdirSync(target, { recursive: true });
  fs.renameSync(f.file, path.join(target, path.basename(f.file)));
  fs.rmSync(path.join(f.home, '.codex', 'sessions'), { recursive: true });
  const options = { ...f.options, customScanPaths: { codex: [custom] } };
  const read = await activity.readSessionActivity({}, options);
  assert.equal(read.sessions[f.key].waitingForInput, true);
});

test('a historical rollout absent from the catalog is located on demand and clears its lease', async t => {
  const f = fixture(t); f.write([started]);
  const dir = path.join(f.home, '.codex', 'sessions', '2025', '10', '01');
  fs.mkdirSync(dir, { recursive: true });
  const id = `rollout-2025-10-01T12-00-00-${nativeId}`;
  const file = path.join(dir, id + '.jsonl');
  fs.renameSync(f.file, file);
  fs.utimesSync(file, new Date('2025-10-01T12:00:00Z'), new Date('2025-10-01T12:00:00Z'));
  f.catalog.exec('DELETE FROM threads');
  const key = `codex:${id}`;
  const summary = { allTime: { sessions: { [key]: { client: 'codex', sessionId: id, totalTokens: 10 } } } };
  const read = await activity.readSessionActivity(summary, f.options);
  assert.equal(read.readings.get(id).state, 'waiting');
  assert.deepEqual(read.sessions, {});
  const waiting = activity.projectSessionActivity(summary, read, now);
  assert.equal(live.sessionWithActivity(waiting.allTime, key).liveActivity.state, 'waiting');
  f.db.exec("UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'");
  const running = activity.projectSessionActivity(waiting, await activity.readSessionActivity(waiting, f.options), now + 1000);
  assert.equal(live.sessionWithActivity(running.allTime, key).liveActivity.state, 'running');
  fs.unlinkSync(f.runtimeFile);
  const cleared = activity.projectSessionActivity(running, await activity.readSessionActivity(running, f.options), now + 2000);
  assert.equal(live.sessionWithActivity(cleared.allTime, key).liveActivity.state, 'unknown');
  assert.equal(cleared.allTime.sessions, summary.allTime.sessions);
  assert.equal(cleared.allTime.sessions[key].totalTokens, 10);
});

test('T3 driver observations share one server validation while retaining per-driver scope', async t => {
  const f = fixture(t); f.write([started]);
  let probes = 0;
  const results = await require('../../src/shared/t3SessionActivity').readT3Activities({ ...f.options,
    readProcessStarts: async (...args) => { probes += 1; return f.options.readProcessStarts(...args); } });
  assert.equal(probes, 1);
  assert.equal(results.get('codex').get(nativeId).state, 'waiting');
  assert.equal(results.get('claudeAgent').size, 0);
});

test('native transcript timestamp changes alone are batched to metadata renewals', () => {
  const native = (time) => ({ client: 'codex', sessionId: 'no-token', native: true, totalTokens: 0,
    lastUsedAt: new Date(time).toISOString(), lastMessageAt: new Date(time).toISOString(), turnEnded: false });
  const first = activity.projectSessionActivity({}, { readings: new Map(), sessions: { 'codex:no-token': native(now) } }, now);
  assert.equal(activity.projectSessionActivity(first, { readings: new Map(), sessions: { 'codex:no-token': native(now + 3000) } }, now + 3000), null);
  const renewed = activity.projectSessionActivity(first, { readings: new Map(), sessions: { 'codex:no-token': native(now + 12000) } }, now + 12000);
  assert.equal(renewed.nativeSessions.today['codex:no-token'].lastUsedAt, new Date(now + 12000).toISOString());
});
