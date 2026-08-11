'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { collectHistoryOnce, collectUsageOnce, tokscaleClientFilter } = require('../../src/shared/collector');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function reasonixEntry(overrides = {}) {
  return {
    client: 'reasonix',
    sessionId: 'reasonix-stats:/Users/test/.reasonix/stats/2026-08-09.jsonl',
    model: 'deepseek-flash/deepseek-v4-flash',
    input: 80,
    output: 30,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: 10,
    cost: 0.25,
    startedAt: '2026-08-09T11:00:00.000Z',
    lastUsedAt: '2026-08-09T11:00:00.000Z',
    ...overrides
  };
}

test('Tokscale client filtering sends Reasonix through the shared aggregate path', () => {
  assert.equal(tokscaleClientFilter('reasonix,hermes'), 'reasonix,hermes');
});

test('Tokscale Reasonix rows use shared token, cost, model and privacy semantics', () => {
  const period = extractUsageFromTokscale({ entries: [
    reasonixEntry(),
    { client: 'hermes', sessionId: 'hermes-1', model: 'deepseek-v4-flash', input: 10, output: 2, cost: 0.1 }
  ] });

  assert.equal(period.totalTokens, 152);
  assert.equal(period.clients.reasonix, 140);
  assert.equal(period.clientCosts.reasonix, 0.25);
  assert.equal(period.outputTokens, 42);
  assert.equal(period.cacheReadTokens, 20);
  assert.equal(period.models['deepseek-v4-flash'], 152);
  assert.equal(period.modelCosts['deepseek-v4-flash'], 0.35);
  assert.equal(period.clientModels.reasonix['deepseek-v4-flash'], 140);
  assert.equal(period.clientModelCosts.reasonix['deepseek-v4-flash'], 0.25);
  assert.equal(Object.hasOwn(period.sessions, 'reasonix:reasonix-stats:/Users/test/.reasonix/stats/2026-08-09.jsonl'), false);
  assert.equal(Object.hasOwn(period.sessions, 'hermes:hermes-1'), true);
  assert.equal(Object.hasOwn(period.models, 'deepseek-flash/deepseek-v4-flash'), false);
});

test('collector aggregates Reasonix with other Tokscale clients in all periods', async () => {
  const calls = [];
  const runTokscale = async ({ clients, flags }) => {
    calls.push({ clients, flags });
    return {
      entries: [
        reasonixEntry(),
        { client: 'hermes', sessionId: 'hermes-1', model: 'deepseek-v4-flash', input: 10, output: 2, cost: 0.1 }
      ]
    };
  };

  const summary = await collectUsageOnce({
    clients: 'reasonix,hermes',
    allTimeSince: '2026-01-01',
    now: new Date(2026, 7, 9, 12, 0, 0),
    deviceId: 'reasonix-tokscale-test',
    historyEnabled: false,
    wslScanEnabled: false,
    runTokscale
  });

  assert.deepEqual(calls.map((call) => call.clients), ['reasonix,hermes', 'reasonix,hermes', 'reasonix,hermes']);
  assert.deepEqual(calls.map((call) => call.flags), [['--today'], ['--month'], ['--since', '2026-01-01']]);
  for (const period of [summary.today, summary.month, summary.allTime]) {
    assert.equal(period.totalTokens, 152);
    assert.equal(period.costUsd, 0.35);
    assert.equal(period.models['deepseek-v4-flash'], 152);
    assert.equal(Object.hasOwn(period.sessions, 'reasonix:reasonix-stats:/Users/test/.reasonix/stats/2026-08-09.jsonl'), false);
    assert.equal(Object.hasOwn(period.sessions, 'hermes:hermes-1'), true);
  }
  assert.equal(summary.clientStatus.reasonix, 'active');
});

test('history uses the Tokscale graph for Reasonix without synthetic message counts', async () => {
  const history = await collectHistoryOnce({
    clients: 'reasonix',
    todayKey: '2026-08-09',
    runGraph: async () => ({ contributions: [{
      date: '2026-08-09',
      clients: [{
        client: 'reasonix',
        modelId: 'deepseek-v4-flash',
        tokens: { input: 80, output: 30, cacheRead: 20, reasoning: 10 },
        cost: 0.25,
        messages: 7
      }]
    }] })
  });

  assert.equal(history.summary.totalTokens, 140);
  assert.equal(history.summary.totalCost, 0.25);
  assert.equal(history.summary.messages, 0);
  assert.equal(history.daily[0].perClient.reasonix.tokens, 140);
  assert.equal(history.daily[0].perModel['deepseek-v4-flash'].tokens, 140);
});
