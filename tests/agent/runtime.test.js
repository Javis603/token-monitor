'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runAgent, runAgentOnce } = require('../../src/agent/runtime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function runtimeHarness() {
  let usageOptions;
  let limitsDeps;
  const limitsRefresh = deferred();
  const deps = {
    deviceRuntimeDeps: {
      createUsageRuntime(options) {
        usageOptions = options;
        return { stop() {}, tick() {}, refreshClient() {} };
      },
      createLimitsRuntime(_options, nextDeps) {
        limitsDeps = nextDeps;
        return {
          clear() {},
          getSnapshot() { return { providers: [] }; },
          reconfigure() {},
          refresh() { return limitsRefresh.promise; },
          stop() {}
        };
      }
    }
  };
  return {
    deps,
    limitsRefresh,
    limitsUpdate: (summary) => limitsDeps.onUpdate(summary),
    usageError: (error) => usageOptions.onError(error, 'startup'),
    usageUpdate: (summary) => usageOptions.onUpdate(summary, 'startup')
  };
}

function usageSummary(tokens = 1) {
  return {
    deviceId: 'device-1',
    updatedAt: 'usage-time',
    today: { totalTokens: tokens },
    month: { totalTokens: tokens },
    allTime: { totalTokens: tokens }
  };
}

test('long-running agent posts usage before hung limits and never overlaps posts', async () => {
  const harness = runtimeHarness();
  const firstSend = deferred();
  const delivered = [];
  let active = 0;
  let maxActive = 0;
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    async deliver(record) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      delivered.push(record);
      if (delivered.length === 1) await firstSend.promise;
      active -= 1;
    }
  }, harness.deps);

  harness.usageUpdate(usageSummary(10));
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  firstSend.resolve();
  await runtime.flush();

  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].today.totalTokens, 10);
  assert.equal(delivered[1].limits.updatedAt, 'limits-time');
  assert.equal(maxActive, 1);
  runtime.stop();
});

test('long-running agent reports one owned error for a failed delivery', async () => {
  const harness = runtimeHarness();
  const expected = new Error('post failed');
  const errors = [];
  const runtime = runAgent({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async () => { throw expected; },
    onError: (...args) => errors.push(args)
  }, harness.deps);

  harness.usageUpdate(usageSummary(9));
  await runtime.flush();
  assert.deepEqual(errors, [[expected, 'sink']]);
  runtime.stop();
});

test('normal once posts usage immediately and a changed limits record second', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(11));
  await new Promise(setImmediate);
  assert.equal(delivered.length, 1);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  harness.limitsRefresh.resolve();
  const final = await running;

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].today.totalTokens, 11);
  assert.equal(delivered[1].limits.updatedAt, 'limits-time');
  assert.deepEqual(final, delivered[1]);
});

test('dry-run once waits for bounded limits and emits one final JSON record', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    dryRun: true,
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(12));
  await new Promise(setImmediate);
  assert.deepEqual(delivered, []);
  harness.limitsUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  harness.limitsRefresh.resolve();
  await running;

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].today.totalTokens, 12);
  assert.equal(delivered[0].limits.updatedAt, 'limits-time');
});

test('once does not duplicate when the initial limits pass has no new publish', async () => {
  const harness = runtimeHarness();
  const delivered = [];
  const running = runAgentOnce({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async (record) => delivered.push(record)
  }, harness.deps);

  harness.usageUpdate(usageSummary(13));
  harness.limitsRefresh.resolve();
  await running;
  assert.equal(delivered.length, 1);
});

test('once rejects and stops when the initial usage collection fails', async () => {
  const harness = runtimeHarness();
  const running = runAgentOnce({
    envelope: { deviceId: 'device-1' },
    usageOptions: {},
    limitsOptions: {},
    deliver: async () => {}
  }, harness.deps);
  harness.usageError(new Error('usage failed'));
  await assert.rejects(running, /usage failed/);
});
