'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildCcswitchHistoryGraph, buildCcswitchPeriods, collectCcswitchRows } = require('../../src/shared/ccswitchUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function createSampleDb(dbPath, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY,
      provider_id TEXT,
      app_type TEXT,
      model TEXT,
      request_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      total_cost_usd REAL,
      latency_ms INTEGER,
      status_code INTEGER,
      created_at INTEGER,
      session_id TEXT
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO proxy_request_logs (
      request_id, provider_id, app_type, model, request_model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      total_cost_usd, latency_ms, status_code, created_at, session_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  for (const r of rows) {
    stmt.run(
      r.request_id || `req_${Math.random()}`,
      r.provider_id || 'test_provider',
      r.app_type || 'ccswitch',
      r.model || 'gpt-4o',
      r.request_model || 'gpt-4o',
      r.input_tokens || 0,
      r.output_tokens || 0,
      r.cache_read_tokens || 0,
      r.cache_creation_tokens || 0,
      r.total_cost_usd || 0.0,
      r.latency_ms || 100,
      r.status_code || 200,
      r.created_at || Math.floor(Date.now() / 1000),
      r.session_id || 'sess_1'
    );
  }
  db.close();
}

test('ccswitchUsage reads rows from cc-switch.db sqlite database', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-usage-'));
  const dbPath = path.join(tmpDir, 'cc-switch.db');

  const ts1 = Math.floor(Date.parse('2026-07-09T10:00:00.000Z') / 1000);
  const ts2 = Math.floor(Date.parse('2026-07-09T11:00:00.000Z') / 1000);

  createSampleDb(dbPath, [
    { request_id: 'r1', model: 'gpt-4o', input_tokens: 100, output_tokens: 50, cache_read_tokens: 20, created_at: ts1 },
    { request_id: 'r2', model: 'claude-3-5-sonnet', input_tokens: 200, output_tokens: 80, cache_read_tokens: 10, created_at: ts2 }
  ]);

  const rows = collectCcswitchRows({ dbPath });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].output, 50);
  assert.equal(rows[0].cacheRead, 20);
  assert.equal(rows[1].model, 'claude-3-5-sonnet');
});

test('ccswitchUsage builds tokscale-shaped JSON periods', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-usage-'));
  const dbPath = path.join(tmpDir, 'cc-switch.db');

  const tsYesterday = Math.floor(Date.parse('2026-07-05T12:00:00.000Z') / 1000);
  const tsToday = Math.floor(Date.parse('2026-07-09T12:00:00.000Z') / 1000);

  createSampleDb(dbPath, [
    { request_id: 'r1', model: 'gpt-4o', input_tokens: 500, output_tokens: 100, created_at: tsYesterday },
    { request_id: 'r2', model: 'gpt-4o', input_tokens: 300, output_tokens: 50, created_at: tsToday }
  ]);

  const rows = collectCcswitchRows({ dbPath });
  const periods = buildCcswitchPeriods({
    now: '2026-07-09T12:00:00.000Z',
    rows
  });

  const todayUsage = extractUsageFromTokscale(periods.today);
  assert.equal(todayUsage.clients.ccswitch, 350);

  const monthUsage = extractUsageFromTokscale(periods.month);
  assert.equal(monthUsage.clients.ccswitch, 950);
});

test('ccswitchUsage builds history graph contributions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-usage-'));
  const dbPath = path.join(tmpDir, 'cc-switch.db');

  const ts1 = Math.floor(Date.parse('2026-07-08T12:00:00.000Z') / 1000);
  const ts2 = Math.floor(Date.parse('2026-07-09T12:00:00.000Z') / 1000);

  createSampleDb(dbPath, [
    { request_id: 'r1', model: 'gpt-4o', input_tokens: 100, output_tokens: 50, created_at: ts1 },
    { request_id: 'r2', model: 'gpt-4o', input_tokens: 200, output_tokens: 80, created_at: ts2 }
  ]);

  const rows = collectCcswitchRows({ dbPath });
  const graph = buildCcswitchHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 2);
  assert.equal(graph.contributions[0].date, '2026-07-08');
  assert.equal(graph.contributions[1].date, '2026-07-09');
});
