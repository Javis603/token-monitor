'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceRuntime } = require('../../src/shared/deviceRuntime');

function harness(options = {}) {
  let usageOptions;
  let limitsDeps;
  const calls = [];
  const usageHandle = {
    refreshClient: (...args) => { calls.push(['refreshClient', ...args]); return 'client'; },
    stop: () => calls.push(['usageStop']),
    tick: (...args) => { calls.push(['tick', ...args]); return 'tick'; }
  };
  const limitsHandle = {
    clear: (...args) => { calls.push(['clear', ...args]); return 'clear'; },
    reconfigure: (...args) => { calls.push(['reconfigure', ...args]); return 'reconfigure'; },
    refresh: (...args) => { calls.push(['refresh', ...args]); return 'refresh'; },
    stop: () => calls.push(['limitsStop'])
  };
  const records = [];
  const runtime = createDeviceRuntime({
    envelope: { deviceId: 'device-1', hostname: 'host' },
    onRecord: (record, meta) => records.push({ record, meta }),
    ...options
  }, {
    createUsageRuntime(next) {
      usageOptions = next;
      return usageHandle;
    },
    createLimitsRuntime(_config, nextDeps) {
      limitsDeps = nextDeps;
      return limitsHandle;
    }
  });
  return { calls, limitsDeps, records, runtime, usageOptions };
}

test('usage publishes immediately without waiting for limits and late limits emit a second full record', () => {
  const { limitsDeps, records, usageOptions } = harness();
  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 10 } }, 'startup');
  assert.equal(records.length, 1);
  assert.equal(records[0].record.today.totalTokens, 10);
  assert.equal(Object.hasOwn(records[0].record, 'limits'), false);

  limitsDeps.onUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  assert.equal(records.length, 2);
  assert.equal(records[1].record.today.totalTokens, 10);
  assert.equal(records[1].record.limits.updatedAt, 'limits-time');
});

test('limits arriving before first usage are buffered without fabricating a zero record', () => {
  const { limitsDeps, records, usageOptions } = harness();
  limitsDeps.onUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });
  assert.equal(records.length, 0);
  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 7 } }, 'startup');
  assert.equal(records.length, 1);
  assert.equal(records[0].record.limits.updatedAt, 'limits-time');
});

test('initial limits seed composes with the first usage record', () => {
  const initialLimits = { updatedAt: 'seed-time', refreshMs: 300000, providers: [] };
  const { records, usageOptions } = harness({ initialLimits });
  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 4 } }, 'startup');
  assert.equal(records[0].record.limits.updatedAt, 'seed-time');
});

test('usage transforms run only for usage events, not limits-only publishes', () => {
  const transformed = [];
  const { limitsDeps, records, usageOptions } = harness({
    transformUsage(summary, reason, meta) {
      transformed.push({ reason, preview: meta.preview });
      return { ...summary, transformed: true };
    }
  });
  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 4 } }, 'startup');
  limitsDeps.onUpdate({ updatedAt: 'limits-time', refreshMs: 300000, providers: [] });

  assert.deepEqual(transformed, [{ reason: 'startup', preview: false }]);
  assert.equal(records.length, 2);
  assert.equal(records[1].record.transformed, true);
});

test('progressive cold-start previews wait for the first complete usage record', () => {
  const { records, usageOptions } = harness({ progressive: true });
  usageOptions.onPreview({ updatedAt: 'preview-time', today: { totalTokens: 2 } });
  assert.equal(records.length, 0);

  usageOptions.onUpdate({
    updatedAt: 'usage-time',
    today: { totalTokens: 3 },
    month: { totalTokens: 4 },
    allTime: { totalTokens: 5 }
  }, 'startup');
  assert.equal(records.length, 1);
  assert.equal(records[0].record.allTime.totalTokens, 5);
});

test('a throwing record observer cannot block the ordered sink', () => {
  const error = new Error('observer failed');
  const delivered = [];
  const errors = [];
  const { usageOptions } = harness({
    onRecord() { throw error; },
    onError: (...args) => errors.push(args),
    sink: { enqueue: (...args) => delivered.push(args) }
  });

  usageOptions.onUpdate({ updatedAt: 'usage-time', today: { totalTokens: 1 } }, 'startup');
  assert.equal(delivered.length, 1);
  assert.deepEqual(errors, [[error, 'record']]);
});

test('stop invalidates both producer callbacks before stopping handles', () => {
  const { calls, limitsDeps, records, runtime, usageOptions } = harness();
  runtime.stop();
  usageOptions.onUpdate({ today: { totalTokens: 99 } }, 'late');
  limitsDeps.onUpdate({ providers: [] });
  assert.deepEqual(records, []);
  assert.deepEqual(calls, [['usageStop'], ['limitsStop']]);
});

test('runtime control methods delegate to the precise producer', () => {
  const { calls, runtime } = harness();
  assert.equal(runtime.tick('manual', { forceHistory: true }), 'tick');
  assert.equal(runtime.refreshClient('cursor', { forceSync: true }), 'client');
  assert.equal(runtime.refreshLimits({ provider: 'kimi' }, 'credential'), 'refresh');
  assert.equal(runtime.reconfigureLimits({ limitsRefreshMs: 60000 }), 'reconfigure');
  assert.equal(runtime.clearLimits({ provider: 'kimi' }, 'logout'), 'clear');
  assert.deepEqual(calls, [
    ['tick', 'manual', { forceHistory: true }],
    ['refreshClient', 'cursor', { forceSync: true }],
    ['refresh', { provider: 'kimi' }, 'credential'],
    ['reconfigure', { limitsRefreshMs: 60000 }],
    ['clear', { provider: 'kimi' }, 'logout']
  ]);
  runtime.stop();
});
