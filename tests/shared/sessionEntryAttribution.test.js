'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite = require('node:sqlite');
const {
  SESSION_ENTRY_EVIDENCE,
  sessionEntryForEvidence
} = require('../../src/shared/usage');
const { applyT3SessionParents, sessionMetadataMap } = require('../../src/shared/sessionMetadata');
const antigravitySessionMetadata = require('../../src/shared/providers/antigravity/sessionMetadata');
const {
  applySessionUsageArchive,
  normalizeSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const { normalizePeriod } = require('../../src/shared/usage');
const { entryTrendPoints } = require('../../src/electron/renderer/usageCharts');

test('entry mapping keeps verified T3 universal and native entries client-scoped', () => {
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.verifiedT3, 'codex'), 't3');
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.verifiedT3, 'claude'), 't3');
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.verifiedT3, 'antigravity'), 't3');
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.native, 'codex'), 'codex-cli');
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.native, 'antigravity'), 'antigravity-cli');
  // Clients without a native entry stay unattributed instead of guessing one.
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.native, 'claude'), '');
  assert.equal(sessionEntryForEvidence(SESSION_ENTRY_EVIDENCE.unavailable, 'codex'), '');
  assert.equal(sessionEntryForEvidence('nonsense', 'codex'), '');
});

function t3Store(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-entry-attribution-'));
  const dir = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'statev2.sqlite');
  const db = new sqlite.DatabaseSync(file);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, root_node_id TEXT, kind TEXT, provider_thread_id TEXT);
  `);
  const thread = (id) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)')
    .run(id, 'New thread', JSON.stringify({ lineage: { parentThreadId: null, relationshipToParent: null } }));
  const provider = (id, app, nativeId, driver = 'codex') => db.prepare(
    'INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)'
  ).run(id, app, driver, JSON.stringify({ nativeThreadRef: { nativeId, driver, strength: 'strong' } }));
  return { home, db, file, thread, provider };
}

test('a bound session attributes T3 while a read catalog without a binding names the native CLI', t => {
  const s = t3Store(t);
  s.thread('app-thread');
  s.provider('p1', 'app-thread', 'bound-native');
  const periods = { today: normalizePeriod({ sessions: {
    bound: { client: 'codex', sessionId: 'bound-native', totalTokens: 10 },
    unbound: { client: 'codex', sessionId: 'unbound-native', totalTokens: 20 },
    claudeNative: { client: 'claude', sessionId: 'claude-native', totalTokens: 30 }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  const sessions = periods.today.sessions;
  assert.equal(sessions['codex:bound-native'].sessionEntry, 't3');
  assert.equal(sessions['codex:bound-native'].t3ThreadId, 'app-thread');
  assert.equal(sessions['codex:unbound-native'].sessionEntry, 'codex-cli');
  assert.equal(sessions['codex:unbound-native'].t3ThreadId, undefined);
  // No native entry value is defined for Claude, so the unattributed answer wins.
  assert.equal(sessions['claude:claude-native'].sessionEntry, undefined);
  const wire = normalizePeriod(periods.today);
  assert.equal(wire.sessions['codex:bound-native'].sessionEntry, 't3');
  assert.equal(wire.sessions['codex:unbound-native'].sessionEntry, 'codex-cli');
});

test('T3CODE_HOME reroutes the catalog the entry evidence is read from', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-entry-attribution-'));
  const custom = path.join(home, 'custom-t3');
  const dir = path.join(custom, 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'statev2.sqlite'));
  t.after(() => {
    try { db.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, root_node_id TEXT, kind TEXT, provider_thread_id TEXT);
  `);
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)')
    .run('app-thread', 'New thread', JSON.stringify({ lineage: {} }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)')
    .run('p1', 'app-thread', 'codex', JSON.stringify({ nativeThreadRef: { nativeId: 'bound-native', driver: 'codex', strength: 'strong' } }));
  const periods = { today: normalizePeriod({ sessions: {
    bound: { client: 'codex', sessionId: 'bound-native', totalTokens: 10 }
  } }) };
  applyT3SessionParents(periods, home, { env: { T3CODE_HOME: custom } });
  assert.equal(periods.today.sessions['codex:bound-native'].sessionEntry, 't3');
});

