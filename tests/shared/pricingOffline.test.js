'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

test('resident period/history scans and model lookups explicitly prohibit pricing network requests', async t => {
  const childProcess = require('node:child_process');
  const calls = [];
  t.mock.method(childProcess, 'spawn', (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ entries: [], contributions: [], pricing: { inputCostPerToken: 1 } }));
      child.emit('close', 0);
    });
    return child;
  });
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const { startCollector, lookupModelPricing } = require(collectorPath);
  t.after(() => { delete require.cache[collectorPath]; });
  const handle = startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', commandTimeoutMs: 1000,
    deviceId: 'pricing-offline-proof', historyEnabled: true, dailyHistoryArchiveEnabled: false,
    projectsEnabled: false, wslScanEnabled: false, watchEnabled: false,
    anchorPersistenceEnabled: false,
    // Keep the background catalog lane separate from the subprocess assertions.
    refreshPricingCatalog: async () => {},
    pricingCatalogTimers: { setTimeout: () => 1, clearTimeout() {} }
  });
  t.after(() => handle.stop());
  await handle.whenIdle();
  const fullCalls = calls.slice();
  const watchStart = calls.length;
  await handle.tick('watch:test', { todayOnly: true });
  const watchCalls = calls.slice(watchStart);
  const pricingStart = calls.length;
  await lookupModelPricing('gpt-5', 1500);
  const pricingCalls = calls.slice(pricingStart);
  const reads = calls.filter(args => args.includes('--json') || args.includes('graph'));
  assert.ok(reads.length >= 6, 'three periods, history, watch and pricing were exercised');
  assert.ok(reads.every(args => args.includes('--offline')), JSON.stringify(reads));
  for (const flag of ['--today', '--month', '--since', 'graph']) {
    assert.ok(fullCalls.some(args => args.includes(flag)), `initial collection includes ${flag}`);
  }
  assert.ok(watchCalls.some(args => args.includes('--today')), 'watch tick scans today');
  assert.ok(pricingCalls.some(args => args.includes('pricing')), 'model pricing lookup runs');
});
