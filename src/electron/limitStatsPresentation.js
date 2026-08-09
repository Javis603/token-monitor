'use strict';

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function hasLocalQuotaEstimate(provider) {
  return (Array.isArray(provider?.windows) && provider.windows.length > 0)
    || provider?.balance !== null && provider?.balance !== undefined
    || provider?.balanceUsd !== null && provider?.balanceUsd !== undefined;
}

function isLocalDeviceProvider(provider, options = {}) {
  const sourceDeviceId = normalizeId(provider?.sourceDeviceId);
  const localDeviceId = normalizeId(options.localDeviceId);
  if (sourceDeviceId) return Boolean(localDeviceId && sourceDeviceId === localDeviceId);
  // Older synced snapshots have no provenance. Preserve them rather than
  // claiming they came from this device and hiding another device's estimate.
  return options.syncActive !== true;
}

function projectLimitProviderForDisplay(provider, options = {}) {
  if (normalizeId(provider?.provider) !== 'opencode'
    || normalizeId(provider?.source) !== 'local'
    || options.opencodeLocalLimitsEnabled === true
    || !isLocalDeviceProvider(provider, options)
    || !hasLocalQuotaEstimate(provider)) {
    return provider;
  }
  return {
    ...provider,
    status: 'disabled',
    stale: false,
    windows: [],
    balance: null,
    balanceUsd: null
  };
}

function projectLimitStatsForDisplay(stats, options = {}) {
  const providers = stats?.limits?.providers;
  if (!Array.isArray(providers)) return stats;
  let changed = false;
  const visibleProviders = providers.map((provider) => {
    const visible = projectLimitProviderForDisplay(provider, options);
    if (visible !== provider) changed = true;
    return visible;
  });
  if (!changed) return stats;
  return {
    ...stats,
    limits: {
      ...stats.limits,
      providers: visibleProviders
    }
  };
}

module.exports = {
  hasLocalQuotaEstimate,
  isLocalDeviceProvider,
  projectLimitProviderForDisplay,
  projectLimitStatsForDisplay
};
