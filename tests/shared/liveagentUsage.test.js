'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const {
  buildLiveAgentHistoryGraph,
  buildLiveAgentPeriods,
  buildTokscaleJson,
  collectLiveAgentRows,
  estimatedRowCost,
  liveAgentDataPaths,
  normalizedModelId
} = require('../../src/shared/providers/liveagent/usage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { localIso, localMs } = require('../helpers/localTime');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'liveagent-usage-'));
}

function assistantMessage({ id, model = 'glm-5.3', timestamp, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, role = 'assistant' }) {
  return {
    id,
    role,
    model,
    timestamp,
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }
  };
}

function writeDb(home, segments) {
  // node:sqlite is the same backend the adapter itself reads through; the
  // fixture writes a real database so the read path is exercised end to end.
  const dbDir = path.join(home, '.liveagent');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'chat-history.sqlite3');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE chatHistorySegment (
    conversation_id TEXT,
    segment_index INTEGER,
    segment_id TEXT,
    messages_json TEXT,
    updated_at INTEGER
  )`);
  const insert = db.prepare(
    'INSERT INTO chatHistorySegment (conversation_id, segment_index, segment_id, messages_json, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [index, segment] of segments.entries()) {
    insert.run(
      segment.conversationId,
      index,
      segment.segmentId,
      JSON.stringify(segment.messages),
      segment.updatedAt
    );
  }
  db.close();
  return dbPath;
}

test('LiveAgent reads assistant usage from chatHistorySegment and skips empty rows', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [{
    conversationId: 'conversation-1',
    segmentId: 'segment-1',
    updatedAt: localMs(2026, 7, 9, 12),
    messages: [
      assistantMessage({ id: 'user-1', role: 'user', timestamp: localIso(2026, 7, 9, 10), input: 999 }),
      assistantMessage({ id: 'assistant-empty', timestamp: localIso(2026, 7, 9, 10) }),
      assistantMessage({ id: 'assistant-1', model: 'glm-5.3', timestamp: localIso(2026, 7, 9, 11), input: 100, output: 20, cacheRead: 5, cacheWrite: 2 })
    ]
  }]);

  const rows = collectLiveAgentRows({ homeDir: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'glm-5.3');
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].output, 20);
  assert.equal(rows[0].cacheRead, 5);
  assert.equal(rows[0].cacheWrite, 2);
  assert.equal(rows[0].createdAt, localMs(2026, 7, 9, 11));
  assert.match(rows[0].sessionId, /^liveagent:[a-f0-9]{12}:conversation-1$/);
  assert.match(rows[0].messageId, /^liveagent:[a-f0-9]{12}:assistant-1$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('LiveAgent windows cut at local midnight and keep undated rows only in all-time', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  const now = localIso(2026, 7, 9, 12);
  writeDb(home, [{
    conversationId: 'conversation-1',
    segmentId: 'segment-1',
    updatedAt: localMs(2026, 7, 9, 12),
    messages: [
      assistantMessage({ id: 'yesterday', timestamp: localIso(2026, 7, 8, 23, 59), input: 40 }),
      assistantMessage({ id: 'today', timestamp: localIso(2026, 7, 9, 0, 1), input: 10 }),
      assistantMessage({ id: 'undated', timestamp: 'not-a-date', input: 7 })
    ]
  }]);

  const periods = buildLiveAgentPeriods({ homeDir: home, now, allTimeSince: '2026-01-01' });
  assert.equal(extractUsageFromTokscale(periods.today).totalTokens, 10);
  assert.equal(extractUsageFromTokscale(periods.month).totalTokens, 50);
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 57);
  fs.rmSync(home, { recursive: true, force: true });
});

test('LiveAgent normalizes bracketed model prefixes and estimates cost from pricing', () => {
  assert.equal(normalizedModelId('[free]Claude-Opus-5'), 'claude-opus-5');
  assert.equal(normalizedModelId('[]glm-5.3'), 'glm-5.3');
  assert.equal(normalizedModelId(''), 'unknown');

  const rows = [{
    sessionId: 'liveagent:source:conversation-1',
    messageId: 'liveagent:source:message-1',
    model: 'glm-5.3',
    input: 10,
    output: 2,
    cacheRead: 4,
    cacheWrite: 3,
    createdAt: localMs(2026, 7, 9, 12),
    messages: 1
  }];
  const pricingByModel = {
    'glm-5.3': {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheReadInputTokenCost: 0.0000003,
      cacheCreationInputTokenCost: 0.00000375
    }
  };
  const json = buildTokscaleJson(0, rows, pricingByModel);
  assert.equal(json.entries.length, 1);
  assert.equal(json.entries[0].client, 'liveagent');
  assert.equal(json.totalMessages, 1);
  assert.ok(Math.abs(json.totalCost - 0.00007245) < 1e-12);

  // An incomplete price leaves the row unestimated instead of half-estimating it.
  assert.equal(estimatedRowCost(rows[0], { 'glm-5.3': { inputCostPerToken: 0.000001 } }), null);
});

test('LiveAgent history keeps per-day and per-model token attribution', (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const home = makeHome();
  writeDb(home, [{
    conversationId: 'conversation-1',
    segmentId: 'segment-1',
    updatedAt: localMs(2026, 7, 9, 12),
    messages: [
      assistantMessage({ id: 'first', model: 'Claude-Sonnet', timestamp: localIso(2026, 7, 8, 12), input: 10, output: 2 }),
      assistantMessage({ id: 'second', model: 'gpt-5', timestamp: localIso(2026, 7, 9, 12), input: 20 })
    ]
  }]);

  const graph = buildLiveAgentHistoryGraph({ homeDir: home });
  assert.deepEqual(graph.contributions, [
    { date: '2026-07-08', clients: [{ client: 'liveagent', modelId: 'claude-sonnet', tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] },
    { date: '2026-07-09', clients: [{ client: 'liveagent', modelId: 'gpt-5', tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] }
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('LiveAgent history deduplicates repeated message ids across reads', () => {
  const row = () => ({
    sessionId: 'liveagent:src:conversation-1',
    messageId: 'liveagent:src:message-1',
    model: 'gpt-5',
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    createdAt: localMs(2026, 7, 9, 12),
    messages: 1
  });
  const graph = buildLiveAgentHistoryGraph({ rows: [row(), row()] });
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].clients[0].tokens.input, 10, 'a repeated message id must be counted once in history too');
});

test('liveAgentDataPaths honors TOKEN_MONITOR_LIVEAGENT_DB_PATH and falls back to the home root', () => {
  const home = 'C:/fixture-home';
  assert.deepEqual(
    liveAgentDataPaths({ homeDir: home, env: {} }).dbPaths,
    [path.join(home, '.liveagent', 'chat-history.sqlite3')]
  );
  assert.deepEqual(
    liveAgentDataPaths({ homeDir: home, env: { TOKEN_MONITOR_LIVEAGENT_DB_PATH: 'C:/custom/liveagent.sqlite3' } }).dbPaths,
    [path.resolve('C:/custom/liveagent.sqlite3')]
  );
});

test('LiveAgent treats a missing database as empty instead of throwing', () => {
  const home = makeHome();
  assert.deepEqual(collectLiveAgentRows({ homeDir: home }), []);
  fs.rmSync(home, { recursive: true, force: true });
});