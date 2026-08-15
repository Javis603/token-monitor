'use strict';

const { aggregateLimits } = require('../shared/limits');
const { DEFAULT_STALE_AFTER_MS } = require('../shared/syncUploadInterval');

const OPENCODE_COMPONENT_PROVENANCE_DETAIL = 'managed';

function normalizeEnumId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeDeviceId(value) {
  return String(value || '').trim();
}

function hasQuotaEstimate(provider) {
  return (Array.isArray(provider?.windows) && provider.windows.length > 0)
    || provider?.balance !== null && provider?.balance !== undefined
    || provider?.balanceUsd !== null && provider?.balanceUsd !== undefined;
}

function hasLocalQuotaEstimate(provider) {
  if (!hasQuotaEstimate(provider)) return false;
  if (normalizeEnumId(provider?.source) === 'local') return true;
  return (provider.windows || []).some((window) => normalizeEnumId(window?.source) === 'local');
}

function isLocalDeviceProvider(provider, options = {}) {
  if (typeof options.localDeviceProvider === 'boolean') return options.localDeviceProvider;
  const sourceDeviceId = normalizeDeviceId(provider?.sourceDeviceId);
  const localDeviceId = normalizeDeviceId(options.localDeviceId);
  if (sourceDeviceId) return Boolean(localDeviceId && sourceDeviceId === localDeviceId);
  // Older aggregate snapshots have no provenance. Preserve them in sync mode
  // rather than claiming they came from this device and hiding remote data.
  return options.syncActive !== true;
}

function windowIsLocalOrUnknown(window, provider) {
  const source = normalizeEnumId(window?.source);
  if (source) return source !== 'web';
  // Hubs released before component provenance preserve the provider source but
  // strip windows[].source. Only collectors carrying the compatibility marker
  // may use that envelope: pre-marker collectors emitted source:web for mixed
  // local/Web rows, so trusting their source would leak the local estimate.
  const hasCompatibilityMarker = normalizeEnumId(provider?.sourceDetail)
    === OPENCODE_COMPONENT_PROVENANCE_DETAIL;
  const providerSource = normalizeEnumId(provider?.source);
  return !hasCompatibilityMarker || (providerSource !== 'web' && providerSource !== 'api');
}

function projectLimitProviderForDisplay(provider, options = {}) {
  if (normalizeEnumId(provider?.provider) !== 'opencode'
    || options.opencodeLocalLimitsEnabled === true
    || !isLocalDeviceProvider(provider, options)
    || !hasQuotaEstimate(provider)) {
    return provider;
  }

  // New collectors identify every OpenCode window as Web or local. Older Hubs
  // strip that component provenance, so untagged windows fall back to the
  // provider-level source retained by the legacy schema.
  const windows = (provider.windows || []).filter((window) => !windowIsLocalOrUnknown(window, provider));
  const hasWebBalance = provider?.balance !== null && provider?.balance !== undefined
    || provider?.balanceUsd !== null && provider?.balanceUsd !== undefined;
  if (windows.length > 0 || hasWebBalance) {
    // Nothing was stripped and the provider already claims a remote source, so
    // this snapshot never carried a local estimate. 'api' must be accepted here
    // as well as 'web': a Go account read from the usage API has no cookie, so
    // rewriting it below would blank an accountKey that webAccountKey cannot
    // restore.
    const remoteSource = normalizeEnumId(provider.source);
    if (windows.length === (provider.windows || []).length
      && (remoteSource === 'web' || remoteSource === 'api')) {
      return provider;
    }
    return {
      ...provider,
      // Once the local component is gone, its DB-path hash is not a valid Web
      // identity. Modern collectors preserve the Web identity independently;
      // legacy mixed snapshots fail closed instead of mislabelling that hash.
      accountKey: String(provider.webAccountKey || ''),
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
  const localDeviceId = normalizeDeviceId(options.localDeviceId);
  if (localDeviceId) return normalizeDeviceId(device?.deviceId) === localDeviceId;
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

function projectionStaleAfterMs(stats) {
  if (Number.isFinite(stats?.staleAfterMs)) return stats.staleAfterMs;
  // Old Hubs do not publish their threshold. Reuse the shared Hub default so
  // re-aggregation cannot stale a candidate sooner than the Hub that supplied
  // it; interval-synced devices can still extend this floor independently.
  return DEFAULT_STALE_AFTER_MS;
}

function replaceOpenCodeProviders(currentProviders, aggregateProviders) {
  const replacements = (aggregateProviders || [])
    .filter((provider) => normalizeEnumId(provider?.provider) === 'opencode');
  const providers = [];
  let inserted = false;
  for (const provider of currentProviders || []) {
    if (normalizeEnumId(provider?.provider) !== 'opencode') {
      providers.push(provider);
      continue;
    }
    if (!inserted) providers.push(...replacements);
    inserted = true;
  }
  if (!inserted) providers.push(...replacements);
  return providers;
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
    projectionStaleAfterMs(stats),
    projectionNowMs(stats, options)
  );
  return {
    ...stats,
    devices: visibleDevices,
    limits: {
      ...stats.limits,
      updatedAt: limits.updatedAt,
      providers: replaceOpenCodeProviders(stats?.limits?.providers, limits.providers)
    }
  };
}

module.exports = {
  hasLocalQuotaEstimate,
  isLocalDeviceProvider,
  projectLimitProviderForDisplay,
  projectLimitStatsForDisplay
};