test('an unreadable or missing T3 catalog leaves entries unattributed instead of native', t => {
  // No store at all: T3 was never installed here.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-entry-attribution-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const periods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'native-x', totalTokens: 10 }
  } }) };
  applyT3SessionParents(periods, home, { env: {} });
  assert.equal(periods.today.sessions['codex:native-x'].sessionEntry, undefined);

  // A corrupt store cannot prove "unbound" either.
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-entry-attribution-'));
  t.after(() => fs.rmSync(corrupt, { recursive: true, force: true }));
  const dir = path.join(corrupt, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'statev2.sqlite'), 'this is not a database');
  const corruptPeriods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'native-x', totalTokens: 10 }
  } }) };
  applyT3SessionParents(corruptPeriods, corrupt, { env: {} });
  assert.equal(corruptPeriods.today.sessions['codex:native-x'].sessionEntry, undefined);
});

test('an ambiguous Codex filename cannot claim a native entry without a searchable identity', t => {
  const s = t3Store(t);
  const native = '019a0000-1234-7000-8000-000000000001';
  const sessionId = `rollout-2026-10-11T00-00-00-${native}-019a0000-1234-7000-8000-000000000002`;
  const periods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId, totalTokens: 10 }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(periods.today.sessions[`codex:${sessionId}`].sessionEntry, undefined);
});

test('antigravity keeps a retained T3 entry when the catalog stops binding it', t => {
  const s = t3Store(t);
  s.thread('app-thread');
  s.provider('p1', 'app-thread', 'ag-native', 'antigravity');
  const periods = { today: normalizePeriod({ sessions: {
    ag: { client: 'antigravity', sessionId: 'ag-native', totalTokens: 10, t3ThreadId: 'app-thread', sessionEntry: 't3' }
  } }) };
  s.db.prepare("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'p1'").run();
  applyT3SessionParents(periods, s.home, { env: {} });
  const session = periods.today.sessions['antigravity:ag-native'];
  assert.equal(session.t3ThreadId, 'app-thread', 'antigravity keeps its app link');
  assert.equal(session.sessionEntry, 't3');
  // The same situation revokes a codex attribution instead of keeping it.
  const codexPeriods = { today: normalizePeriod({ sessions: {
    c: { client: 'codex', sessionId: 'ag-native', totalTokens: 10, t3ThreadId: 'app-thread', sessionEntry: 't3' }
  } }) };
  applyT3SessionParents(codexPeriods, s.home, { env: {} });
  assert.equal(codexPeriods.today.sessions['codex:ag-native'].sessionEntry, undefined);
  assert.equal(codexPeriods.today.sessions['codex:ag-native'].t3ThreadId, undefined);
});

test('a verified identity conflict revokes the entry attribution', t => {
  const s = t3Store(t);
  s.thread('thread-a');
  s.thread('thread-b');
  const conflictId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002';
  s.provider('p1', 'thread-a', 'dup-native');
  s.provider('p2', 'thread-b', 'dup-native');
  s.provider('p3', 'thread-a', conflictId);
  s.provider('p4', 'thread-b', conflictId);
  const periods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'dup-native', totalTokens: 10, t3ThreadId: 'thread-a', sessionEntry: 't3' },
    // A record may arrive holding only the entry, with no stored link; the
    // conflict still unattributes it.
    b: { client: 'codex', sessionId: conflictId, totalTokens: 5, sessionEntry: 't3' }
  } }) };
  const revokedT3ThreadKeys = new Set();
  applyT3SessionParents(periods, s.home, { env: {}, revokedT3ThreadKeys });
  const session = periods.today.sessions['codex:dup-native'];
  assert.equal(session.t3ThreadId, undefined);
  assert.equal(session.sessionEntry, undefined);
  assert.equal(periods.today.sessions[`codex:${conflictId}`].sessionEntry, undefined);
  // The entry-only conflict is recorded, so the collector's retained-range
  // refresh can clear the stale attribution from anchor and past-day rows.
  assert.ok(revokedT3ThreadKeys.has(`codex:${conflictId}`));
});

