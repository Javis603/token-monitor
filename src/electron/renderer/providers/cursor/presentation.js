// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['cursor'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    legacyPlanLabel: row => {
      const label = String(row.accountLabel || '').trim();
      const email = String(row.accountEmail || '').trim();
      return (email && label.toLowerCase() === email.toLowerCase()) || /^[^\s@]+@[^\s@]+$/.test(label) ? '' : label;
    },
    linked: () => true,
    statusLabels: { notConfigured: "Sign in" }
  });
});
