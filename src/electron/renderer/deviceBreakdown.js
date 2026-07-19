'use strict';

(function exposeDeviceBreakdown(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorDeviceBreakdown = api;
})(typeof window !== 'undefined' ? window : null, function createDeviceBreakdownApi() {
  function positiveEntries(value) {
    return Object.entries(value || {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount || 0))])
      .filter(([, amount]) => amount > 0);
  }

  function deviceBreakdownForPeriod(device, periodName, options = {}) {
    const period = device?.periods?.[periodName] || {};
    const totalTokens = Math.max(0, Number(period.totalTokens || 0));
    const tools = positiveEntries(period.clients).map(([client, value]) => {
      const models = positiveEntries(period.clientModels?.[client]).map(([model, modelValue]) => {
        return {
          key: model,
          name: model,
          value: modelValue
        };
      }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

      return {
        key: client,
        client,
        name: options.clientLabels?.[client] || client,
        value,
        percent: totalTokens > 0 ? value / totalTokens * 100 : 0,
        color: options.clientColors?.[client] || options.fallbackColor || '#73bdf5',
        models
      };
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    return {
      totalTokens,
      tools
    };
  }

  return { deviceBreakdownForPeriod };
});
