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

  function usageCostLabel(cost, unpricedTokens, formatCost, formatTokens, unpricedLabel) {
    if (!(finiteNumber(unpricedTokens) > 0)) return formatCost(finiteNumber(cost));
    const missing = `${formatTokens(unpricedTokens)} ${unpricedLabel}`;
    return finiteNumber(cost) > 0 ? `${formatCost(cost)} + ${missing}` : `— (${missing})`;
  }

  function compactUsageCostLabel(cost, unpricedTokens, formatCost) {
    if (!(finiteNumber(unpricedTokens) > 0)) return formatCost(finiteNumber(cost));
    return finiteNumber(cost) > 0 ? `${formatCost(cost)} + ?` : '—';
  }

  // A client can identify the source of unknown usage without identifying its
  // execution model. Only use the Codex mark when the entire bucket is covered.
  function unknownModelSource(period) {
    const total = Number(period?.models?.unknown);
    if (!Number.isFinite(total) || total <= 0) return null;
    if (Number(period?.clientModels?.codex?.unknown) !== total) return null;
    for (const [client, models] of Object.entries(period?.clientModels || {})) {
      const value = Number(models?.unknown ?? 0);
      if (!Number.isFinite(value) || value < 0 || (client !== 'codex' && value > 0)) return null;
    }
    return 'codex';
  }

  function attributionRows(values, costs, options = {}) {
    const valueMap = values && typeof values === 'object' ? values : {};
    const costMap = costs && typeof costs === 'object' ? costs : {};
    const unpricedMap = options.unpricedTokens && typeof options.unpricedTokens === 'object'
      ? options.unpricedTokens
      : {};
    const keys = new Set([...Object.keys(valueMap), ...Object.keys(costMap), ...Object.keys(unpricedMap)]);
    const rows = Array.from(keys, (key) => ({
      key,
      value: finiteNumber(valueMap[key]),
      cost: finiteNumber(costMap[key]),
      ...(unpricedMap[key] > 0 ? { unpricedTokens: finiteNumber(unpricedMap[key]) } : {})
    })).filter((row) => row.value > 0 || row.cost > 0 || row.unpricedTokens > 0);
    const attributedValue = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    const attributedCost = rows.reduce((sum, row) => sum + Math.max(0, row.cost), 0);
    const attributedUnpricedTokens = rows.reduce((sum, row) => sum + Math.max(0, finiteNumber(row.unpricedTokens)), 0);
    const remainderValue = Math.max(0, finiteNumber(options.totalValue) - attributedValue);
    const remainderCost = Math.max(0, Number(
      (finiteNumber(options.totalCost) - attributedCost).toFixed(6)
    ));
    const remainderUnpricedTokens = Math.max(
      0,
      finiteNumber(options.totalUnpricedTokens) - attributedUnpricedTokens
    );
    if (remainderValue > 0 || remainderCost > 0 || remainderUnpricedTokens > 0) {
      rows.push({
        key: options.unattributedKey || UNATTRIBUTED_KEY,
        value: remainderValue,
        cost: remainderCost,
        ...(remainderUnpricedTokens > 0 ? { unpricedTokens: remainderUnpricedTokens } : {}),
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
      || finiteNumber(row.unpricedTokens) > 0
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

  function normalizeRankingMetric(value) {
    return value === 'cost' ? 'cost' : 'tokens';
  }

  function hasKnownCost(rows) {
    return (Array.isArray(rows) ? rows : []).some((row) => (
      row?.unattributed !== true && finiteNumber(row?.cost) > 0
    ));
  }

  function effectiveRankingMetric(rows, metric) {
    return normalizeRankingMetric(metric) === 'cost' && hasKnownCost(rows) ? 'cost' : 'tokens';
  }

  function rankingValue(row, metric) {
    return Math.max(0, finiteNumber(normalizeRankingMetric(metric) === 'cost' ? row?.cost : row?.value));
  }

  function sortedRowsByMetric(rows, effectiveMetric) {
    return [...rows].sort((left, right) => {
      if (effectiveMetric === 'cost') {
        const costDifference = finiteNumber(right?.cost) - finiteNumber(left?.cost);
        if (costDifference !== 0) return costDifference;
      }
      const tokenDifference = finiteNumber(right?.value) - finiteNumber(left?.value);
      if (tokenDifference !== 0) return tokenDifference;
      return String(left?.key || left?.name || '').localeCompare(String(right?.key || right?.name || ''));
    });
  }

  function rankRowsWithValues(rows, metric) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const effectiveMetric = effectiveRankingMetric(sourceRows, metric);
    return sortedRowsByMetric(sourceRows, effectiveMetric).map((row) => ({
      ...row,
      barValue: rankingValue(row, effectiveMetric)
    }));
  }

  return {
    usageCostLabel,
    compactUsageCostLabel,
    unknownModelSource,
    attributionRows,
    visibleAttributionRows,
    attributionValue,
    normalizeRankingMetric,
    rankingValue,
    rankRowsWithValues,
    UNATTRIBUTED_KEY
  };
});
