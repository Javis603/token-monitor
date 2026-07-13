'use strict';

// applyPeriodDelta: exact broader-period update from a fresh --today scan.
// Tokens written since the anchor full scan belong to today AND every broader
// window simultaneously, and session logs are append-only, so
// base + (freshToday - anchorToday) is an identity, not an estimate (issue #15
// follow-up: watch ticks scan only --today).

const assert = require('node:assert/strict');
const test = require('node:test');

const { applyPeriodDelta, emptyPeriod } = require('../../src/shared/usage');

function period(overrides = {}) {
  return { ...emptyPeriod(), ...overrides };
}

test('applyPeriodDelta adds the today delta to totals and per-client/model maps exactly', () => {
  const baseMonth = period({
    totalTokens: 1000,
    costUsd: 10,
    cacheReadTokens: 400,
    cacheWriteTokens: 80,
    outputTokens: 200,
    clients: { claude: 700, codex: 300 },
    clientCacheReads: { claude: 400 },
    clientCacheWrites: { claude: 80 },
    clientOutputs: { claude: 150, codex: 50 },
    models: { 'claude-opus-4-8': 700, 'gpt-5.5': 300 },
    modelCacheReads: { 'claude-opus-4-8': 400 },
    modelCacheWrites: { 'claude-opus-4-8': 80 },
    modelOutputs: { 'claude-opus-4-8': 150, 'gpt-5.5': 50 },
    clientModels: { claude: { 'claude-opus-4-8': 700 }, codex: { 'gpt-5.5': 300 } }
  });
  const anchorToday = period({
    totalTokens: 100,
    costUsd: 1,
    cacheReadTokens: 40,
    cacheWriteTokens: 8,
    outputTokens: 20,
    clients: { claude: 100 },
    clientCacheReads: { claude: 40 },
    clientCacheWrites: { claude: 8 },
    clientOutputs: { claude: 20 },
    models: { 'claude-opus-4-8': 100 },
    modelCacheReads: { 'claude-opus-4-8': 40 },
    modelCacheWrites: { 'claude-opus-4-8': 8 },
    modelOutputs: { 'claude-opus-4-8': 20 },
    clientModels: { claude: { 'claude-opus-4-8': 100 } }
  });
  const freshToday = period({
    totalTokens: 150,
    costUsd: 1.5,
    cacheReadTokens: 70,
    cacheWriteTokens: 12,
    outputTokens: 30,
    clients: { claude: 120, codex: 30 },
    clientCacheReads: { claude: 60, codex: 10 },
    clientCacheWrites: { claude: 12 },
    clientOutputs: { claude: 25, codex: 5 },
    models: { 'claude-opus-4-8': 120, 'gpt-5.5': 30 },
    modelCacheReads: { 'claude-opus-4-8': 60, 'gpt-5.5': 10 },
    modelCacheWrites: { 'claude-opus-4-8': 12 },
    modelOutputs: { 'claude-opus-4-8': 25, 'gpt-5.5': 5 },
    clientModels: { claude: { 'claude-opus-4-8': 120 }, codex: { 'gpt-5.5': 30 } }
  });

  const result = applyPeriodDelta(baseMonth, freshToday, anchorToday);

  assert.equal(result.totalTokens, 1050);
  assert.equal(result.costUsd, 10.5);
  assert.deepEqual(result.clients, { claude: 720, codex: 330 });
  assert.equal(result.models['claude-opus-4-8'], 720);
  assert.equal(result.clientModels.claude['claude-opus-4-8'], 720);
  assert.equal(result.clientModels.codex['gpt-5.5'], 330);
  // Cache-hit and output breakdowns ride the same union-recursion path.
  assert.equal(result.cacheReadTokens, 430);
  assert.equal(result.cacheWriteTokens, 84);
  assert.equal(result.outputTokens, 210);
  assert.deepEqual(result.clientCacheReads, { claude: 420, codex: 10 });
  assert.deepEqual(result.clientCacheWrites, { claude: 84 });
  assert.deepEqual(result.clientOutputs, { claude: 155, codex: 55 });
  assert.deepEqual(result.modelCacheReads, { 'claude-opus-4-8': 420, 'gpt-5.5': 10 });
  assert.deepEqual(result.modelCacheWrites, { 'claude-opus-4-8': 84 });
  assert.deepEqual(result.modelOutputs, { 'claude-opus-4-8': 155, 'gpt-5.5': 55 });
});

