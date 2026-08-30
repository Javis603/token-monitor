'use strict';

(function exposeToolDetails(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorToolDetails = api;
})(typeof window !== 'undefined' ? window : null, function createToolDetailsApi() {
  function amount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function modelRowsForTool(period, client) {
    const clientKey = String(client || '').trim();
    if (!clientKey) return [];
    const models = period?.clientModels?.[clientKey];
    const costs = period?.clientModelCosts?.[clientKey];
    if ((!models || typeof models !== 'object') && (!costs || typeof costs !== 'object')) return [];

    const total = amount(period?.clients?.[clientKey]);
    return [...new Set([...Object.keys(models || {}), ...Object.keys(costs || {})])]
      .map((model) => {
        const value = amount(models?.[model]);
        const cost = amount(costs?.[model]);
        return {
          key: model,
          name: model,
          value,
          cost,
          percent: total > 0 ? Math.min(100, value / total * 100) : 0
        };
      })
      .filter((row) => row.value > 0 || row.cost > 0)
      .sort((a, b) => b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  }

  function detailPercentLabel(value) {
    const percent = amount(value);
    if (percent > 0 && percent < 1) return '<1%';
    return `${Math.round(Math.min(100, percent))}%`;
  }

  return { detailPercentLabel, modelRowsForTool };
});
