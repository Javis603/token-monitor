// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['muse'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    linked: source => source === 'web',
    statusLabels: { unauthorized: source => source === 'web' ? 'Sign in again' : 'Run muse login', notConfigured: source => source === 'web' ? 'Add credential' : 'Install Muse Code' }
  });
});
