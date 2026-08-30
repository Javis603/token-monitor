'use strict';

(function exposeToolDetails(root, factory) {
  const usageAttributionRowsApi = typeof module === 'object' && module.exports
    ? require('./usageAttributionRows')
    : root?.TokenMonitorUsageAttributionRows;
  const api = factory(usageAttributionRowsApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorToolDetails = api;
})(typeof window !== 'undefined' ? window : null, function createToolDetailsApi(usageAttributionRowsApi) {
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
    const totalCost = amount(period?.clientCosts?.[clientKey]);
    return usageAttributionRowsApi.attributionRows(models, costs, {
      totalValue: total,
      totalCost
    })
      .map((row) => {
        const value = amount(row.value);
        const cost = amount(row.cost);
        return {
          key: row.key,
          name: row.key,
          value,
          cost,
          percent: total > 0 ? Math.min(100, value / total * 100) : 0,
          unattributed: row.unattributed === true
        };
      })
      .sort((a, b) => b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  }

  function detailPercentLabel(value) {
    const percent = amount(value);
    if (percent > 0 && percent < 1) return '<1%';
    return `${Math.round(Math.min(100, percent))}%`;
  }

  function tokenInputPercentages(parts = {}) {
    const cacheRead = amount(parts.cacheRead);
    const cacheMiss = amount(parts.cacheMiss);
    const input = cacheRead + cacheMiss;
    return {
      hit: input > 0 ? cacheRead / input * 100 : 0,
      miss: input > 0 ? cacheMiss / input * 100 : 0
    };
  }

  return { detailPercentLabel, modelRowsForTool, tokenInputPercentages };
});
