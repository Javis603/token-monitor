'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTokscaleModelNameForClient } = require('../../src/shared/history');
const { mergeDeviceRecord, normalizePeriod } = require('../../src/shared/usage');

test('released model identities follow first-party folding without merging routers or other vendors', () => {
  const folded = [
    ['openai/gpt-5', 'gpt-5'], ['openai-codex/gpt-6.1-sol', 'gpt-6.1-sol'],
    ['openai/o3-mini', 'o3-mini'], ['anthropic/claude-4-6-sonnet', 'claude-sonnet-4-6'],
    ['vertex_ai/claude-sonnet-4-6', 'claude-sonnet-4-6'], ['google/gemini-3-pro', 'gemini-3-pro'],
    ['x-ai/grok-4', 'grok-4'], ['deepseek-ai/deepseek-v3', 'deepseek-v3'],
    ['minimax_ai/minimax-m2', 'minimax-m2'], ['mistralai/codestral-1', 'codestral-1'],
    ['meta-llama/llama3', 'llama3'], ['qwen/qwen3', 'qwen3'], ['sakana/fugu-ultra', 'fugu-ultra'],
    ['kimi-for-coding/k3', 'k3'], ['moonshot/kimi-k2', 'kimi-k2'],
    ['xiaomi/mimo-v2', 'mimo-v2'], ['z-ai/glm-5', 'glm-5']
  ];
  const distinct = [
    'openrouter/openai/gpt-5', 'azure/gpt-4o', 'openai/claude-opus-5-5',
    'vertex_ai/gemini-2.5-pro', 'cohere/north-mini-code:free', 'cline-free/mimo-v2.6-flash',
    'mistral/demistralized', 'openai/hypergpt-9', 'google/ungeminied-1',
    'xai/ungrokked', 'anthropic/preclaude-3', 'anthropic/claude/opus-5-5', 'anthropic/'
  ];
  for (const [before, after] of [...folded, ...distinct.map((model) => [model, model])]) {
    assert.equal(normalizeTokscaleModelNameForClient(before, 'qodercn'), after, before);
  }
});

test('old period model maps retain output ownership when a client is deselected', () => {
  const period = {
    capabilities: { tokenComponents: true }, totalTokens: 100, costUsd: 1,
    cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 20,
    clients: { qodercn: 100 }, clientCosts: { qodercn: 1 },
    clientCacheReads: { qodercn: 20 }, clientCacheWrites: { qodercn: 10 }, clientOutputs: { qodercn: 20 },
    models: { 'openai/gpt-5': 100 }, modelCosts: { 'openai/gpt-5': 1 },
    modelCacheReads: { 'openai/gpt-5': 20 }, modelCacheWrites: { 'openai/gpt-5': 10 },
    modelOutputs: { 'openai/gpt-5': 20 },
    clientModels: { qodercn: { 'openai/gpt-5': 100 } }, clientModelCosts: { qodercn: { 'openai/gpt-5': 1 } }
  };
  const normalized = normalizePeriod(period);
  assert.equal(normalized.models['gpt-5'], 100);
  assert.equal(normalized.modelCosts['gpt-5'], 1);
  assert.equal(normalized.modelOutputs['gpt-5'], 20);
  const merged = mergeDeviceRecord({
    deviceId: 'd', trackedClients: ['qodercn'], updatedAt: '2026-07-18T12:00:00Z', today: period
  }, {
    deviceId: 'd', trackedClients: ['codex'], updatedAt: '2026-07-18T12:01:00Z', today: {}
  }).periods.today;
  assert.equal(merged.totalTokens, 100);
  assert.equal(merged.models['gpt-5'], 100);
  assert.equal(merged.modelCacheReads['gpt-5'], 20);
  assert.equal(merged.modelCacheWrites['gpt-5'], 10);
  assert.equal(merged.modelOutputs['gpt-5'], 20);
  assert.equal(merged.modelUnclassifiedTokens['gpt-5'] || 0, 0);
  assert.equal(merged.capabilities.tokenComponents, true);
});

test('folded global period collisions preserve components, missing-price counts and throughput', () => {
  const normalized = normalizePeriod({
    capabilities: { tokenComponents: false, throughput: true }, totalTokens: 150,
    cacheReadTokens: 15, outputTokens: 30, unclassifiedTokens: 45, unpricedTokens: 15,
    timedTokens: 150, timedOutputTokens: 30, timedDurationMs: 1500,
    models: { 'openai/gpt-5': 100, 'gpt-5': 50 }, modelCosts: { 'openai/gpt-5': 1, 'gpt-5': 0.5 },
    modelCacheReads: { 'openai/gpt-5': 10, 'gpt-5': 5 }, modelOutputs: { 'openai/gpt-5': 20, 'gpt-5': 10 },
    modelUnclassifiedTokens: { 'openai/gpt-5': 30, 'gpt-5': 15 },
    modelUnpricedTokens: { 'openai/gpt-5': 10, 'gpt-5': 5 },
    modelThroughput: {
      'openai/gpt-5': { timedTokens: 100, timedOutputTokens: 20, timedDurationMs: 1000 },
      'gpt-5': { timedTokens: 50, timedOutputTokens: 10, timedDurationMs: 500 }
    }
  });
  for (const [key, expected] of Object.entries({
    models: 150, modelCosts: 1.5, modelCacheReads: 15, modelOutputs: 30,
    modelUnclassifiedTokens: 45, modelUnpricedTokens: 15
  })) assert.deepEqual(Object.entries(normalized[key]), [['gpt-5', expected]], key);
  assert.deepEqual(normalized.modelThroughput['gpt-5'], {
    timedTokens: 150, timedOutputTokens: 30, timedDurationMs: 1500
  });
  const legacy = normalizePeriod({
    capabilities: { tokenComponents: false }, totalTokens: 150,
    models: { 'openai/gpt-5': 100, 'gpt-5': 50 }
  });
  assert.equal(legacy.modelUnclassifiedTokens['gpt-5'], 150);
});
