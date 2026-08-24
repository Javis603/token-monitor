'use strict';

function createLatestWinsReconciler(options = {}) {
  const apply = options.apply;
  if (typeof apply !== 'function') throw new TypeError('apply must be a function');
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
    : [];
  let activeKey = null;
  let desiredKey = null;
  let timer = null;
  let retryAttempt = 0;
  let disposed = false;

  function clearTimerOnly() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function clearDesired() {
    clearTimerOnly();
    desiredKey = null;
    retryAttempt = 0;
  }

  function arm(delay) {
    timer = setTimer(flush, delay);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function retry(key) {
    if (disposed || desiredKey !== key || activeKey === key) return false;
    if (retryAttempt >= retryDelaysMs.length) return false;
    arm(retryDelaysMs[retryAttempt]);
    retryAttempt += 1;
    return true;
  }

  function setActiveKey(key) {
    activeKey = String(key ?? '');
    if (desiredKey === activeKey) clearDesired();
  }

  function flush() {
    if (disposed || desiredKey === null) return false;
    const key = desiredKey;
    timer = null;
    if (key === activeKey) {
      clearDesired();
      return false;
    }
    try {
      const applied = apply(key);
      if (applied !== false) {
        activeKey = key;
        if (desiredKey === key) clearDesired();
      } else {
        retry(key);
      }
      return applied;
    } catch (error) {
      try { options.onError?.(error); } catch (_) {}
      retry(key);
      return false;
    }
  }

  function schedule(key) {
    if (disposed) return false;
    const normalized = String(key ?? '');
    clearTimerOnly();
    desiredKey = normalized;
    retryAttempt = 0;
    if (desiredKey === activeKey) {
      desiredKey = null;
      return false;
    }
    arm(delayMs);
    return true;
  }

  function cancel() {
    clearDesired();
  }

  function dispose() {
    clearDesired();
    disposed = true;
  }

  return {
    cancel,
    dispose,
    flush,
    schedule,
    setActiveKey,
    state: () => ({
      activeKey,
      desiredKey,
      pendingKey: timer !== null ? desiredKey : null,
      retryAttempt,
      scheduled: timer !== null
    })
  };
}

module.exports = { createLatestWinsReconciler };
