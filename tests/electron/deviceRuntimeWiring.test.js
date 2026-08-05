'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  canRefreshUsageRuntime,
  drainPendingUsageClientRefreshes,
  runLimitInvalidation,
  runManualDeviceRefresh,
  settingsLimitInvalidationPlan
} = require('../../src/electron/deviceRuntimeCoordinator');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('targeted rescans stay strict while Cursor credential refresh is best effort', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  assert.match(main, /if \(!client \|\| !ownsUsageRuntime\(\)\) return false/);
  assert.match(main, /return await refreshUsageClient\(client, \{ forceSync: true \}\) === true/);
  assert.equal(
    (main.match(/bestEffortTrackedUsageRefresh\('cursor', \{ forceSync: true \}\)/g) || []).length,
    2
  );
  assert.match(main, /function bestEffortTrackedUsageRefresh[\s\S]*if \(!tracked\.has\(client\)\) return/);
});

for (const mode of ['local', 'client', 'host']) {
  test(`${mode} manual refresh awaits usage but never waits for limits`, async () => {
    const usage = deferred();
    const limits = deferred();
    const calls = [];
    const runtime = {
      refreshLimits(scope, reason) {
        calls.push(['limits', scope, reason]);
        return limits.promise;
      },
      tick(reason, options) {
        calls.push(['usage', reason, options]);
        return usage.promise;
      }
    };

    let completed = false;
    const refresh = runManualDeviceRefresh(runtime, { forceHistory: true }).then(() => { completed = true; });
    await Promise.resolve();
    assert.deepEqual(calls, [
      ['limits', { all: true }, 'manual'],
      ['usage', 'manual', { forceHistory: true, forceSelfSync: false }]
    ]);
    usage.resolve();
    await refresh;
    assert.equal(completed, true);
    limits.resolve();
  });
}

test('usage runtime refresh ownership follows mode and external-agent state', () => {
  let probes = 0;
  const active = () => { probes += 1; return true; };
  const inactive = () => { probes += 1; return false; };

  assert.equal(canRefreshUsageRuntime('local', active), true);
  assert.equal(probes, 0, 'local mode must not read the external-agent PID');
  assert.equal(canRefreshUsageRuntime('client', active), false);
  assert.equal(canRefreshUsageRuntime('host', active), false);
  assert.equal(canRefreshUsageRuntime('client', inactive), true);
  assert.equal(canRefreshUsageRuntime('host', inactive), true);
  assert.equal(probes, 4);
});

test('pending usage refreshes isolate synchronous failures', async () => {
  const pending = new Map([
    ['cursor', { clientId: 'cursor', options: { forceSync: true } }],
    ['claude', { clientId: 'claude', options: {} }]
  ]);
  const calls = [];
  const errors = [];
  const runtime = {
    refreshClient(clientId, options) {
      calls.push([clientId, options]);
      if (clientId === 'cursor') throw new TypeError('cursor no longer tracked');
      return true;
    }
  };

  assert.doesNotThrow(() => {
    drainPendingUsageClientRefreshes(
      pending,
      runtime,
      (error) => errors.push(error.message)
    );
  });
  assert.equal(pending.size, 0);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['cursor', { forceSync: true }],
    ['claude', {}]
  ]);
  assert.deepEqual(errors, ['cursor no longer tracked']);
});

test('only an opted-in manual refresh forces the self-synced clients', async () => {
  // Every settings toggle and account action refreshes with { force: true }, and
  // those must not pay for the Cursor and Antigravity sync subprocesses. Just
  // the refresh button opts in.
  const ticks = [];
  const runtime = {
    refreshLimits: async () => {},
    tick: async (reason, options) => { ticks.push(options); }
  };

  await runManualDeviceRefresh(runtime, {});
  await runManualDeviceRefresh(runtime, { forceSelfSync: true });

  assert.deepEqual(ticks.map((options) => options.forceSelfSync), [false, true]);
});

test('manual refresh reports a late limits failure without rejecting completed usage', async () => {
  const errors = [];
  const runtime = {
    refreshLimits: async () => { throw new Error('quota offline'); },
    tick: async () => {}
  };
  await runManualDeviceRefresh(runtime, { onLimitsError: (error) => errors.push(error.message) });
  await Promise.resolve();
  assert.deepEqual(errors, ['quota offline']);
});

test('settings changes plan scoped clear-before-refresh invalidations', () => {
  const scopes = [{ provider: 'deepseek' }, { provider: 'zai', accountKey: 'work' }];
  assert.deepEqual(settingsLimitInvalidationPlan({ limitScopes: scopes }), [
    {
      scope: scopes[0],
      reason: 'settings-change',
      options: { clear: true }
    },
    {
      scope: scopes[1],
      reason: 'settings-change',
      options: { clear: true }
    }
  ]);
  assert.deepEqual(settingsLimitInvalidationPlan(), []);
});

test('limit invalidation clears the scoped lane before refreshing it', async () => {
  const calls = [];
  const scope = { provider: 'deepseek' };
  const runtime = {
    clearLimits(nextScope, reason) {
      calls.push(['clear', nextScope, reason]);
    },
    refreshLimits(nextScope, reason) {
      calls.push(['refresh', nextScope, reason]);
      return { refreshed: true };
    }
  };

  const result = await runLimitInvalidation(runtime, scope, 'settings-change', { clear: true });

  assert.deepEqual(calls, [
    ['clear', scope, 'settings-change'],
    ['refresh', scope, 'settings-change']
  ]);
  assert.deepEqual(result, { refreshed: true });
});

test('limit invalidation can clear without scheduling a refresh', async () => {
  const calls = [];
  const scope = { provider: 'deepseek' };
  const runtime = {
    clearLimits(nextScope, reason) {
      calls.push(['clear', nextScope, reason]);
    },
    refreshLimits() {
      calls.push(['refresh']);
    }
  };

  const result = await runLimitInvalidation(
    runtime,
    scope,
    'settings-change',
    { clear: true, refresh: false }
  );

  assert.deepEqual(calls, [['clear', scope, 'settings-change']]);
  assert.deepEqual(result, { cleared: true });
});
