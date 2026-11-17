// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['minimax'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {

  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    planValue: row => String(row.planLabel || '').trim(),
    settingsRecord: rows => rows.findLast(row => row.status === 'ok') || rows.find(row => row.source === 'api') || rows.at(-1),
    statusLabel: (row, source, status) => source === 'oauth' && ['unauthorized', 'notConfigured'].includes(status) ? { label: status === 'unauthorized' ? 'Sign in again' : 'Sign in', tone: 'setup' } : null,
    statusLabels: { unauthorized: "Update API key", notConfigured: "Add API key" }
  });
});
