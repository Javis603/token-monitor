'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { withCursorLifecycle } = require('../../src/shared/providers/cursor/lifecycle');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('collector did not publish while Cursor sync was pending');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture(t, { historyEnabled = true, cursorGraphFailure = false, syncFailure = false, localGate = null } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-background-'));
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const collector = require(collectorPath);
  let localTokens = 10;
  let cursorTokens = { today: 12, month: 40, allTime: 80 };
  let cursorHistoryTokens = null;
  let cursorReadFailure = false;
  const calls = [];
  const graphCalls = [];
  const updates = [];
  const errors = [];
  const syncs = [];
  const gates = [];
  t.mock.method(cursorAuth, 'runCursorSync', options => withCursorLifecycle(async () => {
    syncs.push(options);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    if (syncFailure) throw new Error('simulated Cursor sync failure');
    return { synced: true };
  }, options));
  const day = '2026-11-01';
  const options = {
    clients: 'codex,cursor', allTimeSince: '2024-01-01', commandTimeoutMs: 1000,
    homeDir, env: {}, osInfo: {}, deviceId: 'test', agentVersion: 'test',
    historyEnabled, includeHistory: historyEnabled, projectsEnabled: false,
    watchEnabled: false, intervalMs: 600000, anchorPersistenceEnabled: false,
    wslScanEnabled: false, codexLocalUsageEnabled: false, sessionActivityPolling: false,
    now: () => new Date(`${day}T12:00:00`),
    onUpdate: summary => { updates.push(summary); },
    onError: error => errors.push(error),
    runTokscale: async input => {
      calls.push(input);
      const cursor = input.clients === 'cursor';
      if (cursor) {
        assert.equal(input.offline, true);
        assert.equal(input.cursorLifecycleHeld, true);
        if (cursorReadFailure) throw new Error('simulated Cursor cache read failure');
      } else {
        assert.equal(input.clients, 'codex', 'local reports must never enter the Cursor lifecycle lane');
        if (localGate) await localGate.promise;
      }
      const period = input.flags.includes('--today') ? 'today' : input.flags.includes('--month') ? 'month' : 'allTime';
      const client = cursor ? 'cursor' : 'codex';
      return { processingTimeMs: calls.length, entries: [{ client, sessionId: `${client}-session`, model: `${client}-model`, input: cursor ? cursorTokens[period] : localTokens, output: 0, cost: 0 }] };
    },
    runGraph: async input => {
      graphCalls.push(input);
      const cursor = input.clients === 'cursor';
      if (cursor) assert.equal(input.offline, true);
      else assert.equal(input.clients, 'codex');
      if (cursor && cursorGraphFailure) throw new Error('simulated graph failure');
      return { meta: { generatedAt: new Date(graphCalls.length).toISOString(), version: 1 }, contributions: [{ date: day, clients: [{ client: cursor ? 'cursor' : 'codex', modelId: 'test-model', tokens: { input: cursor ? cursorHistoryTokens ?? cursorTokens.today : localTokens }, cost: 0 }] }] };
    }
  };
  const runtime = collector.startCollector(options);
  t.after(async () => {
    runtime.stop();
    localGate?.resolve();
    for (const gate of gates) gate.resolve();
    await runtime.whenIdle();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  return { runtime, updates, errors, syncs, gates, calls, graphCalls,
    setLocal: value => { localTokens = value; },
    setCursor: value => { cursorTokens = value; },
    setCursorHistory: value => { cursorHistoryTokens = value; },
    failCursorReads: () => { cursorReadFailure = true; } };
}

test('startup whenIdle waits for the first local scan without waiting for the Cursor import', async t => {
  const localGate = deferred();
  const f = fixture(t, { historyEnabled: false, localGate });
  let idle = false;
  const first = f.runtime.whenIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  localGate.resolve();
  await first;
  assert.ok(f.updates.length > 0);
  assert.equal(f.syncs.length, 1);
});

test('long Cursor import leaves Codex watch ticks live, then reconciles all periods and History', async t => {
  const f = fixture(t);
  await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
  assert.equal(f.syncs[0].timeoutMs, 1830000);
  await f.runtime.whenIdle();
  f.setLocal(25);
  await f.runtime.tick('watch:codex', { todayOnly: true, targetClients: ['codex'] });
  assert.equal(f.updates.at(-1).today.clients.codex, 25);
  assert.equal(f.updates.at(-1).today.clients.cursor, 12);
  assert.equal(f.updates.at(-1).allTime.clients.cursor, 80);
  assert.equal(f.syncs.length, 1);
  f.setCursor({ today: 30, month: 90, allTime: 150 });
  f.gates[0].resolve();
  await until(() => f.updates.some(x => x.allTime.clients.cursor === 150));
  const latest = f.updates.at(-1);
  assert.equal(latest.today.clients.cursor, 30);
  assert.equal(latest.month.clients.cursor, 90);
  assert.equal(latest.allTime.clients.cursor, 150);
  assert.equal(latest.history.summary.totalTokens, 55);
  assert.equal(latest.history.summary.activeDays, 1);
  assert.equal(latest.history.daily.filter(x => x.tokens > 0).length, 1);
  assert.deepEqual(f.errors, []);
});

for (const syncFailure of [false, true]) {
  test(`unchanged Cursor completion publishes ${syncFailure ? 'failed' : 'successful'} health without rescanning local usage`, async t => {
    const f = fixture(t, { syncFailure });
    const collection = () => f.updates.at(-1)?.clientHealth?.clients.cursor.collection;
    await until(() => f.syncs.length === 1 && collection()?.state === 'pending');
    await f.runtime.whenIdle();
    const before = f.updates.at(-1);
    const reports = f.calls.filter(call => call.clients === 'codex').length;
    const graphs = f.graphCalls.filter(call => call.clients === 'codex').length;
    f.gates[0].resolve();
    await until(() => collection()?.state === (syncFailure ? 'failed' : 'ok'));
    await f.runtime.whenIdle();
    assert.equal(f.calls.filter(call => call.clients === 'cursor').length, 6, 'the import still reads every cached period');
    assert.equal(f.calls.filter(call => call.clients === 'codex').length, reports);
    assert.equal(f.graphCalls.filter(call => call.clients === 'codex').length, graphs);
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(f.updates.at(-1)[period].totalTokens, before[period].totalTokens, period);
      assert.deepEqual(f.updates.at(-1)[period].clients, before[period].clients, period);
    }
    assert.ok(collection().lastAttemptAt);
    if (syncFailure) assert.ok(collection().syncFailureStage);
    else assert.ok(collection().lastSuccessAt);
    assert.equal(f.updates.at(-1).history, undefined, 'unchanged completion does not replace retained History');
    assert.deepEqual(f.errors, []);
  });
}

