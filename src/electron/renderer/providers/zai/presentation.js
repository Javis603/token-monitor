// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['zai'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any} value */
  function normalizeId(value) { return String(value || '').trim().toLowerCase(); }

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    planLabel: label => label.replace(/^GLM\s+Coding\s+/iu, '').trim() || label,
    compactWindowLabel: window => normalizeId(window?.kind) === 'daily' ? String(window?.label || '').trim() : '',
    statusLabels: { unauthorized: "Update API key", notConfigured: "Add API key" }
  });
});
