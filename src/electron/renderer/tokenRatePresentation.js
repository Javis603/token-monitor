'use strict';

(function exposeTokenRate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorTokenRate = api;
})(typeof window !== 'undefined' ? window : null, function createTokenRateApi() {
  const TOKEN_RATE_BOOST_DOUBLING_MS = 520;
  const TOKEN_RATE_HOLD_THRESHOLD_MS = 180;
  const TOKEN_RATE_SETTLE_MS = 720;
  const TOKEN_RATE_MAX_DISPLAY_RATE = 1e12;

  function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function tokenRateBoostValue(baseRate, elapsedMs, maxRate = TOKEN_RATE_MAX_DISPLAY_RATE) {
    const base = positiveNumber(baseRate);
    const cap = positiveNumber(maxRate) || TOKEN_RATE_MAX_DISPLAY_RATE;
    if (!base) return 0;
    if (base >= cap) return cap;
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const maxElapsed = TOKEN_RATE_BOOST_DOUBLING_MS * Math.log2(cap / base);
    const boundedElapsed = Math.min(elapsed, maxElapsed);
    return Math.min(cap, base * 2 ** (boundedElapsed / TOKEN_RATE_BOOST_DOUBLING_MS));
  }

  function tokenRateSettleValue(fromRate, toRate, elapsedMs) {
    const from = Math.max(0, Number(fromRate) || 0);
    const to = Math.max(0, Number(toRate) || 0);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const progress = Math.min(1, elapsed / TOKEN_RATE_SETTLE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    return from + (to - from) * eased;
  }

  function tokenRatePerSecond(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timedOutput = positiveNumber(period?.timedOutputTokens);
    if (!durationMs || !timedOutput) return 0;
    return timedOutput * 1000 / durationMs;
  }

  function tokenBurnPerMinute(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timed = positiveNumber(period?.timedTokens);
    if (!durationMs || !timed) return 0;
    return timed * 60000 / durationMs;
  }

  function defaultNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function defaultRequestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 16);
  }

  function defaultCancelFrame(frameId) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
    else clearTimeout(frameId);
  }

  function createTokenRateBoostController({
    readValue,
    canStart = () => true,
    prefersReducedMotion = () => false,
    onChange = () => {},
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    maxDisplayRate = TOKEN_RATE_MAX_DISPLAY_RATE
  } = {}) {
    if (typeof readValue !== 'function') throw new TypeError('readValue must be a function');
    if (typeof canStart !== 'function') throw new TypeError('canStart must be a function');
    if (typeof prefersReducedMotion !== 'function') throw new TypeError('prefersReducedMotion must be a function');
    if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof requestFrame !== 'function') throw new TypeError('requestFrame must be a function');
    if (typeof cancelFrame !== 'function') throw new TypeError('cancelFrame must be a function');

    const displayCap = positiveNumber(maxDisplayRate) || TOKEN_RATE_MAX_DISPLAY_RATE;
    let state = null;
    let frameId = null;
    let suppressNextClick = false;

    function currentTime() {
      const value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    }

    function currentValue() {
      const value = readValue() || {};
      return {
        rate: positiveNumber(value.rate),
        mode: value.mode === 'burn' || value.burn === true ? 'burn' : 'speed'
      };
    }

    function cancelScheduledFrame() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    }

    function notify() {
      onChange();
    }

    function snapshot() {
      if (!state) return null;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.startedAt);
      const displayRate = state.phase === 'settling'
        ? tokenRateSettleValue(state.settleFromRate, state.settleToRate, timestamp - state.settledAt)
        : tokenRateBoostValue(state.baseRate, elapsed, displayCap);
      return { ...state, displayRate, elapsedMs: elapsed };
    }

    function schedule() {
      if (!state || frameId !== null) return;
      frameId = requestFrame(step);
    }

    function step() {
      frameId = null;
      if (!state) return;
      const timestamp = currentTime();
      if (state.phase === 'settling' && timestamp - state.settledAt >= TOKEN_RATE_SETTLE_MS) {
        state = null;
        notify();
        return;
      }
      notify();
      schedule();
    }

    function matchesPointer(event) {
      return event?.pointerId === undefined || event.pointerId === state?.pointerId;
    }

    function start(event) {
      if (event?.button !== undefined && event.button !== 0) return false;
      if (state || !canStart() || prefersReducedMotion()) return false;
      const value = currentValue();
      if (!(value.rate > 0)) return false;
      state = {
        phase: 'boosting',
        baseRate: value.rate,
        mode: value.mode,
        pointerId: event?.pointerId,
        startedAt: currentTime()
      };
      notify();
      schedule();
      return true;
    }

    function release(event) {
      if (!state || state.phase !== 'boosting' || !matchesPointer(event)) return false;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.startedAt);
      if (elapsed < TOKEN_RATE_HOLD_THRESHOLD_MS) {
        state = null;
        cancelScheduledFrame();
        notify();
        return false;
      }
      const value = currentValue();
      state = {
        ...state,
        phase: 'settling',
        settleFromRate: tokenRateBoostValue(state.baseRate, elapsed, displayCap),
        settleToRate: value.rate,
        settledAt: timestamp
      };
      suppressNextClick = true;
      notify();
      schedule();
      return true;
    }

    function cancel(event, { preserveSettling = false, suppressClick = true } = {}) {
      if (event?.pointerId !== undefined && !matchesPointer(event)) return false;
      if (preserveSettling && state?.phase === 'settling') return false;
      const hadState = Boolean(state);
      if (!hadState) {
        if (!suppressClick) suppressNextClick = false;
        return false;
      }
      state = null;
      cancelScheduledFrame();
      if (suppressClick) suppressNextClick = true;
      else suppressNextClick = false;
      notify();
      return true;
    }

    function consumeClick() {
      if (!suppressNextClick) return false;
      suppressNextClick = false;
      return true;
    }

    return {
      cancel,
      consumeClick,
      getSnapshot: snapshot,
      release,
      start
    };
  }

  return {
    TOKEN_RATE_BOOST_DOUBLING_MS,
    TOKEN_RATE_HOLD_THRESHOLD_MS,
    TOKEN_RATE_MAX_DISPLAY_RATE,
    TOKEN_RATE_SETTLE_MS,
    createTokenRateBoostController,
    positiveNumber,
    tokenBurnPerMinute,
    tokenRateBoostValue,
    tokenRatePerSecond,
    tokenRateSettleValue
  };
});
