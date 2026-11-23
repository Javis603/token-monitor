// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['zed'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any} value */
  function normalizeId(value) { return String(value || '').trim().toLowerCase(); }

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    linked: source => source === 'web',
    planLabel: label => label.replace(/^Zed\s+/iu, '').trim() || label,
    compactWindows: windows => (windows || []).map(window => window?.limitId === 'zed.edit-predictions' && normalizeId(window?.detail) === 'unlimited' ? { ...window, value: 'Unlimited', resetDescription: '' } : window),
    statusLabels: { notConfigured: "Sign in" }
  });
});
