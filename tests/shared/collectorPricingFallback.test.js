'use strict';

// The bundled first-party rates must reach every path that turns tokscale
// output into usage — full scans, anchored watch ticks, WSL and the history
// graph — and must defer to a price the user wrote to tokscale's
// custom-pricing.json.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installInProcessWatchHost(test);

const {
  collectHistoryOnce,
  collectUsageOnce,
  customPricedModelIds,
  localTodayKey,
  resetCustomPricedModelIdsCache,
  resetPricingFallbackLog
} = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

const FABLE_COST = 2.6361165;

function fableEntry(overrides = {}) {
  return {
    client: 'claude',
    sessionId: 's1',
    model: 'claude-fable-5-1',
    provider: 'anthropic',
    input: 1091,
    output: 10877,
    cacheRead: 1596926,
    cacheWrite: 134570,
    reasoning: 0,
    messageCount: 13,
    cost: 0,
    ...overrides
  };
}

const baseOptions = {
  clients: 'claude',
  allTimeSince: '2025-01-01',
  commandTimeoutMs: 1000,
  deviceId: 'pricing-fallback',
  limitsEnabled: false
};

// Point tokscale's config dir at a scratch directory so the test neither reads
// nor depends on the developer's real custom-pricing.json.
function isolatedTokscaleConfig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokscale-pricing-fallback-'));
  const previous = process.env.TOKSCALE_CONFIG_DIR;
  process.env.TOKSCALE_CONFIG_DIR = dir;
  resetCustomPricedModelIdsCache();
  resetPricingFallbackLog();
  t.after(() => {
    if (previous === undefined) delete process.env.TOKSCALE_CONFIG_DIR;
    else process.env.TOKSCALE_CONFIG_DIR = previous;
    resetCustomPricedModelIdsCache();
    resetPricingFallbackLog();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeCustomPricing(dir, models) {
  fs.writeFileSync(path.join(dir, 'custom-pricing.json'), JSON.stringify({ models }));
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be within 1e-9 of ${expected}`);
}

test('a full scan prices an unpriced first-party row in today, month and allTime', async (t) => {
  isolatedTokscaleConfig(t);
  const logs = [];
  const summary = await collectUsageOnce({
    ...baseOptions,
    runTokscale: async () => ({ entries: [fableEntry()], totalCost: 0 }),
    logger: (message) => logs.push(message)
  });
  for (const period of [summary.today, summary.month, summary.allTime]) {
    near(period.costUsd, FABLE_COST);
    near(period.modelCosts['claude-fable-5-1'], FABLE_COST);
    near(period.clientCosts.claude, FABLE_COST);
    near(period.sessions['claude:s1'].costUsd, FABLE_COST);
    assert.equal(period.totalTokens, 1091 + 10877 + 1596926 + 134570);
  }
  // Three scans, one line: the fallback logs each model once per process.
  assert.equal(logs.filter((line) => line.includes('claude-fable-5-1')).length, 1);
});

test('rows tokscale already priced keep tokscale\'s cost', async (t) => {
  isolatedTokscaleConfig(t);
  const summary = await collectUsageOnce({
    ...baseOptions,
    runTokscale: async () => ({ entries: [fableEntry({ cost: 4.25 })], totalCost: 4.25 })
  });
  assert.equal(summary.today.costUsd, 4.25);
  assert.equal(summary.today.modelCosts['claude-fable-5-1'], 4.25);
});

test('a model priced in custom-pricing.json is left to tokscale, so an explicit $0 stays free', async (t) => {
  const dir = isolatedTokscaleConfig(t);
  writeCustomPricing(dir, { 'claude-fable-5-1': { input_cost_per_million_tokens: 0, output_cost_per_million_tokens: 0 } });
  const summary = await collectUsageOnce({
    ...baseOptions,
    runTokscale: async () => ({ entries: [fableEntry()], totalCost: 0 })
  });
  assert.equal(summary.today.costUsd, 0);
  assert.equal(summary.today.totalTokens, 1091 + 10877 + 1596926 + 134570);
});

test('custom-pricing.json is re-read when it changes and ignored when malformed', async (t) => {
  const dir = isolatedTokscaleConfig(t);
  assert.deepEqual([...customPricedModelIds()], []);

  // Keys are lowercased and otherwise kept verbatim, which is how tokscale matches them.
  writeCustomPricing(dir, { 'Claude-Fable-5-1[1m]': { input_cost_per_million_tokens: 1 } });
  const first = customPricedModelIds();
  assert.deepEqual([...first], ['claude-fable-5-1[1m]']);
  assert.equal(customPricedModelIds(), first);

  // Same size, later mtime: still picked up.
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeCustomPricing(dir, { 'claude-opus-5-1': { input_cost_per_million_tokens: 1 } });
  assert.deepEqual([...customPricedModelIds()], ['claude-opus-5-1']);

  fs.writeFileSync(path.join(dir, 'custom-pricing.json'), 'not json {');
  assert.deepEqual([...customPricedModelIds()], []);

  fs.rmSync(path.join(dir, 'custom-pricing.json'));
  assert.deepEqual([...customPricedModelIds()], []);
});

test('the WSL scan borrows the wrapped runner and prices its rows the same way', async (t) => {
  isolatedTokscaleConfig(t);
  let wslRunTokscale = null;
  await collectUsageOnce({
    ...baseOptions,
    platform: 'win32',
    runTokscale: async () => ({ entries: [fableEntry()], totalCost: 0 }),
    collectWslUsage: async (options) => {
      wslRunTokscale = options.runTokscale;
      return { bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] };
    }
  });
  assert.equal(typeof wslRunTokscale, 'function');
  const scanned = await wslRunTokscale({ clients: 'claude', flags: ['--today', '--home', '\\\\wsl$\\Ubuntu\\home\\u'], commandTimeoutMs: 1000 });
  near(scanned.entries[0].cost, FABLE_COST);
  near(scanned.totalCost, FABLE_COST);
});

test('an anchored watch tick prices the --today scan the same way', async (t) => {
  isolatedTokscaleConfig(t);
  const anchor = { dateKey: localTodayKey(), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  const summary = await collectUsageOnce({
    ...baseOptions,
    todayOnlyAnchor: anchor,
    runTokscale: async ({ flags }) => {
      assert.deepEqual(flags, ['--today']);
      return { entries: [fableEntry()], totalCost: 0 };
    }
  });
  near(summary.today.costUsd, FABLE_COST);
  near(summary.month.costUsd, FABLE_COST);
  near(summary.allTime.costUsd, FABLE_COST);
});

test('the history graph prices the same day and model', async (t) => {
  isolatedTokscaleConfig(t);
  const history = await collectHistoryOnce({
    clients: 'claude',
    todayKey: '2026-09-01',
    runGraph: async () => ({
      contributions: [{
        date: '2026-09-01',
        totals: { tokens: 1743464, cost: 0, messages: 13 },
        clients: [{
          client: 'claude',
          modelId: 'claude-fable-5-1',
          providerId: 'anthropic',
          tokens: { input: 1091, output: 10877, cacheRead: 1596926, cacheWrite: 134570, reasoning: 0 },
          cost: 0,
          messages: 13
        }]
      }]
    })
  });
  assert.equal(history.daily.length, 1);
  near(history.daily[0].cost, FABLE_COST);
  near(history.daily[0].perModel['claude-fable-5-1'].cost, FABLE_COST);
  near(history.summary.totalCost, FABLE_COST);
});
