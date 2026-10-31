'use strict';

(function exposeModelClientBreakdown(root, factory) {
  const projectRowsApi = typeof module === 'object' && module.exports
    ? require('./projectRows')
    : root?.TokenMonitorProjectRows;
  const api = factory(projectRowsApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelClientBreakdown = api;
})(typeof window !== 'undefined' ? window : null, function createModelClientBreakdownApi(projectRowsApi) {
  const clientGradient = projectRowsApi?.clientGradient || function fallbackGradient() {
    return arguments[2] || '#73bdf5';
  };

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  // Invert period.clientModels / clientModelCosts (client → model → n) into the
  // shares that paint one model row's bar. When the Claude Desktop split is on,
  // Desktop usage already lives under client id `claude-desktop`, so it shows as
  // its own segment with the catalog color.
  function clientSharesForModel(period, modelKey) {
    const model = String(modelKey || '');
    if (!model) return { clientTokens: Object.create(null), clientCosts: Object.create(null) };
    const clientTokens = Object.create(null);
    const clientCosts = Object.create(null);
    const modelsByClient = period?.clientModels && typeof period.clientModels === 'object'
      ? period.clientModels
      : null;
    const costsByClient = period?.clientModelCosts && typeof period.clientModelCosts === 'object'
      ? period.clientModelCosts
      : null;
    if (modelsByClient) {
      for (const [client, models] of Object.entries(modelsByClient)) {
        if (!client || !models || typeof models !== 'object') continue;
        const tokens = Math.max(0, Math.round(finiteNumber(models[model])));
        if (tokens > 0) clientTokens[client] = tokens;
      }
    }
    if (costsByClient) {
      for (const [client, models] of Object.entries(costsByClient)) {
        if (!client || !models || typeof models !== 'object') continue;
        const cost = finiteNumber(models[model]);
        if (cost !== 0) clientCosts[client] = cost;
      }
    }
    return { clientTokens, clientCosts };
  }

  function enrichModelRowWithClientBreakdown(row, period, options = {}) {
    if (!row || !period) return row;
    // Derived fixed-period snapshots carry no per-client model maps. Missing
    // attribution is not an "Unknown" client, so keep the plain model bar.
    if (period.capabilities?.clientModels === false) return row;
    const { clientTokens, clientCosts } = clientSharesForModel(period, row.key);
    const attributed = Object.values(clientTokens).reduce((sum, value) => sum + finiteNumber(value), 0);
    if (attributed <= 0) return row;
    const total = Math.max(0, finiteNumber(row.value));
    const bounded = Object.assign(Object.create(null), clientTokens);
    if (total > attributed) bounded[''] = total - attributed;
    const shareEntries = Object.entries(bounded).filter(([, value]) => finiteNumber(value) > 0);
    if (shareEntries.length === 0) return row;

    const colorFor = (client) => {
      if (!client) return options.unknownClientColor || 'var(--muted)';
      const colors = options.clientColors || {};
      if (Object.prototype.hasOwnProperty.call(colors, client) && colors[client]) return colors[client];
      return row.color || '#73bdf5';
    };
    const accordionRows = shareEntries
      .map(([client, value]) => {
        const tokens = finiteNumber(value);
        return {
          key: client || 'unknown',
          name: client
            ? (options.clientLabels?.[client] || client)
            : (options.unknownClientLabel || 'Unknown'),
          value: tokens,
          cost: client ? finiteNumber(clientCosts[client]) : 0,
          percent: total > 0 ? tokens / total * 100 : 0,
          color: colorFor(client)
        };
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    return {
      ...row,
      clientTokens: bounded,
      clientCosts,
      barBackground: clientGradient(bounded, colorFor, row.color || '#73bdf5'),
      accordionRows
    };
  }

  function applyModelClientBreakdown(rows, period, options = {}) {
    if (!options.enabled) return rows;
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    return rows.map((row) => enrichModelRowWithClientBreakdown(row, period, options));
  }

  return {
    applyModelClientBreakdown,
    clientSharesForModel,
    enrichModelRowWithClientBreakdown
  };
});
