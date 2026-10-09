'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractUsageFromTokscale, extractUsageBundleFromTokscale, normalizeDeviceRecord, aggregateDevices, applyPeriodDelta } = require('../../src/shared/usage');
const { syncPayload } = require('../../src/shared/syncPayload');
const { tokenRatePerSecond, createLiveTokenRateTracker } = require('../../src/electron/renderer/tokenRatePresentation');

function row(overrides = {}) {
  return {
    client: 'claude', model: 'shared-model', sessionId: 's1',
    input: 0, output: 200, cacheRead: 0, cost: 0.25,
    performance: { totalDurationMs: 1_000, timedTokens: 100, timedOutputTokens: 100, timedReasoningTokens: 0, tokenCoverage: 0.5 },
    ...overrides
  };
}
const extract = (entry) => extractUsageFromTokscale({ entries: [entry] });

test('mixed timed and untimed output uses the same messages for period, session and model TPS', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [row()] });
  for (const period of [bundle.period, bundle.byClient.claude]) {
    assert.equal(period.totalTokens, 200);
    assert.equal(period.outputTokens, 200);
    assert.equal(period.costUsd, 0.25);
    assert.equal(period.timedOutputTokens, 100);
    assert.equal(tokenRatePerSecond(period), 100);
    assert.equal(tokenRatePerSecond(period.sessions['claude:s1']), 100);
    assert.equal(tokenRatePerSecond(period.modelThroughput['shared-model']), 100);
  }
  const record = normalizeDeviceRecord({ deviceId: 'd1', collectedAt: new Date().toISOString(), periods: { today: bundle.period } });
  const wire = syncPayload(record);
  const merged = aggregateDevices([wire, { ...wire, deviceId: 'd2' }]).periods.today;
  assert.equal(merged.outputTokens, 400);
  assert.equal(merged.timedOutputTokens, 200);
  assert.equal(merged.timedDurationMs, 2_000);
  assert.equal(tokenRatePerSecond(merged), 100);
  assert.equal(tokenRatePerSecond(merged.sessions['claude:s1']), 100);
  assert.equal(tokenRatePerSecond(merged.modelThroughput['shared-model']), 100);
});

test('tokenCoverage cannot discount or infer output when cache/input coverage differs', () => {
  const period = extract(row({ output: 1_000, cacheRead: 99_000,
    performance: { totalDurationMs: 20_000, timedTokens: 92_650, timedOutputTokens: 100, timedReasoningTokens: 0, tokenCoverage: 0.9265 }
  }));
  assert.equal(period.timedOutputTokens, 100);
  assert.equal(tokenRatePerSecond(period), 5);
});

test('explicit zero, aliases and malformed new subtotals do not fall back to whole-row output', () => {
  for (const fields of [
    { timedOutputTokens: 0 }, { timed_output_tokens: 0 },
    { timedOutputTokens: 0, timed_output_tokens: 100 },
    { timedOutputTokens: null }, { timedOutputTokens: -10 }, { timedOutputTokens: 'invalid' }
  ]) {
    const period = extract(row({ performance: { totalDurationMs: 1_000, timedTokens: 10, ...fields } }));
    assert.equal(period.timedOutputTokens, 0);
    assert.equal(period.sessions['claude:s1'].timedOutputTokens, 0);
  }
  assert.equal(extract(row({ performance: { total_duration_ms: 1_000, timed_output_tokens: 100 } })).timedOutputTokens, 100);
  assert.equal(extract(row({ performance: { totalDurationMs: 0, timedOutputTokens: 100 } })).timedOutputTokens, 0);
  assert.equal(extract(row({ performance: { totalDurationMs: 1_000, timedOutputTokens: 999 } })).timedOutputTokens, 200);
  assert.equal(extract(row({ performance: { totalDurationMs: 1_000, timedTokens: 100 } })).timedOutputTokens, 200, 'legacy binary compatibility');
});

test('only timed reasoning is folded into the generated output bucket, once per disjoint client', () => {
  for (const client of ['antigravity', 'antigravity-cli', 'antigravity-extension', 'codex', 'opencode', 'claude']) {
    const period = extract(row({ client, reasoning: 80,
      performance: { totalDurationMs: 1_000, timedTokens: 120, timedOutputTokens: 100, timedReasoningTokens: 20 }
    }));
    const disjoint = client !== 'claude';
    assert.equal(period.outputTokens, disjoint ? 280 : 200);
    assert.equal(period.timedOutputTokens, disjoint ? 120 : 100);
    const session = Object.values(period.sessions)[0];
    assert.equal(session.timedOutputTokens, period.timedOutputTokens);
    assert.equal(tokenRatePerSecond(period.modelThroughput['shared-model']), disjoint ? 120 : 100);
  }
});

test('untimed output append preserves cumulative timing and does not contaminate another client live rate', () => {
  const tracker = createLiveTokenRateTracker();
  const snapshot = (fresh) => extractUsageFromTokscale({ entries: [
    row({ output: fresh ? 300 : 200 }),
    row({ client: 'codex', model: 'gpt-5', output: fresh ? 220 : 100,
      performance: { totalDurationMs: fresh ? 5_000 : 1_000, timedTokens: fresh ? 420 : 200,
        timedOutputTokens: fresh ? 220 : 100, timedReasoningTokens: 0 }
    })
  ] });
  const before = snapshot(false);
  const after = snapshot(true);
  assert.equal(after.outputTokens - before.outputTokens, 220);
  assert.equal(after.timedOutputTokens - before.timedOutputTokens, 120);
  assert.equal(tracker.observe(before), null);
  const sample = tracker.observe(after);
  assert.equal(sample.speed, 30);
  assert.equal(sample.timedOutputTokens, 120);
  assert.deepEqual(sample.models, [{ model: 'gpt-5', speed: 30, burn: 3_300 }]);
  const month = applyPeriodDelta(before, after, before);
  assert.equal(month.timedOutputTokens, after.timedOutputTokens);
  assert.equal(month.sessions['claude:s1'].timedOutputTokens, 100);
  assert.deepEqual(month.modelThroughput, after.modelThroughput);
});

test('a later timed generation counts only its output after an untimed-only baseline', () => {
  const before = extract(row({ performance: { totalDurationMs: 0, timedTokens: 0, timedOutputTokens: 0, timedReasoningTokens: 0 } }));
  const after = extract(row({ output: 300 }));
  const tracker = createLiveTokenRateTracker();
  assert.equal(tracker.observe(before), null);
  assert.equal(tracker.observe(after).speed, 100);
  assert.equal(after.outputTokens, 300);
  assert.equal(after.timedOutputTokens, 100);
});
