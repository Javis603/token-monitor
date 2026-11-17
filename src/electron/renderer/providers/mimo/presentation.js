// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['mimo'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    linked: source => source === 'web',
    settingsRecord: (rows, { isMimoMembershipProduct }) => rows.findLast(row => row.status === 'ok') || rows.find(row => !isMimoMembershipProduct(row)) || rows.at(-1),
    statusLabels: { error: "Unavailable" }
  });
});
