'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTokscaleModelNameForClient } = require('../../src/shared/history');

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