function antigravityFixture(t, { corruptState = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-entry-ag-dir-'));
  const t3Home = path.join(home, 'custom-t3');
  const acpRoot = path.join(t3Home, 'userdata', 'providers', 'antigravity', 'profile-a', 'antigravity-acp');
  const convDir = path.join(acpRoot, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  // An installed T3 with an empty catalog: readable this tick, so a native
  // store row may claim the native entry, but with no bindings in it. A
  // corrupt store instead leaves the binding check inconclusive, and native
  // evidence must not overcome that.
  if (corruptState) {
    fs.writeFileSync(path.join(t3Home, 'userdata', 'statev2.sqlite'), 'this is not a database');
    const acpDb = new sqlite.DatabaseSync(path.join(acpRoot, 'conversation_summaries.db'));
    const nativeDb = new sqlite.DatabaseSync(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
    t.after(() => {
      for (const db of [acpDb, nativeDb]) { try { db.close(); } catch (_) {} }
      fs.rmSync(home, { recursive: true, force: true });
    });
    for (const db of [acpDb, nativeDb]) {
      db.exec(`CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
        workspace_uris TEXT, last_modified_time TEXT,
        parent_conversation_id TEXT, agent_name TEXT
      )`);
    }
    nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('nat-conv', 'Native Task', '', '[]', '2026-11-25T08:00:00Z', '', '');
    return { home, t3Home, env: { T3CODE_HOME: t3Home } };
  }
  const stateDb = new sqlite.DatabaseSync(path.join(t3Home, 'userdata', 'statev2.sqlite'));
  stateDb.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, root_node_id TEXT, kind TEXT, provider_thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_run_attempts (thread_id TEXT, provider_thread_id TEXT, root_node_id TEXT, status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT, child_thread_id TEXT, origin TEXT);
  `);
  const acpDb = new sqlite.DatabaseSync(path.join(acpRoot, 'conversation_summaries.db'));
  const nativeDb = new sqlite.DatabaseSync(path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db'));
  t.after(() => {
    for (const db of [stateDb, acpDb, nativeDb]) { try { db.close(); } catch (_) {} }
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const db of [acpDb, nativeDb]) {
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
      workspace_uris TEXT, last_modified_time TEXT,
      parent_conversation_id TEXT, agent_name TEXT
    )`);
  }
  acpDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('acp-conv', 'T3 ACP Task', '', '[]', '2026-11-25T08:00:00Z', '', '');
  nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('nat-conv', 'Native Task', '', '[]', '2026-11-25T08:00:00Z', '', '');
  return { home, t3Home, env: { T3CODE_HOME: t3Home } };
}

test('T3 ACP directory rows attribute t3 and native store rows attribute the CLI', t => {
  const fixture = antigravityFixture(t);
  const deps = {
    sqlite,
    env: fixture.env,
    antigravityTitleCache: new Map(),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set(),
    sessionMetadataResolvers: new Map([
      ['antigravity', { resolve: antigravitySessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }]
    ])
  };
  const periods = { today: normalizePeriod({ sessions: {
    acp: { client: 'antigravity', sessionId: 'acp-conv', totalTokens: 10 },
    native: { client: 'antigravity', sessionId: 'nat-conv', totalTokens: 20 },
    nowhere: { client: 'antigravity', sessionId: 'nowhere-conv', totalTokens: 30 }
  } }) };
  // sessionMetadataMap bridges the resolver's per-session evidence into the
  // metadata cache the attribution pass reads, exactly like a collection tick.
  sessionMetadataMap(periods, fixture.home, deps);
  applyT3SessionParents(periods, fixture.home, deps);
  const sessions = periods.today.sessions;
  assert.equal(sessions['antigravity:acp-conv'].sessionEntry, 't3');
  assert.equal(sessions['antigravity:nat-conv'].sessionEntry, 'antigravity-cli');
  // A session with no row in any store still reads as native once the binding
  // check completed: the readable catalog proves it unbound (spec scenario 2).
  assert.equal(sessions['antigravity:nowhere-conv'].sessionEntry, 'antigravity-cli');
  const wire = normalizePeriod(periods.today);
  assert.equal(wire.sessions['antigravity:acp-conv'].sessionEntry, 't3');
  assert.equal(wire.sessions['antigravity:nat-conv'].sessionEntry, 'antigravity-cli');
});

test('native directory rows stay unattributed when the binding check is inconclusive', t => {
  // The T3 state catalog is corrupt, so this tick cannot prove the session is
  // unbound; a validated row from the native store is not enough on its own.
  const fixture = antigravityFixture(t, { corruptState: true });
  const deps = {
    sqlite,
    env: fixture.env,
    antigravityTitleCache: new Map(),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set(),
    sessionMetadataResolvers: new Map([
      ['antigravity', { resolve: antigravitySessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }]
    ])
  };
  const periods = { today: normalizePeriod({ sessions: {
    native: { client: 'antigravity', sessionId: 'nat-conv', totalTokens: 20 }
  } }) };
  sessionMetadataMap(periods, fixture.home, deps);
  applyT3SessionParents(periods, fixture.home, deps);
  assert.equal(periods.today.sessions['antigravity:nat-conv'].sessionEntry, undefined);
});

test('session archives round-trip the entry and leave old entries unknown', () => {
  const now = new Date().toISOString();
  const archive = normalizeSessionUsageArchive({ sessions: {
    'codex:rt': { capturedAt: now, periods: { today: { client: 'codex', sessionId: 'rt', totalTokens: 10, sessionEntry: 't3' } } },
    'codex:old': { capturedAt: now, periods: { today: { client: 'codex', sessionId: 'old', totalTokens: 5 } } }
  } });
  assert.equal(archive.sessions['codex:rt'].periods.today.sessionEntry, 't3');
  assert.equal('sessionEntry' in archive.sessions['codex:old'].periods.today, false);
  const summary = { periods: { today: { totalTokens: 0, costUsd: 0, sessions: {} } } };
  const next = applySessionUsageArchive(summary, archive, { now: new Date() });
  assert.equal(next.periods.today.sessions['codex:rt']?.sessionEntry, 't3');
  assert.equal('sessionEntry' in (next.periods.today.sessions['codex:old'] || {}), false);
  assert.equal(next.periods.today.totalTokens, 15);
});

test('entry trend splits add back up to the untouched total curve', () => {
  const points = [{ date: '2026-11-25', tokens: 100 }, { date: '2026-11-20', tokens: 50 }];
  const days = {
    '2026-11-25': { sessions: {
      a: { totalTokens: 40, sessionEntry: 't3' },
      b: { totalTokens: 30, sessionEntry: 'codex-cli' },
      c: { totalTokens: 30 }
    } }
  };
  const t3 = entryTrendPoints(points, days, 't3');
  const cli = entryTrendPoints(points, days, 'codex-cli');
  const unknown = entryTrendPoints(points, days, 'unknown');
  assert.equal(t3[0].tokens, 40);
  assert.equal(cli[0].tokens, 30);
  assert.equal(unknown[0].tokens, 30);
  assert.equal(t3[0].tokens + cli[0].tokens + unknown[0].tokens, points[0].tokens);
  // A day without session detail counts entirely as unknown, never as zero.
  assert.equal(unknown[1].tokens, 50);
  assert.equal(t3[1].tokens, 0);
  assert.equal(cli[1].tokens, 0);
  // No filter returns the points untouched.
  assert.equal(entryTrendPoints(points, days, ''), points);
  // Detail that does not account for the whole day rides the remainder in the
  // unknown bucket, so the entry splits still sum to the day's trend value.
  const partialDays = { '2026-11-25': { sessions: {
    a: { totalTokens: 40, sessionEntry: 't3' },
    b: { totalTokens: 30, sessionEntry: 'codex-cli' }
  } } };
  const partialUnknown = entryTrendPoints(points, partialDays, 'unknown');
  assert.equal(partialUnknown[0].tokens, 100 - 70);
  assert.equal(t3[0].tokens + 30 + partialUnknown[0].tokens, points[0].tokens);
});

test('monthly trend points resolve through the retained daily detail of their days', () => {
  const days = {
    '2026-11-25': { sessions: {
      a: { totalTokens: 40, sessionEntry: 't3' },
      b: { totalTokens: 30, sessionEntry: 'codex-cli' }
    } },
    '2026-11-20': { sessions: {
      c: { totalTokens: 60, sessionEntry: 't3' }
    } },
    // A covered month outside the daily window keeps its own answer.
    '2026-10-04': { sessions: {
      d: { totalTokens: 80, sessionEntry: 'antigravity-cli' }
    } }
  };
  const monthly = [
    { month: '2026-11', tokens: 500 },
    { month: '2026-10', tokens: 80 },
    { month: '2026-09', tokens: 200 }
  ];
  const t3 = entryTrendPoints(monthly, days, 't3', { labelKey: 'month' });
  const cli = entryTrendPoints(monthly, days, 'codex-cli', { labelKey: 'month' });
  const ag = entryTrendPoints(monthly, days, 'antigravity-cli', { labelKey: 'month' });
  const unknown = entryTrendPoints(monthly, days, 'unknown', { labelKey: 'month' });
  // Covered days split by their sessions; the month the detail undercounts
  // rides the remainder in the unknown bucket.
  assert.equal(t3[0].tokens, 100);
  assert.equal(cli[0].tokens, 30);
  assert.equal(unknown[0].tokens, 500 - 130);
  assert.equal(t3[0].tokens + cli[0].tokens + unknown[0].tokens, 500);
  // A fully covered month needs no unknown remainder.
  assert.equal(ag[1].tokens, 80);
  assert.equal(unknown[1].tokens, 0);
  // A month without any covered day counts entirely as unknown.
  assert.equal(unknown[2].tokens, 200);
  assert.equal(t3[2].tokens, 0);
});

test('entry trend choices expose the entries the detail attributes and the unknown remainder', () => {
  const charts = require('../../src/electron/renderer/usageCharts');
  const { entryTrendChoices } = charts;
  // A day whose detail undercounts still offers unknown.
  const partial = [{ date: '2026-11-25', tokens: 100 }];
  const partialDays = { '2026-11-25': { sessions: {
    a: { totalTokens: 40, sessionEntry: 't3' },
    b: { totalTokens: 30, sessionEntry: 'codex-cli' }
  } } };
  assert.deepEqual(entryTrendChoices(partial, partialDays), ['codex-cli', 't3', 'unknown']);
  // Fully covered detail with unattributed sessions keeps offering unknown.
  const fullDays = { '2026-11-25': { sessions: {
    a: { totalTokens: 40, sessionEntry: 't3' },
    b: { totalTokens: 60 }
  } } };
  assert.deepEqual(entryTrendChoices(partial, fullDays), ['t3', 'unknown']);
  // A day with usage and no detail offers unknown alone.
  const bareDays = { '2026-11-24': { sessions: {
    a: { totalTokens: 40, sessionEntry: 't3' }
  } } };
  assert.deepEqual(entryTrendChoices([{ date: '2026-11-23', tokens: 50 }], bareDays), ['unknown']);
  // Monthly points aggregate the choices of their covered days.
  const monthlyDays = {
    '2026-11-25': { sessions: { a: { totalTokens: 40, sessionEntry: 't3' } } },
    '2026-11-20': { sessions: { b: { totalTokens: 30, sessionEntry: 'codex-cli' } } }
  };
  assert.deepEqual(
    entryTrendChoices([{ month: '2026-11', tokens: 200 }], monthlyDays, { labelKey: 'month' }),
    ['codex-cli', 't3', 'unknown']
  );
  // A month covered exactly, with every session attributed, offers no unknown.
  const exactDays = { '2026-11-25': { sessions: { a: { totalTokens: 40, sessionEntry: 't3' } } } };
  assert.deepEqual(
    entryTrendChoices([{ month: '2026-11', tokens: 40 }], exactDays, { labelKey: 'month' }),
    ['t3']
  );
});

test('a link refresh moves the anchor row to the confirmed entry', t => {
  const s = t3Store(t);
  s.thread('app-thread');
  s.provider('p1', 'app-thread', 'bound-native');
  // The anchor row still carries the native CLI label from an earlier tick
  // without the binding; this tick's pass confirmed T3. The anchored update
  // copies the confirmed entry with its link, so a later unavailable read
  // cannot resurrect the stale native label.
  const periods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'bound-native', totalTokens: 10, sessionEntry: 'codex-cli' }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  const session = periods.today.sessions['codex:bound-native'];
  assert.equal(session.t3ThreadId, 'app-thread');
  assert.equal(session.sessionEntry, 't3');
  // Revocation still clears the entry with the link.
  s.db.prepare("DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'p1'").run();
  const revokePeriods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'bound-native', totalTokens: 10, t3ThreadId: 'app-thread', sessionEntry: 't3' }
  } }) };
  applyT3SessionParents(revokePeriods, s.home, { env: {} });
  const revoked = revokePeriods.today.sessions['codex:bound-native'];
  assert.equal(revoked.t3ThreadId, undefined);
  assert.equal(revoked.sessionEntry, undefined);
});

