'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMacWidgetSnapshotController } = require('../../src/electron/macWidgetSnapshotController');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function history(label) {
  return { daily: [], monthly: [], summary: { label } };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(overrides = {}) {
  const prepared = [];
  const discarded = [];
  const published = [];
  const reloaded = [];
  const captures = [];
  const controller = createMacWidgetSnapshotController({
    captureWork({ stats, owner }) {
      const context = {
        stats,
        owner: Object.freeze({ ...owner, sourceKey: stats.source }),
        resolverConfig: Object.freeze({ source: stats.source }),
        presentation: Object.freeze({ currencyCode: stats.currency || 'USD' }),
        snapshotPath: '/tmp/snapshot.json',
        widgetKind: 'TokenMonitorWidget'
      };
      captures.push(context);
      return context;
    },
    async resolveHistory(work) {
      return history(work.resolverConfig.source);
    },
    async prepareSnapshot(work, resolvedHistory) {
      const value = { work, history: resolvedHistory, tempPath: `/tmp/${work.sequence}.tmp` };
      prepared.push(value);
      return { ok: true, changed: true, prepared: value };
    },
    commitSnapshot(value, options) {
      if (!options.isCurrent()) return { ok: false, reason: 'superseded' };
      published.push({ source: value.work.stats.source, history: value.history.summary.label });
      return { ok: true, changed: true };
    },
    async syncSnapshot() {},
    async discardSnapshot(value) {
      discarded.push(value.tempPath);
    },
    reloadSnapshot(work) {
      reloaded.push(work.stats.source);
    },
    logger() {},
    ...overrides
  });
  return { captures, controller, discarded, prepared, published, reloaded };
}

test('queued stats cannot acquire a newer source owner before the lane starts', async () => {
  const harness = createHarness();
  const ownerA = harness.controller.captureProducerOwner();

  assert.equal(harness.controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: ownerA }), true);
  harness.controller.advanceSourceEpoch();
  const ownerB = harness.controller.captureProducerOwner();
  assert.equal(harness.controller.enqueue({ stats: { source: 'hub-b' }, producerOwner: ownerB }), true);

  await harness.controller.whenIdle();

  assert.deepEqual(harness.published, [{ source: 'hub-b', history: 'hub-b' }]);
  assert.deepEqual(harness.reloaded, ['hub-b']);
  assert.equal(harness.captures.length, 2);
});

test('a late producer callback is rejected instead of being relabeled with the current epoch', async () => {
  const harness = createHarness();
  const ownerA = harness.controller.captureProducerOwner();
  harness.controller.advanceSourceEpoch();

  assert.equal(harness.controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: ownerA }), false);
  await nextTurn();

  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.published, []);
});

test('an on-off-on source transition isolates old same-source history completion', async () => {
  const oldHistory = deferred();
  let historyCalls = 0;
  const harness = createHarness({
    resolveHistory(work) {
      historyCalls += 1;
      return historyCalls === 1 ? oldHistory.promise : history(`current-${work.owner.epoch}`);
    }
  });
  const ownerOne = harness.controller.captureProducerOwner();
  harness.controller.enqueue({ stats: { source: 'enabled' }, producerOwner: ownerOne });
  await nextTurn();

  harness.controller.advanceSourceEpoch();
  harness.controller.advanceSourceEpoch();
  const ownerThree = harness.controller.captureProducerOwner();
  harness.controller.enqueue({ stats: { source: 'enabled' }, producerOwner: ownerThree });
  oldHistory.resolve(history('stale-epoch-one'));

  await harness.controller.whenIdle();

  assert.equal(historyCalls, 2);
  assert.deepEqual(harness.published, [{ source: 'enabled', history: `current-${ownerThree.epoch}` }]);
});

test('latest work supersedes an active prepared snapshot and removes its temp file', async () => {
  const firstPrepared = deferred();
  const harness = createHarness({
    async prepareSnapshot(work, resolvedHistory) {
      const value = { work, history: resolvedHistory, tempPath: `/tmp/${work.sequence}.tmp` };
      harness.prepared.push(value);
      if (work.stats.source === 'first') await firstPrepared.promise;
      return { ok: true, changed: true, prepared: value };
    }
  });
  const owner = harness.controller.captureProducerOwner();
  harness.controller.enqueue({ stats: { source: 'first' }, producerOwner: owner });
  await nextTurn();
  harness.controller.enqueue({ stats: { source: 'second' }, producerOwner: owner });
  firstPrepared.resolve();

  await harness.controller.whenIdle();

  assert.deepEqual(harness.discarded, ['/tmp/1.tmp']);
  assert.deepEqual(harness.published, [{ source: 'second', history: 'second' }]);
});

test('a transition during post-commit directory sync suppresses the stale reload', async () => {
  const syncing = deferred();
  const syncStarted = deferred();
  const harness = createHarness({
    async syncSnapshot() {
      syncStarted.resolve();
      await syncing.promise;
    }
  });
  const owner = harness.controller.captureProducerOwner();
  harness.controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: owner });
  await syncStarted.promise;

  harness.controller.advanceSourceEpoch();
  syncing.resolve();
  await harness.controller.whenIdle();

  assert.deepEqual(harness.published, [{ source: 'hub-a', history: 'hub-a' }]);
  assert.deepEqual(harness.reloaded, []);
});

test('stop invalidates pending and in-flight work and rejects old producers', async () => {
  const pendingHistory = deferred();
  const harness = createHarness({ resolveHistory: () => pendingHistory.promise });
  const owner = harness.controller.captureProducerOwner();
  harness.controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: owner });
  await nextTurn();

  harness.controller.stop();
  assert.equal(harness.controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: owner }), false);
  pendingHistory.resolve(history('hub-a'));
  await harness.controller.whenIdle();

  assert.deepEqual(harness.published, []);
  assert.deepEqual(harness.reloaded, []);
});

test('enqueue captures resolver and presentation context before live settings change', async () => {
  const gate = deferred();
  let liveSource = 'hub-a';
  let liveCurrency = 'USD';
  const published = [];
  const controller = createMacWidgetSnapshotController({
    captureWork({ stats, owner }) {
      return {
        stats,
        owner: Object.freeze({ ...owner, sourceKey: liveSource }),
        resolverConfig: Object.freeze({ source: liveSource }),
        presentation: Object.freeze({ currencyCode: liveCurrency }),
        snapshotPath: '/tmp/snapshot.json',
        widgetKind: 'TokenMonitorWidget'
      };
    },
    async resolveHistory(work) {
      await gate.promise;
      return history(work.resolverConfig.source);
    },
    async prepareSnapshot(work, resolvedHistory) {
      return { ok: true, changed: true, prepared: { work, resolvedHistory } };
    },
    commitSnapshot(value, options) {
      if (!options.isCurrent()) return { ok: false, reason: 'superseded' };
      published.push({
        history: value.resolvedHistory.summary.label,
        currency: value.work.presentation.currencyCode
      });
      return { ok: true, changed: true };
    },
    async syncSnapshot() {},
    async discardSnapshot() {},
    reloadSnapshot() {},
    logger() {}
  });
  const owner = controller.captureProducerOwner();
  controller.enqueue({ stats: { source: 'stats-a' }, producerOwner: owner });
  liveSource = 'hub-b';
  liveCurrency = 'EUR';
  gate.resolve();

  await controller.whenIdle();

  assert.deepEqual(published, [{ history: 'hub-a', currency: 'USD' }]);
});
