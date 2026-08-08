'use strict';

// Rationing for the self-synced clients (cursor / antigravity), and the queue of
// source events waiting on it.
//
// Cursor and Antigravity usage only changes when their tokscale syncs run, and
// each sync is a subprocess that rewrites the tokscale cache — issue #15 is what
// happens when those spawns stop being rationed. Everything that decides *when*
// one may run lives here: how long a client must have been idle, what a failure
// does to that floor, which attempt owns the outcome, and what becomes of a
// source event that arrives inside the floor.
//
// Two objects, because the state has two lifetimes. The throttle is per process:
// the cache it protects is one directory on disk, so a collector rebuilt by a
// settings change must not hand itself a fresh allowance. The queue is per
// collector: its pending events only mean anything to the tick loop that would
// drain them, and it holds a timer that has to die with the collector that armed
// it. Keeping them in one object would have to pick one of those lifetimes and
// be wrong about the other.

const SELF_SYNC_KINDS = ['cursor', 'antigravity'];
const {
  normalizeClientSyncDetailCode,
  normalizeClientSyncExitCode,
  normalizeClientSyncFailureStage
} = require('./clientHealth');

// Re-running these syncs on every ordinary tick is pure overhead, so they keep
// their own slow cadence rather than the collector's.
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
// A watch event on an Antigravity IDE source root means the cache is now stale,
// so waiting out the idle cadence would throw away the seconds-level refresh the
// watcher exists for. It gets a shorter floor rather than no floor: `tokscale
// antigravity sync` re-fetches over RPC and rewrites *every* known session
// artifact on every run (upstream keeps `artifactHash`/`lastModifiedMs` in the
// manifest but never short-circuits on them), on top of a `ps` over the whole
// process table and an `lsof` per candidate — so its cost grows with the user's
// session count, and the hot source file is a SQLite WAL that churns for the
// whole turn. Removing the floor entirely would leave issue #15's load half
// unguarded even though its self-trigger half is structurally gone.
const SYNC_SOURCE_EVENT_MIN_INTERVAL_MS = 10 * 1000;

// What a failed sync is allowed to say about itself. A stable code rather than
// the subprocess's stderr: the outcome is reported to a hub and rendered in a
// UI, and tokscale's stderr is neither translatable nor guaranteed free of the
// user's paths. Anything unrecognised collapses to the generic code.
const SELF_SYNC_FAILURE_CODES = new Set(['sync-failed', 'sync-timeout', 'sync-spawn-failed', 'sync-exit-error']);
const FAILURE_STAGE_BY_CODE = Object.freeze({
  'sync-failed': 'unknown',
  'sync-timeout': 'timeout',
  'sync-spawn-failed': 'spawn',
  'sync-exit-error': 'process-exit'
});
const FAILURE_CODE_BY_STAGE = Object.freeze({
  unknown: 'sync-failed',
  timeout: 'sync-timeout',
  spawn: 'sync-spawn-failed',
  'process-exit': 'sync-exit-error'
});

// setTimeout stores its delay in a 32-bit signed int and silently rewrites
// anything larger — or non-finite — to 1ms, turning a "wait a while" into a
// spin. Every delay this module arms goes through here, as does every interval
// startCollector reads from configuration.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function clampTimerDelayMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(1, parsed));
}

// Whether a self-synced client is named by one of a tick's sync selections.
// `true` means all of them (the manual refresh button, where the user is
// explicitly asking for fresh numbers); an array means only those. The
// distinction matters because each sync is its own subprocess: a Cursor sign-in
// has no reason to pay for `tokscale antigravity sync`, and issue #15 is exactly
// what happens when these spawns stop being rationed.
function selfSyncSelected(selection, kind) {
  if (selection === true) return true;
  return Array.isArray(selection) && selection.includes(kind);
}

function mergeSelfSyncSelection(left, right) {
  if (left === true || right === true) return true;
  const merged = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : [])
  ];
  return merged.length ? [...new Set(merged)] : null;
}

