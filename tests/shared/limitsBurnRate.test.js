'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LIMITS_URGENCY_FLOOR_MS,
  LIMITS_URGENCY_SAMPLES_AHEAD,
  createLimitsBurnState,
  markLimitsProbeSuccess,
  nextLimitsUrgencyRefresh,
  pruneLimitsBurnState,
  recordLimitsUrgencyAttempt,
  recordLimitsSample
} = require('../../src/shared/limitsBurnRate');

const BASE_MS = 300_000;

function summary(windows, options = {}) {
  return {
    providers: [{
      provider: options.provider || 'claude',
      accountKey: options.accountKey || 'acct',
      accountEmail: '',
      accountLabel: options.accountLabel || 'Account',
      accountName: '',
      sourceDetail: '',
      status: options.status || 'ok',
      updatedAt: options.updatedAt,
      windows
    }]
  };
}

function sessionWindow(usedPercent, extra = {}) {
  return { kind: 'session', label: '5-hour', usedPercent, resetsAt: null, ...extra };
}

// Stands in for the runtime, which marks an identity measurable only after one
// of its own probes commits successfully.
function sample(state, limits, nowMs) {
  for (const provider of limits.providers) markLimitsProbeSuccess(state, provider);
  recordLimitsSample(state, limits, nowMs);
}

function next(limits, state, nowMs, baseRefreshMs = BASE_MS) {
  return nextLimitsUrgencyRefresh(limits, state, nowMs, { baseRefreshMs });
}

test('a single sample carries no rate, so nothing is scheduled', () => {
  const state = createLimitsBurnState();
  const limits = summary([sessionWindow(88)], { updatedAt: 'a' });
  sample(state, limits, 0);
  assert.equal(next(limits, state, 0), null);
});

// The reported case: the very poll that shows "12% left" already carries the
// 4%/min it took to get there, so it schedules the next one at the floor rather
// than a full base interval later.
test('a burning window schedules an early refresh anchored to the last sample', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(68)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(88)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);

  const due = next(limits, state, BASE_MS);
  assert.ok(due);
  // remaining 12% / (20% per 300s) = 180s to exhaustion; 180s / 4 = 45s, floored to 60s.
  assert.equal(due.refreshAt, BASE_MS + LIMITS_URGENCY_FLOOR_MS);
  assert.equal(due.delayMs, LIMITS_URGENCY_FLOOR_MS);
  assert.deepEqual(due.scopes.map((scope) => scope.provider), ['claude']);
  assert.equal(due.scopes[0].accountKey, 'acct');
});

test('a delay above the floor is used verbatim', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(60)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(80)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);

  // remaining 20% / (20% per 300s) = 300s to exhaustion; 300s / 4 = 75s.
  assert.equal(next(limits, state, BASE_MS).delayMs, 75_000);
});

// The case a plain "remaining < 20%" threshold gets wrong: the quota is low but
// nothing is consuming it, so the base cadence is already enough.
test('a low but idle window schedules nothing', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(85)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(85)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  assert.equal(next(limits, state, BASE_MS), null);
});

// The mirror case: burning hard, but far enough from exhaustion that the base
// cadence still bounds the error to something harmless.
test('a burning window with plenty of headroom schedules nothing', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(0)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(10)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  assert.equal(next(limits, state, BASE_MS), null);
});

test('an exhausted window schedules nothing', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(80)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(100)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  assert.equal(next(limits, state, BASE_MS), null);
});

