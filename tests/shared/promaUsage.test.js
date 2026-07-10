'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildTokscaleJson } = require('../../src/shared/promaUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function assistantRow({ id, model = 'deepseek-v4-pro', createdAt, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return {
    type: 'assistant',
    _createdAt: createdAt,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite
      }
    }
  };
}

test('Proma daily window filters messages before per-model aggregation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-usage-'));
  const filePath = path.join(root, 'session.jsonl');
  const yesterday = Date.parse('2026-07-08T23:50:00.000Z');
  const today = Date.parse('2026-07-09T00:05:00.000Z');
  const todayStart = Date.parse('2026-07-09T00:00:00.000Z');

  writeJsonl(filePath, [
    assistantRow({ id: 'old-message', createdAt: yesterday, input: 100, output: 1 }),
    assistantRow({ id: 'today-message', createdAt: today, input: 40, output: 3, cacheRead: 2 })
  ]);

  const todayUsage = extractUsageFromTokscale(buildTokscaleJson({ todayStart }, { roots: [root] }));
  assert.equal(todayUsage.clients.proma, 45);
  assert.equal(todayUsage.models['deepseek-v4-pro'], 45);

  const monthUsage = extractUsageFromTokscale(buildTokscaleJson({ monthStart: Date.parse('2026-07-01T00:00:00.000Z') }, { roots: [root] }));
  assert.equal(monthUsage.clients.proma, 146);
});

test('Proma collapses streamed chunks by max usage but keeps the latest message time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-usage-'));
  const filePath = path.join(root, 'session.jsonl');
  const beforeToday = Date.parse('2026-07-08T23:59:00.000Z');
  const afterToday = Date.parse('2026-07-09T00:00:02.000Z');
  const todayStart = Date.parse('2026-07-09T00:00:00.000Z');

  writeJsonl(filePath, [
    assistantRow({ id: 'streamed-message', createdAt: beforeToday, input: 100 }),
    assistantRow({ id: 'streamed-message', createdAt: afterToday, input: 20 })
  ]);

  const usage = extractUsageFromTokscale(buildTokscaleJson({ todayStart }, { roots: [root] }));
  assert.equal(usage.clients.proma, 100);
});