test('a retained T3 title source is not evidence and a held entry survives an unavailable read', t => {
  const fixture = antigravityFixture(t, { corruptState: true });
  const staleSource = { native: null, t3: path.join(fixture.t3Home, 'userdata', 'statev2.sqlite') };
  const makeDeps = (extraPrevious) => ({
    sqlite,
    env: fixture.env,
    antigravityTitleCache: new Map(),
    catalogTitleSources: { 'antigravity:stale-conv': staleSource },
    metadataCache: new Map(extraPrevious ? [['antigravity:stale-conv', extraPrevious]] : []),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set(),
    sessionMetadataResolvers: new Map([
      ['antigravity', { resolve: antigravitySessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }]
    ])
  });
  const staleDeps = makeDeps({
    catalogTitle: 'Old T3 title',
    catalogTitleSource: staleSource
  });
  const stalePeriods = { today: normalizePeriod({ sessions: {
    a: { client: 'antigravity', sessionId: 'stale-conv', totalTokens: 20 }
  } }) };
  sessionMetadataMap(stalePeriods, fixture.home, staleDeps);
  assert.equal(staleDeps.metadataCache.get('antigravity:stale-conv')?.sessionEntryEvidence, undefined,
    'a retained title source alone is not this tick\'s evidence');
  applyT3SessionParents(stalePeriods, fixture.home, staleDeps);
  assert.equal(stalePeriods.today.sessions['antigravity:stale-conv'].sessionEntry, undefined,
    'no entry is established from old state');
  // A held entry survives the unavailable read instead of being dropped.
  const heldDeps = makeDeps({
    catalogTitle: 'Old T3 title',
    catalogTitleSource: staleSource
  });
  const heldPeriods = { today: normalizePeriod({ sessions: {
    a: { client: 'antigravity', sessionId: 'stale-conv', totalTokens: 20, sessionEntry: 't3' }
  } }) };
  sessionMetadataMap(heldPeriods, fixture.home, heldDeps);
  applyT3SessionParents(heldPeriods, fixture.home, heldDeps);
  assert.equal(heldPeriods.today.sessions['antigravity:stale-conv'].sessionEntry, 't3');
});

