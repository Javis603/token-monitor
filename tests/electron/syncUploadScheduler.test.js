'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSyncUploadScheduler,
  normalizeSyncUploadIntervalMs
} = require('../../src/electron/syncUploadScheduler');

function createManualClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout(fn, delayMs) {
      const id = nextId++;
      timers.set(id, { fn, dueAt: nowMs + delayMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    jump(ms) {
      nowMs += ms;
    },
    async advance(ms) {
      nowMs += ms;
      for (;;) {
        const due = Array.from(timers.entries())
          .filter(([, timer]) => timer.dueAt <= nowMs)
          .sort((a, b) => a[1].dueAt - b[1].dueAt);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.fn();
        await Promise.resolve();
      }
    },
    timerCount() {
      return timers.size;
    }
  };
}

test('normalizeSyncUploadIntervalMs accepts live and fixed interval choices', () => {
  assert.equal(normalizeSyncUploadIntervalMs(0), 0);
  assert.equal(normalizeSyncUploadIntervalMs('600000'), 600000);
  assert.equal(normalizeSyncUploadIntervalMs(1200000), 1200000);
  assert.equal(normalizeSyncUploadIntervalMs(1800000), 1800000);
  assert.equal(normalizeSyncUploadIntervalMs('bad'), 0);
  assert.equal(normalizeSyncUploadIntervalMs('bad', 1200000), 1200000);
});

test('live upload mode posts every summary immediately', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 0,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => uploads.push(summary.id)
  });

  await scheduler.enqueue({ id: 'first' });
  await scheduler.enqueue({ id: 'second' });

  assert.deepEqual(uploads, ['first', 'second']);
  assert.equal(clock.timerCount(), 0);
});

test('interval mode uploads the first summary immediately and coalesces later updates', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => uploads.push(summary.id)
  });

  await scheduler.enqueue({ id: 'initial' });
  await scheduler.enqueue({ id: 'mid-1' });
  await scheduler.enqueue({ id: 'mid-2' });
  await clock.advance(599999);

  assert.deepEqual(uploads, ['initial']);

  await clock.advance(1);

  assert.deepEqual(uploads, ['initial', 'mid-2']);
  assert.equal(clock.timerCount(), 0);
});

test('interval mode serializes uploads and keeps the latest summary received in flight', async () => {
  const started = [];
  const completed = [];
  const clock = createManualClock();
  let activeUploads = 0;
  let maxActiveUploads = 0;
  let releasePending;
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => {
      started.push(summary.id);
      activeUploads += 1;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      if (summary.id === 'pending') {
        await new Promise((resolve) => { releasePending = resolve; });
      }
      activeUploads -= 1;
      completed.push(summary.id);
    }
  });

  await scheduler.enqueue({ id: 'initial' });
  await scheduler.enqueue({ id: 'pending' });
  clock.jump(600000);
  const flushPromise = scheduler.flush();
  await Promise.resolve();

  await scheduler.enqueue({ id: 'newer' });
  await scheduler.enqueue({ id: 'newest' });

  assert.deepEqual(started, ['initial', 'pending']);
  assert.equal(maxActiveUploads, 1);

  releasePending();
  await flushPromise;
  assert.deepEqual(completed, ['initial', 'pending']);
  assert.equal(clock.timerCount(), 1);

  await clock.advance(600000);
  await Promise.resolve();

  assert.deepEqual(started, ['initial', 'pending', 'newest']);
  assert.deepEqual(completed, ['initial', 'pending', 'newest']);
  assert.equal(maxActiveUploads, 1);
});

test('flush waits for an active upload and uploads the newest pending summary', async () => {
  const completed = [];
  const clock = createManualClock();
  let releaseActive;
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => {
      if (summary.id === 'active') {
        await new Promise((resolve) => { releaseActive = resolve; });
      }
      completed.push(summary.id);
    }
  });

  await scheduler.enqueue({ id: 'initial' });
  await scheduler.enqueue({ id: 'active' });
  clock.jump(600000);
  const activeUpload = scheduler.flush();
  await Promise.resolve();
  await scheduler.enqueue({ id: 'newer' });
  await scheduler.enqueue({ id: 'newest' });

  let flushResolved = false;
  const pendingFlush = scheduler.flush().then(() => { flushResolved = true; });
  await Promise.resolve();
  assert.equal(flushResolved, false);

  releaseActive();
  await Promise.all([activeUpload, pendingFlush]);

  assert.deepEqual(completed, ['initial', 'active', 'newest']);
  assert.equal(clock.timerCount(), 0);
});

test('a failed upload does not throttle the next summary', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => {
      uploads.push(summary.id);
      if (summary.id === 'failed') throw new Error('offline');
    }
  });

  await assert.rejects(scheduler.enqueue({ id: 'failed' }), /offline/);
  await scheduler.enqueue({ id: 'retry' });

  assert.deepEqual(uploads, ['failed', 'retry']);
  assert.equal(clock.timerCount(), 0);
});

test('a failed in-flight upload immediately retries the newest pending summary', async () => {
  const uploads = [];
  const clock = createManualClock();
  let rejectActive;
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => {
      uploads.push(summary.id);
      if (summary.id === 'failed') {
        await new Promise((_, reject) => {
          rejectActive = () => reject(new Error('offline'));
        });
      }
    }
  });

  const failedUpload = scheduler.enqueue({ id: 'failed' });
  await Promise.resolve();
  await scheduler.enqueue({ id: 'newer' });

  rejectActive();
  await assert.rejects(failedUpload, /offline/);
  assert.equal(clock.timerCount(), 1);

  await clock.advance(0);
  await Promise.resolve();

  assert.deepEqual(uploads, ['failed', 'newer']);
  assert.equal(clock.timerCount(), 0);
});

test('flush uploads the pending summary without waiting for the interval', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 1200000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => uploads.push(summary.id)
  });

  await scheduler.enqueue({ id: 'initial' });
  await scheduler.enqueue({ id: 'pending' });
  await scheduler.flush();
  await clock.advance(1200000);

  assert.deepEqual(uploads, ['initial', 'pending']);
  assert.equal(clock.timerCount(), 0);
});

test('stop clears a pending interval upload', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => uploads.push(summary.id)
  });

  await scheduler.enqueue({ id: 'initial' });
  await scheduler.enqueue({ id: 'pending' });
  scheduler.stop();
  await clock.advance(600000);

  assert.deepEqual(uploads, ['initial']);
  assert.equal(clock.timerCount(), 0);
});

test('explicit revisions prevent a stale callback from replacing newer pending data', async () => {
  const uploads = [];
  const clock = createManualClock();
  const scheduler = createSyncUploadScheduler({
    intervalMs: 600000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    upload: async (summary) => uploads.push(summary.id)
  });

  await scheduler.enqueue({ id: 'initial' }, 1);
  await scheduler.enqueue({ id: 'newer' }, 3);
  await scheduler.enqueue({ id: 'stale' }, 2);
  await scheduler.flush();

  assert.deepEqual(uploads, ['initial', 'newer']);
});
