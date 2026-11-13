'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorQoderDisplay = api;
})(typeof window !== 'undefined' ? window : null, function createQoderDisplay() {
  const IDS = Object.freeze(['qoder', 'qodercn']);
  const isQoder = (id) => IDS.includes(id);

  // Presentation only. The collector, archives, sessions and wire retain both ids.
  // Filter hidden versions before grouping, so hiding CN never hides global usage.
  function groupRows(rows, separate = false, label = 'Qoder') {
    if (separate) return rows;
    const versions = rows.filter(row => isQoder(row.key));
    if (!versions.length) return rows;
    const group = { ...versions[0], key: 'qoder', name: label };
    for (const field of ['value', 'cost', 'unpricedTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']) {
      // Missing attribution is unknown, rather than a measured zero.
      group[field] = versions.every(row => Number.isFinite(row[field]))
        ? versions.reduce((total, row) => total + row[field], 0) : undefined;
    }
    group.stale = versions.some(row => row.stale);
    const models = new Map();
    for (const row of versions) {
      for (const model of row.modelRows || []) {
        const previous = models.get(model.key);
        models.set(model.key, previous ? {
          ...previous, value: previous.value + model.value, cost: previous.cost + model.cost,
          unpricedTokens: (previous.unpricedTokens || 0) + (model.unpricedTokens || 0)
        } : { ...model });
      }
    }
    group.modelRows = [...models.values()].map(model => ({
      ...model, percent: group.value > 0 ? model.value / group.value * 100 : 0
    })).sort((a, b) => b.value - a.value || b.cost - a.cost || a.key.localeCompare(b.key));
    let inserted = false;
    return rows.flatMap(row => {
      if (!isQoder(row.key)) return [row];
      if (inserted) return [];
      inserted = true;
      return [group];
    });
  }

  function displayPreference(value, separate) {
    if (separate) return value;
    return [...new Set(String(value || '').split(',').filter(Boolean).map(id => id === 'qodercn' ? 'qoder' : id))].join(',');
  }

  // A settings group moves as one row, but persists both real ids in its order.
  function expandOrder(order) {
    return order.flatMap(id => id === 'qoder' ? IDS : id === 'qodercn' ? [] : [id]);
  }

  function trackingState(clients) {
    const selected = new Set(String(clients || '').split(','));
    return { checked: IDS.every(id => selected.has(id)), mixed: IDS.some(id => selected.has(id)) && !IDS.every(id => selected.has(id)) };
  }

  function setTracked(clients, checked) {
    const selected = String(clients || '').split(',').filter(Boolean).filter(id => !isQoder(id));
    return [...selected, ...(checked ? IDS : [])].join(',');
  }

  return { IDS, isQoder, groupRows, displayPreference, expandOrder, trackingState, setTracked };
});
