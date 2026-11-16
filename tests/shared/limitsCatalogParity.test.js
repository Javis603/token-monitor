'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateLimits } = require('../../src/shared/limits/core');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');

// Cross-device account separation, including provider-specific lanes.
// Explicit entries ensure a newly catalogued provider needs a deliberate answer.
const expectedCounts = {
  claude: 2, codex: 2, opencode: 2, cursor: 2, antigravity: 2,
  cline: 2, factory: 2, kimi: 1, grok: 1, copilot: 2, zed: 1,
  commandcode: 1, mimo: 2, muse: 2, zai: 1, zaiteam: 1, kiro: 1,
  workbuddy: 2, qoder: 1, deepseek: 2, devin: 1, minimax: 2,
  mistral: 1, typesafe: 1, openrouter: 2, volcengine: 2, ollama: 1,
  trae: 1, alibaba: 2, stepfun: 1, notion: 2, manus: 2, hark: 2,
  opendesign: 2, thirdparty: 2
};

test('catalog aggregation matches the per-provider collapse table', () => {
  assert.deepEqual(Object.keys(expectedCounts).sort(), [...LIMIT_PROVIDER_IDS].sort());
  for (const provider of LIMIT_PROVIDER_IDS) {
    const devices = ['a', 'b'].map(deviceId => ({
      deviceId,
      limits: { providers: [{ provider, accountKey: `sha256:${deviceId}`, status: 'ok', source: 'api', windows: [] }] }
    }));
    assert.equal(aggregateLimits(devices, 0, 0).providers.length, expectedCounts[provider], provider);
  }
});
