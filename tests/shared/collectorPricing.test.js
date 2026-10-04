'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startCollector, pricingFingerprint, configFingerprint, collectorAnchorTrust, localTodayKey } = require('../../src/shared/collector');
const { deviceRecordFromAnchor } = require('../../src/shared/anchorSeed');
const { emptyPeriod } = require('../../src/shared/usage');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pricing-anchor-'));
  const pricingPath = path.join(dir, 'custom-pricing.json');
  const previous = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const setPrice = price => fs.writeFileSync(pricingPath, JSON.stringify({ models: { test: { input_cost_per_million_tokens: price } } }));
  return { dir, pricingPath, setPrice };
}

test('both collector and cold-start seed refuse anchors after pricing or binary changes', t => {
  const f = fixture(t);
  f.setPrice(1);
  const options = { clients: 'claude', allTimeSince: '2024-01-01', pricingPath: f.pricingPath, binaryRevision: 'fork-a', now: new Date() };
  const revision = pricingFingerprint(options);
  const saved = {
    dateKey: localTodayKey(options.now), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod(),
    configFingerprint: configFingerprint('claude', options.allTimeSince, true, '', '', null, revision),
    fullScanAt: options.now.toISOString()
  };
  assert.ok(collectorAnchorTrust(saved, options));
  assert.ok(deviceRecordFromAnchor(saved, options));
  f.setPrice(2);
  assert.notEqual(pricingFingerprint(options), revision);
  assert.equal(collectorAnchorTrust(saved, options), null);
  assert.equal(deviceRecordFromAnchor(saved, options), null);
  f.setPrice(1);
  assert.equal(pricingFingerprint(options), revision, 'same file content restores the same price identity');
  assert.equal(collectorAnchorTrust(saved, { ...options, binaryRevision: 'fork-b' }), null);
  assert.equal(deviceRecordFromAnchor(saved, { ...options, binaryRevision: 'fork-b' }), null);
  fs.unlinkSync(f.pricingPath);
  assert.equal(collectorAnchorTrust(saved, options), null, 'removing an override also invalidates prices');
});

test('watch reprices all windows and history after add, edit, zero, remove and restart', async t => {
  const f = fixture(t);
  let calls = 0;
  let graphs = 0;
  const updates = [];
  const currentPrice = () => fs.existsSync(f.pricingPath)
    ? JSON.parse(fs.readFileSync(f.pricingPath)).models.test.input_cost_per_million_tokens : 9;
  const options = {
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'test-device',
    pricingPath: f.pricingPath, binaryRevision: 'fork-a', intervalMs: 60 * 60 * 1000,
    watchEnabled: false, wslScanEnabled: false, projectsEnabled: false,
    historyEnabled: true, historyIntervalMs: 60 * 60 * 1000,
    runTokscale: async () => {
      calls += 1;
      return { entries: [{ client: 'claude', sessionId: 's', model: 'test', input: 100, output: 0, cost: currentPrice() }] };
    },
    runGraph: async () => {
      graphs += 1;
      return { contributions: [{ date: localTodayKey(), clients: [{ client: 'claude', modelId: 'test', tokens: { input: 100 }, cost: currentPrice() }] }] };
    },
    onUpdate: summary => updates.push(summary)
  };
  let handle = startCollector(options);
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 3);
  assert.equal(graphs, 1);
  await handle.tick('watch:test', { todayOnly: true });
  assert.equal(calls, 4, 'unchanged pricing keeps the exact today-only delta');
  assert.equal(graphs, 1);
  for (const price of [3, 2, 0, null]) {
    if (price === null) fs.unlinkSync(f.pricingPath); else f.setPrice(price);
    const before = calls;
    const beforeGraphs = graphs;
    await handle.tick('watch:test', { todayOnly: true });
    assert.equal(calls - before, 3, 'price changes upgrade watch to serial full scan');
    assert.equal(graphs - beforeGraphs, 1, 'price changes bypass the history interval');
    const summary = updates.at(-1);
    for (const period of ['today', 'month', 'allTime']) assert.equal(summary[period].costUsd, price ?? 9);
    assert.equal(summary.history.daily.at(-1).cost, price ?? 9);
  }
  const beforeRestart = calls;
  handle.stop();
  handle = startCollector(options);
  await handle.whenIdle();
  assert.equal(calls - beforeRestart, 1, 'same pricing revision reuses the persisted anchor');
  handle.stop();
  f.setPrice(7);
  const beforeChangedRestart = calls;
  handle = startCollector(options);
  await handle.whenIdle();
  assert.equal(calls - beforeChangedRestart, 3, 'an edited file while stopped refuses the persisted anchor');
  assert.equal(updates.at(-1).allTime.costUsd, 7);
});

