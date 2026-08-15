'use strict';

// Polling shows a quota's remaining percentage as an *upper* bound: whatever was
// consumed since the last probe is invisible, and that error grows with the
// burn rate. Harmless at 90% remaining, and exactly the wrong direction at 10%.
//
// So the interval is driven by time-to-exhaustion rather than by a "remaining <
// N%" threshold. A threshold is wrong at both ends: it polls all night for a low
// but idle quota, and stays slow for one that is being consumed fast from a
// comfortable level. The single quantity that captures both is
//
//   ttl   = remainingPercent / burnRate
//   delay = ttl / LIMITS_URGENCY_SAMPLES_AHEAD
//
// Read that as a control target, NOT an invariant: *while the observed rate
// holds*, roughly 1/SAMPLES_AHEAD of what is left is consumed before the next
// probe. It is not a bound anyone can rely on, because the rate is measured
// between two samples and says nothing about acceleration inside the next gap:
// an idle quota that suddenly burns at ten times the last observed rate is
// exactly the case polling cannot see. Do not restate this as a guarantee.
//
// Idle quotas produce a zero rate and fall straight back to the configured
// cadence, so the steady state costs nothing, and the schedule only ever
// *shortens* the base interval, never lengthens it.

// Adaptive is its own scheduling policy, not a modifier on the fixed intervals:
// picking it means "5 minutes normally, faster when a quota is about to run
// out". The fixed 1/2/5/15/30 options keep their exact previous meaning, so
// there is deliberately no per-interval floor to derive.
const LIMITS_ADAPTIVE_BASE_MS = 5 * 60_000;
const LIMITS_URGENCY_FLOOR_MS = 60_000;
const LIMITS_URGENCY_SAMPLES_AHEAD = 4;
// Asymmetric on purpose. A faster burn is adopted at once, while a quiet
// interval only decays the estimate: pausing to read code at 8% remaining must
// not relax the cadence back to the base interval just in time for the next
// burst to land unseen.
const LIMITS_URGENCY_RELEASE_WEIGHT = 0.3;

function text(value) {
  return String(value ?? '').trim();
}

// Mirrors the provider key in limitResetBoundary.js rather than the runtime's
// lane identity: this key only has to be stable and unique per account within
// this module, and matching the other snapshot-driven scheduler keeps the two
// reading the same way. A label rename restarts that window's history, which
// self-heals on the next two samples.
function providerIdentityKey(provider) {
  return [
    provider?.provider,
    provider?.accountKey,
    provider?.accountEmail,
    provider?.accountLabel
  ].map(text).join(':');
}

function providerScope(provider) {
  return {
    provider: text(provider?.provider),
    accountKey: text(provider?.accountKey),
    accountEmail: text(provider?.accountEmail).toLowerCase(),
    accountName: text(provider?.accountName),
    accountLabel: text(provider?.accountLabel),
    sourceDetail: text(provider?.sourceDetail)
  };
}

// Same triple the OpenCode window merge keys on, so a provider that reorders or
// relabels its windows keeps its history instead of silently restarting it.
function windowKey(window) {
  return [window?.kind, window?.metric, window?.label].map(text).join(':');
}

// A balance window's headline is money; its remainingPercent is derived in the
// display layer and deliberately absent from the wire, so there is nothing here
// to measure a rate against.
function measurableWindow(window) {
  if (!window || window.metric === 'credits') return null;
  // Read rather than coerced: a normalized window carries either a finite number
  // or null, and Number(null) is 0. Coercing would turn a percentage that could
  // not be derived into a fully unused quota, and score the next real reading as
  // a burn of that entire amount.
  const usedPercent = window.usedPercent;
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : null;
}

function createLimitsBurnState() {
  // live holds the identities this runtime has actually probed successfully.
  // Eligibility cannot be read off the snapshot: previousLimits seeds rows that
  // carry status 'ok' from a previous session, and any other provider committing
  // rebuilds the whole snapshot, so a provider that has not been probed yet would
  // otherwise have its persisted row planted as a baseline stamped with the
  // current time. Its own first probe would then look like an entire offline
  // session's consumption in a second.
  //
  // inFlight holds the provider identities whose urgency probe has been
  // dispatched but has not settled. Without it a provider slower than the floor
  // is scheduled again while its own probe is still running, and the lane's
  // latest-wins semantics abort the first one: an endless series of cancelled
  // requests that never publishes a reading. The attempt floor cannot cover
  // this, since it only moves a deadline and does not know what is running.
  return { windows: new Map(), attempts: new Map(), inFlight: new Set(), live: new Set() };
}

