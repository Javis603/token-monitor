'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createStatsPresentationCache, createStatsPublicationBatcher } = require('../../src/electron/statsPublisher');

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; }
  };
}

test('the presentation of one snapshot is projected once for every reader', () => {
  const cache = createStatsPresentationCache();
  const stats = { periods: {} };
  let projections = 0;
  const project = () => { projections += 1; return { projected: projections }; };

  const first = cache.get(stats, 'key', project);
  assert.equal(cache.get(stats, 'key', project), first);
  assert.equal(projections, 1);
});

test('a new snapshot or a new settings key projects again', () => {
  const cache = createStatsPresentationCache();
  const stats = { periods: {} };
  let projections = 0;
  const project = () => { projections += 1; return { projected: projections }; };

  const first = cache.get(stats, 'aliases-a', project);
  const second = cache.get(stats, 'aliases-b', project);
  assert.notEqual(second, first);
  assert.notEqual(cache.get({ periods: {} }, 'aliases-b', project), second);
  assert.equal(projections, 3);
  // Only the latest key is kept per snapshot; going back is a fresh projection.
  cache.get(stats, 'aliases-a', project);
  assert.equal(projections, 4);
});

test('non-object stats pass straight through the projection', () => {
  const cache = createStatsPresentationCache();
  assert.equal(cache.get(null, 'key', (stats) => stats), null);
});

test('requests inside one window publish once, at the window close', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'local', at: 'a' });
  batcher.request({ reason: 'local', at: 'b' });
  assert.equal(clock.timers.length, 1, 'a later request joins the open window rather than extending it');
  assert.equal(clock.timers[0].ms, 1000);
  assert.equal(clock.timers[0].unrefCalled, true);
  assert.deepEqual(published, []);

  clock.timers[0].fn();
  assert.deepEqual(published, [{ reason: 'local', at: 'b' }]);

  batcher.request({ reason: 'local', at: 'c' });
  assert.equal(clock.timers.length, 2, 'the next request opens a new window');
});

test('a Hub event in the batch outranks a later local tick', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.request({ reason: 'local', at: 'tick' });
  clock.timers[0].fn();
  assert.deepEqual(published, [{ reason: 'ingest', at: 'hub' }]);

  // A Hub event without a reason is still a Hub event.
  batcher.request({ reason: 'local', at: 'tick' });
  batcher.request({ reason: undefined, at: 'snapshot' });
  clock.timers[1].fn();
  assert.deepEqual(published[1], { reason: undefined, at: 'snapshot' });
});

test('flush publishes the pending batch now and closes the window', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.flush();
  assert.deepEqual(published, [], 'nothing pending publishes nothing');

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.flush();
  assert.deepEqual(published, [{ reason: 'ingest', at: 'hub' }]);
  assert.equal(clock.timers[0].cleared, true);
});

test('cancel drops the pending batch', () => {
  const clock = fakeTimers();
  const published = [];
  const batcher = createStatsPublicationBatcher({
    windowMs: 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    publish: (entry) => published.push(entry)
  });

  batcher.request({ reason: 'ingest', at: 'hub' });
  batcher.cancel();
  assert.equal(clock.timers[0].cleared, true);
  batcher.flush();
  assert.deepEqual(published, []);
});