test('applyPeriodDelta covers session-level cache and reasoning token fields', () => {
  const baseMonth = period({
    sessions: {
      'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 300, inputTokens: 100, outputTokens: 50, cacheReadTokens: 120, cacheWriteTokens: 20, reasoningTokens: 10, costUsd: 3, startedAt: '2026-06-11T08:00:00.000Z', lastUsedAt: '2026-06-12T01:00:00.000Z', models: { m: 300 } }
    }
  });
  const anchorToday = period({
    sessions: {
      'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 60, inputTokens: 20, outputTokens: 10, cacheReadTokens: 24, cacheWriteTokens: 4, reasoningTokens: 2, costUsd: 0.6, startedAt: '2026-06-12T00:00:00.000Z', lastUsedAt: '2026-06-12T01:00:00.000Z', models: { m: 60 } }
    }
  });
  const freshToday = period({
    sessions: {
      'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 100, inputTokens: 30, outputTokens: 18, cacheReadTokens: 40, cacheWriteTokens: 7, reasoningTokens: 5, costUsd: 1, startedAt: '2026-06-12T00:00:00.000Z', lastUsedAt: '2026-06-12T02:00:00.000Z', models: { m: 100 } }
    }
  });

  const result = applyPeriodDelta(baseMonth, freshToday, anchorToday);
  const session = result.sessions['claude:s1'];

  assert.equal(session.totalTokens, 340);
  assert.equal(session.inputTokens, 110);
  assert.equal(session.outputTokens, 58);
  assert.equal(session.cacheReadTokens, 136);
  assert.equal(session.cacheWriteTokens, 23);
  assert.equal(session.reasoningTokens, 13);
  assert.equal(session.costUsd, 3.4);
});

test('applyPeriodDelta carries sessions: new today sessions appear, cross-day sessions keep earliest start and latest use', () => {
  const baseMonth = period({
    sessions: {
      'claude:old': { client: 'claude', sessionId: 'old', totalTokens: 500, costUsd: 5, startedAt: '2026-06-10T08:00:00.000Z', lastUsedAt: '2026-06-11T09:00:00.000Z', models: { m: 500 } },
      'claude:span': { client: 'claude', sessionId: 'span', totalTokens: 200, costUsd: 2, startedAt: '2026-06-11T22:00:00.000Z', lastUsedAt: '2026-06-12T01:00:00.000Z', models: { m: 200 } }
    }
  });
  const anchorToday = period({
    sessions: {
      'claude:span': { client: 'claude', sessionId: 'span', totalTokens: 40, costUsd: 0.4, startedAt: '2026-06-12T00:00:00.000Z', lastUsedAt: '2026-06-12T01:00:00.000Z', models: { m: 40 } }
    }
  });
  const freshToday = period({
    sessions: {
      'claude:span': { client: 'claude', sessionId: 'span', totalTokens: 90, costUsd: 0.9, startedAt: '2026-06-12T00:00:00.000Z', lastUsedAt: '2026-06-12T03:00:00.000Z', models: { m: 90 } },
      'claude:new': { client: 'claude', sessionId: 'new', totalTokens: 10, costUsd: 0.1, startedAt: '2026-06-12T02:00:00.000Z', lastUsedAt: '2026-06-12T02:30:00.000Z', models: { m: 10 } }
    }
  });

  const result = applyPeriodDelta(baseMonth, freshToday, anchorToday);

  // Untouched old session passes through.
  assert.equal(result.sessions['claude:old'].totalTokens, 500);
  // Cross-day session: month value grows by today's delta; start stays the earlier one.
  assert.equal(result.sessions['claude:span'].totalTokens, 250);
  assert.equal(result.sessions['claude:span'].startedAt, '2026-06-11T22:00:00.000Z');
  assert.equal(result.sessions['claude:span'].lastUsedAt, '2026-06-12T03:00:00.000Z');
  assert.equal(result.sessions['claude:span'].models.m, 250);
  // Brand-new today session appears as-is.
  assert.equal(result.sessions['claude:new'].totalTokens, 10);
  assert.equal(result.sessions['claude:new'].client, 'claude');
});

test('applyPeriodDelta clamps float residue at zero and never mutates its inputs', () => {
  const baseMonth = period({ costUsd: 0.1, clients: { claude: 10 }, totalTokens: 10 });
  const anchorToday = period({ costUsd: 0.1 + 1e-15, clients: { claude: 10 }, totalTokens: 10 });
  const freshToday = period();
  const baseSnapshot = JSON.stringify(baseMonth);

  const result = applyPeriodDelta(baseMonth, freshToday, anchorToday);

  assert.ok(result.costUsd >= 0);
  assert.equal(result.clients.claude, 0);
  assert.equal(JSON.stringify(baseMonth), baseSnapshot);
  assert.equal(anchorToday.costUsd, 0.1 + 1e-15);
});