function recordLimitsSample(state, limits, nowMs) {
  if (!state) return;
  for (const provider of limits?.providers || []) {
    // Only a successful probe from this runtime is a measurement. A failed probe
    // republishes the retained last-good windows under the failure status, and a
    // row that has never been probed here is a persisted seed; updatedAt then
    // keeps an unchanged successful row from being re-sampled on an unrelated
    // rebuild.
    if (text(provider?.status) !== 'ok') continue;
    const updatedAt = text(provider?.updatedAt);
    if (!updatedAt) continue;
    const identity = providerIdentityKey(provider);
    if (!state.live?.has(identity)) continue;
    for (const window of provider?.windows || []) {
      const usedPercent = measurableWindow(window);
      if (usedPercent === null) continue;
      const key = `${identity}|${windowKey(window)}`;
      const resetsAt = text(window.resetsAt);
      const previous = state.windows.get(key);
      if (!previous) {
        state.windows.set(key, { usedPercent, at: nowMs, updatedAt, resetsAt, rate: 0 });
        continue;
      }
      if (previous.updatedAt === updatedAt) continue;
      const elapsedMs = nowMs - previous.at;
      // Across a reset the difference is not a burn, so re-baseline and carry
      // the previous estimate rather than decaying it toward zero on evidence
      // that was never there.
      const reset = resetsAt !== previous.resetsAt || usedPercent < previous.usedPercent;
      let rate = previous.rate;
      if (!reset && elapsedMs > 0) {
        const instant = (usedPercent - previous.usedPercent) / elapsedMs;
        rate = instant >= previous.rate
          ? instant
          : (LIMITS_URGENCY_RELEASE_WEIGHT * instant)
            + ((1 - LIMITS_URGENCY_RELEASE_WEIGHT) * previous.rate);
      }
      state.windows.set(key, { usedPercent, at: nowMs, updatedAt, resetsAt, rate });
    }
  }
}

// Called by the runtime for every row a probe of its own committed successfully.
// Nothing else may mark an identity measurable.
function markLimitsProbeSuccess(state, row) {
  if (state) state.live.add(providerIdentityKey(row));
}

function recordLimitsUrgencyAttempt(state, keys, nowMs) {
  if (!state) return;
  for (const key of keys || []) state.attempts.set(String(key), nowMs);
}

function pruneLimitsBurnState(state, limits) {
  if (!state) return;
  const identities = new Set();
  const windows = new Set();
  for (const provider of limits?.providers || []) {
    const identity = providerIdentityKey(provider);
    identities.add(identity);
    for (const window of provider?.windows || []) {
      windows.add(`${identity}|${windowKey(window)}`);
    }
  }
  for (const key of state.windows.keys()) {
    if (!windows.has(key)) state.windows.delete(key);
  }
  for (const key of state.attempts.keys()) {
    if (!identities.has(key)) state.attempts.delete(key);
  }
  for (const key of state.live) {
    if (!identities.has(key)) state.live.delete(key);
  }
}

function nextLimitsUrgencyRefresh(limits, state, nowMs = Date.now(), options = {}) {
  const baseRefreshMs = Number(options.baseRefreshMs);
  if (!state || !Number.isFinite(baseRefreshMs) || baseRefreshMs <= 0) return null;
  const floorMs = Number.isFinite(Number(options.floorMs))
    ? Math.max(0, Number(options.floorMs))
    : LIMITS_URGENCY_FLOOR_MS;
  // Nothing to add once the configured cadence is already at or below the floor:
  // this only ever shortens an interval, never introduces one the user could not
  // have selected in settings themselves.
  if (baseRefreshMs <= floorMs) return null;
  const samplesAhead = Number(options.samplesAhead) > 0
    ? Number(options.samplesAhead)
    : LIMITS_URGENCY_SAMPLES_AHEAD;

  let refreshAt = Infinity;
  let keys = [];
  let scopes = new Map();
  for (const provider of limits?.providers || []) {
    const identity = providerIdentityKey(provider);
    if (state.inFlight?.has(identity)) continue;
    const attemptedAt = state.attempts.get(identity) || 0;
    for (const window of provider?.windows || []) {
      const usedPercent = measurableWindow(window);
      if (usedPercent === null) continue;
      const remaining = 100 - usedPercent;
      if (remaining <= 0) continue;
      const sample = state.windows.get(`${identity}|${windowKey(window)}`);
      if (!sample || !(sample.rate > 0)) continue;
      const delayMs = remaining / sample.rate / samplesAhead;
      if (!(delayMs < baseRefreshMs)) continue;
      // Anchored to the sample that produced it, so a provider preempted by a
      // more urgent one keeps its own deadline instead of drifting a full delay
      // further out each time something else fires first. The attempt floor
      // holds even when a probe fails and leaves the sample where it was.
      const candidate = Math.max(
        sample.at + Math.max(delayMs, floorMs),
        attemptedAt + floorMs
      );
      if (candidate > refreshAt) continue;
      if (candidate < refreshAt) {
        refreshAt = candidate;
        keys = [];
        scopes = new Map();
      }
      if (!keys.includes(identity)) {
        keys.push(identity);
        scopes.set(identity, providerScope(provider));
      }
    }
  }
  if (!Number.isFinite(refreshAt)) return null;
  // keys and scopes are parallel: keys[i] is the identity of scopes[i]. The
  // caller needs both, and a scope cannot be turned back into its key without
  // duplicating the normalization that built it.
  return {
    refreshAt,
    delayMs: Math.max(0, refreshAt - nowMs),
    keys,
    scopes: [...scopes.values()]
  };
}

module.exports = {
  LIMITS_ADAPTIVE_BASE_MS,
  LIMITS_URGENCY_FLOOR_MS,
  LIMITS_URGENCY_RELEASE_WEIGHT,
  LIMITS_URGENCY_SAMPLES_AHEAD,
  createLimitsBurnState,
  markLimitsProbeSuccess,
  nextLimitsUrgencyRefresh,
  pruneLimitsBurnState,
  recordLimitsSample,
  recordLimitsUrgencyAttempt
};
