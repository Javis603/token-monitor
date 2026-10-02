'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { extractUsageFromTokscale } = require('../../src/shared/usage');
const {
  buildCursorDeviceHistoryGraph,
  buildCursorDevicePeriods,
  collectCursorDeviceRows,
  normalizeCursorUsageSource
} = require('../../src/shared/providers/cursor/deviceUsage');
const { localIso } = require('../helpers/localTime');

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function stopLine(overrides = {}) {
  return {
    v: 1,
    event: 'stop',
    ts: '2026-09-15T12:00:00.000Z',
    model: 'cursor-grok-4.6-xhigh',
    input_tokens: 100,
    output_tokens: 5,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    project: 'token-monitor',
    ...overrides
  };
}

test('normalizeCursorUsageSource defaults to account', () => {
  assert.equal(normalizeCursorUsageSource(undefined), 'account');
  assert.equal(normalizeCursorUsageSource('DEVICE'), 'device');
  assert.equal(normalizeCursorUsageSource('nope', 'device'), 'device');
  assert.equal(normalizeCursorUsageSource('nope'), 'account');
});

test('Cursor device rows split inclusive input so cache is not double-counted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-usage-'));
  const logPath = path.join(root, 'usage.jsonl');
  writeJsonl(logPath, [stopLine()]);
  const rows = collectCursorDeviceRows({ logPath });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 50);
  assert.equal(rows[0].cacheRead, 40);
  assert.equal(rows[0].cacheWrite, 10);
  assert.equal(rows[0].output, 5);
  assert.equal(rows[0].sessionId, 'conv-1');
  assert.equal(rows[0].projectLabel, 'token-monitor');

  const usage = extractUsageFromTokscale(buildCursorDevicePeriods({
    now: '2026-09-15T13:00:00.000Z',
    allTimeSince: '2026-01-01',
    logPath
  }).today);
  assert.equal(usage.clients.cursor, 105);
  assert.equal(usage.cacheReadTokens, 40);
  assert.equal(usage.cacheWriteTokens, 10);
  assert.equal(usage.outputTokens, 5);
});

test('Cursor device log last write for a generation_id wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-usage-'));
  const logPath = path.join(root, 'usage.jsonl');
  writeJsonl(logPath, [
    stopLine({ output_tokens: 1 }),
    stopLine({ ts: '2026-09-15T12:00:02.000Z', output_tokens: 9 })
  ]);
  const rows = collectCursorDeviceRows({ logPath });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output, 9);
});

test('Cursor device periods honor today and all-time cutoffs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-usage-'));
  const logPath = path.join(root, 'usage.jsonl');
  const today = localIso(2026, 9, 15, 10);
  writeJsonl(logPath, [
    stopLine({ ts: '2025-01-01T00:00:00.000Z', generation_id: 'old', input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }),
    stopLine({ ts: today, generation_id: 'new', input_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 })
  ]);
  const periods = buildCursorDevicePeriods({
    now: localIso(2026, 9, 15, 13),
    allTimeSince: '2026-01-01',
    logPath
  });
  assert.equal(extractUsageFromTokscale(periods.today).clients.cursor, 42);
  assert.equal(extractUsageFromTokscale(periods.allTime).clients.cursor, 42);
});

test('Cursor device history graph groups by local day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-usage-'));
  const logPath = path.join(root, 'usage.jsonl');
  writeJsonl(logPath, [stopLine({ input_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 })]);
  const graph = buildCursorDeviceHistoryGraph({ logPath });
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].clients[0].client, 'cursor');
  assert.equal(graph.contributions[0].clients[0].tokens.input, 10);
  assert.equal(graph.contributions[0].clients[0].tokens.output, 2);
});