// remainingPercent for a balance is a display-layer derivation that never
// reaches the wire, so these windows cannot be reasoned about here.
test('credits windows are ignored', () => {
  const state = createLimitsBurnState();
  const credits = (used) => ({ kind: 'monthly', metric: 'credits', label: 'Balance', usedPercent: used });
  sample(state, summary([credits(68)], { updatedAt: 'a' }), 0);
  const limits = summary([credits(88)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  assert.equal(next(limits, state, BASE_MS), null);
});

test('windows without a usable percentage are never recorded', () => {
  const state = createLimitsBurnState();
  const bare = (used) => ({ kind: 'session', label: '5-hour', usedPercent: used });
  sample(state, summary([bare(null)], { updatedAt: 'a' }), 0);
  const limits = summary([bare(null)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  // Asserted on the state, not only on the schedule: two coerced zeroes also
  // produce no schedule, so a rate of nothing is not evidence of nothing stored.
  assert.equal(state.windows.size, 0);
  assert.equal(next(limits, state, BASE_MS), null);
});

// normalizeLimitWindow leaves usedPercent null whenever no explicit percentage
// is given and used/limit cannot derive one, so this is a shape the wire really
// carries rather than a defensive hypothetical.
test('an underivable percentage does not become a zero baseline', () => {
  const state = createLimitsBurnState();
  const bare = (used) => ({ kind: 'session', label: '5-hour', usedPercent: used });
  sample(state, summary([bare(null)], { updatedAt: 'a' }), 0);
  const limits = summary([bare(80)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  // The first real reading is a baseline, not an 80-point burn.
  assert.equal([...state.windows.values()][0].rate, 0);
  assert.equal(next(limits, state, BASE_MS), null);
});

// A failed probe keeps the last good windows and its original updatedAt. Reading
// that as a fresh sample would score the failure as "nothing burned" and relax
// the cadence at exactly the wrong moment.
test('a repeated updatedAt records no new sample', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(68)], { updatedAt: 'a' }), 0);
  const stale = summary([sessionWindow(68)], { updatedAt: 'a' });
  sample(state, stale, BASE_MS);
  assert.equal(next(stale, state, BASE_MS), null);

  const fresh = summary([sessionWindow(88)], { updatedAt: 'b' });
  sample(state, fresh, BASE_MS * 2);
  // 20 points over both intervals from the one real sample, not over the last.
  assert.equal(next(fresh, state, BASE_MS * 2).delayMs, 90_000);
});

test('a window reset re-baselines instead of producing a negative rate', () => {
  const rateOf = (state) => [...state.windows.values()][0].rate;
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(90, { resetsAt: '2026-08-13T01:00:00.000Z' })], { updatedAt: 'a' }), 0);
  const reset = summary([sessionWindow(2, { resetsAt: '2026-08-13T06:00:00.000Z' })], { updatedAt: 'b' });
  sample(state, reset, BASE_MS);
  assert.equal(rateOf(state), 0);
  assert.equal(next(reset, state, BASE_MS), null);

  const after = summary([sessionWindow(22, { resetsAt: '2026-08-13T06:00:00.000Z' })], { updatedAt: 'c' });
  sample(state, after, BASE_MS * 2);
  // Measured from the post-reset baseline: 2% -> 22% is 20 points, not -68.
  assert.equal(rateOf(state), 20 / BASE_MS);
});

test('a percentage that drops without a reset stamp also re-baselines', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(90)], { updatedAt: 'a' }), 0);
  const dropped = summary([sessionWindow(30)], { updatedAt: 'b' });
  sample(state, dropped, BASE_MS);
  assert.equal([...state.windows.values()][0].rate, 0);
  assert.equal(next(dropped, state, BASE_MS), null);

  sample(state, summary([sessionWindow(50)], { updatedAt: 'c' }), BASE_MS * 2);
  assert.equal([...state.windows.values()][0].rate, 20 / BASE_MS);
});

test('the rate reacts at once to a faster burn and decays slowly when it stops', () => {
  const state = createLimitsBurnState();
  const key = () => [...state.windows.values()][0].rate;
  sample(state, summary([sessionWindow(0)], { updatedAt: 'a' }), 0);
  sample(state, summary([sessionWindow(20)], { updatedAt: 'b' }), BASE_MS);
  const peak = key();
  assert.ok(peak > 0);

  sample(state, summary([sessionWindow(20)], { updatedAt: 'c' }), BASE_MS * 2);
  const once = key();
  sample(state, summary([sessionWindow(20)], { updatedAt: 'd' }), BASE_MS * 3);
  const twice = key();
  assert.ok(once < peak && once > 0, 'one quiet interval only decays the rate');
  assert.ok(twice < once && twice > 0, 'the decay continues');

  sample(state, summary([sessionWindow(40)], { updatedAt: 'e' }), BASE_MS * 4);
  assert.equal(key(), peak, 'a renewed burn is adopted immediately');
});

