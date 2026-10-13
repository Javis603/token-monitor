'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractUsageFromTokscale, mergePeriods, applyPeriodDelta, normalizePeriod } = require('../../src/shared/usage');
const { createModelSpeedRuntime } = require('../../src/electron/modelSpeedRuntime');
const core = require('../../src/electron/modelSpeedHistory');
const { createLiveTokenRateTracker, tokenRatePerSecond } = require('../../src/electron/renderer/tokenRatePresentation');
const start = Math.floor(new Date(2026, 9, 9, 12).getTime() / core.FIVE_MINUTES) * core.FIVE_MINUTES;
const account = (letter) => ({ platform: 'observed-provider', accountId: `sha256:${letter.repeat(64)}`, accessType: 'api' });
function row(out = 200, timed = 100, ms = 1000, overrides = {}) {
  return { client: 'claude', model: 'shared-model', sessionId: 's1', input: 0, output: out,
    performance: { totalDurationMs: ms, timedTokens: timed, timedOutputTokens: timed, timedReasoningTokens: 0 },
    usageSource: account('a'), lastUsedAt: new Date(start).toISOString(), ...overrides };
}
const extract = (...entries) => extractUsageFromTokscale({ entries });
const catalog = (period) => Object.values(period.modelSourceThroughput);
function runtime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mixed-timing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let at = start;
  const instance = createModelSpeedRuntime({ directory, now: () => at });
  return { instance, observe(period) { instance.observe({ today: period, month: period, allTime: period }, { source: 'synthetic' }); at += 1000; },
    reload() { return createModelSpeedRuntime({ directory, now: () => at }); } };
}
test('mixed timing source numerator closes over measured output, while usage references retain all output', () => {
  const period = extract(row());
  assert.equal(period.outputTokens, 200);
  assert.equal(Object.values(period.modelUsageSources)[0].outputTokens, 200);
  assert.equal(catalog(period)[0].timedOutputTokens, 100);
  assert.equal(tokenRatePerSecond(catalog(period)[0]), 100);
  assert.deepEqual(normalizePeriod(period).modelSourceThroughput, period.modelSourceThroughput);
});
test('native partial source splits use the new measured bound and reject old whole-output allocations', () => {
  const partial = extract(row(200, 100, 1000, { usageSources: [
    { usageSource: account('b'), timedOutputTokens: 40, timedDurationMs: 400 }
  ] }));
  assert.deepEqual(catalog(partial).map(value => [value.accountId, value.timedOutputTokens, value.timedDurationMs]), [
    [account('b').accountId, 40, 400], [account('a').accountId, 60, 600]
  ]);
  for (const split of [{ timedOutputTokens: 200, timedDurationMs: 1000 }, { timedOutputTokens: 40, timedDurationMs: 1000 }]) {
    const invalid = extract(row(200, 100, 1000, { usageSources: [{ usageSource: account('b'), ...split }] }));
    assert.equal(catalog(invalid).length, 1);
    assert.equal(catalog(invalid)[0].accountId, account('a').accountId);
    assert.equal(catalog(invalid)[0].timedOutputTokens, 100);
  }
});
test('multiple sources of one model merge as raw measured sums, never as averages or borrowed clocks', () => {
  const merged = mergePeriods(extract(row()), extract(row(1000, 50, 2000, { usageSource: account('b'), sessionId: 's2' }),
    row(9000, 0, 0, { usageSource: account('c'), sessionId: 's3' })));
  assert.equal(merged.outputTokens, 10200);
  assert.equal(merged.timedOutputTokens, 150);
  assert.equal(merged.timedDurationMs, 3000);
  assert.equal(tokenRatePerSecond(merged.modelThroughput['shared-model']), 50);
  assert.equal(catalog(merged).length, 2);
  assert.equal(Object.values(merged.modelUsageSources).length, 3);
  assert.equal(catalog(merged).reduce((n, value) => n + value.timedOutputTokens, 0), 150);
});
test('weighted TPS, every period, list and sole-source history retain only new timed output across restart', t => {
  const fixture = runtime(t);
  fixture.observe(extract(row()));
  fixture.observe(extract(row(400, 200, 2000)));
  fixture.observe(extract(row(1000, 300, 6000)));
  const reloaded = fixture.reload();
  const before = reloaded.list().models[0];
  assert.equal(before.todayTokens, 0, 'candidates are memory-only after restart');
  for (const period of ['today', 'week', 'last7', 'month', 'last30', 'allTime']) {
    const detail = reloaded.detail(before.id, { period });
    assert.equal(detail.weightedTps, 40, period);
    assert.equal(detail.sources.find(value => value.accessType === 'api').weightedTps, 40, period);
    assert.equal(detail.samples, 2, period);
    assert.equal(reloaded.list({ period }).models[0].weightedTps, 40, period);
  }
  fixture.observe(extract(row(1000, 300, 6000)));
  assert.equal(fixture.instance.detail(before.id).samples, 2);
});
test('untimed append changes usage rank evidence but no history sample, period timing or live TPS', t => {
  const fixture = runtime(t), tracker = createLiveTokenRateTracker();
  const first = extract(row()), second = extract(row(500, 100, 1000));
  fixture.observe(first); tracker.observe(first);
  fixture.observe(second);
  assert.equal(tracker.observe(second), null);
  const item = fixture.instance.list().models[0];
  assert.equal(item.todayTokens, 500);
  assert.equal(item.samples, 0);
  assert.equal(item.lastTps, 100);
  const month = applyPeriodDelta(first, second, first);
  assert.equal(month.outputTokens, 500);
  assert.equal(month.timedOutputTokens, 100);
  assert.equal(catalog(month)[0].timedOutputTokens, 100);
});
test('mixed-account history leaves source speed unattributed rather than guessing an owner', t => {
  const fixture = runtime(t);
  const period = (n) => extract(row(200 * n, 100 * n, 1000 * n), row(1000 * n, 50 * n, 2000 * n, { usageSource: account('b'), sessionId: 's2' }));
  fixture.observe(period(1)); fixture.observe(period(2));
  const item = fixture.instance.list().models[0], detail = fixture.instance.detail(item.id);
  assert.equal(detail.weightedTps, 50);
  const measured = detail.sources.filter(value => value.weightedTps !== null);
  assert.equal(measured.length, 1);
  assert.equal(measured[0].id, 'unattributed');
  assert.equal(measured[0].timedOutputTokens, 150);
  assert.ok(detail.sources.filter(value => value.id !== 'unattributed').every(value => value.referenceOnly));
});
test('legacy binaries keep their approximation without inventing exact measured subtotals', t => {
  const fixture = runtime(t);
  const period = extract(row(200, 100, 1000, { performance: { totalDurationMs: 1000, timedTokens: 100 } }));
  fixture.observe(period);
  assert.equal(fixture.instance.list().models[0].lastTps, 200);
  assert.equal(catalog(period)[0].timedOutputTokens, 200);
});
test('counter corrections discard pending old-basis output before high-water recovery', () => {
  const source = 'a'.repeat(64), day = '2026-10-09';
  const observe = (state, out, ms, at) => {
    const period = { modelThroughput: { x: { timedOutputTokens: out, timedDurationMs: ms } } };
    return core.ingest(state, { source, day, at, allTime: period, today: period }).state;
  };
  let state = observe(core.fresh(), 200, 1000, start);
  state = observe(state, 230, 1100, start + 1000);
  assert.equal(state.series[`${source}:x`].pending.out, 30);
  state = observe(state, 100, 1100, start + 2000);
  assert.deepEqual(state.series[`${source}:x`].pending, { out: 0, ms: 0 });
  state = core.normalize(JSON.parse(JSON.stringify(state))).state;
  state = observe(state, 300, 2100, start + 3000);
  assert.equal(core.project(state, start + 3000)[0].lastTps, 70);
});
