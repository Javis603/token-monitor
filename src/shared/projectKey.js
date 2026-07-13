'use strict';

(function exposeProjectKey(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProjectKey = api;
})(typeof window !== 'undefined' ? window : null, function createProjectKeyApi() {
  function canonicalProjectKey(value) {
    const label = String(value || '').trim().normalize('NFC');
    return label ? label.toLowerCase().normalize('NFC') : '';
  }

  function deterministicProjectLabel(left, right) {
    const a = String(left || '').trim().normalize('NFC');
    const b = String(right || '').trim().normalize('NFC');
    if (!a) return b;
    if (!b) return a;
    return a < b ? a : b;
  }

  return { canonicalProjectKey, deterministicProjectLabel };
});
