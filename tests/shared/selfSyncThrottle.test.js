'use strict';

// The self-sync rate limiter and its queue of deferred source events, driven
// directly. tests/shared/collectorLoadGuards.test.js covers the same rules
// end-to-end through a live collector; these reach the cases that path cannot,
// because antigravity is the only source-sync client a real collector has and
// several of the rules only differ once two clients disagree.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSelfSyncThrottle,
  createSourceSyncQueue,
  mergeSelfSyncSelection,
  selfSyncSelected,
  SYNC_MIN_INTERVAL_MS,
  SYNC_SOURCE_EVENT_MIN_INTERVAL_MS
} = require('../../src/shared/selfSyncThrottle');

// A clock and a timer wheel the tests own outright, so a deadline can be
// asserted at the millisecond without sleeping or patching a global.
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: nowMs + ms });
      return seq;
    },
    clearTimeout: (id) => { timers.delete(id); },
    // Milliseconds from now until each armed timer, soonest first.
    armed: () => [...timers.values()].map((timer) => timer.at - nowMs).sort((a, b) => a - b),
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (dueId === null) break;
        timers.delete(dueId);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    }
  };
}

function settledSync(throttle, kind, { failed }) {
  const attempt = throttle.beginAttempt(kind);
  throttle.completeAttempt(kind, attempt, failed);
}

