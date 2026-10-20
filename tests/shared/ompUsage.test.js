'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { /* Node 22.15+ only. */ }

const { collectOmpUsage, detectOmpIndexLag, readOmpStatsRows, sessionIdentity } = require('../../src/shared/providers/omp/usage');
const { collectHistoryOnce, collectUsageOnce } = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

(sqlite ? test : test.skip)('OMP stats adapter reads a bounded snapshot and preserves period/session identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-stats-usage-'));
  const databasePath = path.join(root, 'stats.db');
  const rootSession = path.join(root, 'root.jsonl');
  const childSession = path.join(root, 'child.jsonl');
  fs.writeFileSync(rootSession, `${JSON.stringify({ type: 'session', id: 'root-id' })}\n`);
  fs.writeFileSync(childSession, `${JSON.stringify({ type: 'session', id: 'child-id', parentSession: 'root-id' })}\n`);

  const database = new sqlite.DatabaseSync(databasePath);
  let databaseOpen = true;
  t.after(() => {
    if (databaseOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE session_rollup (
      session_file TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      total_tokens INTEGER,
      cost_total REAL
    );
    CREATE TABLE messages (
      session_file TEXT,
      model TEXT,
      provider TEXT,
      timestamp INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      cost_total REAL,
      agent_type TEXT
    );
  `);

  const now = new Date(2026, 9, 18, 12, 0, 0, 0);
  const nowMs = now.getTime();
  const historyStartMs = new Date(2026, 8, 1, 0, 0, 0, 0).getTime();
  const previousMonthMs = new Date(2026, 8, 30, 12, 0, 0, 0).getTime();
  const futureMs = nowMs + 60_000;
  const sessionInsert = database.prepare('INSERT INTO session_rollup VALUES (?, ?, ?, ?, ?)');
  sessionInsert.run(rootSession, Math.floor((nowMs - 5_000) / 1000), Math.floor((nowMs - 1_000) / 1000), 6, 1.5);
  sessionInsert.run(childSession, Math.floor(previousMonthMs / 1000), Math.floor((previousMonthMs + 1_000) / 1000), 10, 2.5);
  const messageInsert = database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  messageInsert.run(rootSession, 'omp-model', 'omp-provider', nowMs - 5_000, 2, 3, 0, 0, 5, 1.25, 'interactive');
  messageInsert.run(rootSession, 'omp-model', 'omp-provider', nowMs - 1_000, 1, 0, 0, 0, 1, 0.25, 'interactive');
  messageInsert.run(childSession, 'omp-model', 'omp-provider', previousMonthMs, 4, 5, 0, 1, 10, 2.5, 'subagent');
  messageInsert.run(rootSession, 'omp-model', 'omp-provider', futureMs, 99, 0, 0, 0, 99, 9, 'interactive');
  messageInsert.run(rootSession, 'omp-model', 'omp-provider', nowMs - 2_000, 0, 0, 0, 0, 0, 0, 'interactive');
  database.close();
  databaseOpen = false;

  assert.deepEqual(sessionIdentity(rootSession), {
    sessionId: 'root-id',
    parentSessionId: '',
    sessionRole: 'root'
  });
  assert.deepEqual(sessionIdentity(childSession), {
    sessionId: 'child-id',
    parentSessionId: 'root-id',
    sessionRole: 'child'
  });
  assert.deepEqual(sessionIdentity(String.raw`C:\\omp\\sessions\\123e4567-e89b-12d3-a456-426614174000.jsonl`), {
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    parentSessionId: '',
    sessionRole: 'root'
  });

  const rows = readOmpStatsRows({
    statsDbPath: databasePath,
    sinceMs: historyStartMs,
    nowMs
  });
  assert.equal(rows.rows.length, 2, 'zero, future, and out-of-window rows are excluded');
  assert.equal(rows.sessionCount, 2);
  assert.deepEqual(rows.rows.map((row) => [row.sessionId, row.day, row.totalTokens]), [
    ['child-id', '2026-09-30', 10],
    ['root-id', '2026-10-18', 6]
  ]);

  const usage = collectOmpUsage({
    statsDbPath: databasePath,
    allTimeSince: '2026-09-01',
    now,
    nowMs
  });
  assert.equal(usage.today.totalTokens, 6);
  assert.equal(usage.today.costUsd, 1.5);
  assert.equal(usage.month.totalTokens, 6);
  assert.equal(usage.allTime.totalTokens, 16);
  assert.deepEqual(Object.keys(usage.today.sessions), ['omp:root-id']);
  assert.deepEqual(Object.keys(usage.allTime.sessions).sort(), ['omp:child-id', 'omp:root-id']);
  const child = usage.allTime.sessions['omp:child-id'];
  assert.deepEqual({
    totalTokens: child.totalTokens,
    costUsd: child.costUsd,
    messageCount: child.messageCount,
    inputTokens: child.inputTokens,
    outputTokens: child.outputTokens,
    cacheReadTokens: child.cacheReadTokens,
    cacheWriteTokens: child.cacheWriteTokens,
    models: child.models,
    modelCosts: child.modelCosts,
    providers: child.providers,
    sessionRole: child.sessionRole,
    parentSessionId: child.parentSessionId,
    agentType: child.agentType
  }, {
    totalTokens: 10,
    costUsd: 2.5,
    messageCount: 1,
    inputTokens: 4,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 1,
    models: { 'omp-model': 10 },
    modelCosts: { 'omp-model': 2.5 },
    providers: { 'omp-provider': 10 },
    sessionRole: 'child',
    parentSessionId: 'root-id',
    agentType: 'subagent'
  });
  assert.deepEqual(usage.historyGraph.contributions.map((day) => [
    day.date,
    Object.values(day.clients[0].tokens).reduce((total, value) => total + value, 0)
  ]), [
    ['2026-09-30', 10],
    ['2026-10-18', 6]
  ]);
});

(sqlite ? test : test.skip)('collector includes OMP stats on a full target refresh without an anchor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-collector-usage-'));
  const homeDir = path.join(root, 'home');
  const databasePath = path.join(root, 'stats.db');
  const sessionFile = path.join(homeDir, '.omp', 'agent', 'sessions', 'root.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'omp-root' })}\n`);
  const database = new sqlite.DatabaseSync(databasePath);
  let databaseOpen = true;
  t.after(() => {
    if (databaseOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE session_rollup (
      session_file TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      total_tokens INTEGER,
      cost_total REAL
    );
    CREATE TABLE messages (
      session_file TEXT,
      model TEXT,
      provider TEXT,
      timestamp INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      cost_total REAL,
      agent_type TEXT
    );
  `);
  const now = new Date(2026, 9, 18, 12, 0, 0, 0);
  const nowMs = now.getTime();
  const previousMs = new Date(2026, 8, 30, 12, 0, 0, 0).getTime();
  database.prepare('INSERT INTO session_rollup VALUES (?, ?, ?, ?, ?)').run(
    sessionFile,
    Math.floor((nowMs - 1_000) / 1000),
    Math.floor(nowMs / 1000),
    12,
    3.5
  );
  database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    sessionFile,
    'omp-model',
    'omp-provider',
    nowMs - 1_000,
    2,
    10,
    0,
    0,
    12,
    3.5,
    'interactive'
  );
  database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    sessionFile,
    'omp-model',
    'omp-provider',
    previousMs,
    2,
    3,
    0,
    0,
    5,
    1,
    'interactive'
  );
  database.close();
  databaseOpen = false;

  const calls = [];
  const summary = await collectUsageOnce({
    clients: 'omp,claude',
    targetClients: ['claude'],
    allTimeSince: '2024-01-01',
    homeDir,
    now,
    ompStatsDbPath: databasePath,
    ompStatsEnabled: true,
    historyEnabled: false,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    runTokscale: async (input) => {
      calls.push(input);
      return { entries: [{ client: 'claude', sessionId: 'claude-1', totalTokens: 4, cost: 1, input: 4 }] };
    },
    deviceId: 'fixture',
    agentVersion: 'fixture'
  });

  assert.equal(calls.length, 3);
  assert.equal(summary.ompUsageMode, 'stats-db');
  assert.deepEqual(summary.authoritativeSessionClients, ['omp']);
  assert.equal(summary.allTime.totalTokens, 21);
  assert.deepEqual(summary.allTime.clients, { omp: 17, claude: 4 });
  assert.deepEqual(Object.keys(summary.allTime.sessions).sort(), ['claude:claude-1', 'omp:omp-root']);
  const empty = emptyPeriod();
  const anchored = await collectUsageOnce({
    clients: 'omp',
    allTimeSince: '2024-01-01',
    homeDir,
    now,
    ompStatsDbPath: databasePath,
    ompStatsEnabled: true,
    todayOnlyAnchor: {
      dateKey: '2026-10-18',
      ompUsageMode: 'stats-db',
      today: empty,
      month: empty,
      allTime: empty,
      todayPartitions: {},
      sessionIdentityVersion: 2,
      t3Titles: {},
      catalogTitleSources: {},
      catalogProjects: { today: {}, month: {}, allTime: {}, labels: {} }
    },
    historyEnabled: true,
    includeHistory: true,
    dailyHistoryArchiveEnabled: false,
    projectsEnabled: false,
    wslScanEnabled: false,
    runGraph: async () => ({ contributions: [] }),
    runTokscale: async () => { throw new Error('unexpected Tokscale scan'); },
    deviceId: 'fixture',
    agentVersion: 'fixture'
  });
  assert.deepEqual(anchored.history.daily.map((day) => [day.date, day.tokens]), [
    ['2026-09-30', 5],
    ['2026-10-18', 12]
  ]);

});

(sqlite ? test : test.skip)('OMP index lag is detected from a growing transcript, not a stale cursor row', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-stats-lag-'));
  const databasePath = path.join(root, 'stats.db');
  const liveSession = path.join(root, 'live.jsonl');
  const idleSession = path.join(root, 'idle.jsonl');
  const nowMs = new Date(2026, 9, 18, 12, 0, 0, 0).getTime();
  fs.writeFileSync(liveSession, 'x'.repeat(400));
  fs.writeFileSync(idleSession, 'x'.repeat(400));
  const twoHoursAgo = nowMs - 2 * 60 * 60 * 1000;
  fs.utimesSync(liveSession, nowMs / 1000, nowMs / 1000);
  fs.utimesSync(idleSession, nowMs / 1000, nowMs / 1000);

  const database = new sqlite.DatabaseSync(databasePath);
  let databaseOpen = true;
  t.after(() => {
    if (databaseOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE session_rollup (session_file TEXT, started_at INTEGER, ended_at INTEGER, total_tokens INTEGER, cost_total REAL);
    CREATE TABLE messages (
      session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      total_tokens INTEGER, cost_total REAL, agent_type TEXT
    );
    CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER, last_modified REAL, parser_state TEXT);
  `);
  const insertCursor = database.prepare('INSERT INTO file_offsets VALUES (?, ?, ?, NULL)');
  // `live` has 400 bytes on disk with only 100 imported, and its cursor is two
  // hours old: the index stopped importing a transcript OMP is still writing.
  insertCursor.run(liveSession, 100, twoHoursAgo);
  // `idle` is fully imported, so its old cursor is not a lag.
  insertCursor.run(idleSession, 400, twoHoursAgo);

  const lag = detectOmpIndexLag(database, { nowMs, activeMs: 24 * 60 * 60 * 1000 });
  assert.equal(lag.active, true);
  assert.equal(lag.stale, true);
  assert.equal(lag.stalledSessions, 1);
  assert.equal(lag.checked, 2);
  // File mtimes are second-granular on most filesystems, so compare the span.
  assert.ok(Math.abs(lag.lagMs - 2 * 60 * 60 * 1000) <= 1000, `lag ${lag.lagMs}`);
  // A younger gap than the threshold is real but not yet worth reporting.
  assert.equal(
    detectOmpIndexLag(database, { nowMs, thresholdMs: 3 * 60 * 60 * 1000 }).stale,
    false
  );
  // Nothing was written recently, so the index is quiet rather than behind.
  fs.utimesSync(liveSession, (nowMs - 5 * 24 * 60 * 60 * 1000) / 1000, (nowMs - 5 * 24 * 60 * 60 * 1000) / 1000);
  const quiet = detectOmpIndexLag(database, { nowMs });
  assert.equal(quiet.active, false);
  assert.equal(quiet.stale, false);
  database.close();
  databaseOpen = false;

  // A database without the cursor table cannot answer, so it reports nothing
  // rather than claiming health.
  const barePath = path.join(root, 'bare.db');
  const bare = new sqlite.DatabaseSync(barePath);
  bare.exec('CREATE TABLE messages (session_file TEXT)');
  assert.equal(detectOmpIndexLag(bare, { nowMs }), null);
  bare.close();
});

test('OMP-only history is reported as successful without duplicate merge', async () => {
  const statuses = [];
  const history = await collectHistoryOnce({
    clients: '',
    ompGraph: {
      contributions: [{
        date: '2026-10-18',
        clients: [{ client: 'omp', modelId: 'omp-model', tokens: { input: 9 }, cost: 0.9 }]
      }]
    },
    historyEnabled: true,
    dailyHistoryArchiveEnabled: false,
    todayKey: '2026-10-18',
    onHistoryStatus: (status) => statuses.push(status)
  });

  assert.equal(statuses.length, 1);
  assert.ok(statuses[0].successAt);
  assert.equal(statuses[0].failureCode, null);
  assert.equal(history.daily.length, 1);
  assert.equal(history.daily[0].tokens, 9);
  assert.equal(history.daily[0].cost, 0.9);
});
