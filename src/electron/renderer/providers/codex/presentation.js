// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['codex'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any} value */
  function normalizeId(value) { return String(value || '').trim().toLowerCase(); }
  /** @param {any} value */
  function codexAdditionalQuotaDisplayName(value) {
    const name = String(value || '').trim();
    return normalizeId(name) === 'gpt-reserve' ? 'Luna Reserve' : name;
  }
  /** @param {any} window */
  function isCanonicalCodexWindow(window) {
    return window?.additional !== true;
  }
  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    codexAdditionalQuotaDisplayName,
    compactWindows: windows => (windows || []).filter(isCanonicalCodexWindow),
    sourceLabel: (source, detail) => source === 'rpc' ? ({ app: 'App', cli: 'CLI', managed: 'Managed', unknown: 'RPC' }[detail] || '') : ''
  });
});
