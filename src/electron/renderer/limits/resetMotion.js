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
    const source = provider || {};
    const identity = clean(source.accountKey)
      || clean(source.webAccountKey)
      || normalized(source.accountEmail)
      || clean(source.accountName)
      || clean(source.accountLabel)
      || clean(source.profileId)
      || 'default';
    return opaqueKey([normalized(source.provider), identity]);
  }

  function windowKey(label, window = {}) {
    const source = window || {};
    const explicitId = clean(source.limitId)
      || clean(source.id)
      || clean(source.quotaId)
      || clean(source.model)
      || clean(source.group);
    return opaqueKey([
      normalized(source.kind),
      explicitId,
      normalized(source.label || label),
      source.additional === true ? 'additional' : 'canonical'
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
    const source = window || {};
    const remaining = finitePercent(source.remainingPercent);
    if (remaining !== null) return remaining;
    const used = finitePercent(source.usedPercent);
    return used === null ? null : 100 - used;
  }

  function displayPercent(value) {
    return finitePercent(value);
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
    displayPercent,
    durationMs,
    providerKey,
    remainingPercent,
    shouldAnimateReset,
    windowKey
  };
});
