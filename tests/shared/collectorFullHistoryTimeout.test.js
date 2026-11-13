'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const childProcess = require('node:child_process');
const { createDeviceRuntime } = require('../../src/shared/usage/deviceRuntime');

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('collector did not reach the expected stage');
}

// Exercise the real subprocess timer and termination path with a virtual clock,
// rather than a stub which merely asserts the timeout argument it was passed.
function fixture(t, overrides = {}, delayMs = 120001) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-history-timeout-'));
  const previousShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = home;
  t.after(() => {
    if (previousShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previousShared;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  let slow = true;
  t.mock.method(childProcess, 'spawn', (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      setImmediate(() => child.emit('close', null, signal));
      return true;
    };
    children.push(child);
    const tokens = args.includes('--today') ? 10 : args.includes('--month') ? 100 : 1000;
    const complete = () => {
      child.stdout.emit('data', JSON.stringify({ entries: [{ client: 'claude', model: 'test', input: tokens }] }));
      child.emit('close', 0);
    };
    if (args.includes('--since') && slow) setTimeout(complete, delayMs);
    else setImmediate(complete);
    return child;
  });
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const collector = require(collectorPath);
  const uploads = [], errors = [], previews = [];
  let usage;
  const runtime = createDeviceRuntime({
    envelope: { deviceId: 'large-history-test', agentVersion: 'test' },
    progressive: true,
    onColdPreview: record => previews.push(record),
    sink: { enqueue: record => uploads.push(record) },
    usageOptions: {
      clients: 'claude', deviceId: 'large-history-test', allTimeSince: '2024-01-01',
      commandTimeoutMs: 120000, homeDir: home, env: {}, osInfo: {},
      historyEnabled: false, dailyHistoryArchiveEnabled: false, projectsEnabled: false,
      watchEnabled: false, sessionActivityPolling: false, intervalMs: 3600000,
      pricingCatalogTimers: { setTimeout: () => 1, clearTimeout() {} },
      onError: error => errors.push(error),
      ...overrides
    }
  }, {
    createUsageRuntime: options => (usage = collector.startCollector(options)),
    createLimitsRuntime: () => ({ stop() {} })
  });
  t.after(async () => {
    runtime.stop();
    await usage.whenIdle();
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { runtime, children, uploads, errors, previews, usage,
    anchorPath: path.join(home, 'collector-anchor.json'),
    fast: () => { slow = false; } };
}

test('all-time report exceeding 120s completes, persists a fresh anchor and reaches the upload sink', async t => {
  const f = fixture(t);
  await until(() => f.children.length === 3);
  assert.equal(f.uploads.length, 0, 'previews must never become uploads');
  assert.equal(fs.existsSync(f.anchorPath), false);
  assert.equal(f.previews.at(-1).month.totalTokens, 100);
  t.mock.timers.tick(120001);
  await f.usage.whenIdle();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.children[2].signals, []);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].today.totalTokens, 10);
  assert.equal(f.uploads[0].month.totalTokens, 100);
  assert.equal(f.uploads[0].allTime.totalTokens, 1000);
  assert.equal(JSON.parse(fs.readFileSync(f.anchorPath)).allTime.totalTokens, 1000);
});

test('full-history timeout rejects incomplete accounting, then a later tick recovers', async t => {
  const f = fixture(t, { allTimeTimeoutMs: 130000 }, 130001);
  await until(() => f.children.length === 3);
  t.mock.timers.tick(130000);
  await f.usage.whenIdle();
  assert.match(f.errors[0].message, /timed out after 130000ms/);
  assert.deepEqual(f.children[2].signals, ['SIGTERM']);
  assert.equal(f.uploads.length, 0);
  assert.equal(fs.existsSync(f.anchorPath), false);
  f.fast();
  await f.runtime.tick('manual');
  assert.equal(f.uploads.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.anchorPath)).allTime.totalTokens, 1000);
});

test('stopping during a long all-time report aborts it without an upload or anchor', async t => {
  const f = fixture(t);
  await until(() => f.children.length === 3);
  t.mock.timers.tick(120000);
  assert.deepEqual(f.children[2].signals, [], 'the ordinary deadline must not kill all-time');
  f.runtime.stop();
  await f.usage.whenIdle();
  assert.deepEqual(f.children[2].signals, ['SIGTERM']);
  assert.equal(f.uploads.length, 0);
  assert.equal(fs.existsSync(f.anchorPath), false);
});

for (const [value, expected] of [['7200000', 7200000], ['', 300000], ['invalid', 300000], ['Infinity', 300000], ['0', 300000], ['-1', 300000], ['999999999999', 2147483647]]) {
  test(`all-time environment budget ${JSON.stringify(value)} resolves to ${expected}ms`, async () => {
    const { collectUsageOnce } = require('../../src/shared/collector');
    const calls = [];
    await collectUsageOnce({
      clients: 'claude', allTimeSince: '2024-01-01', commandTimeoutMs: 120000,
      historyEnabled: false, projectsEnabled: false,
      env: { TOKEN_MONITOR_ALL_TIME_TIMEOUT_MS: value },
      runTokscale: async input => { calls.push(input); return { entries: [] }; }
    });
    assert.deepEqual(calls.map(x => x.commandTimeoutMs), [120000, 120000, expected]);
  });
}
