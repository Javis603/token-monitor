'use strict';

function createLatestWinsReconciler(options = {}) {
  const apply = options.apply;
  if (typeof apply !== 'function') throw new TypeError('apply must be a function');
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  let activeKey = null;
  let pendingKey = null;
  let timer = null;
  let disposed = false;

  function clearPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pendingKey = null;
  }

  function setActiveKey(key) {
    activeKey = String(key ?? '');
    if (pendingKey === activeKey) clearPending();
  }

  function flush() {
    if (disposed || pendingKey === null) return false;
    const key = pendingKey;
    timer = null;
    pendingKey = null;
    if (key === activeKey) return false;
    try {
      const applied = apply(key);
      if (applied !== false) activeKey = key;
      return applied;
    } catch (error) {
      try { options.onError?.(error); } catch (_) {}
      return false;
    }
  }

  function schedule(key) {
    if (disposed) return false;
    const normalized = String(key ?? '');
    if (timer !== null) clearTimer(timer);
    timer = null;
    pendingKey = normalized;
    if (pendingKey === activeKey) {
      pendingKey = null;
      return false;
    }
    timer = setTimer(flush, delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
    return true;
  }

  function cancel() {
    clearPending();
  }

  function dispose() {
    clearPending();
    disposed = true;
  }

  return {
    cancel,
    dispose,
    flush,
    schedule,
    setActiveKey,
    state: () => ({ activeKey, pendingKey, scheduled: timer !== null })
  };
}

module.exports = { createLatestWinsReconciler };