test('a price change during serial scans discards the mixed result and replays all windows', async t => {
  const f = fixture(t);
  f.setPrice(1);
  let calls = 0;
  const updates = [];
  const handle = startCollector({
    clients: 'claude', allTimeSince: '2024-01-01', deviceId: 'test-device',
    pricingPath: f.pricingPath, binaryRevision: 'fork-a', intervalMs: 60 * 60 * 1000,
    anchorPersistenceEnabled: false, watchEnabled: false, wslScanEnabled: false, projectsEnabled: false, historyEnabled: false,
    runTokscale: async () => {
      calls += 1;
      const price = JSON.parse(fs.readFileSync(f.pricingPath)).models.test.input_cost_per_million_tokens;
      if (calls === 1) f.setPrice(5);
      return { entries: [{ client: 'claude', sessionId: 's', model: 'test', input: 100, output: 0, cost: price }] };
    },
    onUpdate: summary => updates.push(summary)
  });
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 6);
  assert.equal(updates.length, 1);
  for (const period of ['today', 'month', 'allTime']) assert.equal(updates[0][period].costUsd, 5);
});

for (const changes of [1, 5]) {
  test(`pricing replay is bounded and reports its result with ${changes} pending price changes`, async t => {
    const f = fixture(t);
    let price = 1;
    f.setPrice(price);
    let calls = 0;
    let armed = false;
    let mutations = 0;
    const updates = [];
    const handle = startCollector({
      clients: 'claude', pricingPath: f.pricingPath, binaryRevision: 'fork-a', intervalMs: 3600000,
      anchorPersistenceEnabled: false, watchEnabled: false, wslScanEnabled: false,
      projectsEnabled: false, historyEnabled: false,
      runTokscale: async () => {
        calls += 1;
        const captured = price;
        if (armed && calls % 3 === 1 && mutations < changes) {
          mutations += 1;
          f.setPrice(++price);
        }
        return { entries: [{ client: 'claude', sessionId: 's', model: 'test', input: 100, output: 0, cost: captured }] };
      },
      onUpdate: summary => updates.push(summary)
    });
    t.after(() => handle.stop());
    await handle.whenIdle();
    armed = true;
    const before = calls;
    const result = await handle.tick('manual');
    assert.equal(calls - before, 6, 'one full scan and at most one full replay');
    assert.equal(result, changes === 1, 'a successful replay is the initiating tick result');
    assert.equal(updates.length, changes === 1 ? 2 : 1, 'mixed scans never publish');
    armed = false;
    assert.equal(await handle.tick('watch:test', { todayOnly: true }), true);
    for (const period of ['today', 'month', 'allTime']) assert.equal(updates.at(-1)[period].costUsd, price);
  });
}

test('a pricing replay preserves independently queued tick waiters', async t => {
  const f = fixture(t);
  f.setPrice(1);
  let enterScan;
  let releaseScan;
  const entered = new Promise(resolve => { enterScan = resolve; });
  const gate = new Promise(resolve => { releaseScan = resolve; });
  let armed = false;
  let calls = 0;
  const handle = startCollector({
    clients: 'claude', pricingPath: f.pricingPath, binaryRevision: 'fork-a', intervalMs: 3600000,
    anchorPersistenceEnabled: false, watchEnabled: false, wslScanEnabled: false,
    projectsEnabled: false, historyEnabled: false,
    runTokscale: async () => {
      calls += 1;
      const price = JSON.parse(fs.readFileSync(f.pricingPath)).models.test.input_cost_per_million_tokens;
      if (armed) {
        armed = false;
        enterScan();
        await gate;
      }
      return { entries: [{ client: 'claude', sessionId: 's', model: 'test', input: 100, output: 0, cost: price }] };
    }, onUpdate() {}
  });
  t.after(() => { releaseScan(); handle.stop(); });
  await handle.whenIdle();
  armed = true;
  const initiating = handle.tick('manual');
  await entered;
  const queued = handle.tick('manual:queued');
  f.setPrice(5);
  releaseScan();
  assert.deepEqual(await Promise.all([initiating, queued]), [true, true]);
  assert.equal(calls, 12, 'initial, discarded manual, replay, and independently queued full scan');
});
