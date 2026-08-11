'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_DEMAND_LEASE_MS,
  DEFAULT_PROVISIONAL_LEASE_MS,
  DEFAULT_RECONCILE_MS,
  createMacWidgetDemandState
} = require('../../src/electron/macWidgetDemand');

const BASE_CLOCK = 1_000_000;
const MARKER_PATH = '/home/Library/Group Containers/group.com.tokenmonitor/widget-demand';
const PROVISIONAL_MARKER_PATH = '/home/Library/Group Containers/group.com.tokenmonitor/widget-demand-provisional';

function createHarness(options = {}, initialMarkers = {}) {
  let clock = BASE_CLOCK;
  let activations = 0;
  let intervalCallback = null;
  let watcherCallback = null;
  let watchCalls = 0;
  const markerMtime = {
    full: initialMarkers.full ?? null,
    provisional: initialMarkers.provisional ?? null
  };
  const state = createMacWidgetDemandState({
    markerPath: MARKER_PATH,
    provisionalMarkerPath: PROVISIONAL_MARKER_PATH,
    leaseMs: DEFAULT_DEMAND_LEASE_MS,
    provisionalLeaseMs: DEFAULT_PROVISIONAL_LEASE_MS,
    reconcileMs: DEFAULT_RECONCILE_MS,
    now: () => clock,
    setInterval: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearInterval: () => {
      intervalCallback = null;
    },
    watch: (_directory, callback) => {
      watchCalls += 1;
      watcherCallback = callback;
      return { close: () => { watcherCallback = null; }, on: () => {} };
    },
    fs: {
      lstatSync: (targetPath) => {
        const which = targetPath === MARKER_PATH ? 'full' : 'provisional';
        const mtime = markerMtime[which];
        if (mtime === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: mtime };
      }
    },
    onActivation: () => {
      activations += 1;
    },
    ...options
  });
  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    state,
    clock: { advance: (milliseconds) => { clock += milliseconds; } },
    marker: {
      touch: () => { markerMtime.full = clock; },
      age: (milliseconds) => { markerMtime.full = clock - milliseconds; },
      remove: () => { markerMtime.full = null; }
    },
    provisional: {
      touch: () => { markerMtime.provisional = clock; },
      age: (milliseconds) => { markerMtime.provisional = clock - milliseconds; },
      remove: () => { markerMtime.provisional = null; }
    },
    activations: () => activations,
    watchCalls: () => watchCalls,
    fireInterval() {
      if (intervalCallback) intervalCallback();
    },
    fireWatcher() {
      if (watcherCallback) watcherCallback();
    },
    flush
  };
}

test('a never-existing marker closes the gate from the first probe', () => {
  const harness = createHarness();
  assert.equal(harness.state.isInstalled(), false);
});

test('a fresh marker keeps the gate open', () => {
  const harness = createHarness({}, { full: BASE_CLOCK - 1_000 });
  assert.equal(harness.state.isInstalled(), true);
});

test('a marker as old as the lease closes the gate', () => {
  const stale = createHarness({}, { full: BASE_CLOCK - DEFAULT_DEMAND_LEASE_MS });
  assert.equal(stale.state.isInstalled(), false);
  const fresh = createHarness({}, { full: BASE_CLOCK - (DEFAULT_DEMAND_LEASE_MS - 1) });
  assert.equal(fresh.state.isInstalled(), true);
});

test('first placement fires activation the moment the watcher sees the marker', async () => {
  const harness = createHarness();
  assert.equal(harness.state.isInstalled(), false);
  harness.state.start();
  harness.marker.touch();
  harness.fireWatcher();
  await harness.flush();
  assert.equal(harness.activations(), 1);
  assert.equal(harness.state.isInstalled(), true);
});

test('a missed watcher event is caught by the reconcile poll', async () => {
  const harness = createHarness();
  harness.state.start();
  harness.marker.touch();
  harness.clock.advance(DEFAULT_RECONCILE_MS);
  harness.fireInterval();
  await harness.flush();
  assert.equal(harness.activations(), 1);
  assert.equal(harness.state.isInstalled(), true);
});

