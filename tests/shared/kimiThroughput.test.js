'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractUsageBundleFromTokscale } = require('../../src/shared/usage');
const { tokenRatePerSecond, createLiveTokenRateTracker } = require('../../src/electron/renderer/tokenRatePresentation');

function kimi(overrides = {}) {
  return {
    client: 'kimi', model: 'kimi-for-coding', sessionId: 'synthetic-kimi-session',
    input: 100, output: 60, cacheRead: 20, cacheWrite: 0, reasoning: 0,
    performance: { totalDurationMs: 1500, timedTokens: 180, timedOutputTokens: 60,
      timedReasoningTokens: 0, sampleCount: 1, tokenCoverage: 1 },
    ...overrides
  };
}

test('Kimi native whole-response timing feeds period, client, session and model speed', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [kimi()] });
  for (const period of [bundle.period, bundle.byClient.kimi]) {
    assert.equal(period.totalTokens, 180);
    assert.equal(period.outputTokens, 60);
    assert.equal(period.timedOutputTokens, 60);
    assert.equal(period.timedDurationMs, 1500);
    assert.equal(tokenRatePerSecond(period), 40);
    assert.equal(tokenRatePerSecond(period.sessions['kimi:synthetic-kimi-session']), 40);
    assert.equal(tokenRatePerSecond(period.modelThroughput['kimi-for-coding']), 40);
  }
});

test('untimed Kimi rows keep their usage without inflating a timed generation rate', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [
    kimi(),
    kimi({ sessionId: 'untimed', output: 600, performance: {
      totalDurationMs: 0, timedTokens: 0, timedOutputTokens: 0, sampleCount: 0, tokenCoverage: 0
    } })
  ] });
  assert.equal(bundle.period.outputTokens, 660);
  assert.equal(bundle.period.timedOutputTokens, 60);
  assert.equal(bundle.period.timedDurationMs, 1500);
  assert.equal(tokenRatePerSecond(bundle.period), 40);
});

test('legacy and native Kimi generations share timing and count reasoning inside output once', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [
    kimi({ performance: { totalDurationMs: 3000, timedTokens: 180, sampleCount: 1, tokenCoverage: 1 } }),
    kimi()
  ] });
  assert.equal(bundle.period.outputTokens, 120);
  assert.equal(bundle.period.timedOutputTokens, 120);
  assert.equal(bundle.period.timedDurationMs, 4500);
  assert.equal(tokenRatePerSecond(bundle.period), 120 / 4.5);
});

test('a native Kimi completion reaches the existing live tracker', () => {
  const tracker = createLiveTokenRateTracker();
  const snapshot = (n) => extractUsageBundleFromTokscale({ entries: [kimi({
    input: 100 * n, output: 60 * n, cacheRead: 20 * n,
    performance: { totalDurationMs: 1500 * n, timedTokens: 180 * n,
      timedOutputTokens: 60 * n, timedReasoningTokens: 0, sampleCount: n, tokenCoverage: 1 }
  })] }).period;
  assert.equal(tracker.observe(snapshot(1)), null);
  const sample = tracker.observe(snapshot(2));
  assert.equal(sample.speed, 40);
  assert.equal(sample.timedOutputTokens, 60);
  assert.equal(sample.timedDurationMs, 1500);
  assert.deepEqual(sample.models, [{ model: 'kimi-for-coding', speed: 40, burn: 7200 }]);
});