for (const change of ['month', 'allTime', 'history']) {
  test(`a Cursor ${change}-only correction still reconciles all periods and History`, async t => {
    const f = fixture(t);
    await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
    await f.runtime.whenIdle();
    const reports = f.calls.filter(call => call.clients === 'codex').length;
    const graphs = f.graphCalls.filter(call => call.clients === 'codex').length;
    if (change === 'history') f.setCursorHistory(25);
    else f.setCursor({ today: 12, month: 40, allTime: 80, [change]: 100 });
    f.gates[0].resolve();
    await until(() => change === 'history'
      ? f.updates.at(-1)?.history?.summary.totalTokens === 35
      : f.updates.at(-1)?.[change].clients.cursor === 100);
    await f.runtime.whenIdle();
    const scans = f.calls.filter(call => call.clients === 'codex').slice(reports);
    assert.deepEqual(scans.map(call => call.flags), [['--today'], ['--month'], ['--since', '2024-01-01']]);
    assert.equal(f.graphCalls.filter(call => call.clients === 'codex').length, graphs + 1);
    assert.equal(f.updates.at(-1).today.clients.cursor, 12);
    assert.deepEqual(f.errors, []);
  });
}

test('manual Cursor force waits outside the local tick and never overlaps syncs', async t => {
  const f = fixture(t, { historyEnabled: false });
  await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
  let refreshed = false;
  const explicit = f.runtime.refreshClient('cursor', { forceSync: true }).then(() => { refreshed = true; });
  f.setLocal(20);
  await f.runtime.tick('watch:codex', { todayOnly: true, targetClients: ['codex'] });
  assert.equal(f.updates.at(-1).today.clients.codex, 20);
  assert.equal(refreshed, false);
  assert.equal(f.syncs.length, 1);
  f.gates[0].resolve();
  await until(() => f.syncs.length === 2);
  assert.equal(refreshed, false);
  f.setCursor({ today: 42, month: 100, allTime: 200 });
  f.gates[1].resolve();
  await explicit;
  assert.equal(f.updates.at(-1).allTime.clients.cursor, 200);
  assert.deepEqual(f.errors, []);
});