// The rate limiter itself: last-sync stamps, the failure backoff, and the
// attempt fence that decides which in-flight sync owns the outcome. `now` is
// injectable so a test can drive the floors without touching the global clock;
// it is read per call, never captured, so patching Date.now still works.
function createSelfSyncThrottle(options = {}) {
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  const lastSyncAt = {};
  // Whether the last attempt for this kind failed. The short source floor is a
  // reward for a sync that works: once one fails there is nothing upstream to
  // say whether the cause is transient, so the client drops to the idle cadence
  // until an attempt succeeds. Expressed as the floor itself rather than as a
  // longer timer, because the floor is read from three places — the drain, the
  // catch-up arm, and the sync decision — and a backoff that only moved the
  // timer still let an unrelated client's watch event drain the failed one
  // straight back out.
  const lastSyncFailed = {};
  // stop() cannot cancel a sync already in flight — a spawned `antigravity sync`
  // runs up to 30s — so a collector rebuilt by a settings change can have the
  // previous one's attempt land after its own. Latest attempt wins: a completion
  // only writes the flag while it is still the newest attempt for its kind.
  // (lastSyncAt is deliberately left alone; an old stamp only rate-limits.)
  const attemptSeq = {};
  // Reporting state, kept apart from the three fields above because those decide
  // behaviour and these only describe it. `lastSyncAt` in particular is the
  // rate-limit anchor — `claim()` moves it, and a completion deliberately does
  // not — so it answers "when may the next sync run", never "when did one last
  // work". A diagnostic that reads it as the latter is the mistake this exists
  // to prevent.
  const lastAttemptAt = {};
  const lastSuccessAt = {};
  const lastFailureCode = {};
  const lastFailureStage = {};
  const lastDetailCode = {};
  const lastExitCode = {};
  const completedSeq = {};
  for (const kind of SELF_SYNC_KINDS) {
    lastSyncAt[kind] = 0;
    lastSyncFailed[kind] = false;
    attemptSeq[kind] = 0;
    lastAttemptAt[kind] = 0;
    lastSuccessAt[kind] = 0;
    lastFailureCode[kind] = '';
    lastFailureStage[kind] = '';
    lastDetailCode[kind] = '';
    lastExitCode[kind] = null;
    completedSeq[kind] = 0;
  }

  // Claims the right to sync `kind` now, stamping the clock when it grants one.
  function claim(kind, minIntervalMs = SYNC_MIN_INTERVAL_MS) {
    const nowMs = now();
    const elapsed = nowMs - lastSyncAt[kind];
    // A backwards clock step (an NTP correction, a VM resume) leaves a stamp in
    // the future, and a negative elapsed compares below every floor — including
    // the zero floor, which would refuse the manual refresh outright. The stamp
    // is meaningless once the clock it came from is gone, so treat it as due and
    // re-anchor. Deliberately wall-clock rather than a monotonic source: every
    // other deadline in the collector is wall-clock too, and one hybrid would be
    // worse than this guard.
    if (elapsed >= 0 && elapsed < minIntervalMs) return false;
    lastSyncAt[kind] = nowMs;
    return true;
  }

  // 0 when this kind may sync now, otherwise the milliseconds left on its floor.
  // A floor that refuses a sync has to hand back a deadline: dropping the
  // request instead would strand the change until the fallback interval, which
  // is the latency the watcher exists to remove. Same rollback handling as
  // claim — a stamp from a clock that no longer exists is not something to wait
  // out.
  function msUntilDue(kind, minIntervalMs) {
    const elapsed = now() - lastSyncAt[kind];
    if (elapsed < 0) return 0;
    return Math.max(0, minIntervalMs - elapsed);
  }

  function beginAttempt(kind) {
    attemptSeq[kind] += 1;
    lastAttemptAt[kind] = now();
    return attemptSeq[kind];
  }

  function completeAttempt(kind, attempt, failed, code = '', details = {}) {
    if (attempt !== attemptSeq[kind]) return;
    completedSeq[kind] = attempt;
    lastSyncFailed[kind] = failed;
    if (!failed) {
      lastSuccessAt[kind] = now();
      lastFailureCode[kind] = '';
      lastFailureStage[kind] = '';
      lastDetailCode[kind] = '';
      lastExitCode[kind] = null;
      return;
    }
    const requestedStage = normalizeClientSyncFailureStage(details?.failureStage);
    const failureStage = requestedStage || FAILURE_STAGE_BY_CODE[code] || 'unknown';
    lastFailureCode[kind] = SELF_SYNC_FAILURE_CODES.has(code)
      ? code
      : (FAILURE_CODE_BY_STAGE[failureStage] || 'sync-failed');
    lastFailureStage[kind] = failureStage;
    lastDetailCode[kind] = normalizeClientSyncDetailCode(details?.detailCode) || 'unknown';
    lastExitCode[kind] = normalizeClientSyncExitCode(details?.exitCode);
  }

  // A read-only view for diagnostics. `pending` is reachable rather than
  // theoretical: stop() cannot cancel a sync already in flight, so a collector
  // rebuilt by a settings change can be asked for a snapshot while the previous
  // one's subprocess is still running.
  function syncStatus(kind) {
    const started = attemptSeq[kind] || 0;
    let state = 'idle';
    if (started > 0) {
      if (completedSeq[kind] !== started) state = 'pending';
      else state = lastSyncFailed[kind] ? 'failed' : 'ok';
    }
    return {
      state,
      lastAttemptAt: lastAttemptAt[kind] || 0,
      lastSuccessAt: lastSuccessAt[kind] || 0,
      failureCode: lastFailureCode[kind] || '',
      failureStage: lastFailureStage[kind] || '',
      detailCode: lastDetailCode[kind] || '',
      exitCode: lastExitCode[kind]
    };
  }

  function sourceFloorMs(kind) {
    return lastSyncFailed[kind] ? SYNC_MIN_INTERVAL_MS : SYNC_SOURCE_EVENT_MIN_INTERVAL_MS;
  }

  // How long this kind must have been idle before a tick may sync it. An
  // explicit user action waits for nothing; a watch event on a raw source root
  // waits out the short floor; everything else keeps the idle cadence.
  function minIntervalForTick(selections, kind) {
    // A manual refresh is the user overriding the backoff on purpose.
    if (selfSyncSelected(selections.forceSelfSync, kind)) return 0;
    if (selfSyncSelected(selections.sourceSelfSync, kind)) return sourceFloorMs(kind);
    return SYNC_MIN_INTERVAL_MS;
  }

  return { claim, msUntilDue, beginAttempt, completeAttempt, sourceFloorMs, minIntervalForTick, syncStatus };
}

