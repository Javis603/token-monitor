'use strict';

(function exposeLimitProviderPresentation(root, factory) {
  const accountIdentityApi = typeof module === 'object' && module.exports
    ? require('../accountIdentity')
    : root?.TokenMonitorAccountIdentity;
  const limitWindowLabelsApi = typeof module === 'object' && module.exports
    ? require('../../../shared/limits/windowLabels')
    : root?.TokenMonitorLimitWindowLabels;
  const workbuddyIdentityApi = typeof module === 'object' && module.exports
    ? require('../../../shared/providers/workbuddy/identity')
    : root?.TokenMonitorWorkbuddyIdentity;
  const policies = typeof module === 'object' && module.exports ? require('./presentationPolicies') : root.TokenMonitorProviderPresentationPolicies;
  const api = factory(accountIdentityApi, limitWindowLabelsApi || {}, workbuddyIdentityApi, policies);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitProviderPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createLimitProviderPresentationApi(accountIdentityApi, limitWindowLabelsApi, workbuddyIdentityApi, policies) {
  const { isMimoMembershipProduct } = limitWindowLabelsApi;
  const { isWorkbuddyPlaceholder } = workbuddyIdentityApi;
  const SOURCE_LABELS = {
    oauth: 'OAuth',
    cli: 'CLI',
    web: 'Web',
    rpc: 'RPC',
    local: 'Local',
    api: 'API'
  };

  const accountDeclarations = typeof module === 'object' && module.exports
    ? require('../../../shared/limits/accounts').LIMIT_PROVIDER_ACCOUNTS : [];
  const KIND_LABELS = { oauth: 'OAuth', cli: 'CLI', desktop: 'Desktop app', web: 'Web', apiKey: 'API key', env: 'Environment', file: 'Local' };

  function connectionSources(id, declarations = accountDeclarations) {
    return declarations.find(entry => entry.id === providerId(id))?.sources || [];
  }

  function connectionTag(provider, declarations = accountDeclarations) {
    const parts = [...new Set(connectionSources(provider, declarations).map(source => KIND_LABELS[source.kind]))];
    return parts.length ? { label: parts.join('/'), parts, kind: 'capability' } : null;
  }

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function providerId(value) {
    return normalizeId(typeof value === 'object' && value ? value.provider : value);
  }

  function sourceId(value, fallback = '') {
    return normalizeId(typeof value === 'object' && value ? (value.source || fallback) : (value || fallback));
  }

  function sourceDetailId(value) {
    return normalizeId(typeof value === 'object' && value ? value.sourceDetail : '');
  }

  function deviceKey(value) {
    return String(value || '').trim();
  }

  function deviceLabel(deviceOrId) {
    if (typeof deviceOrId === 'string') return deviceOrId.trim();
    const id = String(deviceOrId?.deviceId || '').trim();
    if (id) return id;
    return String(deviceOrId?.hostname || '').trim();
  }

  function statusId(provider, fallback = '') {
    return String(provider?.status || fallback).trim();
  }

  function limitProviderSourceLabel(providerOrId, sourceFallback = '') {
    const source = sourceId(providerOrId, sourceFallback);
    return policies[providerId(providerOrId)]?.sourceLabel?.(source, sourceDetailId(providerOrId)) || SOURCE_LABELS[source] || '';
  }

  function limitProviderCapabilityTags(providerOrId) {
    const tag = connectionTag(providerOrId);
    return tag ? [tag.label] : [];
  }

  function limitProviderDisplayLabel(value) {
    const label = String(value || '').trim();
    if (!label || label.includes('@')) return label;
    return label.replace(/^[a-z]/, (letter) => letter.toUpperCase());
  }

  function limitProviderLegacyPlanLabel(provider) {
    return policies[providerId(provider)]?.legacyPlanLabel?.(provider) ?? String(provider?.accountLabel || '').trim();
  }

  function limitProviderPlanValue(provider, helpers) {
    return policies[providerId(provider)]?.planValue?.(provider, helpers);
  }

  function limitProviderFailureLabel(provider, translate) {
    return policies[providerId(provider)]?.failureLabel?.(provider, translate);
  }

  function limitProviderPlanDisplayLabel(providerOrId, value) {
    const label = limitProviderDisplayLabel(value);
    return policies[providerId(providerOrId)]?.planLabel?.(label) || label;
  }

  const codexAdditionalQuotaDisplayName = policies.codex.codexAdditionalQuotaDisplayName;

  // One "Third-party APIs" group can hold New API, Sub2API and Custom rows at
  // once, and each of those is a different product: they get their own mark and
  // colour rather than all reading as one anonymous integration. The adapter id
  // is what the user picked, so it is also the only thing that can name the row's
  // plan — these adapters report no plan of their own.

  const thirdPartyAdapterVisual = policies.thirdparty.thirdPartyAdapterVisual;

  const thirdPartyAdapterFamily = policies.thirdparty.thirdPartyAdapterFamily;

  // The family every account in a group shares, or null when they differ. A
  // shared family moves up to the group header; a mixed one stays per row.
  const thirdPartySharedAdapterFamily = policies.thirdparty.thirdPartySharedAdapterFamily;

  // The account row's plan text. Each adapter is one product and the adapter id
  // is what the user picked, so it is the only thing that can name the row —
  // these adapters report no plan of their own. undefined hands the cell back to
  // the provider's own plan label.
  const thirdPartyGroupPlanText = policies.thirdparty.thirdPartyGroupPlanText;

  const antigravityQuotaWindow = policies.antigravity.antigravityQuotaWindow;



  const antigravityQuotaWindowVisible = policies.antigravity.antigravityQuotaWindowVisible;

  function limitProviderCompactWindows(providerOrId, windows = []) {
    return policies[providerId(providerOrId)]?.compactWindows?.(windows) ?? windows;
  }

  function limitProviderCompactWindowLabel(providerOrId, window, visibleWindows = []) {
    return policies[providerId(providerOrId)]?.compactWindowLabel?.(window, visibleWindows) || '';
  }

  function limitProviderCompactWindowPeriodLabel(providerOrId, window, visibleWindows = []) {
    return policies[providerId(providerOrId)]?.compactWindowPeriodLabel?.(window, visibleWindows) || '';
  }

  function limitResetRemainingMs(value, nowMs = Date.now(), resetNowGraceMs = 60 * 1000) {
    if (!value) return null;
    const resetMs = new Date(value).getTime();
    const currentMs = Number(nowMs);
    if (!Number.isFinite(resetMs) || !Number.isFinite(currentMs)) return null;
    const remainingMs = resetMs - currentMs;
    if (remainingMs > 0) return remainingMs;
    return remainingMs >= -Math.max(0, Number(resetNowGraceMs) || 0) ? 0 : null;
  }

  // "4h 26m" — coarse enough that a row does not rewrite itself every second,
  // which is what a quota meter wants and a stopwatch does not.
  function limitDurationText(ms) {
    const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return '<1m';
  }

  // The line under a quota meter: when the window turns over, or when the thing
  // it measures expires. Shared rather than re-derived per surface — the Limits
  // page and the edge dock render the same meters, and a window that says
  // "Expires" on one and "Reset" on the other is describing two different
  // products.
  function limitBoundaryText(window) {
    const diffMs = limitResetRemainingMs(window?.resetsAt);
    if (diffMs === null) return '';
    const mixed = window?.boundaryKind === 'mixed';
    const prefix = window?.boundaryKind === 'expiry'
      ? 'Expires'
      : mixed
        ? 'Changes in'
        : 'Reset';
    if (diffMs === 0) return mixed ? 'Changes now' : `${prefix} now`;
    return `${prefix} ${limitDurationText(diffMs)}`;
  }

  // The "live" Codex account is the one THIS device's Codex app/CLI is currently
  // signed into (sourceDetail app/cli/unknown). Managed accounts added inside
  // Token Monitor report sourceDetail 'managed' and are NOT live. A remote
  // device's live login (selectedIsRemote) is also not "live" from here — across
  // synced devices, "Live" only ever points at the local account.
  function isCodexLiveAccount(provider, provenance) {
    if (!accountIdentityApi?.isCodexLiveAccount(provider)) return false;
    // "Active" means this device is signed into the account — not that the shown
    // quota came from here. So hide it only when the selected record is remote
    // AND this device has no login of its own for the account; when both devices
    // are signed in, the remote record is selected but the badge still belongs.
    if (provenance && provenance.selectedIsRemote && !provenance.hasLocalCandidate) return false;
    return true;
  }

  function isLinkedStatus(provider) {
    return policies[providerId(provider)]?.linked?.(sourceId(provider)) || false;
  }

  // How long ago a provider row was refreshed, and whether that reading is
  // still trusted. One function because the Limits view and the edge dock used
  // to word this differently off the same `provider.stale` flag — the page said
  // "Stale · 55m ago" while the card said "Updated 54m ago" and added a
  // separate warning line, which read like two different conditions.
  //
  // `tone` is what a surface decorates with; the words do not change with it.
  function limitProviderFreshness(provider, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const at = Date.parse(provider?.updatedAt || provider?.checkedAt || '');
    if (!Number.isFinite(at)) {
      return { text: provider?.stale ? 'Stale' : 'Update unknown', age: '', tone: provider?.stale ? 'stale' : 'unknown' };
    }
    const diffMs = Math.max(0, nowMs - at);
    let age;
    if (diffMs < 45_000) {
      age = 'just now';
    } else {
      const minutes = Math.round(diffMs / 60000);
      if (minutes < 60) {
        age = `${minutes}m ago`;
      } else {
        const hours = Math.round(minutes / 60);
        age = hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
      }
    }
    return provider?.stale
      ? { text: `Stale · ${age}`, age, tone: 'stale' }
      : { text: `Updated ${age}`, age, tone: 'ok' };
  }

  function limitProviderStatusLabel(provider = {}) {
    const status = statusId(provider);
    if (provider.stale) return { label: 'Stale', tone: 'stale' };
    const policy = policies[providerId(provider)];
    const source = sourceId(provider);
    const custom = policy?.statusLabel?.(provider, source, status);
    if (custom) return custom;
    const label = policy?.statusLabels?.[status];
    if (label) return { label: typeof label === 'function' ? label(source) : label, tone: status === 'error' ? 'warn' : 'setup' };
    if (status === 'ok') return { label: isLinkedStatus(provider) ? 'Linked' : 'Live', tone: 'ok' };
    if (status === 'disabled') return { label: 'Disabled', tone: 'muted' };
    if (status === 'noSyncedData') return { label: 'No synced data', tone: 'sync' };
    if (status === 'unauthorized') return { label: 'Sign in again', tone: 'setup' };
    if (status === 'rateLimited') return { label: 'Limited', tone: 'warn' };
    if (status === 'sourceRateLimited') return { label: 'Usage API limited', tone: 'warn' };
    if (status === 'unavailable') return { label: 'Unavailable', tone: 'warn' };
    if (status === 'notConfigured') return { label: 'Not set up', tone: 'setup' };
    return status ? { label: 'Error', tone: 'warn' } : null;
  }

  function apiKeyAccountStatus(provider, configured, enabled = true) {
    if (!configured) return 'notConfigured';
    if (!enabled) return 'disabled';
    const status = statusId(provider);
    if (!status) return 'checking';
    if (status === 'ok') return 'linked';
    if (status === 'unauthorized') return 'invalid';
    if (status === 'rateLimited' || status === 'sourceRateLimited') return 'limited';
    if (status === 'unavailable') return 'unavailable';
    if (status === 'disabled' || status === 'noSyncedData') return 'notChecked';
    if (status === 'notConfigured') return 'notConfigured';
    return 'error';
  }

  function namedApiProfileStatus(provider, options = {}) {
    const providerEnabled = options.providerEnabled !== false;
    const profileEnabled = options.profileEnabled !== false;
    if (!profileEnabled) return 'disabled';
    if (!providerEnabled) return 'hidden';
    return apiKeyAccountStatus(provider, true, true);
  }

  function usableProviderCandidate(provider) {
    const status = statusId(provider);
    return status !== 'disabled' && status !== 'notConfigured';
  }

  // The key family is read from accountIdentity.js rather than built again here:
  // it is the same rule the subscription matcher binds with, and a second copy of
  // it is a second answer to "which account is this" waiting to drift.
  function providerMatchesTarget(candidate, target) {
    if (providerId(candidate) !== providerId(target)) return false;
    const targetAccountKeys = accountIdentityApi.accountKeyFamily(target);
    if (targetAccountKeys.size === 0) return true;
    return [...accountIdentityApi.accountKeyFamily(candidate)].some((key) => targetAccountKeys.has(key));
  }

  function deviceProviderCandidate(device, target) {
    const providers = Array.isArray(device?.limits?.providers) ? device.limits.providers : [];
    return providers.find((provider) => providerMatchesTarget(provider, target) && usableProviderCandidate(provider)) || null;
  }

  function limitProviderProvenance(providerOrId, options = {}) {
    const provider = typeof providerOrId === 'object' && providerOrId ? providerOrId : { provider: providerOrId };
    const providerName = providerId(provider);
    const localKey = deviceKey(options.localDeviceId);
    const selectedKey = deviceKey(provider?.sourceDeviceId);
    const devices = Array.isArray(options.devices) ? options.devices : [];
    const selectedDevice = devices.find((device) => deviceKey(device?.deviceId) === selectedKey) || null;
    const candidates = devices.filter((device) => deviceProviderCandidate(device, providerName ? provider : providerName));
    const localCandidate = candidates.find((device) => localKey && deviceKey(device?.deviceId) === localKey) || null;
    const remoteCandidates = candidates.filter((device) => !localKey || deviceKey(device?.deviceId) !== localKey);
    const selectedIsLocal = Boolean(selectedKey && localKey && selectedKey === localKey);
    const selectedIsRemote = Boolean(selectedKey && localKey && selectedKey !== localKey);

    return {
      syncActive: Boolean(options.syncActive),
      selectedDeviceId: selectedKey,
      selectedDeviceLabel: deviceLabel(selectedDevice) || String(provider?.sourceDeviceId || '').trim(),
      selectedIsLocal,
      selectedIsRemote,
      hasLocalCandidate: Boolean(localCandidate),
      remoteCount: remoteCandidates.length,
      candidateCount: candidates.length
    };
  }

  function limitProviderProvenanceTags(provenance) {
    if (!provenance?.syncActive) return [];
    if (provenance.selectedIsRemote && provenance.selectedDeviceLabel) {
      const tags = [{
        key: 'settings.limits.device.from',
        values: { device: provenance.selectedDeviceLabel },
        deviceLabel: provenance.selectedDeviceLabel,
        kind: 'device',
        tone: 'remote'
      }];
      if (provenance.hasLocalCandidate) {
        tags.push({ key: 'settings.limits.device.localAlso', kind: 'device', tone: 'multi' });
      }
      return tags;
    }
    if (provenance.selectedIsLocal) {
      if (provenance.remoteCount > 0) {
        return [{
          key: 'settings.limits.device.localAndSynced',
          values: { count: provenance.remoteCount },
          count: provenance.remoteCount,
          kind: 'device',
          tone: 'multi'
        }];
      }
      return [{ key: 'settings.limits.device.local', kind: 'device', tone: 'local' }];
    }
    return [];
  }

  function limitProviderMainDeviceLabel(provenance, options = {}) {
    if (!options.showSource || !provenance?.syncActive || !provenance.selectedIsRemote) return '';
    return provenance.selectedDeviceLabel || '';
  }

  function pluginLimitCapabilityTags(module) {
    const declared = new Set(module.capabilities || []);
    const tags = module.sampling ? [{ label: 'Auto', kind: 'capability' }] : [];
    const sourceLabels = { api: 'API', apiKey: 'API key', oauth: 'OAuth', web: 'Web', cli: 'CLI' };
    const sources = Object.keys(sourceLabels).filter(id => declared.has(id));
    // API key describes the API authentication; do not repeat API/API key.
    if (sources.includes('apiKey') && sources.includes('api')) sources.splice(sources.indexOf('api'), 1);
    if (sources.length) tags.push({ label: sources.map(id => sourceLabels[id]).join('/'), parts: sources.map(id => sourceLabels[id]),
      ...(sources.length === 1 && sources[0] === 'apiKey' ? { key: 'settings.limits.capability.apiKey' } : {}), kind: 'capability' });
    tags.push(...(module.tags || []).map(label => ({ label, kind: 'custom' })));
    return tags;
  }

  // Credential state comes from the host's revision-bound verification, never
  // from a quota reading or whether an author has mounted its settings UI.
  function pluginLimitSettingsStatus(module, provider, enabled = true) {
    if (!enabled || provider?.status === 'disabled') return null;
    if (module.credentials && module.credentialState) {
      const saved = module.credentialState;
      const status = saved.verification !== 'unverified' ? saved.verification
        : !saved.hasSaved ? 'notConfigured' : saved.configured ? 'configured' : 'partial';
      return { key: `plugins.credentials.${['valid', 'verifying'].includes(status) ? '' : 'status.'}${status}`,
        detailKey: `plugins.credentials.${status}`, tone: status === 'valid' ? 'ok' : 'setup' };
    }
    if (!provider) return { key: 'plugins.limits.awaitingData', tone: 'muted' };
    if (provider.status === 'ok' && !provider.stale) return null;
    if (provider.status === 'notConfigured') return { key: 'settings.limits.status.notSetUp', tone: 'setup' };
    if (provider.status === 'unauthorized') return { key: module.credentials ? 'plugins.credentials.invalid' : 'settings.limits.status.error', tone: 'setup' };
    if (provider.status === 'error') return { key: 'plugins.limits.readFailed', tone: 'warn' };
    return limitProviderStatusLabel(provider);
  }

  function limitProviderSettingsTags(providerOrId, provenance = null) {
    const tags = [];
    const provider = typeof providerOrId === 'object' && providerOrId ? providerOrId : { provider: providerOrId };
    const status = limitProviderStatusLabel(provider);
    if (status) tags.push({ ...status, kind: 'status' });
    if (status && (provider.status === 'ok' || provider.stale)) {
      const sourceLabel = limitProviderSourceLabel(provider);
      if (sourceLabel) tags.push({ label: sourceLabel, kind: 'source' });
      tags.push(...limitProviderProvenanceTags(provenance));
      return tags;
    }
    for (const label of limitProviderCapabilityTags(provider)) {
      tags.push({ label, kind: 'capability' });
    }
    return tags;
  }

  // A total describes the entire group, never just the successful subset. Compare
  // every non-measurement field too: currency, pool, period and reset boundaries
  // must describe the same kind of finite entitlement before addition is useful.
  const workbuddyCreditTotals = policies.workbuddy.workbuddyCreditTotals;

  function limitProviderSettingsRecord(providers, id) {
    const rows = (providers || []).filter(row => row.provider === id);
    return policies[id]?.settingsRecord?.(rows, { isMimoMembershipProduct }) ?? rows.at(-1);
  }

  return {
    connectionSources,
    connectionTag,
    antigravityQuotaWindow,
    antigravityQuotaWindowVisible,
    apiKeyAccountStatus,
    codexAdditionalQuotaDisplayName,
    isCodexLiveAccount,
    limitProviderCapabilityTags,
    limitProviderCompactWindowLabel,
    limitProviderCompactWindowPeriodLabel,
    limitProviderCompactWindows,
    limitProviderFreshness,
    limitProviderDisplayLabel,
    limitProviderPlanDisplayLabel,
    limitProviderPlanValue,
    limitProviderLegacyPlanLabel,
    limitProviderFailureLabel,
    limitProviderMainDeviceLabel,
    namedApiProfileStatus,
    limitProviderProvenance,
    limitBoundaryText,
    limitDurationText,
    limitResetRemainingMs,
    limitProviderSourceLabel,
    limitProviderStatusLabel,
    pluginLimitCapabilityTags,
    pluginLimitSettingsStatus,
    limitProviderSettingsTags,
    limitProviderSettingsRecord,
    thirdPartyAdapterFamily,
    thirdPartyAdapterVisual,
    thirdPartyGroupPlanText,
    thirdPartySharedAdapterFamily,
    workbuddyCreditTotals,
    isWorkbuddyPlaceholder
  };
});
