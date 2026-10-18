'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { /* Node 22.15+ only. */ }

const { collectOmpUsage, readOmpStatsRows, sessionIdentity } = require('../../src/shared/providers/omp/usage');

(sqlite ? test : test.skip)('OMP stats adapter reads a bounded snapshot and preserves period/session identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-stats-usage-'));
  const databasePath = path.join(root, 'stats.db');
  const rootSession = path.join(root, 'root.jsonl');
  const childSession = path.join(root, 'child.jsonl');
  fs.writeFileSync(rootSession, `${JSON.stringify({ type: 'session', id: 'root-id' })}\n`);
  fs.writeFileSync(childSession, `${JSON.stringify({ type: 'session', id: 'child-id', parentSession: 'root-id' })}\n`);

  const database = new sqlite.DatabaseSync(databasePath);
  t.after(() => {
    database.close();
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
