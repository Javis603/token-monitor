'use strict';

(function exposeCostPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCostPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createCostPresentationApi() {
  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function costAvailability(cost, unpricedTokens) {
    if (finite(unpricedTokens) <= 0) return 'known';
    return finite(cost) > 0 ? 'partial' : 'unknown';
  }

  function formatCostAvailability(cost, unpricedTokens, formatCost, labels = {}) {
    const availability = costAvailability(cost, unpricedTokens);
    if (availability === 'unknown') return labels.unknown || 'Cost unavailable';
    const formatted = formatCost(finite(cost));
    return availability === 'partial'
      ? `${formatted} · ${labels.partial || 'Partial cost'}`
      : formatted;
  }

  return { costAvailability, formatCostAvailability };
});
