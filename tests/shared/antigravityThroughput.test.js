'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractUsageBundleFromTokscale, extractUsageFromTokscale } = require('../../src/shared/usage');
const { tokenRatePerSecond, tokenBurnPerMinute, createLiveTokenRateTracker } = require('../../src/electron/renderer/tokenRatePresentation');

function generation(overrides = {}) {
  return {
    client: 'antigravity-extension', model: 'gemini-3-flash', sessionId: 'conversation',
    inputTokens: 50, outputTokens: 80, reasoningTokens: 40, cacheReadTokens: 20, cost: 0.01,
    performance: { totalDurationMs: 2_000, timedTokens: 190, tokenCoverage: 1 },
    ...overrides
  };
}

test('Antigravity native aliases feed existing speed with reasoning counted once', () => {
  for (const client of ['antigravity', 'antigravity-cli', 'antigravity-extension']) {
    const bundle = extractUsageBundleFromTokscale({ entries: [generation({ client })] });
    for (const period of [bundle.period, bundle.byClient.antigravity]) {
      assert.equal(period.totalTokens, 190);
      assert.equal(period.outputTokens, 120);
      assert.equal(period.timedOutputTokens, 120);
      assert.equal(period.timedTokens, 190);
      assert.equal(period.timedDurationMs, 2_000);
      assert.equal(tokenRatePerSecond(period), 60);
      assert.equal(tokenBurnPerMinute(period), 5_700);
      assert.equal(period.modelThroughput['gemini-3-flash'].timedOutputTokens, 120);
    }
  }
});

test('partial Antigravity timing preserves usage while withholding mismatched speed', () => {
  const period = extractUsageFromTokscale({ entries: [generation({
    inputTokens: 100, outputTokens: 160, reasoningTokens: 80, cacheReadTokens: 40
  })] });
  assert.equal(period.totalTokens, 380);
  assert.equal(period.outputTokens, 240);
  assert.equal(period.costUsd, 0.01);
  assert.equal(period.timedTokens, 0);
  assert.equal(period.timedOutputTokens, 0);
  assert.equal(period.timedDurationMs, 0);
  assert.equal(tokenRatePerSecond(period), 0);
  assert.equal(tokenBurnPerMinute(period), 0);
  const tracker = createLiveTokenRateTracker();
  assert.equal(tracker.observe(period), null);
  assert.equal(tracker.getSample(), null);
  assert.deepEqual(Object.keys(period.modelThroughput), []);
});

test('unavailable or overcovered Antigravity timing never changes token totals', () => {
  for (const performance of [undefined, { totalDurationMs: 0, timedTokens: 190 },
    { totalDurationMs: 2_000, timedTokens: 380 }, { totalDurationMs: 2_000 }]) {
    const period = extractUsageFromTokscale({ entries: [generation({ performance })] });
    assert.equal(period.totalTokens, 190);
    assert.equal(period.outputTokens, 120);
    assert.equal(period.timedTokens, 0);
    assert.equal(period.timedOutputTokens, 0);
    assert.equal(period.timedDurationMs, 0);
  }
});

test('Codex and Antigravity share the original combined rate and model breakdown', () => {
  const period = extractUsageFromTokscale({ entries: [generation({ model: 'shared-model' }), {
    client: 'codex', model: 'shared-model', inputTokens: 100, outputTokens: 100,
    performance: { totalDurationMs: 1_000, timedTokens: 200 }
  }] });
  assert.equal(period.timedOutputTokens, 220);
  assert.equal(period.timedDurationMs, 3_000);
  assert.equal(tokenRatePerSecond(period), 220 / 3);
  assert.equal(period.modelThroughput['shared-model'].timedOutputTokens, 220);
  assert.equal(period.modelThroughput['shared-model'].timedDurationMs, 3_000);
});

test('a native generation refresh reaches the existing live tracker and model hover', () => {
  const tracker = createLiveTokenRateTracker();
  const period = (multiplier) => extractUsageFromTokscale({ entries: [generation({
    inputTokens: 50 * multiplier, outputTokens: 80 * multiplier,
    reasoningTokens: 40 * multiplier, cacheReadTokens: 20 * multiplier,
    performance: { totalDurationMs: 2_000 * multiplier, timedTokens: 190 * multiplier }
  })] });
  assert.equal(tracker.observe(period(1)), null);
  const sample = tracker.observe(period(2));
  assert.equal(sample.speed, 60);
  assert.deepEqual(sample.models, [{ model: 'gemini-3-flash', speed: 60, burn: 5_700 }]);
});

test('partial Antigravity timing cannot inflate another client speed or burn', () => {
  const period = extractUsageFromTokscale({ entries: [generation({ outputTokens: 160 }), {
    client: 'codex', model: 'gpt-5', inputTokens: 100, outputTokens: 100,
    performance: { totalDurationMs: 1_000, timedTokens: 200 }
  }] });
  assert.equal(period.totalTokens, 470);
  assert.equal(period.outputTokens, 300);
  assert.equal(tokenRatePerSecond(period), 100);
  assert.equal(tokenBurnPerMinute(period), 12_000);
  assert.deepEqual(Object.keys(period.modelThroughput), ['gpt-5']);
});