test('the most urgent window of a provider wins', () => {
  const state = createLimitsBurnState();
  const windows = (session, weekly) => [
    sessionWindow(session),
    { kind: 'weekly', label: 'Weekly', usedPercent: weekly, resetsAt: null }
  ];
  sample(state, summary(windows(60, 10), { updatedAt: 'a' }), 0);
  const limits = summary(windows(80, 20), { updatedAt: 'b' });
  sample(state, limits, BASE_MS);

  // session: 20% left at 20 points/300s -> 75s. weekly: 80% left -> above base.
  const due = next(limits, state, BASE_MS);
  assert.equal(due.delayMs, 75_000);
  assert.equal(due.scopes.length, 1);
});

test('the earliest provider wins and only its scope is returned', () => {
  const state = createLimitsBurnState();
  const both = (claudeUsed, kimiUsed, updatedAt) => ({
    providers: [
      summary([sessionWindow(claudeUsed)], { provider: 'claude', accountKey: 'c', updatedAt }).providers[0],
      summary([sessionWindow(kimiUsed)], { provider: 'kimi', accountKey: 'k', updatedAt }).providers[0]
    ]
  });
  sample(state, both(60, 60, 'a'), 0);
  const limits = both(88, 80, 'b');
  sample(state, limits, BASE_MS);

  const due = next(limits, state, BASE_MS);
  assert.deepEqual(due.scopes.map((scope) => scope.provider), ['claude']);
  assert.equal(due.delayMs, LIMITS_URGENCY_FLOOR_MS);
});

// Without this a provider whose probe keeps failing would never move its sample
// forward, leaving a deadline permanently in the past to fire on every rebuild.
test('a fired attempt holds the provider off for a full floor', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(68)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(88)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);

  const due = next(limits, state, BASE_MS);
  recordLimitsUrgencyAttempt(state, due.keys, due.refreshAt);
  const again = next(limits, state, due.refreshAt);
  assert.equal(again.refreshAt, due.refreshAt + LIMITS_URGENCY_FLOOR_MS);
});

test('state for providers and windows that disappear is dropped', () => {
  const state = createLimitsBurnState();
  const limits = summary([sessionWindow(60)], { updatedAt: 'a' });
  sample(state, limits, 0);
  recordLimitsUrgencyAttempt(state, ['claude:acct::Account'], 0);
  assert.equal(state.windows.size, 1);
  assert.equal(state.attempts.size, 1);

  pruneLimitsBurnState(state, limits);
  assert.equal(state.windows.size, 1);
  assert.equal(state.attempts.size, 1);

  pruneLimitsBurnState(state, { providers: [] });
  assert.equal(state.windows.size, 0);
  assert.equal(state.attempts.size, 0);
});

test('a base interval at or below the floor disables the early refresh entirely', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(68)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(88)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);
  assert.equal(next(limits, state, BASE_MS, LIMITS_URGENCY_FLOOR_MS), null);
});

test('a provider with a probe in flight is skipped entirely', () => {
  const state = createLimitsBurnState();
  sample(state, summary([sessionWindow(68)], { updatedAt: 'a' }), 0);
  const limits = summary([sessionWindow(88)], { updatedAt: 'b' });
  sample(state, limits, BASE_MS);

  const due = next(limits, state, BASE_MS);
  state.inFlight.add(due.keys[0]);
  assert.equal(next(limits, state, BASE_MS), null);
  state.inFlight.delete(due.keys[0]);
  assert.deepEqual(next(limits, state, BASE_MS), due);
});

// The runtime pairs keys[i] with scopes[i] to mark the right provider in flight,
// so a tie has to keep both arrays in step.
test('keys and scopes are returned in the same order', () => {
  const state = createLimitsBurnState();
  const both = (used, updatedAt) => ({
    providers: [
      summary([sessionWindow(used)], { provider: 'claude', accountKey: 'c', updatedAt }).providers[0],
      summary([sessionWindow(used)], { provider: 'kimi', accountKey: 'k', updatedAt }).providers[0]
    ]
  });
  sample(state, both(60, 'a'), 0);
  const limits = both(88, 'b');
  sample(state, limits, BASE_MS);

  const due = next(limits, state, BASE_MS);
  assert.equal(due.keys.length, 2);
  assert.deepEqual(
    due.keys,
    due.scopes.map((scope) => `${scope.provider}:${scope.accountKey}::${scope.accountLabel}`)
  );
});

test('the sampling constants are the documented ones', () => {
  assert.equal(LIMITS_URGENCY_FLOOR_MS, 60_000);
  assert.equal(LIMITS_URGENCY_SAMPLES_AHEAD, 4);
});
