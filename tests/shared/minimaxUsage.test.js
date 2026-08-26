'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildMinimaxHistoryGraph,
  buildTokscaleJson,
  buildMinimaxPeriods,
  collectMinimaxRows,
  MINIMAX_ROOT
} = require('../../src/shared/minimaxUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function writeSession(root, day, sessionDir, rows) {
  const dir = path.join(root, ...day.split('-'), sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  );
  return dir;
}

// MiniMax puts the role on the message, keys the id at the top level, and already
// reports normalised camelCase counters — none of which match the Proma shape.
function assistantRow({ id, model = 'MiniMax-M3', timestamp, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return {
    message_id: id,
    turn_id: `turn-${id}`,
    message: { role: 'assistant', model, timestamp, usage: { input, output, cacheRead, cacheWrite } }
  };
}

test('MiniMax sessions are discovered under the year/month/day layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  writeSession(root, '2026-08-20', '22-02-18-817-session_aaa', [
    assistantRow({ id: 'a1', timestamp: Date.parse('2026-08-20T22:02:19.000Z'), input: 10, output: 2 })
  ]);
  writeSession(root, '2026-08-22', '20-24-31-499-session_bbb', [
    assistantRow({ id: 'b1', timestamp: Date.parse('2026-08-22T20:24:32.000Z'), input: 5, output: 1, cacheRead: 40 })
  ]);

  const rows = collectMinimaxRows({ roots: [root] });
  assert.equal(rows.length, 2);
  assert.deepEqual([...new Set(rows.map((row) => row.model))], ['MiniMax-M3']);
  // The session directory is the only stable identity, so two sessions must not
  // collapse into one.
  assert.equal(new Set(rows.map((row) => row.sessionId)).size, 2);
});

test('only assistant messages carrying usage are counted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  writeSession(root, '2026-08-20', '22-02-18-817-session_aaa', [
    { message_id: 'u1', message: { role: 'user', content: 'hi' } },
    { message_id: 't1', message: { role: 'toolResult', content: 'ok' } },
    assistantRow({ id: 'a1', timestamp: Date.parse('2026-08-20T22:02:19.000Z'), input: 7, output: 3, cacheRead: 11 })
  ]);

  const json = buildTokscaleJson({}, { rows: collectMinimaxRows({ roots: [root] }) });
  assert.equal(json.totalMessages, 1);
  assert.equal(json.totalInput, 7);
  assert.equal(json.totalOutput, 3);
  assert.equal(json.totalCacheRead, 11);
});

test('a streamed reply split across records counts once at its largest total', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  const ts = Date.parse('2026-08-20T22:02:19.000Z');
  writeSession(root, '2026-08-20', '22-02-18-817-session_aaa', [
    assistantRow({ id: 'same', timestamp: ts, input: 5, output: 1 }),
    assistantRow({ id: 'same', timestamp: ts + 500, input: 5, output: 9, cacheRead: 20 })
  ]);

  const json = buildTokscaleJson({}, { rows: collectMinimaxRows({ roots: [root] }) });
  assert.equal(json.totalMessages, 1, 'partials of one reply are one message');
  assert.equal(json.totalOutput, 9);
  assert.equal(json.totalCacheRead, 20);
});

test('the daily window filters per message, not per aggregated model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  const yesterday = Date.parse('2026-08-21T23:50:00.000Z');
  const today = Date.parse('2026-08-22T00:05:00.000Z');
  const todayStart = Date.parse('2026-08-22T00:00:00.000Z');
  // One session spanning midnight: the older message must not drag today's usage
  // out of the window, nor be counted inside it.
  writeSession(root, '2026-08-21', '23-49-00-000-session_aaa', [
    assistantRow({ id: 'old', timestamp: yesterday, input: 100, output: 1 }),
    assistantRow({ id: 'new', timestamp: today, input: 40, output: 3, cacheRead: 2 })
  ]);

  const rows = collectMinimaxRows({ roots: [root] });
  const period = extractUsageFromTokscale(buildTokscaleJson({ todayStart }, { rows }));
  assert.equal(period.totalTokens, 45);
});

test('history graph places each message on its own local day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  writeSession(root, '2026-08-20', '22-02-18-817-session_aaa', [
    assistantRow({ id: 'a1', timestamp: Date.parse('2026-08-20T12:00:00.000Z'), input: 10, output: 2 })
  ]);
  writeSession(root, '2026-08-22', '20-24-31-499-session_bbb', [
    assistantRow({ id: 'b1', timestamp: Date.parse('2026-08-22T12:00:00.000Z'), input: 5, output: 1 })
  ]);

  const graph = buildMinimaxHistoryGraph({ rows: collectMinimaxRows({ roots: [root] }) });
  assert.equal(graph.contributions.length, 2);
  for (const day of graph.contributions) {
    assert.equal(day.clients.length, 1);
    assert.equal(day.clients[0].client, 'minimax');
    assert.equal(day.clients[0].modelId, 'minimax-m3');
  }
});

test('an undated message stays out of dated windows and off the graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-usage-'));
  writeSession(root, '2026-08-20', '22-02-18-817-session_aaa', [
    assistantRow({ id: 'no-ts', timestamp: undefined, input: 9, output: 1 })
  ]);

  const rows = collectMinimaxRows({ roots: [root] });
  const todayStart = Date.parse('2026-08-20T00:00:00.000Z');
  assert.equal(extractUsageFromTokscale(buildTokscaleJson({ todayStart }, { rows })).totalTokens, 0);
  assert.equal(buildMinimaxHistoryGraph({ rows }).contributions.length, 0);
  // allTime deliberately keeps it: a total that silently drops messages is worse
  // than one that cannot place them on a day.
  const periods = buildMinimaxPeriods({ roots: [root], allTimeSince: 0 });
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 10);
});

test('a missing MiniMax root yields no rows rather than throwing', () => {
  assert.deepEqual(collectMinimaxRows({ roots: [path.join(os.tmpdir(), 'minimax-does-not-exist')] }), []);
  assert.ok(MINIMAX_ROOT.endsWith(path.join('.minimax', 'v2', 'sessions')));
});
