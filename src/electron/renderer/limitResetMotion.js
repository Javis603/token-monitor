'use strict';

(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitResetMotion = api;
})(typeof window !== 'undefined' ? window : null, function createLimitResetMotionApi() {
  const FULL_PERCENT = 99.5;

  function clean(value) {
    return String(value || '').trim();
  }

  function normalized(value) {
    return clean(value).toLowerCase();
  }

  function opaqueKey(parts) {
    const input = parts.map(clean).join('\0');
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function providerKey(provider = {}) {
    const identity = clean(provider.accountKey)
      || clean(provider.webAccountKey)
      || normalized(provider.accountEmail)
      || clean(provider.accountName)
      || clean(provider.accountLabel)
      || clean(provider.profileId)
      || 'default';
    return opaqueKey([normalized(provider.provider), identity]);
  }

  function windowKey(label, window = {}) {
    const explicitId = clean(window.limitId)
      || clean(window.id)
      || clean(window.quotaId)
      || clean(window.model)
      || clean(window.group);
    return opaqueKey([
      normalized(window.kind),
      explicitId,
      normalized(window.label || label),
      window.additional === true ? 'additional' : 'canonical'
    ]);
  }

  function finitePercent(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
  }

  function resetTime(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function remainingPercent(window = {}) {
    const remaining = finitePercent(window.remainingPercent);
    if (remaining !== null) return remaining;
    const used = finitePercent(window.usedPercent);
    return used === null ? null : 100 - used;
  }

  function durationMs(fromPercent, toPercent = 100) {
    const from = finitePercent(fromPercent);
    const to = finitePercent(toPercent);
    if (from === null || to === null) return 1100;
    return Math.round(900 + (Math.abs(to - from) * 7));
  }

  function shouldAnimateReset(previous, current) {
    const from = finitePercent(previous?.remainingPercent);
    const to = finitePercent(current?.remainingPercent);
    if (from === null || to === null || from >= FULL_PERCENT || to < FULL_PERCENT) return false;

    const previousReset = resetTime(previous?.resetsAt);
    const currentReset = resetTime(current?.resetsAt);
    // When both snapshots expose the cycle boundary, a real reset advances it.
    // This rejects account/data corrections that happen to refill a meter.
    if (previousReset !== null && currentReset !== null && currentReset <= previousReset) return false;
    return true;
  }

  return {
    durationMs,
    providerKey,
    remainingPercent,
    shouldAnimateReset,
    windowKey
  };
});
