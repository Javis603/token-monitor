'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const { collectZcodeUsage } = require('../../src/shared/zcodeUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

// Whole suite needs node:sqlite (Node >= 22.5). Skip cleanly when absent.
const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Build a synthetic db.sqlite with the model_usage schema (simplified to columns we read).
function makeDb({ rows = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-usage-'));
  tmpDirs.push(tmp);
  const file = path.join(tmp, 'db.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE model_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0
  )`);

  const ins = db.prepare(
    `INSERT INTO model_usage (id, session_id, model_id, provider_id, status, started_at, completed_at,
     input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    ins.run(
      r.id || `id-${r.session_id}`,
      r.session_id,
      r.model_id,
      r.provider_id,
      r.status,
      r.started_at,
      r.completed_at ?? null,
      r.input_tokens ?? 0,
      r.output_tokens ?? 0,
      r.reasoning_tokens ?? 0,
      r.cache_creation_input_tokens ?? 0,
      r.cache_read_input_tokens ?? 0
    );
  }
  db.close();
  return file;
}

// Use a fixed "now" so today/month boundaries are deterministic.
const NOW = Date.UTC(2026, 5, 4, 14, 30, 0); // 2026-06-04T14:30:00Z
// Today start: local midnight of that date. We compute it in local time.
function todayStartMs() {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function monthStartMs() {
  const d = new Date(NOW);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Row timestamps relative to NOW:
const T_TODAY_1  = NOW - 3 * 60 * 60 * 1000; // 3h ago — today
const T_TODAY_2  = NOW - 1 * 60 * 60 * 1000; // 1h ago — today
const T_MONTH    = NOW - 3 * 24 * 60 * 60 * 1000; // 3d ago — this month
const T_OLD      = NOW - 90 * 24 * 60 * 60 * 1000; // 90d ago — allTime only

maybe('terminal-state filter: running rows excluded, cancelled+error included', () => {
  const file = makeDb({
    rows: [
      { id: 'u1', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_TODAY_1, completed_at: T_TODAY_1 + 5000,
        input_tokens: 100, output_tokens: 50 },
      { id: 'u2', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'running',
        started_at: T_TODAY_2, completed_at: null,
        input_tokens: 200, output_tokens: 100 },
      { id: 'u3', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'cancelled',
        started_at: T_TODAY_2, completed_at: T_TODAY_2 + 3000,
        input_tokens: 300, output_tokens: 0 },
      { id: 'u4', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'error',
        started_at: T_TODAY_2, completed_at: T_TODAY_2 + 4000,
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 400 },
      { id: 'u5', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_TODAY_2, completed_at: T_TODAY_2 + 5000,
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    ]
  });

  const zc = collectZcodeUsage({ dbPath: file, nowMs: NOW });
  // u2 (running) excluded, u5 (all-zero tokens) excluded
  assert.equal(zc.today.length, 3);
  const ids = zc.today.map((r) => r.client);
  assert.deepEqual(ids, ['zcode', 'zcode', 'zcode']);

  // Verify u1 (completed), u3 (cancelled), u4 (error) are present via input tokens
  const inputs = zc.today.map((r) => r.input_tokens).sort();
  assert.deepEqual(inputs, [0, 100, 300]);
});

maybe('cache read/write split preserved; reasoning not added to output', () => {
  const file = makeDb({
    rows: [
      { id: 'c1', session_id: 's1', model_id: 'deepseek-v4', provider_id: 'a2ec',
        status: 'completed', started_at: T_TODAY_1, completed_at: T_TODAY_1 + 5000,
        input_tokens: 7655, output_tokens: 71, reasoning_tokens: 26,
        cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 }
    ]
  });

  const zc = collectZcodeUsage({ dbPath: file, nowMs: NOW });
  assert.equal(zc.today.length, 1);
  const row = zc.today[0];
  assert.equal(row.input_tokens, 7655);
  assert.equal(row.output_tokens, 71);
  assert.equal(row.cache_write_tokens, 500);
  assert.equal(row.cache_read_tokens, 2000);
  assert.equal(row.reasoning_tokens, 26);
  // reasoning is informational only, not added to output
  assert.equal(row.output_tokens, 71);

  // Now run through extractUsageFromTokscale and verify the period shape
  const period = extractUsageFromTokscale(zc.today);
  assert.equal(period.clients.zcode, 7655 + 71 + 500 + 2000); // input+output+cache_creation+cache_read
  assert.equal(period.clientCacheReads.zcode, 2000);
  assert.equal(period.clientCacheWrites.zcode, 500);
  assert.equal(period.clientOutputs.zcode, 71);
  // model and session aggregation
  assert.equal(period.models['deepseek-v4'], 7655 + 71 + 500 + 2000);
  const sessionKey = 'zcode:s1';
  assert.ok(period.sessions[sessionKey]);
  assert.equal(period.sessions[sessionKey].inputTokens, 7655);
  assert.equal(period.sessions[sessionKey].outputTokens, 71);
  assert.equal(period.sessions[sessionKey].cacheReadTokens, 2000);
  assert.equal(period.sessions[sessionKey].cacheWriteTokens, 500);
  assert.equal(period.sessions[sessionKey].reasoningTokens, 26);
});

maybe('today/month/allTime bucketing by completed_at', () => {
  const file = makeDb({
    rows: [
      { id: 'b1', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_TODAY_1, completed_at: T_TODAY_1,
        input_tokens: 100, output_tokens: 10 },
      { id: 'b2', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_MONTH, completed_at: T_MONTH + 5000,
        input_tokens: 200, output_tokens: 20 },
      { id: 'b3', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_OLD, completed_at: T_OLD + 5000,
        input_tokens: 300, output_tokens: 30 }
    ]
  });

  const zc = collectZcodeUsage({ dbPath: file, nowMs: NOW });
  // b1 is today, b2 is this month (but not today), b3 is allTime only
  assert.equal(zc.today.length, 1);
  assert.equal(zc.today[0].input_tokens, 100);
  assert.equal(zc.month.length, 2); // b1 + b2
  const monthInputs = zc.month.map((r) => r.input_tokens).sort();
  assert.deepEqual(monthInputs, [100, 200]);
  assert.equal(zc.allTime.length, 3); // b1 + b2 + b3
  const allInputs = zc.allTime.map((r) => r.input_tokens).sort();
  assert.deepEqual(allInputs, [100, 200, 300]);
});

maybe('missing/unreadable db returns null arrays', () => {
  const zc = collectZcodeUsage({
    dbPath: path.join(os.tmpdir(), 'nonexistent-zcode-db-12345.sqlite'),
    nowMs: NOW
  });
  assert.equal(zc.today, null);
  assert.equal(zc.month, null);
  assert.equal(zc.allTime, null);
});

maybe('node:sqlite unavailable returns null arrays', () => {
  const zc = collectZcodeUsage({ sqlite: null, nowMs: NOW });
  assert.equal(zc.today, null);
  assert.equal(zc.month, null);
  assert.equal(zc.allTime, null);
});

maybe('session metadata: started_at from earliest row, last_used_at from latest completed_at', () => {
  const file = makeDb({
    rows: [
      { id: 'sm1', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_TODAY_1, completed_at: T_TODAY_1 + 5000,
        input_tokens: 100, output_tokens: 10 },
      { id: 'sm2', session_id: 's1', model_id: 'm1', provider_id: 'p1', status: 'completed',
        started_at: T_TODAY_2, completed_at: T_TODAY_2 + 5000,
        input_tokens: 200, output_tokens: 20 }
    ]
  });

  const zc = collectZcodeUsage({ dbPath: file, nowMs: NOW });
  const period = extractUsageFromTokscale(zc.today);
  const session = period.sessions['zcode:s1'];
  assert.ok(session);
  // startedAt should be the earliest started_at
  assert.equal(session.startedAt, new Date(T_TODAY_1).toISOString());
  // lastUsedAt should be the latest completed_at
  assert.equal(session.lastUsedAt, new Date(T_TODAY_2 + 5000).toISOString());
});

maybe('provider_id mapped to session.providers', () => {
  const file = makeDb({
    rows: [
      { id: 'pr1', session_id: 's1', model_id: 'm1', provider_id: 'a2ecbdcc', status: 'completed',
        started_at: T_TODAY_1, completed_at: T_TODAY_1 + 5000,
        input_tokens: 100, output_tokens: 10 }
    ]
  });

  const zc = collectZcodeUsage({ dbPath: file, nowMs: NOW });
  const period = extractUsageFromTokscale(zc.today);
  const session = period.sessions['zcode:s1'];
  assert.ok(session.providers['a2ecbdcc']);
  assert.equal(session.providers['a2ecbdcc'], 100 + 10); // input+output
});