test('a claim holds the floor and stamps the clock that granted it', () => {
  const clock = fakeClock();
  const throttle = createSelfSyncThrottle({ now: clock.now });

  assert.equal(throttle.claim('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS), true);
  assert.equal(throttle.claim('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS), false);
  assert.equal(
    throttle.msUntilDue('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS),
    SYNC_SOURCE_EVENT_MIN_INTERVAL_MS
  );

  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS - 1);
  assert.equal(throttle.claim('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS), false);
  assert.equal(throttle.msUntilDue('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS), 1);

  clock.advance(1);
  assert.equal(throttle.claim('antigravity', SYNC_SOURCE_EVENT_MIN_INTERVAL_MS), true);
});

test('one kind reaching its floor does not release another', () => {
  const clock = fakeClock();
  const throttle = createSelfSyncThrottle({ now: clock.now });

  throttle.claim('cursor', 0);
  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  throttle.claim('antigravity', 0);

  assert.equal(throttle.msUntilDue('cursor', SYNC_MIN_INTERVAL_MS), SYNC_MIN_INTERVAL_MS - SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  assert.equal(throttle.msUntilDue('antigravity', SYNC_MIN_INTERVAL_MS), SYNC_MIN_INTERVAL_MS);
});

test('a stamp left in the future by a backwards clock step is not waited out', () => {
  // An NTP correction or a VM resume can move the clock backwards. A negative
  // elapsed compares below every floor — including the zero floor a manual
  // refresh uses, which would then be refused outright.
  const clock = fakeClock(10 * 60 * 1000);
  const throttle = createSelfSyncThrottle({ now: clock.now });
  throttle.claim('antigravity', 0);

  clock.advance(-5 * 60 * 1000);
  assert.equal(throttle.msUntilDue('antigravity', SYNC_MIN_INTERVAL_MS), 0);
  assert.equal(throttle.claim('antigravity', SYNC_MIN_INTERVAL_MS), true);
  // Re-anchored to the stepped clock, so the floor applies again from here.
  assert.equal(throttle.claim('antigravity', SYNC_MIN_INTERVAL_MS), false);
});

test('a failure drops the source floor to the idle cadence until one succeeds', () => {
  const throttle = createSelfSyncThrottle({ now: fakeClock().now });
  assert.equal(throttle.sourceFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);

  settledSync(throttle, 'antigravity', { failed: true });
  assert.equal(throttle.sourceFloorMs('antigravity'), SYNC_MIN_INTERVAL_MS);
  // The backoff is per client: a wedged Antigravity language server must not
  // park Cursor on the slow cadence too.
  assert.equal(throttle.sourceFloorMs('cursor'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);

  settledSync(throttle, 'antigravity', { failed: false });
  assert.equal(throttle.sourceFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
});

test('a failed sync keeps bounded stage and exit metadata without retaining stderr', () => {
  const throttle = createSelfSyncThrottle({ now: () => 1 });
  const attempt = throttle.beginAttempt('antigravity');
  throttle.completeAttempt('antigravity', attempt, true, 'sync-exit-error', {
    failureStage: 'process-exit',
    exitCode: 17,
    stderr: 'ENOENT: /Users/alice/.gemini/private'
  });

  assert.deepEqual(throttle.syncStatus('antigravity'), {
    state: 'failed',
    lastAttemptAt: 1,
    lastSuccessAt: 0,
    failureCode: 'sync-exit-error',
    failureStage: 'process-exit',
    detailCode: 'unknown',
    exitCode: 17
  });
  assert.equal(JSON.stringify(throttle.syncStatus('antigravity')).includes('alice'), false);
});

test('failure stage infers the stable code when a producer supplies only stage metadata', () => {
  const throttle = createSelfSyncThrottle({ now: () => 1 });
  const attempt = throttle.beginAttempt('cursor');
  throttle.completeAttempt('cursor', attempt, true, '', { failureStage: 'timeout' });
  assert.equal(throttle.syncStatus('cursor').failureCode, 'sync-timeout');
  assert.equal(throttle.syncStatus('cursor').failureStage, 'timeout');
  assert.equal(throttle.syncStatus('cursor').detailCode, 'unknown');
});

test('a superseded attempt cannot rewrite the current backoff', () => {
  // stop() cannot cancel a sync already in flight, so a collector rebuilt by a
  // settings change can have the previous one's attempt land after its own.
  const throttle = createSelfSyncThrottle({ now: fakeClock().now });

  const stale = throttle.beginAttempt('antigravity');
  const live = throttle.beginAttempt('antigravity');

  throttle.completeAttempt('antigravity', live, false);
  throttle.completeAttempt('antigravity', stale, true);
  assert.equal(throttle.sourceFloorMs('antigravity'), SYNC_SOURCE_EVENT_MIN_INTERVAL_MS, 'the stale failure was ignored');

  const staleOk = throttle.beginAttempt('antigravity');
  const liveFail = throttle.beginAttempt('antigravity');
  throttle.completeAttempt('antigravity', liveFail, true);
  throttle.completeAttempt('antigravity', staleOk, false);
  assert.equal(throttle.sourceFloorMs('antigravity'), SYNC_MIN_INTERVAL_MS, 'the stale success did not clear the live backoff');
});

test('the tick floor follows the selection that asked for the sync', () => {
  const throttle = createSelfSyncThrottle({ now: fakeClock().now });

  assert.equal(throttle.minIntervalForTick({}, 'antigravity'), SYNC_MIN_INTERVAL_MS);
  assert.equal(
    throttle.minIntervalForTick({ sourceSelfSync: ['antigravity'] }, 'antigravity'),
    SYNC_SOURCE_EVENT_MIN_INTERVAL_MS
  );
  // A manual refresh overrides the backoff on purpose; a source event does not.
  assert.equal(throttle.minIntervalForTick({ forceSelfSync: true }, 'antigravity'), 0);
  settledSync(throttle, 'antigravity', { failed: true });
  assert.equal(
    throttle.minIntervalForTick({ sourceSelfSync: ['antigravity'] }, 'antigravity'),
    SYNC_MIN_INTERVAL_MS
  );
  assert.equal(throttle.minIntervalForTick({ forceSelfSync: true }, 'antigravity'), 0);
  // A scoped force names one client and must not widen to the other.
  assert.equal(throttle.minIntervalForTick({ forceSelfSync: ['cursor'] }, 'antigravity'), SYNC_MIN_INTERVAL_MS);
});

function queueHarness(overrides = {}) {
  const clock = fakeClock();
  const throttle = createSelfSyncThrottle({ now: clock.now });
  const drained = [];
  let busy = false;
  const queue = createSourceSyncQueue({
    throttle,
    retryMs: 1500,
    isBusy: () => busy,
    onDue: (clients) => drained.push(clients),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides
  });
  return {
    clock,
    throttle,
    queue,
    drained,
    setBusy: (value) => { busy = value; }
  };
}

test('recording an event does not arm a timer on its own', () => {
  // The watcher is already debounced into a tick that drains the queue a moment
  // later, so re-arming per event would rebuild the timer for every write in a
  // burst only to land on the deadline the drain computes anyway.
  const { clock, queue } = queueHarness();
  queue.record('antigravity');
  assert.deepEqual(clock.armed(), []);
  assert.equal(queue.size, 1);
});

test('a drain inside the floor defers the event instead of dropping it', () => {
  const { clock, throttle, queue, drained } = queueHarness();
  throttle.claim('antigravity', 0);

  queue.record('antigravity');
  assert.equal(queue.takeDue(), null, 'nothing is due yet');
  assert.deepEqual(clock.armed(), [SYNC_SOURCE_EVENT_MIN_INTERVAL_MS]);

  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  assert.deepEqual(drained, [['antigravity']]);
  assert.equal(queue.size, 0);
  assert.deepEqual(clock.armed(), [], 'an empty queue leaves nothing armed');
});

test('the catch-up deadline is the earliest across everything pending', () => {
  // Handing a single client's delay to the arm is what would let one client's
  // backoff overwrite another's nearer deadline.
  const { clock, throttle, queue, drained } = queueHarness();
  throttle.claim('cursor', 0);
  throttle.claim('antigravity', 0);
  settledSync(throttle, 'cursor', { failed: true });

  queue.record('cursor');
  queue.record('antigravity');
  assert.equal(queue.takeDue(), null);
  assert.deepEqual(clock.armed(), [SYNC_SOURCE_EVENT_MIN_INTERVAL_MS], 'the fast client sets the deadline');

  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  assert.deepEqual(drained, [['antigravity']], 'the backed-off client is not dragged out with it');
  assert.deepEqual(
    clock.armed(),
    [SYNC_MIN_INTERVAL_MS - SYNC_SOURCE_EVENT_MIN_INTERVAL_MS],
    're-armed on what is left'
  );

  clock.advance(SYNC_MIN_INTERVAL_MS);
  assert.deepEqual(drained, [['antigravity'], ['cursor']]);
});

test('an unrelated drain cannot spend a backed-off client\'s pending event', () => {
  // takeDue runs for every watcher event. Draining on the source floor rather
  // than the client's own would consume the event for a sync the tick then
  // refuses, losing the change until the fallback interval.
  const { clock, throttle, queue } = queueHarness();
  throttle.claim('antigravity', 0);
  settledSync(throttle, 'antigravity', { failed: true });
  queue.record('antigravity');

  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS + 1);
  assert.equal(queue.takeDue(), null, 'still inside the idle cadence it was backed off to');
  assert.equal(queue.size, 1);
});

test('a deadline landing mid-tick retries rather than widening the tick', () => {
  // Folding into an in-flight tick would carry the sync selection but not the
  // target clients, turning a one-partition catch-up into an all-client scan.
  const { clock, throttle, queue, drained, setBusy } = queueHarness();
  throttle.claim('antigravity', 0);
  queue.record('antigravity');
  queue.takeDue();

  setBusy(true);
  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  assert.deepEqual(drained, [], 'held back while a tick is in flight');
  assert.deepEqual(clock.armed(), [1500], 'retries one watch debounce later');

  clock.advance(1500);
  assert.deepEqual(drained, [], 'still busy');

  setBusy(false);
  clock.advance(1500);
  assert.deepEqual(drained, [['antigravity']]);
});

test('a forced sync acknowledges only the clients it names', () => {
  const { clock, throttle, queue } = queueHarness();
  throttle.claim('cursor', 0);
  throttle.claim('antigravity', 0);
  settledSync(throttle, 'cursor', { failed: true });
  queue.record('cursor');
  queue.record('antigravity');
  queue.takeDue();
  assert.deepEqual(clock.armed(), [SYNC_SOURCE_EVENT_MIN_INTERVAL_MS]);

  assert.deepEqual(queue.acknowledge(['antigravity']), ['antigravity']);
  assert.equal(queue.size, 1);
  // Recomputed rather than merely cancelled: removing one client leaves
  // another pending whose deadline still has to stand.
  assert.deepEqual(clock.armed(), [SYNC_MIN_INTERVAL_MS]);

  assert.deepEqual(queue.acknowledge(true), ['cursor']);
  assert.equal(queue.size, 0);
  assert.deepEqual(clock.armed(), []);
});

test('a failed sync puts back the event the tick consumed for it', () => {
  const { clock, throttle, queue } = queueHarness();
  throttle.claim('antigravity', 0);
  queue.record('antigravity');
  clock.advance(SYNC_SOURCE_EVENT_MIN_INTERVAL_MS);
  assert.deepEqual(queue.takeDue(), ['antigravity']);
  assert.deepEqual(clock.armed(), []);

  throttle.claim('antigravity', 0);
  settledSync(throttle, 'antigravity', { failed: true });
  queue.restore(['antigravity'], 'antigravity');
  assert.equal(queue.size, 1);
  // The failure already moved the floor, so the shared re-arm backs the retry
  // off on its own — no separate backoff constant to disagree with.
  assert.deepEqual(clock.armed(), [SYNC_MIN_INTERVAL_MS]);
});

test('a cadence sync failing on its own does not invent a pending event', () => {
  // An unprompted five-minute sync failing against a wedged IDE must not turn
  // the idle cadence into a ten-second retry loop.
  const { clock, queue } = queueHarness();
  queue.restore([], 'antigravity');
  assert.equal(queue.size, 0);
  assert.deepEqual(clock.armed(), []);
});

test('stopping cancels the catch-up and refuses later restores', () => {
  const { clock, throttle, queue, drained } = queueHarness();
  throttle.claim('antigravity', 0);
  queue.record('antigravity');
  queue.takeDue();
  assert.deepEqual(clock.armed(), [SYNC_SOURCE_EVENT_MIN_INTERVAL_MS]);

  queue.stop();
  assert.deepEqual(clock.armed(), []);

  // A sync spawned before stop() can still report failure afterwards; there is
  // no collector left to run the catch-up it would ask for, so the event is not
  // taken back either — rearm() would refuse to arm for it regardless, but a
  // dead queue should not be accumulating state for nobody.
  const pendingBefore = queue.size;
  queue.restore(['cursor'], 'cursor');
  assert.equal(queue.size, pendingBefore);
  assert.deepEqual(clock.armed(), []);
  clock.advance(SYNC_MIN_INTERVAL_MS);
  assert.deepEqual(drained, []);
});

test('sync selections read `true` as every client and an array as only its own', () => {
  assert.equal(selfSyncSelected(true, 'cursor'), true);
  assert.equal(selfSyncSelected(['cursor'], 'cursor'), true);
  assert.equal(selfSyncSelected(['cursor'], 'antigravity'), false);
  assert.equal(selfSyncSelected(null, 'cursor'), false);

  assert.equal(mergeSelfSyncSelection(null, null), null);
  assert.equal(mergeSelfSyncSelection(true, ['cursor']), true);
  assert.equal(mergeSelfSyncSelection(['cursor'], true), true);
  assert.deepEqual(mergeSelfSyncSelection(['cursor'], ['antigravity']), ['cursor', 'antigravity']);
  assert.deepEqual(mergeSelfSyncSelection(['cursor'], ['cursor']), ['cursor']);
  assert.deepEqual(mergeSelfSyncSelection(null, ['cursor']), ['cursor']);
});
