'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCopilotSessionStoreHistoryGraph,
  buildCopilotSessionStorePeriods,
  collectCopilotSessionStoreRows,
  copilotSessionStoreDataPaths,
  normalizeCopilotSessionStoreDbRow
} = require('../../src/shared/copilotSessionStoreUsage');

test('copilotSessionStoreDataPaths defaults to ~/.copilot/session-store.db and honours the env override', () => {
  const home = os.homedir();
  assert.deepEqual(
    copilotSessionStoreDataPaths({ homeDir: home, env: {} }).dbPaths,
    [path.join(home, '.copilot', 'session-store.db')]
  );
  assert.deepEqual(
    copilotSessionStoreDataPaths({ homeDir: home, env: { TOKEN_MONITOR_COPILOT_SESSION_DB_PATH: 'D:/data/store.db' } }).dbPaths,
    [path.resolve('D:/data/store.db')]
  );
});

test('normalizeCopilotSessionStoreDbRow splits cached input without double-counting', () => {
  const row = normalizeCopilotSessionStoreDbRow({
    id: 41,
    session_id: '2uAUA7y0BaX8EJMSEvSqdxg7X15',
    model: 'gpt-5.6-terra',
    input_tokens: 17_401,
    output_tokens: 289,
    cache_read_tokens: 11_776,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    created_at: '2026-08-23 01:57:06.033Z'
  }, 'src');
  assert.deepEqual(row, {
    sessionId: 'copilot:src:2uAUA7y0BaX8EJMSEvSqdxg7X15',
    messageId: 'copilot:src:2uAUA7y0BaX8EJMSEvSqdxg7X15:41',
    model: 'gpt-5.6-terra',
    projectLabel: '',
    input: 5_625,
    output: 289,
    cacheRead: 11_776,
    cacheWrite: 0,
    reasoning: 0,
    createdAt: Date.parse('2026-08-23T01:57:06.033Z'),
    messages: 1
  });
});

test('normalizeCopilotSessionStoreDbRow clamps runaway cache fields into the prompt window', () => {
  const row = normalizeCopilotSessionStoreDbRow({
    id: 1, session_id: 's', model: 'm',
    input_tokens: 50, output_tokens: 3,
    cache_read_tokens: 999, cache_write_tokens: 999
  }, 'src');
  assert.equal(row.cacheRead, 50);
  assert.equal(row.cacheWrite, 0);
  assert.equal(row.input, 0);
});

test('normalizeCopilotSessionStoreDbRow drops empty and malformed rows', () => {
  assert.equal(normalizeCopilotSessionStoreDbRow(null), null);
  assert.equal(normalizeCopilotSessionStoreDbRow({ id: 1, input_tokens: null, output_tokens: null }), null);
  assert.equal(normalizeCopilotSessionStoreDbRow({ id: 1, session_id: 's', model: 'm', input_tokens: 0, output_tokens: 0 }), null);
});

test('buildCopilotSessionStorePeriods windows rows into today/month/allTime', () => {
  const now = new Date(2026, 7, 23, 12, 0, 0); // local 2026-08-23 12:00
  const todayRow = {
    sessionId: 'copilot:s:a', messageId: 'a', model: 'm',
    input: 35, output: 10, cacheRead: 60, cacheWrite: 0, reasoning: 2,
    createdAt: now.getTime() - 60_000, messages: 1
  };
  const monthRow = {
    sessionId: 'copilot:s:b', messageId: 'b', model: 'm',
    input: 100, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    createdAt: new Date(2026, 7, 1, 9, 0, 0).getTime(), messages: 1
  };
  const periods = buildCopilotSessionStorePeriods({ now, rows: [todayRow, monthRow], pricingByModel: {} });

  assert.equal(periods.today.totalInput, 35);
  assert.equal(periods.today.totalOutput, 10);
  assert.equal(periods.month.totalInput, 135);
  assert.equal(periods.allTime.totalMessages, 2);

  for (const period of [periods.today, periods.month, periods.allTime]) {
    for (const entry of period.entries) {
      assert.equal(entry.client, 'copilot');
      assert.equal(entry.provider, 'copilot');
      assert.equal(entry.reasoning, entry === periods.allTime.entries[0] ? 2 : entry.reasoning);
    }
  }
});

test('undated rows count only for allTime', () => {
  const now = new Date(2026, 7, 23, 12, 0, 0);
  const undated = {
    sessionId: 'copilot:s:x', messageId: 'x', model: 'm',
    input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    createdAt: 0, messages: 1
  };
  const periods = buildCopilotSessionStorePeriods({ now, rows: [undated], pricingByModel: {} });
  assert.equal(periods.today.totalMessages, 0);
  assert.equal(periods.month.totalMessages, 0);
  assert.equal(periods.allTime.totalMessages, 1);
});

test('buildCopilotSessionStoreHistoryGraph buckets per day and model under the copilot client', () => {
  const graph = buildCopilotSessionStoreHistoryGraph({
    rows: [
      { sessionId: 's', messageId: '1', model: 'm1', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, createdAt: new Date(2026, 7, 22).getTime(), messages: 1 },
      { sessionId: 's', messageId: '2', model: 'm1', input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, createdAt: new Date(2026, 7, 22).getTime(), messages: 1 },
      { sessionId: 's', messageId: '3', model: 'm2', input: 7, output: 3, cacheRead: 4, cacheWrite: 0, reasoning: 1, cost: null, createdAt: new Date(2026, 7, 23).getTime(), messages: 1 }
    ],
    pricingByModel: {}
  });
  assert.equal(graph.contributions.length, 2);
  assert.deepEqual(graph.contributions.map((day) => day.date), ['2026-08-22', '2026-08-23']);
  const day1 = graph.contributions[0].clients.find((entry) => entry.modelId === 'm1');
  assert.equal(day1.client, 'copilot');
  assert.equal(day1.tokens.input, 15);
  const day2 = graph.contributions[1].clients[0];
  assert.equal(day2.tokens.cacheRead, 4);
  assert.equal(day2.tokens.reasoning, 1);
});
