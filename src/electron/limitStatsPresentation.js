'use strict';

const { aggregateLimits } = require('../shared/limits');

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function hasQuotaEstimate(provider) {
  return (Array.isArray(provider?.windows) && provider.windows.length > 0)
    || provider?.balance !== null && provider?.balance !== undefined
    || provider?.balanceUsd !== null && provider?.balanceUsd !== undefined;
}

function hasLocalQuotaEstimate(provider) {
  if (!hasQuotaEstimate(provider)) return false;
  if (normalizeId(provider?.source) === 'local') return true;
  return (provider.windows || []).some((window) => normalizeId(window?.source) === 'local');
}

function isLocalDeviceProvider(provider, options = {}) {
  if (typeof options.localDeviceProvider === 'boolean') return options.localDeviceProvider;
  const sourceDeviceId = normalizeId(provider?.sourceDeviceId);
  const localDeviceId = normalizeId(options.localDeviceId);
  if (sourceDeviceId) return Boolean(localDeviceId && sourceDeviceId === localDeviceId);
  // Older aggregate snapshots have no provenance. Preserve them in sync mode
  // rather than claiming they came from this device and hiding remote data.
  return options.syncActive !== true;
}

function windowIsLocalOrUnknown(window) {
  const source = normalizeId(window?.source);
  return source !== 'web';
}

function projectLimitProviderForDisplay(provider, options = {}) {
  if (normalizeId(provider?.provider) !== 'opencode'
    || options.opencodeLocalLimitsEnabled === true
    || !isLocalDeviceProvider(provider, options)
    || !hasQuotaEstimate(provider)) {
    return provider;
  }

  // New collectors identify every OpenCode window as Web or local. For an old
  // local-device snapshot, an untagged window is ambiguous and must fail closed:
  // retaining it could keep a disabled DB estimate visible while the Hub is down.
  const windows = (provider.windows || []).filter((window) => !windowIsLocalOrUnknown(window));
  const hasWebBalance = provider?.balance !== null && provider?.balance !== undefined
    || provider?.balanceUsd !== null && provider?.balanceUsd !== undefined;
  if (windows.length > 0 || hasWebBalance) {
    if (windows.length === (provider.windows || []).length && normalizeId(provider.source) === 'web') {
      return provider;
    }
    return {
      ...provider,
      source: 'web',
      windows
    };
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

function isLocalDeviceRecord(device, options = {}) {
  const localDeviceId = normalizeId(options.localDeviceId);
  if (localDeviceId) return normalizeId(device?.deviceId) === localDeviceId;
  return options.syncActive !== true;
}

function projectDeviceForDisplay(device, options = {}) {
  const providers = device?.limits?.providers;
  if (!Array.isArray(providers) || !isLocalDeviceRecord(device, options)) return device;
  let changed = false;
  const visibleProviders = providers.map((provider) => {
    const visible = projectLimitProviderForDisplay(provider, {
      ...options,
      localDeviceProvider: true
    });
    if (visible !== provider) changed = true;
    return visible;
  });
  if (!changed) return device;
  return {
    ...device,
    limits: {
      ...device.limits,
      providers: visibleProviders
    }
  };
}

function projectionNowMs(stats, options = {}) {
  if (Number.isFinite(options.nowMs)) return options.nowMs;
  const timestamp = Date.parse(stats?.limits?.updatedAt || stats?.updatedAt || '');
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function projectAggregateProviders(stats, options = {}) {
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

function projectLimitStatsForDisplay(stats, options = {}) {
  if (!Array.isArray(stats?.devices)) return projectAggregateProviders(stats, options);

  let changed = false;
  const visibleDevices = stats.devices.map((device) => {
    const visible = projectDeviceForDisplay(device, options);
    if (visible !== device) changed = true;
    return visible;
  });
  if (!changed) return stats;

  const limits = aggregateLimits(
    visibleDevices,
    Number.isFinite(stats.staleAfterMs) ? stats.staleAfterMs : 0,
    projectionNowMs(stats, options)
  );
  return {
    ...stats,
    devices: visibleDevices,
    limits: {
      ...stats.limits,
      ...limits
    }
  };
}

module.exports = {
  hasLocalQuotaEstimate,
  isLocalDeviceProvider,
  projectLimitProviderForDisplay,
  projectLimitStatsForDisplay
};