test('a stale→fresh transition fires activation', async () => {
  const harness = createHarness({}, { full: BASE_CLOCK - (DEFAULT_DEMAND_LEASE_MS + 1) });
  assert.equal(harness.state.isInstalled(), false);
  harness.state.start();
  harness.marker.touch();
  harness.fireWatcher();
  await harness.flush();
  assert.equal(harness.activations(), 1);
  assert.equal(harness.state.isInstalled(), true);
});

test('removal closes the gate without firing activation', async () => {
  const harness = createHarness({}, { full: BASE_CLOCK - 1_000 });
  assert.equal(harness.state.isInstalled(), true);
  harness.state.start();
  harness.marker.remove();
  harness.fireWatcher();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), false);
  assert.equal(harness.activations(), 0);
});

test('an unreadable marker is fail-open and never gates work', async () => {
  const messages = [];
  const harness = createHarness({
    logger: (message) => messages.push(message),
    fs: {
      lstatSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
    }
  });
  assert.equal(harness.state.isInstalled(), true);
  harness.state.start();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), true);
  assert.equal(messages.length, 1);
});

test('stop clears the interval and watcher and ignores later signals', async () => {
  const harness = createHarness();
  harness.state.start();
  harness.state.stop();
  harness.marker.touch();
  harness.fireWatcher();
  harness.fireInterval();
  await harness.flush();
  assert.equal(harness.activations(), 0);
  assert.equal(harness.state.isInstalled(), false);
});

test('start is idempotent and attaches a single watcher', () => {
  const harness = createHarness();
  harness.state.start();
  harness.state.start();
  assert.equal(harness.watchCalls(), 1);
});

test('an already-fresh marker at start does not re-fire activation', async () => {
  const harness = createHarness({}, { full: BASE_CLOCK - 1_000 });
  harness.state.start();
  harness.fireInterval();
  await harness.flush();
  assert.equal(harness.activations(), 0);
  assert.equal(harness.state.isInstalled(), true);
});

test('a provisional-only signal opens the gate without the full lease', () => {
  const harness = createHarness({}, { provisional: BASE_CLOCK - 1_000 });
  assert.equal(harness.state.isInstalled(), true);
});

test('a provisional signal as old as its short lease closes the gate', () => {
  const stale = createHarness({}, { provisional: BASE_CLOCK - DEFAULT_PROVISIONAL_LEASE_MS });
  assert.equal(stale.state.isInstalled(), false);
  const fresh = createHarness({}, { provisional: BASE_CLOCK - (DEFAULT_PROVISIONAL_LEASE_MS - 1) });
  assert.equal(fresh.state.isInstalled(), true);
});

test('a full lease overrides a stale provisional signal', () => {
  const harness = createHarness({}, {
    full: BASE_CLOCK - 1_000,
    provisional: BASE_CLOCK - DEFAULT_PROVISIONAL_LEASE_MS
  });
  assert.equal(harness.state.isInstalled(), true);
});

test('a cancelled add flow expires and a later timeline reopens the gate', async () => {
  const harness = createHarness({}, { provisional: BASE_CLOCK - 1_000 });
  assert.equal(harness.state.isInstalled(), true);
  harness.state.start();

  // The user cancels placement: the provisional signal expires on its own.
  harness.provisional.remove();
  harness.clock.advance(DEFAULT_RECONCILE_MS);
  harness.fireInterval();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), false);

  // A real placement is then confirmed: the first timeline() writes the full
  // marker, which must reopen the gate immediately.
  harness.marker.touch();
  harness.fireWatcher();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), true);
  assert.equal(harness.activations(), 1);
});

test('snapshot-only demand keeps the full lease idle so a no-widget user pays little', async () => {
  const harness = createHarness();
  harness.state.start();
  harness.provisional.touch();
  harness.fireWatcher();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), true);
  assert.equal(harness.activations(), 1);

  // The provisional lease is short: after it expires with no full marker, the
  // gate closes and a no-widget user is back to zero pipeline cost.
  harness.provisional.age(DEFAULT_PROVISIONAL_LEASE_MS);
  harness.clock.advance(DEFAULT_RECONCILE_MS);
  harness.fireInterval();
  await harness.flush();
  assert.equal(harness.state.isInstalled(), false);
});
