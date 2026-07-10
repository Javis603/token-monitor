'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildPromaHistoryGraph, buildTokscaleJson, buildPromaPeriods, PROMA_ROOT } = require('../../src/shared/promaUsage');
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

test('Proma default parsing excludes unverified conversation transcripts', () => {
  const observedRoots = [];
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = (root) => {
    observedRoots.push(root);
    return [];
  };

  try {
    buildTokscaleJson();
    assert.deepEqual(observedRoots, [PROMA_ROOT]);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test('Proma all-time window honors the configured cutoff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-usage-'));
  writeJsonl(path.join(root, 'session.jsonl'), [
    assistantRow({ id: 'before-cutoff', createdAt: '2025-01-01T00:00:00.000Z', input: 100 }),
    assistantRow({ id: 'after-cutoff', createdAt: '2026-02-01T00:00:00.000Z', input: 40, output: 2 })
  ]);

  const periods = buildPromaPeriods({
    now: '2026-07-09T12:00:00.000Z',
    allTimeSince: '2026-01-01',
    roots: [root]
  });
  const allTimeUsage = extractUsageFromTokscale(periods.allTime);
  assert.equal(allTimeUsage.clients.proma, 42);
});

test('Proma periods read each session file once before deriving all windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-usage-'));
  const filePath = path.join(root, 'session.jsonl');
  writeJsonl(filePath, [assistantRow({ id: 'message', createdAt: '2026-07-09T12:00:00.000Z', input: 10 })]);
  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    if (args[0] === filePath) reads += 1;
    return originalReadFileSync(...args);
  };
  try {
    const periods = buildPromaPeriods({ now: '2026-07-09T13:00:00.000Z', allTimeSince: '2026-01-01', roots: [root] });
    assert.equal(reads, 1);
    assert.equal(extractUsageFromTokscale(periods.today).totalTokens, 10);
    assert.equal(extractUsageFromTokscale(periods.month).totalTokens, 10);
    assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 10);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('Proma history keeps per-day and per-model token attribution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-usage-'));
  writeJsonl(path.join(root, 'session.jsonl'), [
    assistantRow({ id: 'first', model: 'Claude-Sonnet', createdAt: '2026-07-08T12:00:00.000Z', input: 10, output: 2 }),
    assistantRow({ id: 'second', model: 'gpt-5', createdAt: '2026-07-09T12:00:00.000Z', input: 20 })
  ]);
  const graph = buildPromaHistoryGraph({ roots: [root] });
  assert.deepEqual(graph.contributions, [
    { date: '2026-07-08', clients: [{ client: 'proma', modelId: 'claude-sonnet', tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] },
    { date: '2026-07-09', clients: [{ client: 'proma', modelId: 'gpt-5', tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 1 }] }
  ]);
});

test('Proma cost estimates use every populated token category', () => {
  const rows = [{
    model: 'Claude-Sonnet', input: 10, output: 2, cacheRead: 4, cacheWrite: 3,
    messages: 1, createdAt: Date.parse('2026-07-09T12:00:00.000Z')
  }];
  const pricingByModel = {
    'claude-sonnet': {
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      cacheReadInputTokenCost: 0.0000003,
      cacheCreationInputTokenCost: 0.00000375
    }
  };
  const json = buildTokscaleJson({}, { rows, pricingByModel });
  assert.ok(Math.abs(json.entries[0].cost - 0.00007245) < 1e-12);
  assert.ok(Math.abs(json.totalCost - 0.00007245) < 1e-12);
  const graph = buildPromaHistoryGraph({ rows, pricingByModel });
  assert.ok(Math.abs(graph.contributions[0].clients[0].cost - 0.00007245) < 1e-12);
});

test('Proma leaves an incomplete price out instead of partially estimating it', () => {
  const rows = [{ model: 'custom-model', input: 10, output: 2, cacheRead: 0, cacheWrite: 1, messages: 1 }];
  const json = buildTokscaleJson({}, {
    rows,
    pricingByModel: { 'custom-model': { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002 } }
  });
  assert.equal(json.entries[0].cost, 0);
});
