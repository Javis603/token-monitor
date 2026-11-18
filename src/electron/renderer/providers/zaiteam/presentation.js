// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['zaiteam'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    statusLabels: { unauthorized: "Update API key", notConfigured: "Add API key" }
  });
});