test('refreshClient Cursor without force rescans the offline cache while local scans stay live', async t => {
  const f = fixture(t, { historyEnabled: false });
  await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
  f.setCursor({ today: 44, month: 100, allTime: 200 });
  let ready = false;
  const refreshed = f.runtime.refreshClient('cursor').then(result => { ready = true; return result; });
  f.setLocal(22);
  await f.runtime.tick('watch:codex', { todayOnly: true, targetClients: ['codex'] });
  assert.equal(f.updates.at(-1).today.clients.codex, 22);
  assert.equal(ready, false, 'the explicit cache read still respects the active lifecycle operation');
  f.gates[0].resolve();
  assert.equal(await refreshed, true);
  assert.equal(f.updates.at(-1).today.clients.cursor, 44);
  assert.equal(f.updates.at(-1).month.clients.cursor, 100);
  assert.equal(f.updates.at(-1).allTime.clients.cursor, 200);
  assert.equal(f.syncs.length, 1, 'a cache rescan does not force an extra network sync');
});

for (const forceSync of [false, true]) {
  test(`refreshClient Cursor reports a failed requested cache read (force=${forceSync})`, async t => {
    const f = fixture(t, { historyEnabled: false });
    await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
    f.failCursorReads();
    const refreshed = f.runtime.refreshClient('cursor', { forceSync });
    f.gates[0].resolve();
    if (forceSync) {
      // The pending forced operation can fail its initial cache read before a
      // second network attempt; its caller still receives an explicit failure.
      await new Promise(resolve => setImmediate(resolve));
      for (const gate of f.gates) gate.resolve();
    }
    assert.equal(await refreshed, false);
    assert.equal(f.updates.at(-1).allTime.clients.cursor, 80, 'failed reads preserve the last complete view');
  });
}

test('stop cancels background import and whenIdle retains its physical-close barrier', async t => {
  const f = fixture(t, { historyEnabled: false });
  await until(() => f.syncs.length === 1);
  await f.runtime.whenIdle();
  f.runtime.stop();
  assert.equal(f.syncs[0].signal.aborted, true);
  let idle = false;
  const stopped = f.runtime.whenIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  const count = f.updates.length;
  f.gates[0].resolve();
  await stopped;
  assert.equal(f.updates.length, count);
  assert.deepEqual(f.errors, []);
});

test('Cursor graph failure preserves usage publication while History remains best effort', async t => {
  const f = fixture(t, { cursorGraphFailure: true });
  await until(() => f.syncs.length === 1 && f.updates.some(x => x.today.clients.cursor === 12));
  f.setLocal(33);
  await f.runtime.tick('watch:codex', { todayOnly: true, targetClients: ['codex'] });
  assert.equal(f.updates.at(-1).today.clients.codex, 33);
  assert.equal(f.updates.at(-1).today.clients.cursor, 12);
  assert.equal(f.runtime.getDiagnostics().lastHistoryFailureCode, 'history-graph-failed');
  assert.deepEqual(f.errors, []);
});

test('aggregate-only native reports retain their tokens when merged with a Cursor snapshot', async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-aggregate-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const { collectUsageOnce } = require('../../src/shared/collector');
  const cursor = { entries: [{ client: 'cursor', sessionId: 'cached', input: 12, cost: 0 }] };
  const result = await collectUsageOnce({
    clients: 'codex,cursor', homeDir, env: {}, osInfo: {}, projectsEnabled: false,
    historyEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false,
    cursorSnapshot: { today: cursor, month: cursor, allTime: cursor },
    runTokscale: async () => ({ totalTokens: 23 })
  });
  assert.equal(result.today.totalTokens, 35);
  assert.equal(result.month.totalTokens, 35);
  assert.equal(result.allTime.totalTokens, 35);
});

