'use strict';

(function exposeLimitProviderPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitProviderPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createLimitProviderPresentationApi() {
  const SOURCE_LABELS = {
    oauth: 'OAuth',
    cli: 'CLI',
    web: 'Web',
    rpc: 'RPC',
    local: 'Local',
    api: 'API'
  };

  const PROVIDER_SOURCE_LABELS = {
    claude: { oauth: 'OAuth', cli: 'CLI' },
    codex: { rpc: 'RPC' },
    cursor: { web: 'Web' },
    antigravity: { rpc: 'RPC' },
    opencode: { local: 'Local', web: 'Web' },
    deepseek: { api: 'API' },
    minimax: { api: 'API' },
    mimo: { web: 'Web' },
    grok: { rpc: 'CLI', web: 'Web' },
    copilot: { api: 'API' },
    kiro: { cli: 'CLI' },
    zai: { api: 'API' },
    zaiteam: { api: 'API' },
    volcengine: { api: 'API' },
    qoder: { web: 'Web' },
    kimi: { api: 'API' }
  };

  const CODEX_RPC_DETAIL_LABELS = {
    app: 'App',
    cli: 'CLI',
    managed: 'Managed',
    unknown: 'RPC'
  };

  const CAPABILITY_TAGS = {
    claude: ['Auto', 'OAuth/CLI'],
    codex: ['Auto', 'App/CLI RPC'],
    cursor: ['Manual login', 'Web'],
    antigravity: ['App/CLI must be open', 'RPC'],
    opencode: ['Local/Web', 'Manual login'],
    deepseek: ['Pay-as-you-go', 'API key'],
    minimax: ['Token Plan', 'API key'],
    mimo: ['Token Plan', 'Web'],
    grok: ['Auto', 'CLI/Web'],
    copilot: ['Manual login', 'API'],
    kiro: ['Auto', 'CLI'],
    zai: ['Coding Plan', 'API key'],
    zaiteam: ['Team Plan', 'API key'],
    volcengine: ['Coding Plan', 'API key'],
    qoder: ['Manual login', 'Web'],
    kimi: ['Coding Plan', 'API key']
  };

  // Capability hint -> the status label it would duplicate. When that status is
  // active, the hint is suppressed so the row doesn't show two tags saying the
  // same thing (see limitProviderSettingsTags).
  const CAPABILITY_STATUS_DUPLICATES = {
    'App/CLI must be open': 'Open app or CLI'
  };

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
    return String(value || '').trim().toLowerCase();
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
    const provider = providerId(providerOrId);
    const source = sourceId(providerOrId, sourceFallback);
    const sourceDetail = sourceDetailId(providerOrId);
    if (provider === 'codex' && source === 'rpc' && CODEX_RPC_DETAIL_LABELS[sourceDetail]) {
      return CODEX_RPC_DETAIL_LABELS[sourceDetail];
    }
    return PROVIDER_SOURCE_LABELS[provider]?.[source] || SOURCE_LABELS[source] || '';
  }

  function limitProviderCapabilityTags(providerOrId) {
    return (CAPABILITY_TAGS[providerId(providerOrId)] || []).slice();
  }

  function limitProviderDisplayLabel(value) {
    const label = String(value || '').trim();
    if (!label || label.includes('@')) return label;
    return label.replace(/^[a-z]/, (letter) => letter.toUpperCase());
  }

  // The "live" Codex account is the one THIS device's Codex app/CLI is currently
  // signed into (sourceDetail app/cli/unknown). Managed accounts added inside
  // Token Monitor report sourceDetail 'managed' and are NOT live. A remote
  // device's live login (selectedIsRemote) is also not "live" from here — across
  // synced devices, "Live" only ever points at the local account.
  function isCodexLiveAccount(provider, provenance) {
    if (providerId(provider) !== 'codex') return false;
    if (statusId(provider) !== 'ok') return false;
    // "Active" means this device is signed into the account — not that the shown
    // quota came from here. So hide it only when the selected record is remote
    // AND this device has no login of its own for the account; when both devices
    // are signed in, the remote record is selected but the badge still belongs.
    if (provenance && provenance.selectedIsRemote && !provenance.hasLocalCandidate) return false;
    return sourceDetailId(provider) !== 'managed';
  }

  function isLinkedStatus(provider) {
    const providerName = providerId(provider);
    const source = sourceId(provider);
    return providerName === 'cursor'
      || (providerName === 'opencode' && source === 'web')
      || (providerName === 'mimo' && source === 'web');
  }

  function limitProviderStatusLabel(provider = {}) {
    const providerName = providerId(provider);
    const status = statusId(provider);

    if (provider?.stale) return { label: 'Stale', tone: 'stale' };
    if (status === 'ok') return { label: isLinkedStatus(provider) ? 'Linked' : 'Live', tone: 'ok' };
    if (status === 'disabled') return { label: 'Disabled', tone: 'muted' };
    if (status === 'noSyncedData') return { label: 'No synced data', tone: 'sync' };
    if (status === 'unauthorized') {
      return providerName === 'deepseek' || providerName === 'minimax' || providerName === 'copilot' || providerName === 'zai' || providerName === 'zaiteam' || providerName === 'volcengine' || providerName === 'kimi'
        ? { label: 'Update API key', tone: 'setup' }
        : providerName === 'qoder'
          ? { label: 'Sign in again', tone: 'setup' }
          : providerName === 'grok'
          ? { label: 'Re-login', tone: 'setup' }
          : { label: 'Sign in again', tone: 'setup' };
    }
    if (status === 'rateLimited') return { label: 'Limited', tone: 'warn' };
    if (status === 'sourceRateLimited') return { label: 'Usage API limited', tone: 'warn' };
    if (status === 'unavailable') return { label: 'Unavailable', tone: 'warn' };
    if (providerName === 'mimo' && status === 'error') return { label: 'Unavailable', tone: 'warn' };
    if (status === 'notConfigured') {
      if (providerName === 'antigravity') return { label: 'Open app or CLI', tone: 'setup' };
      if (providerName === 'cursor' || providerName === 'copilot' || providerName === 'qoder') return { label: 'Sign in', tone: 'setup' };
      if (providerName === 'deepseek' || providerName === 'minimax' || providerName === 'zai' || providerName === 'zaiteam' || providerName === 'volcengine' || providerName === 'kimi') return { label: 'Add API key', tone: 'setup' };
      if (providerName === 'grok') return { label: 'Run grok login', tone: 'setup' };
      if (providerName === 'kiro') return { label: 'Run kiro-cli login', tone: 'setup' };
      return { label: 'Not set up', tone: 'setup' };
    }
    return status ? { label: 'Error', tone: 'warn' } : null;
  }

  function apiKeyAccountStatus(provider, configured) {
    if (!configured) return 'notConfigured';
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

  function usableProviderCandidate(provider) {
    const status = statusId(provider);
    return status !== 'disabled' && status !== 'notConfigured';
  }

  function accountKey(value) {
    return String(value || '').trim();
  }

  function providerMatchesTarget(candidate, target) {
    if (providerId(candidate) !== providerId(target)) return false;
    const targetAccountKey = accountKey(target?.accountKey);
    if (!targetAccountKey) return true;
    return accountKey(candidate?.accountKey) === targetAccountKey;
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
    // Some capability hints restate the active setup status (e.g. antigravity's
    // "App/CLI must be open" vs the notConfigured "Open app or CLI"). Drop the
    // hint when it would duplicate the status tag already shown.
    const statusLabel = status?.label;
    for (const label of limitProviderCapabilityTags(provider)) {
      if (CAPABILITY_STATUS_DUPLICATES[label] === statusLabel) continue;
      tags.push({ label, kind: 'capability' });
    }
    return tags;
  }

  return {
    apiKeyAccountStatus,
    isCodexLiveAccount,
    limitProviderCapabilityTags,
    limitProviderDisplayLabel,
    limitProviderMainDeviceLabel,
    limitProviderProvenance,
    limitProviderSourceLabel,
    limitProviderStatusLabel,
    limitProviderSettingsTags
  };
});
