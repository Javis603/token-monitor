'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runManualDeviceRefresh } = require('../../src/electron/deviceRuntimeCoordinator');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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
      ['usage', 'manual', { forceHistory: true }]
    ]);
    usage.resolve();
    await refresh;
    assert.equal(completed, true);
    limits.resolve();
  });
}

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
