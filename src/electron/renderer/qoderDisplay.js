'use strict';

(function expose(root, factory) {
  const preferences = typeof module === 'object' && module.exports
    ? require('./clientDisplayPreferences') : root.TokenMonitorClientDisplayPreferences;
  const api = factory(preferences);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorQoderDisplay = api;
})(typeof window !== 'undefined' ? window : null, function createQoderDisplay(preferences) {
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

  function orderCommit(order, clients, orderValue, pinnedValue, clientId) {
    const groupClients = clients.filter(client => (typeof client === 'string' ? client : client.id) !== 'qodercn');
    const result = preferences.clientDisplayOrderCommit(
      displayPreference(order.join(','), false).split(','), groupClients,
      displayPreference(orderValue, false), displayPreference(pinnedValue, false),
      clientId === 'qodercn' ? 'qoder' : clientId
    );
    if (result.clientDisplayOrder !== undefined) {
      return { clientDisplayOrder: expandOrder(result.clientDisplayOrder.split(',')).join(','), pinnedClients: '' };
    }
    // Test the move using visible groups, then restore the original pin members.
    // Pinning only CN must not implicitly pin international Qoder or clear pins.
    const pinned = preferences.normalizePinnedClients(pinnedValue, clients).split(',').filter(Boolean);
    return { pinnedClients: result.pinnedClients.split(',').flatMap(group =>
      pinned.filter(id => (id === 'qodercn' ? 'qoder' : id) === group)
    ).join(',') };
  }

  function trackingState(clients) {
    const selected = new Set(String(clients || '').split(','));
    return { checked: IDS.every(id => selected.has(id)), mixed: IDS.some(id => selected.has(id)) && !IDS.every(id => selected.has(id)) };
  }

  function setTracked(clients, checked) {
    const selected = String(clients || '').split(',').filter(Boolean).filter(id => !isQoder(id));
    return [...selected, ...(checked ? IDS : [])].join(',');
  }

  function healthDetail(editions) {
    const groups = (type) => editions.map(({ detail }) => detail.groups.find(group => group.id === type));
    const sources = groups('source');
    const data = groups('data');
    const checkedCount = sources.reduce((total, group) => total + group.checkedCount, 0);
    const detectedCount = sources.reduce((total, group) => total + group.detectedCount, 0);
    return {
      groups: [
        { ...sources[0], checkedCount, detectedCount, state: checkedCount === 0 ? 'unknown' : detectedCount > 0 ? 'detected' : 'missing', checks: sources.flatMap(group => group.checks) },
        { id: 'collection', key: 'settings.tools.health.sync', editions: editions.map(({ id, detail }) => ({ id, collection: detail.groups.find(group => group.id === 'collection') })) },
        { ...data[0], periods: ['today', 'month', 'allTime'].map(period => ({
          period,
          tokens: data.reduce((total, group) => total + group.periods.find(entry => entry.period === period).tokens, 0),
          cost: data.reduce((total, group) => total + group.periods.find(entry => entry.period === period).cost, 0)
        })), lastActivityDay: data.map(group => group.lastActivityDay).filter(Boolean).sort().at(-1) || '' }
      ],
      notes: editions.flatMap(({ id, detail }) => detail.notes.map(note => ({ ...note, clientId: id })))
    };
  }

  return { IDS, isQoder, groupRows, displayPreference, expandOrder, orderCommit, trackingState, setTracked, healthDetail };
});
