'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionRowsForPeriod, tokenBreakdownEntries } = require('../../src/electron/renderer/sessionRows');

function cells(entries) {
  return entries.map(([label, value]) => `${label} ${value}`);
}

test('list rows split fresh input, output and the merged cache cell', () => {
  const entries = tokenBreakdownEntries(
    { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 40000, cacheWriteTokens: 800 },
    { total: 42300 }
  );
  assert.deepEqual(cells(entries), ['in 1,200', 'out 300', 'cache 40,800']);
});

test('session detail turns split the same way from their own field names', () => {
  const entries = tokenBreakdownEntries(
    { input: 5, output: 7, cacheRead: 11, cacheWrite: 13 },
    { total: 36 }
  );
  assert.deepEqual(cells(entries), ['in 5', 'out 7', 'cache 24']);
});

test('no component data means no popover at all', () => {
  assert.equal(tokenBreakdownEntries(null), null);
  assert.equal(tokenBreakdownEntries(undefined), null);
});

test('a client that reports only a total shows dashes instead of three zeroes', () => {
  const entries = tokenBreakdownEntries(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { total: 900 }
  );
  assert.deepEqual(cells(entries), ['in —', 'out —', 'cache —']);
});

test('a session with no cache traffic still reads 0, not a dash', () => {
  const entries = tokenBreakdownEntries(
    { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { total: 12 }
  );
  assert.deepEqual(cells(entries), ['in 10', 'out 2', 'cache 0']);
});

test('one unusable component dashes only its own cell', () => {
  const entries = tokenBreakdownEntries(
    { inputTokens: 'not a number', outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 },
    { total: 10 }
  );
  assert.deepEqual(cells(entries), ['in —', 'out 4', 'cache 6']);
});

test('native telemetry rows feed the popover from prompt/completion counters', () => {
  const native = {
    client: 'reasonix',
    sessionId: 'abc',
    title: 'native',
    totalTokens: 1000,
    // promptTokens include the cache hits; the explicit misses win.
    promptTokens: 700,
    cacheHitTokens: 500,
    cacheMissTokens: 150,
    cacheWriteTokens: 50,
    completionTokens: 100,
    lastUsedAt: new Date().toISOString()
  };
  const rows = sessionRowsForPeriod({ sessions: {} }, { nativeSessions: { 'reasonix:abc': native } });
  assert.equal(rows.length, 1);
  assert.deepEqual(cells(tokenBreakdownEntries(rows[0].usageMetrics, { total: rows[0].value })),
    ['in 150', 'out 100', 'cache 550']);
});

test('native telemetry without explicit misses keeps cache writes out of the input cell', () => {
  const native = {
    client: 'reasonix',
    sessionId: 'abc',
    title: 'native',
    totalTokens: 800,
    // promptTokens = hits + misses + writes; only the first two are reported.
    promptTokens: 700,
    cacheHitTokens: 500,
    cacheWriteTokens: 50,
    completionTokens: 100,
    lastUsedAt: new Date().toISOString()
  };
  const rows = sessionRowsForPeriod({ sessions: {} }, { nativeSessions: { 'reasonix:abc': native } });
  const row = rows[0];
  assert.deepEqual(cells(tokenBreakdownEntries(row.usageMetrics, { total: row.value })),
    ['in 150', 'out 100', 'cache 550']);
});

test('a reported zero completion count reads as 0, not as a missing counter', () => {
  const native = {
    client: 'reasonix',
    sessionId: 'abc',
    title: 'native',
    totalTokens: 700,
    promptTokens: 700,
    cacheHitTokens: 500,
    cacheMissTokens: 150,
    cacheWriteTokens: 50,
    completionTokens: 0,
    lastUsedAt: new Date().toISOString()
  };
  const rows = sessionRowsForPeriod({ sessions: {} }, { nativeSessions: { 'reasonix:abc': native } });
  const row = rows[0];
  assert.deepEqual(cells(tokenBreakdownEntries(row.usageMetrics, { total: row.value })),
    ['in 150', 'out 0', 'cache 550']);
});

test('a miss counter the telemetry never carried falls back to the prompt remainder', () => {
  const native = {
    client: 'reasonix',
    sessionId: 'abc',
    title: 'native',
    totalTokens: 800,
    promptTokens: 700,
    cacheHitTokens: 500,
    cacheWriteTokens: 50,
    // The reader reports a missing counter as 0, not as undefined.
    cacheMissTokens: 0,
    completionTokens: 100,
    lastUsedAt: new Date().toISOString()
  };
  const rows = sessionRowsForPeriod({ sessions: {} }, { nativeSessions: { 'reasonix:abc': native } });
  const row = rows[0];
  assert.deepEqual(cells(tokenBreakdownEntries(row.usageMetrics, { total: row.value })),
    ['in 150', 'out 100', 'cache 550']);
});
