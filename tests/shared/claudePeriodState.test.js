'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { emptyPeriod, mergePeriods } = require('../../src/shared/usage');
const { reconcileClaudePeriodState, acceptedClaudeWindows } = require('../../src/shared/usage/claudePeriodState');
const names = ['today', 'month', 'allTime'];
const period = (client, totalTokens) => ({ ...emptyPeriod(), totalTokens, clients: { [client]: totalTokens } });
function capture(tokens) {
  const claude = period('claude', tokens), gemini = period('gemini', 7);
  const partitions = Object.fromEntries(names.map(name => [name, { claude, gemini }]));
  return { periods: Object.fromEntries(names.map(name => [name, mergePeriods(claude, gemini)])),
    partitions, todayPartitions: partitions.today,
    sources: { today: { exact: true }, month: { exact: true }, allTime: { exact: true } },
    identityState: Object.fromEntries(names.map(name => [name, { capturedAt: '2026-10-13T06:00:00Z', events: [] }])) };
}
const options = { enabled: true, complete: source => source?.exact === true, includeHistory: false,
  todayKey: '2026-10-13', timeZone: 'UTC', identityFingerprint: 'config', projectsEnabled: false,
  supplementalPeriods: () => emptyPeriod() };

test('period retention preserves valid counters that have no portable identity claims', () => {
  // Valid native usage need not have an admitted message identity. Rebuilding
  // counters only from the optional proof would lose these accepted readings.
  const first = capture(100);
  const accepted = reconcileClaudePeriodState({ ...first.periods }, first, options);
  assert.equal(accepted.snapshot.periods.allTime.totalTokens, 100);
  assert.equal(accepted.snapshot.identityState.allTime.events.length, 0);
  const next = capture(20);
  next.sources.today.exact = false;
  const summary = { ...next.periods };
  const retained = acceptedClaudeWindows(accepted.snapshot, options);
  const result = reconcileClaudePeriodState(summary, next, { ...options, previous: accepted.snapshot, retained });
  assert.equal(result.readFailed, true);
  assert.strictEqual(result.snapshot, accepted.snapshot);
  for (const name of names) {
    assert.equal(summary[name].totalTokens, 107);
    assert.equal(summary[name].clients.gemini, 7);
  }
});

test('a complete History graph cannot certify an incomplete native period capture', () => {
  const first = capture(100);
  const accepted = reconcileClaudePeriodState({ ...first.periods }, first, options);
  const next = capture(10);
  next.sources.month.exact = false;
  next.historyGraph = { sourceUsage: { exact: true, fullHistory: true }, contributions: [] };
  const summary = { ...next.periods };
  const result = reconcileClaudePeriodState(summary, next, { ...options, includeHistory: true,
    previous: accepted.snapshot, retained: acceptedClaudeWindows(accepted.snapshot, options) });
  assert.equal(result.readFailed, true);
  assert.equal(summary.month.clients.claude, 100);
});
