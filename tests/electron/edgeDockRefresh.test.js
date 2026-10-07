'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createDeviceRuntime } = require('../../src/shared/usage/deviceRuntime');

// Exercise the actual main-process action without booting Electron or collectors.
const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const actionSource = main.slice(main.indexOf('async function refreshLimitsFromEdgeDock('), main.indexOf('function edgeDockCellsFor('));
function refreshAction(runtime) {
  return Function('canRefreshEdgeDockLimits', 'deviceRuntimeHandle', 'settings', 'parseLimitProviders', 'defaultLimitProviders',
    `return (${actionSource.trim()})`)(() => true, runtime, { limitProviders: ['claude', 'kimi'] }, (providers) => providers, () => []);
}

function clock() {
  let now = 1_000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    }
  };
}

function row(provider, status = 'ok') {
  return { provider, accountKey: 'account', source: 'api', status, windows: [] };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function runtimeFor(timer, probeProvider) {
  return createDeviceRuntime({ limitsOptions: { limitProviders: ['claude', 'kimi'], limitsRefreshMs: 60_000 } }, {
    createUsageRuntime: () => ({ stop() {} }),
    limitsDeps: {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      providerPhysicalBoundMs: () => 10_000,
      cleanupGraceMs: 0,
      maxConcurrency: 2,
      probeProvider
    }
  });
}

test('Edge Dock full manual refresh postpones a nearly due interval without duplicating or superseding probes', async (t) => {
  const timer = clock();
  const calls = [];
  let finish;
  let signal;
  const runtime = runtimeFor(timer, (provider, _config, context) => {
    calls.push([provider, context.reason]);
    if (provider === 'kimi' && context.reason === 'manual') {
      signal = context.signal;
      return new Promise((resolve) => { finish = resolve; });
    }
    return Promise.resolve([row(provider)]);
  });
  t.after(() => runtime.stop());
  await settle();
  calls.length = 0;
  timer.advance(59_900);
  const manual = refreshAction(runtime)();
  await settle();
  assert.equal(typeof finish, 'function');
  timer.advance(100);
  await settle();
  assert.equal(signal.aborted, false, 'the old interval must not cancel the manual request');
  assert.deepEqual(calls, [['claude', 'manual'], ['kimi', 'manual']]);
  finish([row('kimi')]);
  assert.deepEqual(await manual, { ok: true });
  timer.advance(59_899);
  await settle();
  assert.equal(calls.length, 2, 'next interval is anchored to the manual refresh');
  timer.advance(1);
  await settle();
  assert.deepEqual(calls, [['claude', 'manual'], ['kimi', 'manual'], ['claude', 'interval'], ['kimi', 'interval']]);
});

test('Edge Dock full refresh retains provider backoff and reports a deferred lane', async (t) => {
  const timer = clock();
  const calls = [];
  const runtime = runtimeFor(timer, async (provider, _config, context) => {
    calls.push([provider, context.reason]);
    if (provider === 'kimi') {
      context.onRetryAfter(30_000);
      return [row(provider, 'sourceRateLimited')];
    }
    return [row(provider)];
  });
  t.after(() => runtime.stop());
  await settle();
  calls.length = 0;
  assert.deepEqual(await refreshAction(runtime)(), { ok: false });
  assert.deepEqual(calls, [['claude', 'manual']], 'manual refresh must not bypass provider backoff');
});

test('Edge Dock full refresh reports a failed provider probe', async (t) => {
  const runtime = runtimeFor(clock(), async (provider, _config, context) => {
    if (provider === 'kimi' && context.reason === 'manual') throw new Error('offline');
    return [row(provider)];
  });
  t.after(() => runtime.stop());
  await settle();
  assert.deepEqual(await refreshAction(runtime)(), { ok: false });
});

for (const addedStatus of ['unavailable', 'sourceRateLimited', 'ok', 'notConfigured']) {
  test(`Edge Dock checks a provider added mid-refresh with status ${addedStatus}`, async (t) => {
    let finish;
    let response;
    const calls = [];
    const runtime = runtimeFor(clock(), async (provider, _config, context) => {
      calls.push([provider, context.reason]);
      if (provider === 'kimi' && context.reason === 'manual') {
        return new Promise((resolve) => { finish = resolve; });
      }
      return [row(provider, provider === 'cursor' ? addedStatus : 'ok')];
    });
    t.after(() => runtime.stop());
    await settle();
    calls.length = 0;
    const manual = refreshAction({
      async refreshLimits(...args) {
        response = await runtime.refreshLimits(...args);
        return response;
      }
    })();
    await settle();
    assert.equal(typeof finish, 'function');
    runtime.reconfigureLimits({ limitProviders: ['claude', 'kimi', 'cursor'] });
    await settle();
    assert.deepEqual(calls, [['claude', 'manual'], ['kimi', 'manual'], ['cursor', 'provider-added']]);
    finish([row('kimi')]);
    const result = await manual;
    assert.deepEqual(response.results.map((entry) => entry.provider), ['claude', 'kimi']);
    assert.equal(response.results.some((entry) => entry.superseded || entry.deferred || entry.error), false);
    assert.equal(response.snapshot.providers.find((entry) => entry.provider === 'cursor').status, addedStatus);
    assert.deepEqual(result, { ok: ['ok', 'notConfigured'].includes(addedStatus) });
  });
}