// The per-collector half: which clients saw a source event that has not been
// paid for yet, and the single timer that comes back for them once their floor
// clears. Kept apart from the collector's watch-target set because the two
// answer different questions — that set decides which partitions to rescan, this
// one decides which sync may skip ahead of the idle cadence. An antigravity-cli
// write lands in the first and not the second.
//
//   throttle — the shared rate limiter above; every deadline is read from it
//   retryMs  — how long to wait when the deadline lands mid-tick
//   isBusy   — whether a tick is in flight right now
//   onDue    — run a targeted catch-up tick for these clients
//
// setTimeout/clearTimeout are injectable and resolved per call, never captured:
// node:test's mock timers replace the global after this object is built, and a
// captured reference would keep running on the real clock.
function createSourceSyncQueue(options = {}) {
  const throttle = options.throttle;
  const retryMs = clampTimerDelayMs(options.retryMs, 1500);
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
  const onDue = options.onDue;
  const setTimer = (fn, ms) => (options.setTimeout || globalThis.setTimeout)(fn, ms);
  const clearTimer = (timer) => (options.clearTimeout || globalThis.clearTimeout)(timer);
  const pending = new Set();
  let catchUpTimer = null;
  let stopped = false;

  // Deliberately does not re-arm. A source event only reaches this through the
  // watcher, which is already debounced into a tick that drains the queue a
  // moment later; re-arming per event would rebuild the timer for every write in
  // a burst to land on the same deadline the drain computes anyway.
  function record(kind) {
    pending.add(kind);
  }

  // Drains only the clients whose floor has elapsed. One left behind arms a
  // catch-up for the moment it clears: a source event is a statement that the
  // cache is stale, and that stays true whether or not another event follows, so
  // the floor has to defer the sync rather than discard it. Without this a turn
  // ending inside the floor — two quick turns, or one right after startup —
  // would sit on stale numbers until the fallback interval.
  function takeDue() {
    const due = [];
    for (const kind of pending) {
      // sourceFloorMs, not the source floor constant: this runs for every
      // watcher event, so an unrelated client's write would otherwise drain a
      // backed-off client here while minIntervalForTick still refuses to sync
      // it — consuming the pending event for a sync that never runs, and losing
      // the change until the fallback interval.
      if (throttle.msUntilDue(kind, throttle.sourceFloorMs(kind)) === 0) due.push(kind);
    }
    for (const kind of due) pending.delete(kind);
    rearm();
    return due.length > 0 ? due : null;
  }

  // The one place the catch-up deadline is decided. Everything that changes the
  // pending set calls this and passes nothing: the deadline is always the
  // earliest across whatever is pending now. Handing a single client's delay in
  // is what would let one client's backoff overwrite another's nearer deadline —
  // unreachable while antigravity is the only source-sync client, but the same
  // shape of divergence that has already cost this state machine a bug.
  function rearm() {
    if (catchUpTimer) {
      clearTimer(catchUpTimer);
      catchUpTimer = null;
    }
    if (stopped || pending.size === 0) return;
    let soonestWaitMs = null;
    for (const kind of pending) {
      const waitMs = throttle.msUntilDue(kind, throttle.sourceFloorMs(kind));
      soonestWaitMs = soonestWaitMs === null ? waitMs : Math.min(soonestWaitMs, waitMs);
    }
    catchUpTimer = setTimer(() => {
      catchUpTimer = null;
      if (stopped) return;
      // Re-arm instead of queueing, and check before draining: the collector's
      // coalesce state carries the sync selections but not targetClients, so
      // folding into an in-flight tick would widen this into an all-client
      // scan — the cost the targeting exists to avoid, and it could drag an
      // unrelated Cursor sync in with it. Same reason the watch debounce
      // re-arms.
      if (isBusy()) {
        catchUpTimer = setTimer(() => {
          catchUpTimer = null;
          rearm();
        }, retryMs);
        return;
      }
      const due = takeDue();
      if (!due) return;
      onDue(due);
    }, clampTimerDelayMs(Math.max(1, soonestWaitMs), retryMs));
  }

  // A forced sync satisfies any source event already waiting on the same client:
  // it re-reads the IDE from scratch, so leaving the client pending would spend
  // a second full sync ~one floor later on a change the forced run just picked
  // up — and a manual refresh is exactly what a user reaches for when the number
  // looks stale. Called where the tick actually starts rather than where it is
  // queued, since a forced tick waiting behind another has not synced anything
  // yet; an event arriving mid-tick re-enters through the watcher.
  function acknowledge(selection) {
    if (!selection || pending.size === 0) return [];
    const acknowledged = [];
    for (const kind of [...pending]) {
      if (!selfSyncSelected(selection, kind)) continue;
      pending.delete(kind);
      acknowledged.push(kind);
    }
    // Recomputed rather than merely cancelled when the set empties: removing one
    // client can leave another pending whose deadline still has to stand.
    if (acknowledged.length > 0) rearm();
    return acknowledged;
  }

  // A sync that reported failure did not refresh the cache, so the source event
  // the tick consumed on its behalf is still outstanding. Restoring it lets the
  // catch-up retry after the floor instead of leaving the change for the
  // fallback interval. Only ever restores what that tick actually consumed: an
  // unprompted cadence sync failing against a wedged IDE must not invent a
  // pending event and turn the idle cadence into a ten-second retry loop.
  function restore(consumed, kind) {
    if (!consumed.includes(kind) || stopped) return;
    pending.add(kind);
    // The failure already moved this kind's floor to the idle cadence, so the
    // shared re-arm backs the retry off on its own — no separate backoff
    // constant, and no way for the arm and the drain to disagree.
    rearm();
  }

  function stop() {
    stopped = true;
    if (catchUpTimer) {
      clearTimer(catchUpTimer);
      catchUpTimer = null;
    }
  }

  return {
    record,
    takeDue,
    acknowledge,
    restore,
    stop,
    get size() { return pending.size; }
  };
}

module.exports = {
  clampTimerDelayMs,
  createSelfSyncThrottle,
  createSourceSyncQueue,
  mergeSelfSyncSelection,
  selfSyncSelected,
  MAX_TIMER_DELAY_MS,
  SELF_SYNC_FAILURE_CODES,
  SELF_SYNC_KINDS,
  SYNC_MIN_INTERVAL_MS,
  SYNC_SOURCE_EVENT_MIN_INTERVAL_MS
};
