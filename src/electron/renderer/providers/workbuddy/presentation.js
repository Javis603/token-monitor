// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['workbuddy'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any[]} providers */
  function workbuddyCreditTotals(providers) {
    if (!Array.isArray(providers) || providers.length < 2) return null;
    const keys = providers.map((provider) => String(provider?.accountKey || '').trim());
    if (keys.some((key) => !key) || new Set(keys).size !== providers.length) return null;
    const measurementFields = new Set(['used', 'remaining', 'limit', 'usedPercent', 'remainingPercent']);
    /** @param {Record<string, any>} window */
    const signature = (window) => JSON.stringify(Object.keys(window).sort()
      .filter((key) => !measurementFields.has(key)).map((key) => [key, window[key]]));
    const readings = providers.map((provider) => {
      if (provider?.provider !== 'workbuddy' || provider.status !== 'ok' || provider.stale || provider.actionRequired) return null;
      if (!Array.isArray(provider.windows) || !provider.windows.length) return null;
      const windows = new Map();
      for (const window of provider.windows) {
        if (!window || window.metric !== 'credits' || !window.currency || window.detail === 'unlimited'
          || !Number.isFinite(window.limit) || window.limit <= 0
          || !Number.isFinite(window.used) || window.used < 0 || window.used > window.limit
          || !Number.isFinite(window.remaining) || window.remaining < 0 || window.remaining > window.limit) return null;
        const key = signature(window);
        if (windows.has(key)) return null;
        windows.set(key, window);
      }
      return windows;
    });
    if (readings.some((reading) => !reading)) return null;
    if (providers.some((provider) => provider.realm !== providers[0].realm || provider.region !== providers[0].region)) return null;
    const validReadings = /** @type {Map<string, any>[]} */ (readings);
    const first = validReadings[0];
    if (validReadings.some((reading) => reading.size !== first.size || [...first.keys()].some((key) => !reading.has(key)))) return null;
    const totals = [...first].map(([key, window]) => {
      /** @param {string} field */
      const sum = (field) => validReadings.reduce((total, reading) => total + reading.get(key)[field], 0);
      const used = sum('used');
      const remaining = sum('remaining');
      const limit = sum('limit');
      return { ...window, used, remaining, limit, usedPercent: used / limit * 100, remainingPercent: remaining / limit * 100 };
    });
    return totals.every((window) => [window.used, window.remaining, window.limit, window.usedPercent, window.remainingPercent].every(Number.isFinite))
      ? totals : null;
  }
  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    failureLabel: (row, translate) => row.actionRequired === 'appSessionEncrypted' ? translate('settings.limits.status.appSessionEncrypted') : undefined,
    workbuddyCreditTotals,
    statusLabel: row => row.actionRequired === 'appSessionEncrypted' ? { label: 'Encrypted by app', key: 'settings.limits.status.appSessionEncrypted', tone: 'warn' } : null,
    statusLabels: { notConfigured: "Sign in" }
  });
});
