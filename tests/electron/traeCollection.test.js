'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTraeCollection, normalizeTraeIntervalMs } = require('../../src/electron/traeCollection');

const KEY = 'a'.repeat(64);

function fakePeriods(total = 1000) {
  return {
    today: { clients: { trae: total }, sessions: {} },
    month: { clients: { trae: total * 2 }, sessions: {} },
    allTime: { clients: { trae: total * 3 }, sessions: {} }
  };
}

let signatureCounter = 0;

function createLane(overrides = {}) {
  // The lane follows the shared collection cadence (collectionMode /
  // collectionIntervalMs); tests set those explicitly where they matter.
  const settings = { traeCollectionEnabled: true, traeDbKey: KEY };
  if (overrides.settings) Object.assign(settings, overrides.settings);
  const pushed = [];
  const deps = {
    platform: 'win32',
    dbPath: 'C:/fake/Trae CN/database.db',
    now: () => overrides.now || Date.now(),
    // Unique per call by default so existing tests never trip the P1 skip; the
    // skip/retry tests override this with a controllable signature.
    traeSourceSignature: () => `sig-${(signatureCounter += 1)}`,
    collectTraeSnapshot: () => ({ rows: [{ sessionId: 'trae:cn:s1', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], pages: 3, bytes: 12288 }),
    buildTraePeriodsNormalized: () => overrides.periods || fakePeriods(),
    buildTraeHistoryGraph: () => ({ contributions: [] }),
    extractTraeKeyFromProcess: () => ({ encKey: KEY, pid: 111 }),
    ...overrides.deps
  };
  const lane = createTraeCollection({
    getSettings: () => settings,
    updateSettings: async (patch) => { Object.assign(settings, patch); },
    pushStatus: (status) => pushed.push(status),
    log: () => {},
    userDataPath: overrides.userDataPath || '.',
    nudgeCollector: overrides.nudgeCollector,
    deps
  });
  return { lane, settings, pushed, deps };
}

test('normalizeTraeIntervalMs falls back and floors', () => {
  assert.equal(normalizeTraeIntervalMs(undefined), 1800000);
  assert.equal(normalizeTraeIntervalMs(5000), 1800000, 'below the floor falls back to the default');
  assert.equal(normalizeTraeIntervalMs(900000), 900000);
});

test('status reports unsupported, idle, and needsKey states before any collection', () => {
  const macLane = createLane({ deps: { platform: 'darwin' } });
  assert.equal(macLane.lane.status().state, 'unsupported');

  const { lane } = createLane();
  const status = lane.status();
  assert.equal(status.state, 'idle', 'a saved key without a collection is idle');
  assert.equal(status.dbFound, false);
  assert.equal(status.usage.allTime, 0);

  const needsKey = createLane({ settings: { traeDbKey: '' } });
  assert.equal(needsKey.lane.status().state, 'needsKey');
});

test('collectNow builds the snapshot, updates usage, and arms the timer', async () => {
  const { lane } = createLane();
  const status = await lane.collectNow('manual');
  assert.equal(status.state, 'ok');
  assert.equal(status.usage.today, 1000);
  assert.equal(status.usage.allTime, 3000);
  assert.equal(status.rowCount, 1);
  assert.ok(status.lastSuccessAt);
  assert.ok(status.nextCollectAt, 'the interval timer must be armed after a collect');
  lane.stop();
});

test('a failing collect maps its error code into the state', async () => {
  const failure = new Error('key does not match');
  failure.code = 'TRAE_KEY_INVALID';
  const { lane } = createLane({ deps: { collectTraeSnapshot: () => { throw failure; } } });
  const status = await lane.collectNow('manual');
  assert.equal(status.state, 'keyInvalid');
  assert.equal(status.errorCode, 'TRAE_KEY_INVALID');
  lane.stop();
});

test('extractAndSaveKey stores the key and collects right after', async () => {
  const { lane, settings } = createLane();
  settings.traeDbKey = '';
  const result = await lane.extractAndSaveKey();
  assert.equal(result.ok, true);
  assert.equal(settings.traeDbKey, KEY, 'the extracted key must be persisted via updateSettings');
  assert.equal(result.status.state, 'ok', 'a collect must follow the successful extraction');
  assert.equal(result.status.usage.today, 1000);
  lane.stop();
});

test('collection cadence follows the global Collection frequency setting', async () => {
  const { lane, settings } = createLane();
  settings.collectionMode = 'interval';
  settings.collectionIntervalMs = 900000;
  lane.onSettingsChanged();
  assert.equal(lane.status().intervalMs, 900000);

  settings.collectionMode = 'smart';
  lane.onSettingsChanged();
  assert.equal(lane.status().intervalMs, 600000);

  settings.collectionMode = 'live';
  lane.onSettingsChanged();
  assert.equal(lane.status().intervalMs, 120000, 'live keeps a two-minute backstop timer');
  lane.stop();
});

// ---- Live watch lane ----------------------------------------------------

// Controllable fake clock + timer queue + directory watcher. `fire(delayMs)`
// advances the clock and runs every pending timer whose deadline has arrived;
// `emitWatch(filename)` delivers a directory event; `emitWatchError` simulates
// a watcher failure.
function fakeTiming() {
  let clock = 0;
  const timers = [];
  const watchHandles = [];
  const fsApi = {
    existsSync: () => true,
    watch: (dir, opts, callback) => {
      const handle = { dir, callback, closed: false, listeners: {} };
      handle.on = (event, listener) => { handle.listeners[event] = listener; };
      handle.close = () => { handle.closed = true; };
      watchHandles.push(handle);
      return handle;
    }
  };
  const setWatchTimer = (callback, delay) => {
    const entry = { at: clock + delay, fired: false, cleared: false, callback, delay };
    timers.push(entry);
    return {
      unref() {},
      clear() { entry.cleared = true; }
    };
  };
  const clearWatchTimer = (handle) => { handle?.clear?.(); };
  // Signature-poll heartbeat shares the timer queue (fire() drives it) but is
  // excluded from pending(), which the watch tests query.
  const setPollTimer = (callback, delay) => {
    const entry = { at: clock + delay, fired: false, cleared: false, callback, delay, poll: true };
    timers.push(entry);
    return {
      unref() {},
      clear() { entry.cleared = true; }
    };
  };
  const clearPollTimer = (handle) => { handle?.clear?.(); };
  const pending = () => timers.filter((entry) => !entry.fired && !entry.cleared && !entry.poll);
  const pendingPoll = () => timers.filter((entry) => !entry.fired && !entry.cleared && entry.poll);
  function fire(delayMs) {
    clock += delayMs;
    for (const entry of [...timers].sort((a, b) => a.at - b.at)) {
      if (!entry.fired && !entry.cleared && entry.at <= clock) {
        entry.fired = true;
        entry.callback();
      }
    }
  }
  function emitWatch(filename) {
    for (const handle of watchHandles) {
      if (!handle.closed) handle.callback('change', filename);
    }
  }
  function emitWatchError(message) {
    for (const handle of watchHandles) {
      if (!handle.closed) handle.listeners.error?.(new Error(message));
    }
  }
  return {
    deps: { fsApi, setWatchTimer, clearWatchTimer, setPollTimer, clearPollTimer, now: () => clock },
    fire,
    emitWatch,
    emitWatchError,
    watchHandles,
    pending,
    pendingPoll,
    now: () => clock,
    setClock: (value) => { clock = value; }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('live mode watches the Trae directory and collects after the quiet window', async () => {
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();
  assert.equal(timing.watchHandles.length, 1, 'start must arm the directory watcher');
  assert.equal(lane.status().watchActive, true);

  timing.emitWatch('unrelated.log');
  assert.equal(timing.pending().length, 0, 'events for other files must be ignored');

  timing.emitWatch('database.db-wal');
  timing.emitWatch('database.db');
  assert.equal(timing.pending().length, 1, 'a burst coalesces into one quiet timer');
  assert.equal(timing.pending()[0].delay, 1500, 'the quiet window is 1.5s after the last write');

  timing.fire(1500);
  await settle();
  assert.equal(collects, 1, 'the quiet edge must trigger exactly one collect');
  assert.equal(lane.status().state, 'ok');
  lane.stop();
  assert.equal(timing.watchHandles[0].closed, true, 'stop must close the watcher');
});

test('watch events without a filename still land on the quiet window', async () => {
  // Windows directory watches omit the filename on coalesced/high-rate
  // events (WAL appends during streaming are exactly that); dropping them
  // was the "manual rescan works, automatic never" symptom.
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();

  timing.emitWatch('unrelated.log');
  assert.equal(timing.pending().length, 0, 'a named unrelated file still does not schedule');

  timing.emitWatch(undefined);
  assert.equal(timing.pending().length, 1, 'a nameless event must be treated as a relevant write');
  assert.equal(timing.pending()[0].delay, 1500);

  timing.emitWatch(null);
  timing.emitWatch('');
  assert.equal(timing.pending().length, 1, 'nameless events coalesce into the same quiet timer');

  timing.fire(1500);
  await settle();
  assert.equal(collects, 1, 'the quiet edge fires the collect');
  lane.stop();
});

test('status.lastActivityAt is the newest real turn, independent of collect time', async () => {
  const { lane } = createLane({
    deps: {
      collectTraeSnapshot: async () => ({
        rows: [
          { sessionId: 'trae:cn:s1', messageId: 'm1', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 1_000, messages: 1 },
          { sessionId: 'trae:cn:s1', messageId: 'm2', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 9_000, messages: 1 },
          { sessionId: 'trae:cn:s2', messageId: 'm3', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }
        ],
        maxId: 3, pages: 1, bytes: 4096
      })
    }
  });
  const status = await lane.collectNow('manual');
  assert.equal(status.lastActivityAt, 9_000,
    'last activity must be the max turn timestamp, not the collect time');
  assert.notEqual(status.lastActivityAt, status.capturedAt);
  assert.ok(status.capturedAt, 'the capture stamp still exists for diagnostics');
  lane.stop();
});

test('the watch min gap slides instead of stacking collects', async () => {
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();

  timing.emitWatch('database.db');
  timing.fire(1500);
  await settle();
  assert.equal(collects, 1);

  // A second burst 1s after the first collect lands inside the 4s min gap:
  // the quiet timer slides to the gap boundary instead of collecting early.
  timing.setClock(2500);
  timing.emitWatch('database.db');
  timing.fire(1500);
  await settle();
  assert.equal(collects, 1, 'inside the min gap no second collect may run');
  timing.fire(1500);
  await settle();
  assert.equal(collects, 2, 'the slid collect runs once the gap elapses');
  lane.stop();
});

test('a burst that never quiets still collects at the 8s cap', async () => {
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();

  timing.emitWatch('database.db');
  // Continuous streaming writes keep resetting the quiet edge.
  for (let at = 2000; at <= 7000; at += 1000) {
    timing.setClock(at);
    timing.emitWatch('database.db');
  }
  const scheduled = timing.pending().at(-1);
  assert.ok(scheduled, 'a quiet timer must be pending');
  assert.equal(scheduled.delay, 1000, 'the 8s cap from the first event overrides the quiet window');
  timing.fire(1000);
  await settle();
  assert.equal(collects, 1, 'the capped timer must collect');
  lane.stop();
});

test('smart and interval modes never watch', () => {
  for (const collectionMode of ['smart', 'interval']) {
    const timing = fakeTiming();
    const { lane, settings } = createLane({ deps: timing.deps });
    settings.collectionMode = collectionMode;
    lane.start();
    assert.equal(timing.watchHandles.length, 0, `${collectionMode} mode must not watch`);
    assert.equal(lane.status().watchActive, false);
    lane.stop();
    assert.equal(timing.watchHandles.length, 0);
  }
});

test('the polling heartbeat collects even when watch events never arrive', async () => {
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      traeSourceSignature: () => `sig-${Math.floor(timing.now() / 5000)}`,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [{ messageId: 'm1', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();
  assert.equal(timing.pendingPoll().length, 1, 'live mode arms the signature poller');

  // First poll: no snapshot yet, so it collects immediately.
  timing.fire(2000);
  await settle();
  assert.equal(collects, 1);

  // Still inside the same signature window: the poll must be absorbed by P1.
  timing.fire(2000);
  await settle();
  assert.equal(collects, 1, 'an unchanged signature must not re-collect');

  // Cross the signature boundary with no watch event at all — the poller
  // picks the change up on its own cadence.
  timing.fire(1000);
  timing.fire(2000);
  await settle();
  assert.equal(collects, 2, 'the poller must collect on signature changes without any watch event');

  lane.stop();
  assert.equal(timing.pendingPoll().length, 0, 'stop must cancel the poller');
});

test('smart and interval modes never run the poller', async () => {
  const timing = fakeTiming();
  const { lane, settings } = createLane({ deps: { ...timing.deps } });
  settings.collectionMode = 'smart';
  lane.onSettingsChanged();
  assert.equal(timing.pendingPoll().length, 0, 'smart mode relies on its interval alone');

  settings.collectionMode = 'interval';
  lane.onSettingsChanged();
  assert.equal(timing.pendingPoll().length, 0, 'interval mode relies on its interval alone');

  settings.collectionMode = 'live';
  lane.onSettingsChanged();
  assert.equal(timing.pendingPoll().length, 1, 'live mode re-arms the poller');
  lane.stop();
});

test('a watcher error tears the watch down and leaves the timer lane intact', async () => {
  const timing = fakeTiming();
  let collects = 0;
  const { lane } = createLane({
    deps: {
      ...timing.deps,
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  lane.start();
  assert.equal(lane.status().watchActive, true);

  timing.emitWatchError('EBADF: bad file descriptor');
  assert.equal(timing.watchHandles[0].closed, true, 'the failed watcher must be closed');
  assert.equal(lane.status().watchActive, false);
  assert.equal(lane.status().intervalMs, 120000, 'the backstop interval survives the watch failure');

  // Later directory events with no watcher are inert; the interval lane still
  // collects on demand.
  timing.emitWatch('database.db');
  assert.equal(timing.pending().length, 0);
  await lane.collectNow('manual');
  assert.equal(collects, 1);
  lane.stop();
});

test('P1 skips the decrypt when the database signature is unchanged', async () => {
  let collects = 0;
  const { lane } = createLane({
    deps: {
      traeSourceSignature: () => 'stable-sig',
      collectTraeSnapshot: async () => {
        collects += 1;
        return { rows: [{ messageId: 'm1', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  await lane.collectNow('first');
  assert.equal(collects, 1);
  await lane.collectNow('second');
  assert.equal(collects, 1, 'an unchanged signature must not re-decrypt');
  assert.equal(lane.status().state, 'ok', 'the skipped tick still reports the cached snapshot');
  lane.stop();
});

test('P1 retries after a failed collect instead of trusting a stale signature', async () => {
  let collects = 0;
  const { lane } = createLane({
    deps: {
      traeSourceSignature: () => 'stable-sig',
      collectTraeSnapshot: async () => {
        collects += 1;
        if (collects === 1) {
          const error = new Error('boom');
          error.code = 'TRAE_KEY_INVALID';
          throw error;
        }
        return { rows: [{ messageId: 'm1', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  await lane.collectNow('first');
  assert.equal(lane.status().state, 'keyInvalid');
  await lane.collectNow('second');
  assert.equal(collects, 2, 'a failed collect must not lock in the signature');
  assert.equal(lane.status().state, 'ok');
  lane.stop();
});

test('a landed snapshot nudges the shared collector so the totals refresh immediately', async () => {
  const nudges = [];
  const { lane } = createLane({ nudgeCollector: () => { nudges.push(1); } });
  await lane.collectNow('manual');
  assert.equal(nudges.length, 1, 'the collector must be asked to rebuild the summary after new data');
  lane.stop();
});

test('a P1 skip and a failed collect must not nudge the collector', async () => {
  let collects = 0;
  const nudges = [];
  const { lane } = createLane({
    nudgeCollector: () => { nudges.push(1); },
    deps: {
      traeSourceSignature: () => 'stable-sig',
      collectTraeSnapshot: async () => {
        collects += 1;
        if (collects === 1) {
          const error = new Error('boom');
          error.code = 'TRAE_KEY_INVALID';
          throw error;
        }
        return { rows: [{ messageId: 'm1', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 1, pages: 1, bytes: 4096 };
      }
    }
  });
  await lane.collectNow('first');
  assert.equal(nudges.length, 0, 'a failed collect landed no snapshot');
  await lane.collectNow('second');
  assert.equal(collects, 2);
  assert.equal(nudges.length, 1, 'the retry that landed data nudges once');
  await lane.collectNow('third');
  assert.equal(collects, 2, 'the unchanged signature skips the decrypt');
  assert.equal(nudges.length, 1, 'the P1 skip has nothing new for the totals');
  lane.stop();
});

test('a throwing collector nudge must not fail the collect', async () => {
  const { lane } = createLane({
    nudgeCollector: () => { throw new Error('nudge boom'); }
  });
  const status = await lane.collectNow('manual');
  assert.equal(status.state, 'ok', 'a broken nudge must not surface as a collect failure');
  assert.equal(status.usage.today, 1000);
  lane.stop();
});

test('P2 accumulates incremental rows and refreshes overlap by messageId', async () => {
  const calls = [];
  const { lane } = createLane({
    deps: {
      traeSourceSignature: () => `sig-${calls.length}`,
      collectTraeSnapshot: async (args) => {
        calls.push(args.sinceId);
        if (calls.length === 1) {
          return { rows: [{ messageId: 'm1', input: 10, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 1, pages: 1, bytes: 4096 };
        }
        // Second collect: m1 refreshed (streaming backfill), m2 new.
        return {
          rows: [
            { messageId: 'm1', input: 15, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 },
            { messageId: 'm2', input: 5, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }
          ],
          maxId: 2, pages: 1, bytes: 4096
        };
      },
      buildTraePeriodsNormalized: ({ rows }) => fakePeriods(rows.reduce((sum, row) => sum + row.input, 0))
    }
  });
  await lane.collectNow('first');
  assert.equal(calls[0], undefined, 'the first collect is a full read');
  assert.equal(lane.status().usage.today, 10);
  await lane.collectNow('second');
  assert.equal(calls[1], 1, 'the second collect resumes from the high-water id');
  assert.equal(lane.status().rowCount, 2);
  assert.equal(lane.status().usage.today, 20, 'm1 refreshed to 15 and m2 added 5, no double count');
  lane.stop();
});

test('P2 falls back to a full read when chat_turn is rebuilt (id regresses)', async () => {
  const calls = [];
  const { lane } = createLane({
    deps: {
      traeSourceSignature: () => `sig-${calls.length}`,
      collectTraeSnapshot: async (args) => {
        calls.push(args.sinceId);
        if (calls.length === 1) {
          return { rows: [{ messageId: 'm1', input: 10, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 900, pages: 1, bytes: 4096 };
        }
        if (calls.length === 2) {
          // Table rebuilt: MAX(id) dropped below the cursor.
          return { rows: [{ messageId: 'n1', input: 7, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 3, pages: 1, bytes: 4096 };
        }
        return { rows: [{ messageId: 'n1', input: 7, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], maxId: 3, pages: 1, bytes: 4096 };
      },
      buildTraePeriodsNormalized: ({ rows }) => fakePeriods(rows.reduce((sum, row) => sum + row.input, 0))
    }
  });
  await lane.collectNow('first');
  await lane.collectNow('second');
  assert.equal(calls[1], 900, 'the incremental attempt used the old cursor');
  assert.equal(calls[2], undefined, 'the regression triggered a full re-read');
  assert.equal(lane.status().rowCount, 1, 'stale rows were dropped on the rebuild');
  assert.equal(lane.status().usage.today, 7);
  lane.stop();
});

test('applyToSummary merges the snapshot only when enabled and supported', async () => {
  const { lane, settings } = createLane();
  await lane.collectNow('manual');
  const summary = { today: { clients: {} }, month: { clients: {} }, allTime: { clients: {} } };
  lane.applyToSummary(summary, { preview: false });
  assert.equal(summary.today.clients.trae, 1000);
  assert.equal(summary.allTime.clients.trae, 3000);

  settings.traeCollectionEnabled = false;
  const untouched = { today: { clients: {} }, month: { clients: {} }, allTime: { clients: {} } };
  lane.applyToSummary(untouched, { preview: false });
  assert.equal(untouched.today.clients.trae, undefined);
  lane.stop();
});

test('onSettingsChanged drops the snapshot when the key is removed', async () => {
  const { lane, settings } = createLane();
  await lane.collectNow('manual');
  settings.traeDbKey = '';
  lane.onSettingsChanged();
  const summary = { today: { clients: {} }, month: { clients: {} }, allTime: { clients: {} } };
  lane.applyToSummary(summary, { preview: false });
  assert.equal(summary.today.clients.trae, undefined);
  assert.equal(lane.status().state, 'needsKey');
  lane.stop();
});

// ---- TraeWork lane (source: 'traework') ---------------------------------

function fakeTraeWorkPeriods(total = 500) {
  return {
    today: { clients: { traework: total }, sessions: {} },
    month: { clients: { traework: total * 2 }, sessions: {} },
    allTime: { clients: { traework: total * 3 }, sessions: {} }
  };
}

function createTraeWorkLane(overrides = {}) {
  const settings = { traeWorkCollectionEnabled: true, traeWorkDbKey: KEY };
  if (overrides.settings) Object.assign(settings, overrides.settings);
  const pushed = [];
  const extractCalls = [];
  const deps = {
    platform: 'win32',
    dbPath: 'C:/fake/TRAE SOLO CN/database.db',
    now: () => overrides.now || Date.now(),
    traeSourceSignature: () => `sig-${(signatureCounter += 1)}`,
    collectTraeSnapshot: () => ({ rows: [{ sessionId: 'trae:work:s1', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, createdAt: 0, messages: 1 }], pages: 3, bytes: 12288 }),
    buildTraePeriodsNormalized: () => overrides.periods || fakeTraeWorkPeriods(),
    buildTraeHistoryGraph: () => ({ contributions: [] }),
    extractTraeKeyFromProcess: (args) => {
      extractCalls.push(args);
      return { encKey: KEY, pid: 222 };
    },
    ...overrides.deps
  };
  const lane = createTraeCollection({
    source: 'traework',
    getSettings: () => settings,
    updateSettings: async (patch) => { Object.assign(settings, patch); },
    pushStatus: (status) => pushed.push(status),
    log: () => {},
    userDataPath: overrides.userDataPath || '.',
    nudgeCollector: overrides.nudgeCollector,
    deps
  });
  return { lane, settings, pushed, deps, extractCalls };
}

test('the traework lane keys enabled/key state off its own settings and attributes usage to traework', async () => {
  const { lane, settings } = createTraeWorkLane();
  const status = await lane.collectNow('manual');
  assert.equal(status.state, 'ok');
  assert.equal(status.usage.today, 500, 'usage reads the traework client partition');
  assert.equal(status.usage.allTime, 1500);

  const summary = { today: { clients: {} }, month: { clients: {} }, allTime: { clients: {} } };
  lane.applyToSummary(summary, { preview: false });
  assert.equal(summary.today.clients.traework, 500);
  assert.equal(summary.today.clients.trae, undefined);

  settings.traeCollectionEnabled = false; // the Trae CN switch must not affect this lane
  settings.traeWorkCollectionEnabled = false;
  lane.onSettingsChanged();
  assert.equal(lane.status().state, 'disabled');
  lane.stop();
});

test('the traework lane extracts its key from the TRAE SOLO CN process and saves it under its own setting', async () => {
  const { lane, settings, extractCalls } = createTraeWorkLane();
  settings.traeWorkDbKey = '';
  const result = await lane.extractAndSaveKey();
  assert.equal(result.ok, true);
  assert.equal(extractCalls[0].imageName, 'TRAE SOLO CN.exe');
  assert.equal(settings.traeWorkDbKey, KEY);
  assert.equal(settings.traeDbKey, undefined, 'the Trae CN key setting must stay untouched');
  assert.equal(result.status.state, 'ok');
  lane.stop();
});

test('extracting the key while the app runs arms the live watch and poller', async () => {
  // The key lands through the lane's updateSettings seam, which bypasses the
  // settings:update diff that calls onSettingsChanged — without an explicit
  // refresh there, a first-run key extraction left the lane with no watch and
  // no poller, and updates only happened on the backstop timer or a manual
  // rescan.
  const timing = fakeTiming();
  const { lane, settings } = createTraeWorkLane({ deps: { ...timing.deps } });
  settings.traeWorkDbKey = '';
  const result = await lane.extractAndSaveKey();
  assert.equal(result.ok, true);
  assert.equal(timing.watchHandles.length, 1, 'the live watch must start after the key arrives');
  assert.equal(timing.pendingPoll().length, 1, 'the signature poller must start after the key arrives');
  assert.equal(lane.status().state, 'ok');
  lane.stop();
  assert.equal(timing.watchHandles[0].closed, true, 'stop must close the watch started by the extraction');
});
