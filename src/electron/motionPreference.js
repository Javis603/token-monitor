'use strict';

(function exposeMotionPreference(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorMotionPreference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const VALUES = new Set(['system', 'on', 'off']);

  function normalize(value, fallback = 'system') {
    const next = String(value || '').trim();
    if (VALUES.has(next)) return next;
    return VALUES.has(fallback) ? fallback : 'system';
  }

  function shouldReduceMotion(value, systemReduced = false) {
    const preference = normalize(value);
    if (preference === 'on') return true;
    if (preference === 'off') return false;
    return Boolean(systemReduced);
  }

  return { normalize, shouldReduceMotion };
});