test('Cursor History merge preserves uncapped lifetime statistics and native time metrics', async () => {
  const { collectHistoryOnce } = require('../../src/shared/collector');
  const row = (date, client, input) => ({ date, clients: [{ client, modelId: 'model', tokens: { input } }] });
  const timeMetrics = { totalActiveTimeMs: 500, longestContinuousMs: 400, maxConcurrentSessions: 2, sessionCount: 3 };
  const result = await collectHistoryOnce({
    clients: 'codex', capDays: 2, todayKey: '2026-11-01',
    runGraph: async () => ({ contributions: [row('2025-01-01', 'codex', 100), row('2026-11-01', 'codex', 10)], timeMetrics }),
    cursorGraph: { contributions: [row('2026-11-01', 'cursor', 20)] }
  });
  assert.equal(result.summary.totalTokens, 130);
  assert.equal(result.summary.activeDays, 2);
  assert.equal(result.summary.peakDayTokens, 100);
  assert.deepEqual(result.summary.timeMetrics, timeMetrics);
  assert.equal(result.daily.find(row => row.date === '2026-11-01').tokens, 30);
});

test('isolated WSL home scans remain offline and never wait behind the host Cursor import', async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-wsl-'));
  const gate = deferred();
  const busy = withCursorLifecycle(() => gate.promise);
  t.after(async () => { gate.resolve(); await busy; fs.rmSync(homeDir, { recursive: true, force: true }); });
  const calls = [];
  t.mock.method(require('node:child_process'), 'spawn', (_bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ entries: [] }));
      child.emit('close', 0);
    });
    return child;
  });
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const { collectUsageOnce } = require(collectorPath);
  const empty = { entries: [] };
  const collection = collectUsageOnce({
    clients: 'cursor', allTimeSince: '2024-01-01', commandTimeoutMs: 1000,
    homeDir, env: {}, osInfo: {}, platform: 'win32', projectsEnabled: false, historyEnabled: false,
    codexLocalUsageEnabled: false, cursorSnapshot: { today: empty, month: empty, allTime: empty },
    probeWslState: () => 'ok',
    collectWslUsage: async options => {
      await options.runTokscale({ clients: 'cursor', flags: ['--today', '--home', '\\\\wsl$\\fixture\\home\\test'], commandTimeoutMs: 1000 });
      return { bundle: require('../../src/shared/wslUsage').emptyWslBundle(), detected: [] };
    }
  });
  let complete = false;
  void collection.then(() => { complete = true; });
  await until(() => complete);
  await collection;
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--offline'));
  assert.ok(calls[0].includes('--home'));
});

test('a native pricing replay waits for a matching Cursor snapshot before publishing', async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-reprice-'));
  const pricingPath = path.join(homeDir, 'custom-pricing.json');
  let price = 1;
  const setPrice = value => {
    price = value;
    fs.writeFileSync(pricingPath, JSON.stringify({ models: { fixture: { input_cost_per_million_tokens: value } } }));
  };
  setPrice(1);
  t.mock.method(cursorAuth, 'runCursorSync', async () => ({ synced: true }));
  const collectorPath = require.resolve('../../src/shared/collector');
  delete require.cache[collectorPath];
  const { startCollector } = require(collectorPath);
  const updates = [];
  const errors = [];
  let cursorReads = 0;
  let armed = false;
  const runtime = startCollector({
    clients: 'codex,cursor', homeDir, pricingPath, binaryRevision: 'fixture',
    env: {}, osInfo: {}, projectsEnabled: false, historyEnabled: false,
    watchEnabled: false, intervalMs: 600000, anchorPersistenceEnabled: false,
    wslScanEnabled: false, codexLocalUsageEnabled: false, sessionActivityPolling: false,
    runTokscale: async input => {
      const captured = price;
      if (input.clients === 'cursor') cursorReads++;
      if (armed && input.clients === 'codex' && input.flags.includes('--today')) {
        armed = false;
        setPrice(2);
      }
      return { entries: [{ client: input.clients, sessionId: 'session', model: 'fixture', input: 10, cost: captured }] };
    },
    onUpdate: summary => updates.push(summary),
    onError: error => errors.push(error)
  });
  t.after(async () => { runtime.stop(); await runtime.whenIdle(); fs.rmSync(homeDir, { recursive: true, force: true }); });
  await until(() => cursorReads === 6 && updates.some(summary => summary.allTime.clientCosts.cursor === 1));
  await new Promise(resolve => setImmediate(resolve));
  await runtime.whenIdle();
  updates.length = 0;
  armed = true;
  await runtime.tick('manual');
  assert.ok(updates.length > 0);
  for (const summary of updates) for (const period of ['today', 'month', 'allTime']) {
    assert.equal(summary[period].clientCosts.codex, 2);
    assert.equal(summary[period].clientCosts.cursor, 2);
    assert.equal(summary[period].costUsd, 4);
  }
  assert.deepEqual(errors, []);
});
