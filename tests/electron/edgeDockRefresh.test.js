'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runManualDeviceRefresh } = require('../../src/electron/deviceRuntimeCoordinator');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const refreshSource = main.slice(main.indexOf('let manualStatsRefreshInFlight ='), main.indexOf('function managedPricingSidecarPath('));
const dockSource = main.slice(main.indexOf('function canRefreshEdgeDockStats('), main.indexOf('function edgeDockCellsFor('));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const usage = deferred();
  const limits = deferred();
  const calls = [];
  const context = {
    deviceRuntimeHandle: {
      refreshLimits: (...args) => { calls.push(['limits', ...args]); return limits.promise; },
      tick: (...args) => { calls.push(['usage', ...args]); return usage.promise; }
    },
    hubModeGeneration: 1,
    settings: { hubMode: 'local', limitsEnabled: false, limitProviders: [] },
    mode: 'local',
    localStats: { updatedAt: '2026-10-07T00:00:00Z' },
    currentHubStatsIdentity: () => 'local',
    ownsUsageRuntime: () => Boolean(context.deviceRuntimeHandle),
    runManualDeviceRefresh,
    console: { log() {} }
  };
  vm.runInNewContext(`${refreshSource}\n${dockSource}`, context);
  return { context, usage, limits, calls };
}

for (const first of ['App', 'Edge Dock']) {
  test(`${first} and the other refresh button share the existing App refresh`, async () => {
    const { context, usage, limits, calls } = fixture();
    let completed = false;
    const app = () => context.refreshManualStats();
    const dock = () => context.refreshStatsFromEdgeDock();
    const requests = first === 'App' ? [app(), dock()] : [dock(), app()];
    const both = Promise.all(requests).then((values) => { completed = true; return values; });
    assert.equal(JSON.stringify(calls), JSON.stringify([
      ['limits', { all: true }, 'manual'],
      ['usage', 'manual', { forceHistory: true, forceSelfSync: true }]
    ]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    usage.resolve(true);
    const values = await both;
    assert.equal(completed, true, 'background limits must not hold either button open');
    assert.equal(JSON.stringify(values[first === 'App' ? 1 : 0]), JSON.stringify({ ok: true }));
    assert.equal(values[first === 'App' ? 0 : 1], context.localStats);
    limits.reject(new Error('background quota failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'each producer was dispatched only once');
  });
}

test('a rejected shared refresh releases both callers and permits retry', async () => {
  const { context, usage, limits, calls } = fixture();
  const error = new Error('usage transport failed');
  const observed = Promise.allSettled([context.refreshManualStats(), context.refreshStatsFromEdgeDock()]);
  usage.reject(error);
  const results = await observed;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason === error));
  context.deviceRuntimeHandle.tick = async () => true;
  await context.refreshManualStats();
  assert.equal(calls.filter(([source]) => source === 'limits').length, 2);
  limits.resolve();
});

test('runtime or mode replacement does not join an obsolete refresh', async () => {
  const { context, usage, limits } = fixture();
  const old = context.refreshManualStats();
  const nextUsage = deferred();
  let ticks = 0;
  context.hubModeGeneration += 1;
  context.deviceRuntimeHandle = {
    refreshLimits: async () => {},
    tick: () => { ticks += 1; return nextUsage.promise; }
  };
  const next = context.refreshManualStats();
  assert.notEqual(old, next);
  usage.resolve(true);
  await old;
  assert.equal(context.refreshManualStats(), next, 'old cleanup must not clear the new request');
  assert.equal(ticks, 1);
  nextUsage.resolve(true);
  await next;
  limits.resolve();
});

test('Edge Dock needs a local runtime but does not require limits to be enabled', async () => {
  const { context, usage, limits } = fixture();
  assert.equal(context.canRefreshEdgeDockStats(), true);
  usage.resolve(true);
  assert.equal(JSON.stringify(await context.refreshStatsFromEdgeDock()), JSON.stringify({ ok: true }));
  limits.resolve();
  context.deviceRuntimeHandle = null;
  assert.equal(context.canRefreshEdgeDockStats(), false);
  assert.equal((await context.refreshStatsFromEdgeDock()).ok, false);
});

test('App manual-button IPC uses the shared entry; other stats reads retain their options', () => {
  assert.match(main, /options\?\.force === true && options\?\.feedback === true \? refreshManualStats\(\) : fetchStats\(options\)/);
});