test('a title the T3 catalog joined this pass is positive object-source evidence', t => {
  const fixture = antigravityFixture(t);
  const stateDb = new sqlite.DatabaseSync(path.join(fixture.t3Home, 'userdata', 'statev2.sqlite'));
  stateDb.prepare('INSERT INTO orchestration_v2_projection_threads (thread_id, title, deleted_at, payload_json) VALUES (?, ?, NULL, ?)')
    .run('app-thread', 'T3 Task', JSON.stringify({ lineage: {} }));
  stateDb.prepare('INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, driver, payload_json) VALUES (?, ?, ?, ?)')
    .run('p1', 'app-thread', 'antigravity', JSON.stringify({ nativeThreadRef: { nativeId: 'acp-conv', driver: 'antigravity', strength: 'strong' } }));
  // Close before the fixture's cleanup removes the directory.
  stateDb.close();
  const deps = {
    sqlite,
    env: fixture.env,
    antigravityTitleCache: new Map(),
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set(),
    sessionMetadataResolvers: new Map([
      ['antigravity', { resolve: antigravitySessionMetadata.resolveSessionMetadata, retryAfterTimestampFallback: true }]
    ])
  };
  const periods = { today: normalizePeriod({ sessions: {
    acp: { client: 'antigravity', sessionId: 'acp-conv', totalTokens: 10 }
  } }) };
  sessionMetadataMap(periods, fixture.home, deps);
  assert.equal(deps.metadataCache.get('antigravity:acp-conv')?.sessionEntryEvidence, 'verified-t3');
  applyT3SessionParents(periods, fixture.home, deps);
  assert.equal(periods.today.sessions['antigravity:acp-conv'].sessionEntry, 't3');
});
