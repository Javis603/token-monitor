'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMacWidgetSnapshotController } = require('../../src/electron/macWidgetSnapshotController');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function history(label) {
  return { daily: [], monthly: [], summary: { label } };
}

test('the controller resolves and publishes from one immutable captured config', async () => {
  const gate = deferred();
  let liveSource = 'hub-a';
  const published = [];
  const controller = createMacWidgetSnapshotController({
    captureWork({ stats, owner }) {
      const resolverConfig = Object.freeze({ source: liveSource });
      return {
        stats,
        owner: Object.freeze({ ...owner, sourceKey: resolverConfig.source }),
        resolverConfig,
        presentation: Object.freeze({ currencyCode: 'USD' }),
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
      published.push({ stats: value.work.stats.source, history: value.resolvedHistory.summary.label });
      return { ok: true, changed: true };
    },
    async syncSnapshot() {},
    async discardSnapshot() {},
    reloadSnapshot() {},
    logger() {}
  });
  const producerOwner = controller.captureProducerOwner();
  controller.enqueue({ stats: { source: 'stats-a' }, producerOwner });
  liveSource = 'hub-b';
  gate.resolve();

  await controller.whenIdle();

  assert.deepEqual(published, [{ stats: 'stats-a', history: 'hub-a' }]);
});

test('a superseded history result cannot publish before queued current work', async () => {
  const oldHistory = deferred();
  const published = [];
  const controller = createMacWidgetSnapshotController({
    captureWork({ stats, owner }) {
      return {
        stats,
        owner: Object.freeze({ ...owner, sourceKey: stats.source }),
        resolverConfig: Object.freeze({ source: stats.source }),
        presentation: Object.freeze({}),
        snapshotPath: '/tmp/snapshot.json',
        widgetKind: 'TokenMonitorWidget'
      };
    },
    resolveHistory(work) {
      return work.stats.source === 'hub-a' ? oldHistory.promise : history('hub-b');
    },
    async prepareSnapshot(work, resolvedHistory) {
      return { ok: true, changed: true, prepared: { work, resolvedHistory } };
    },
    commitSnapshot(value, options) {
      if (!options.isCurrent()) return { ok: false, reason: 'superseded' };
      published.push(value.resolvedHistory.summary.label);
      return { ok: true, changed: true };
    },
    async syncSnapshot() {},
    async discardSnapshot() {},
    reloadSnapshot() {},
    logger() {}
  });

  const ownerA = controller.captureProducerOwner();
  controller.enqueue({ stats: { source: 'hub-a' }, producerOwner: ownerA });
  await new Promise((resolve) => setImmediate(resolve));
  controller.advanceProducerAndSourceEpoch();
  const ownerB = controller.captureProducerOwner();
  controller.enqueue({ stats: { source: 'hub-b' }, producerOwner: ownerB });
  oldHistory.resolve(history('hub-a'));

  await controller.whenIdle();

  assert.deepEqual(published, ['hub-b']);
});
