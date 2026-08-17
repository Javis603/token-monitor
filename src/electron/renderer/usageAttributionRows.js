'use strict';

(function exposeUsageAttributionRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorUsageAttributionRows = api;
})(typeof window !== 'undefined' ? window : null, function createUsageAttributionRowsApi() {
  const UNATTRIBUTED_KEY = '__unattributed';

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function attributionRows(values, costs, options = {}) {
    const valueMap = values && typeof values === 'object' ? values : {};
    const costMap = costs && typeof costs === 'object' ? costs : {};
    const keys = new Set([...Object.keys(valueMap), ...Object.keys(costMap)]);
    const rows = Array.from(keys, (key) => ({
      key,
      value: finiteNumber(valueMap[key]),
      cost: finiteNumber(costMap[key])
    })).filter((row) => row.value > 0 || row.cost > 0);
    const attributedValue = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    const attributedCost = rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0);
    const remainderValue = Math.max(0, finiteNumber(options.totalValue) - attributedValue);
    const remainderCost = Math.max(0, Number(
      (finiteNumber(options.totalCost) - attributedCost).toFixed(6)
    ));
    if (remainderValue > 0 || remainderCost > 0) {
      rows.push({
        key: options.unattributedKey || UNATTRIBUTED_KEY,
        value: remainderValue,
        cost: remainderCost,
        unattributed: true
      });
    }
    return rows;
  }

  function visibleAttributionRows(rows, formatCost) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (typeof formatCost !== 'function') return sourceRows;
    const zeroCost = String(formatCost(0));
    return sourceRows.filter((row) => (
      row?.unattributed !== true
      || finiteNumber(row.value) > 0
      || String(formatCost(row.cost)) !== zeroCost
    ));
  }

  function attributionValue(values, total, key) {
    if (key !== UNATTRIBUTED_KEY) return finiteNumber(values?.[key]);
    const attributed = Object.values(values || {}).reduce(
      (sum, value) => sum + Math.max(0, finiteNumber(value)),
      0
    );
    return Math.max(0, finiteNumber(total) - attributed);
  }

  return { attributionRows, visibleAttributionRows, attributionValue, UNATTRIBUTED_KEY };
});
