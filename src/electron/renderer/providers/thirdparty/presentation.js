// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['thirdparty'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any} value */
  function normalizeId(value) { return String(value || '').trim().toLowerCase(); }
  /** @type {Record<string, {color: string, markId: string}>} */
  const THIRD_PARTY_ADAPTER_VISUALS = {
    'newapi-account': { color: '#C738FB', markId: 'newapi' },
    'newapi-token': { color: '#C738FB', markId: 'newapi' },
    sub2api: { color: '#39D9E7', markId: 'sub2api' },
    custom: { color: '#8A96A8', markId: 'thirdparty' }
  };

  /** @param {any} provider @param {any} fallbackColor */
  function thirdPartyAdapterVisual(provider, fallbackColor) {
    return THIRD_PARTY_ADAPTER_VISUALS[normalizeId(provider?.adapterId)]
      || { color: fallbackColor, markId: 'thirdparty' };
  }

  /** @param {any} provider */
  function thirdPartyAdapterFamily(provider) {
    const adapterId = normalizeId(provider?.adapterId);
    if (adapterId === 'newapi-account' || adapterId === 'newapi-token') return 'newapi';
    if (adapterId === 'sub2api') return 'sub2api';
    if (adapterId === 'custom') return 'thirdparty';
    return '';
  }

  // The family every account in a group shares, or null when they differ. A
  // shared family moves up to the group header; a mixed one stays per row.
  /** @param {any[]} providers */
  function thirdPartySharedAdapterFamily(providers) {
    const families = new Set((providers || []).map(thirdPartyAdapterFamily));
    return families.size === 1 ? [...families][0] : null;
  }

  // The account row's plan text. Each adapter is one product and the adapter id
  // is what the user picked, so it is the only thing that can name the row —
  // these adapters report no plan of their own. undefined hands the cell back to
  // the provider's own plan label.
  /** @param {any} provider */
  function thirdPartyGroupPlanText(provider) {
    if (provider?.status !== 'ok') return undefined;
    const adapterId = normalizeId(provider?.adapterId);
    if (adapterId === 'newapi-account') return 'New API · Account';
    if (adapterId === 'newapi-token') return 'New API · API key';
    if (adapterId === 'sub2api') return 'Sub2API · Account';
    if (adapterId === 'custom') return 'Custom';
    const planLabel = String(provider?.planLabel || '').toLowerCase();
    if (planLabel === 'account') return 'Account';
    if (planLabel === 'api key') return 'API key';
    if (planLabel === 'custom') return 'Custom';
    return undefined;
  }


  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    thirdPartyAdapterVisual, thirdPartyAdapterFamily, thirdPartySharedAdapterFamily, thirdPartyGroupPlanText,
    statusLabels: { unauthorized: "Update credential", notConfigured: "Add credential" }
  });
});
