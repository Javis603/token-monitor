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

  function cappedTokenRate(value) {
    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed <= 0) return 0;
    return Math.min(TOKEN_RATE_MAX_DISPLAY_RATE, parsed);
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

  function tokenRateSettleValue(fromRate, toRate, elapsedMs, durationMs = TOKEN_RATE_SETTLE_MS) {
    const from = cappedTokenRate(fromRate);
    const to = cappedTokenRate(toRate);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const duration = Number(durationMs);
    const progress = duration >= 0 && Number.isFinite(duration) && duration > 0
      ? Math.min(1, elapsed / duration)
      : duration === 0 ? 1 : Math.min(1, elapsed / TOKEN_RATE_SETTLE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    return cappedTokenRate(from + (to - from) * eased);
  }

  function tokenRatePerSecond(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timedOutput = positiveNumber(period?.timedOutputTokens);
    if (!durationMs || !timedOutput) return 0;
    return cappedTokenRate(timedOutput * 1000 / durationMs);
  }

  function tokenBurnPerMinute(period) {
    const durationMs = positiveNumber(period?.timedDurationMs);
    const timed = positiveNumber(period?.timedTokens);
    if (!durationMs || !timed) return 0;
    return cappedTokenRate(timed * 60000 / durationMs);
  }

  function usageCounters(period) {
    if (period?.capabilities?.throughput === false) return null;
    const counter = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const counters = {
      timedTokens: counter(period?.timedTokens),
      timedOutputTokens: counter(period?.timedOutputTokens),
      timedDurationMs: counter(period?.timedDurationMs)
    };
    return Object.values(counters).every((value) => value !== null) ? counters : null;
  }

  // A period is cumulative, so its ratio is necessarily an average. Live rate is the ratio
  // of the counters added by one successful snapshot: the duration comes from the same
  // tokscale performance entries as both token numerators, never from watcher or wall time.
  // Equal snapshots keep the last sample (limits-only and final-after-preview pushes are
  // common); any regression is a new baseline boundary such as midnight or reconfiguration.
  function createLiveTokenRateTracker({ now = defaultNow } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    let baseline = null;
    let sample = null;
    let revision = 0;

    function reset(period) {
      baseline = period ? usageCounters(period) : null;
      sample = null;
    }

    function observe(period) {
      const current = usageCounters(period);
      if (!current) {
        baseline = null;
        sample = null;
        return null;
      }
      if (!baseline) {
        baseline = current;
        return null;
      }

      const delta = {
        timedTokens: current.timedTokens - baseline.timedTokens,
        timedOutputTokens: current.timedOutputTokens - baseline.timedOutputTokens,
        timedDurationMs: current.timedDurationMs - baseline.timedDurationMs
      };
      baseline = current;

      if (Object.values(delta).some((value) => value < 0)) {
        sample = null;
        return null;
      }
      if (!(delta.timedDurationMs > 0)) return sample;

      revision += 1;
      sample = {
        speed: tokenRatePerSecond(delta),
        burn: tokenBurnPerMinute(delta),
        sampledAt: Number(now()) || 0,
        revision,
        ...delta
      };
      return sample;
    }

    function getSample() {
      return sample;
    }

    function value(mode) {
      if (!sample) return null;
      return mode === 'burn' ? sample.burn : sample.speed;
    }

    return { getSample, observe, reset, value };
  }

  // Hub devices publish independently. Taking one delta from the aggregate would make the
  // headline jump between whichever device happened to upload last, and dividing summed
  // tokens by summed model-busy time would be an average rather than fleet throughput. Keep
  // one matched-counter tracker per device, then add only samples that are still live.
  function createLiveTokenRateGroupTracker({ now = defaultNow, activeMs = 8000, clearMs = 180000 } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const lifetime = positiveNumber(activeMs);
    if (!lifetime) throw new TypeError('activeMs must be a positive number');
    const clearAfter = positiveNumber(clearMs);
    if (!clearAfter || clearAfter <= lifetime) throw new TypeError('clearMs must be greater than activeMs');
    const trackers = new Map();
    let revision = 0;
    let lastDisplaySample = null;

    function normalizedEntries(entries) {
      const result = [];
      const seen = new Set();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(entry?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, period: entry?.period });
      }
      return result;
    }

    function reset(entries = []) {
      trackers.clear();
      lastDisplaySample = null;
      for (const entry of normalizedEntries(entries)) {
        const tracker = createLiveTokenRateTracker({ now });
        tracker.reset(entry.period);
        trackers.set(entry.id, tracker);
      }
    }

    function observe(entries = []) {
      const nextEntries = normalizedEntries(entries);
      const present = new Set(nextEntries.map((entry) => entry.id));
      let changed = false;
      let fresh = false;
      let invalidated = false;

      for (const [id, tracker] of trackers) {
        if (present.has(id)) continue;
        if (tracker.getSample()) {
          changed = true;
        }
        trackers.delete(id);
      }

      for (const entry of nextEntries) {
        let tracker = trackers.get(entry.id);
        if (!tracker) {
          tracker = createLiveTokenRateTracker({ now });
          tracker.reset(entry.period);
          trackers.set(entry.id, tracker);
          continue;
        }
        const previous = tracker.getSample();
        const sample = tracker.observe(entry.period);
        if (sample === previous) continue;
        changed = true;
        if (sample) fresh = true;
        else if (previous) invalidated = true;
      }

      if (invalidated) lastDisplaySample = null;
      if (fresh) revision += 1;
      return { changed, sample: getSample() };
    }

    function activeSamples() {
      const timestamp = Number(now()) || 0;
      return [...trackers.values()]
        .map((tracker) => tracker.getSample())
        .filter((sample) => sample && timestamp < sample.sampledAt + lifetime);
    }

    function getSample() {
      const samples = activeSamples();
      if (samples.length) {
        lastDisplaySample = {
          speed: cappedTokenRate(samples.reduce((sum, sample) => sum + sample.speed, 0)),
          burn: cappedTokenRate(samples.reduce((sum, sample) => sum + sample.burn, 0)),
          sampledAt: Math.max(...samples.map((sample) => sample.sampledAt)),
          deviceCount: samples.length,
          revision
        };
        return {
          ...lastDisplaySample,
          expiresAt: Math.min(...samples.map((sample) => sample.sampledAt + lifetime)),
          idle: false
        };
      }

      // The retained aggregate is presentation-only: expired device samples no longer
      // contribute to live throughput, but the last useful reading stays visible in the
      // dimmed state until it is old enough to be genuinely unavailable.
      const timestamp = Number(now()) || 0;
      const expiresAt = lastDisplaySample?.sampledAt + clearAfter;
      if (!lastDisplaySample || timestamp >= expiresAt) return null;
      return { ...lastDisplaySample, expiresAt, idle: true };
    }

    function nextExpiryAt() {
      return getSample()?.expiresAt || null;
    }

    return { getSample, nextExpiryAt, observe, reset };
  }

  function selectLiveTokenRatePeriods(stats, deviceId, hubMode = 'local', scope = 'all') {
    const normalizedDeviceId = String(deviceId || '').trim();
    const syncMode = hubMode === 'client' || hubMode === 'host';
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];

    if (syncMode && scope !== 'device') {
      return {
        entries: devices
          .filter((device) => device?.stale !== true && device?.periods?.today && typeof device.periods.today === 'object')
          .map((device) => ({ id: `device:${String(device.deviceId || 'unknown')}`, period: device.periods.today })),
        source: 'devices:all'
      };
    }

    const localDevice = normalizedDeviceId
      ? devices.find((device) => String(device?.deviceId || '') === normalizedDeviceId)
      : null;
    // Local mode owns the aggregate snapshot, so it remains a valid same-device
    // source while startup anchors or a device-id change leave `devices` empty.
    // Sync mode must stay strict: its aggregate may contain other machines.
    const localPeriod = localDevice?.periods?.today
      || (!syncMode ? stats?.periods?.today : null);
    if (localPeriod && typeof localPeriod === 'object') {
      return {
        entries: [{ id: `device:${normalizedDeviceId}`, period: localPeriod }],
        source: `device:${normalizedDeviceId}`
      };
    }
    return { entries: [], source: `device:${normalizedDeviceId || 'unavailable'}` };
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
        rate: Math.min(displayCap, cappedTokenRate(value.rate)),
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
      const settleDuration = state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS;
      const displayRate = state.phase === 'settling'
        ? tokenRateSettleValue(state.settleFromRate, state.settleToRate, timestamp - state.settledAt, settleDuration)
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
      if (state.phase === 'settling' && timestamp - state.settledAt >= (state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS)) {
        state = null;
        notify();
        return;
      }
      notify();
      schedule();
    }

    function refresh() {
      if (!state || state.phase !== 'settling') return false;
      const timestamp = currentTime();
      const elapsed = Math.max(0, timestamp - state.settledAt);
      const duration = state.settleDurationMs ?? TOKEN_RATE_SETTLE_MS;
      if (elapsed >= duration) return false;

      const value = currentValue();
      if (value.mode !== state.mode) {
        state = null;
        cancelScheduledFrame();
        suppressNextClick = false;
        return true;
      }
      if (value.rate === state.settleToRate) return false;

      state = {
        ...state,
        settleFromRate: tokenRateSettleValue(state.settleFromRate, state.settleToRate, elapsed, duration),
        settleToRate: value.rate,
        settledAt: timestamp,
        settleDurationMs: duration - elapsed
      };
      return true;
    }

    function matchesPointer(event) {
      return event?.pointerId === undefined || event.pointerId === state?.pointerId;
    }

    function start(event) {
      if (event?.button !== undefined && event.button !== 0) return false;
      const enabled = canStart();
      const reduced = prefersReducedMotion();
      // A new primary pointer sequence cannot belong to a canceled gesture. Clear a guard that
      // was left behind when blur/pointercancel produced no follow-up click; if the canceled
      // gesture does produce one, consumeClick() runs before this next pointerdown instead.
      suppressNextClick = false;
      if (!enabled || reduced) return false;
      if (state && state.phase !== 'settling') return false;
      const value = currentValue();
      if (!(value.rate > 0)) return false;
      if (state?.phase === 'settling') {
        // A second hold is a new gesture, not a mode click. Interrupt the old release animation
        // so the new pointer can own the controller immediately.
        state = null;
        cancelScheduledFrame();
      }
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
        settledAt: timestamp,
        settleDurationMs: TOKEN_RATE_SETTLE_MS
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
      refresh,
      release,
      start
    };
  }

  return {
    TOKEN_RATE_BOOST_DOUBLING_MS,
    TOKEN_RATE_HOLD_THRESHOLD_MS,
    TOKEN_RATE_MAX_DISPLAY_RATE,
    TOKEN_RATE_SETTLE_MS,
    cappedTokenRate,
    createLiveTokenRateGroupTracker,
    createLiveTokenRateTracker,
    createTokenRateBoostController,
    positiveNumber,
    selectLiveTokenRatePeriods,
    tokenBurnPerMinute,
    tokenRateBoostValue,
    tokenRatePerSecond,
    tokenRateSettleValue
  };
});
