'use strict';

(function exposeUsageAttributionRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorUsageAttributionRows = api;
})(typeof window !== 'undefined' ? window : null, function createUsageAttributionRowsApi() {
  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function attributionRows(values, costs) {
    const valueMap = values && typeof values === 'object' ? values : {};
    const costMap = costs && typeof costs === 'object' ? costs : {};
    const keys = new Set([...Object.keys(valueMap), ...Object.keys(costMap)]);
    return Array.from(keys, (key) => ({
      key,
      value: finiteNumber(valueMap[key]),
      cost: finiteNumber(costMap[key])
    })).filter((row) => row.value > 0 || row.cost > 0);
  }

  return { attributionRows };
});
