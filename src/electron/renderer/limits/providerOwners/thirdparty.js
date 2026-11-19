'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorThirdpartyAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, t, limitProviderPresentationApi, optionalFiniteNumber, formatCompactMoney, currentLocale, limitProviderEnabled, localProviderStatuses, accountShellApi, renderSettingsSummaries, setAccountShellError, isSettingsSurfaceVisible, renderAccountShellError, accountProfileRequests, accountProfileSaves, refreshStats } = host;
 const state = {thirdPartyAccountExpanded: host.initial.thirdPartyAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setThirdPartyAccountExpanded(expanded) {
  setAccountGroupExpanded('thirdparty', expanded, 'thirdPartyAccountExpanded');
}

function selectedThirdPartyAdapter() {
  const platform = String(document.getElementById('thirdpartyPlatformInput')?.value || 'newapi');
  const mode = String(document.getElementById('thirdpartyModeInput')?.value || 'account');
  if (platform === 'custom') return 'custom';
  if (platform === 'sub2api') return 'sub2api';
  return mode === 'token' ? 'newapi-token' : 'newapi-account';
}

function updateThirdPartyHttpWarning() {
  const input = document.getElementById('thirdpartyBaseUrlInput');
  const warning = document.getElementById('thirdpartyHttpWarning');
  if (!warning) return;
  let insecure;
  try {
    insecure = new URL(String(input?.value || '').trim()).protocol === 'http:';
  } catch {
    warning.classList.add('hidden');
    return;
  }
  warning.classList.toggle('hidden', !insecure);
}

function setThirdPartyAdapterFields() {
  const adapter = selectedThirdPartyAdapter();
  const customMode = adapter === 'custom';
  const sub2apiMode = adapter === 'sub2api';
  const singleChoiceField = customMode || sub2apiMode;
  const accountMode = adapter === 'newapi-account' || sub2apiMode;
  const newApiAccountMode = adapter === 'newapi-account';
  const pairedCredentials = newApiAccountMode;
  document.getElementById('thirdpartyChoiceGrid')?.classList.toggle('single-field', singleChoiceField);
  document.getElementById('thirdpartyModeField')?.classList.toggle('hidden', singleChoiceField);
  document.getElementById('thirdpartyCredentialGrid')?.classList.toggle(
    'single-field',
    !pairedCredentials
  );
  document.getElementById('thirdpartyAccessTokenRow')?.classList.toggle('hidden', !accountMode);
  document.getElementById('thirdpartyRefreshTokenRow')?.classList.toggle('hidden', !sub2apiMode);
  document.getElementById('thirdpartySub2ApiSteps')?.classList.toggle('hidden', !sub2apiMode);
  document.getElementById('thirdpartyUserIdRow')?.classList.toggle('hidden', !newApiAccountMode);
  document.getElementById('thirdpartyApiKeyRow')?.classList.toggle('hidden', accountMode);
  document.getElementById('thirdpartyCustomConfig')?.classList.toggle('hidden', !customMode);
  const hint = document.getElementById('thirdpartyModeHint');
  if (hint) {
    const hintKey = customMode
      ? 'settings.thirdparty.hintCustom'
      : sub2apiMode
        ? 'settings.thirdparty.hintSub2Api'
        : adapter === 'newapi-token'
          ? 'settings.thirdparty.hintNewApiToken'
          : 'settings.thirdparty.hintNewApiAccount';
    hint.textContent = t(hintKey);
  }
  const accessTokenLabel = document.getElementById('thirdpartyAccessTokenLabel');
  const accessTokenInput = document.getElementById('thirdpartyAccessTokenInput');
  const refreshTokenLabel = document.getElementById('thirdpartyRefreshTokenLabel');
  const refreshTokenInput = document.getElementById('thirdpartyRefreshTokenInput');
  const accessTokenKey = 'settings.thirdparty.accessToken';
  const accessTokenPlaceholderKey = sub2apiMode
    ? 'settings.thirdparty.sub2ApiAccessTokenPlaceholder'
    : 'settings.thirdparty.accessTokenPlaceholder';
  const refreshTokenKey = 'settings.thirdparty.refreshToken';
  const refreshTokenPlaceholderKey = sub2apiMode
    ? 'settings.thirdparty.sub2ApiRefreshTokenPlaceholder'
    : 'settings.thirdparty.refreshTokenPlaceholder';
  if (accessTokenLabel) {
    accessTokenLabel.dataset.i18n = accessTokenKey;
    accessTokenLabel.textContent = t(accessTokenKey);
  }
  if (accessTokenInput) {
    accessTokenInput.dataset.i18nPlaceholder = accessTokenPlaceholderKey;
    accessTokenInput.placeholder = t(accessTokenPlaceholderKey);
  }
  if (refreshTokenLabel) {
    refreshTokenLabel.dataset.i18n = refreshTokenKey;
    refreshTokenLabel.textContent = t(refreshTokenKey);
  }
  if (refreshTokenInput) {
    refreshTokenInput.dataset.i18nPlaceholder = refreshTokenPlaceholderKey;
    refreshTokenInput.placeholder = t(refreshTokenPlaceholderKey);
  }
}

function thirdPartyProfileStatusText(provider, options = {}) {
  const status = limitProviderPresentationApi.namedApiProfileStatus(provider, options);
  if (status === 'disabled') return t('settings.profiles.disabled');
  if (status === 'hidden') return '';
  if (status === 'checking') return t('settings.thirdparty.checking');
  if (status === 'invalid') return t('settings.thirdparty.invalidKey');
  if (status !== 'linked') return t('settings.thirdparty.unavailable');
  const balance = optionalFiniteNumber(provider.balance?.amount);
  if (balance !== null) return `✓ ${formatCompactMoney(balance, provider.balance?.currency || 'USD', state.settings?.compactTokenUnits, currentLocale())}`;
  const unlimited = (provider.windows || []).some((window) => (
    window?.showMeter === false && String(window?.detail || '').toLowerCase() === 'unlimited'
  ));
  return unlimited ? `✓ ${t('settings.thirdparty.unlimited')}` : '✓';
}

function updateNamedApiProfilesStatus({
  providerId,
  profileSettingsKey,
  profileCountStateKey,
  statusText
}) {
  const providerEnabled = limitProviderEnabled(providerId);
  const providers = localProviderStatuses(providerId);
  const byName = new Map(providers.map((provider) => [
    String(provider.accountName || provider.accountLabel || ''),
    provider
  ]));
  for (const infoEl of document.querySelectorAll(`[data-managed-profile-provider="${providerId}"][data-managed-profile-name]`)) {
    const name = infoEl.dataset.managedProfileName || '';
    const profile = state.settings?.[profileSettingsKey]?.[name];
    infoEl.textContent = statusText(byName.get(name), {
      providerEnabled,
      profileEnabled: profile?.enabled !== false
    });
  }
  const envInfo = document.querySelector(
    `[data-managed-profile-provider="${providerId}"][data-managed-profile-environment]`
  );
  if (envInfo) envInfo.textContent = statusText(byName.get('environment'), { providerEnabled });
  const statusEl = document.getElementById(`${providerId}Status`);
  if (!statusEl) return;
  const total = state[profileCountStateKey] || 0;
  const linked = providers.filter((provider) => provider.status === 'ok').length;
  accountShellApi.render({
    status: statusEl,
    statusText: total === 0
      ? t(`settings.${providerId}.statusNotSet`)
      : !providerEnabled
        ? t(`settings.${providerId}.nAccounts`, { count: total })
        : t(`settings.${providerId}.connected`, { linked, total })
  });
}

function updateThirdPartyProfilesStatus() {
  accountList?.updateReadings(localProviderStatuses('thirdparty'));
  updateNamedApiProfilesStatus({
    providerId: 'thirdparty',
    profileSettingsKey: 'thirdPartyProfiles',
    profileCountStateKey: 'thirdPartyProfileCount',
    statusText: thirdPartyProfileStatusText
  });
}

function thirdPartyProfileErrorText(result, adapter = '') {
  if (result?.errorCode === 'invalidName') return t('settings.thirdparty.invalidName');
  if (result?.errorCode === 'invalidAdapter') return t('settings.thirdparty.invalidAdapter');
  if (result?.errorCode === 'invalidBaseUrl') return t('settings.thirdparty.invalidBaseUrl');
  if (result?.errorCode === 'missingAccessToken' && adapter === 'sub2api') {
    return t('settings.thirdparty.missingSub2ApiToken');
  }
  if (result?.errorCode === 'missingAccessToken') return t('settings.thirdparty.missingAccessToken');
  if (result?.errorCode === 'missingApiKey') return t('settings.thirdparty.missingApiKey');
  if (result?.errorCode === 'invalidCredential' && adapter === 'sub2api') {
    return t('settings.thirdparty.sub2ApiCredentialRejected');
  }
  if (result?.errorCode === 'newApiLegacyTokenRetired') return t('settings.thirdparty.legacyTokenRetired');
  if (result?.errorCode === 'newApiScopeDenied') return t('settings.thirdparty.scopeDenied');
  if (result?.errorCode === 'invalidEndpointPath') return t('settings.thirdparty.invalidEndpointPath');
  if (result?.errorCode === 'invalidAuthMode') return t('settings.thirdparty.invalidAuthMode');
  if (result?.errorCode === 'invalidJsonPath') return t('settings.thirdparty.invalidJsonPath');
  if (result?.errorCode === 'invalidCurrency') return t('settings.thirdparty.invalidCurrency');
  if (result?.errorCode === 'invalidDivisor') return t('settings.thirdparty.invalidDivisor');
  if (result?.errorCode === 'invalidCredential') return t('settings.thirdparty.invalidCredential');
  if (result?.errorCode === 'unavailable') return t('settings.thirdparty.unavailable');
  return result?.error || t('settings.thirdparty.saveFailedShort');
}

function renderNamedApiProfiles(config) {
  if (!isSettingsSurfaceVisible()) return;
  const {
    providerId,
    profileSettingsKey,
    envConfiguredKey,
    profileCountStateKey,
    api,
    rerender,
    updateStatus,
    detailForProfile = () => '',
  } = config;
  const listEl = document.getElementById(`${providerId}ProfileList`);
  if (!listEl || !api) return;
  renderAccountShellError(providerId);
  const isCurrent = accountProfileRequests.begin(providerId);
  api.getProfiles().then(({ profiles, hasEnvVar, environmentAccountKey }) => {
    if (!isCurrent() || !isSettingsSurfaceVisible() || document.getElementById(`${providerId}ProfileList`) !== listEl) return;
    if (!accountList) listEl.replaceChildren();
    state.settings[profileSettingsKey] = profiles;
    state.settings[envConfiguredKey] = Boolean(hasEnvVar);
    const entries = Object.entries(profiles);
    state[profileCountStateKey] = entries.length + (hasEnvVar ? 1 : 0);

    if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      busy: () => document.getElementById('thirdpartyProfileSubmit')?.disabled === true,
      sourceLabel: account => account.source === 'environment' ? t('settings.limits.sources.env') : '',
      editor: { submit: 'thirdpartyProfileSubmit', nodes: ['thirdpartyAddDetails'], visibility: 'thirdpartyAddDetails', cancel: () => setThirdPartyAddExpanded(false) },
      document, provider: providerId, label: host.providerLabel || providerId,
      add: () => {
        resetThirdPartyDraft();
        setThirdPartyAddExpanded(true);
      }, container: listEl, t, bridge: window.tokenMonitor,
      getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
      detailText: account => account.source === 'environment' ? '' : detailForProfile(account),
      enabled: (account, value) => api.setProfileEnabled(account.id, value),
      remove: account => api.deleteProfile(account.id), changed: () => {}, refresh: rerender,
      edit: account => {
        const profile = account;
        resetThirdPartyDraft();
        const name = document.getElementById('thirdpartyProfileName');
        name.value = account.id;
        name.readOnly = true;
        document.getElementById('thirdpartyBaseUrlInput').value = profile.baseUrl || '';
        document.getElementById('thirdpartyPlatformInput').value = profile.adapter === 'newapi-account' || profile.adapter === 'newapi-token' ? 'newapi' : profile.adapter;
        document.getElementById('thirdpartyModeInput').value = profile.adapter === 'newapi-token' ? 'token' : 'account';
        for (const [field, key] of Object.entries({ UserId: 'userId', EndpointPath: 'endpointPath', AuthMode: 'authMode', RemainingPath: 'remainingPath', UsedPath: 'usedPath', TotalPath: 'totalPath', Currency: 'currency', Divisor: 'divisor' })) {
          const input = document.getElementById(`thirdparty${field}Input`);
          if (input && profile[key] !== undefined) input.value = profile[key];
        }
        setThirdPartyAdapterFields();
        updateThirdPartyHttpWarning();
        document.getElementById('thirdpartyAddDetails').classList.remove('hidden');
        document.getElementById('thirdpartyAddToggle').setAttribute('aria-expanded', 'true');
      }
    });
    accountList.update([
      ...entries.map(([name, profile]) => ({ ...profile, id: name, accountName: name, accountKey: profile.accountKey || profile.canonicalAccountKey })),
      ...(hasEnvVar ? [{ id: 'environment', accountKey: environmentAccountKey, accountName: t('settings.thirdparty.environment'), source: 'environment', canPause: false, removable: false }] : [])
    ], host.localProviderStatuses(providerId));
    updateStatus();
    renderSettingsSummaries();
  }).catch(() => {
    if (!isCurrent() || !isSettingsSurfaceVisible()) return;
    accountShellApi.render({
      status: document.getElementById(`${providerId}Status`),
      statusText: t(`settings.${providerId}.unavailable`)
    });
  });
}

function renderThirdPartyProfiles() {
  renderNamedApiProfiles({
    providerId: 'thirdparty',
    profileSettingsKey: 'thirdPartyProfiles',
    envConfiguredKey: 'thirdPartyEnvConfigured',
    profileCountStateKey: 'thirdPartyProfileCount',
    api: window.tokenMonitor.thirdparty,
    rerender: renderThirdPartyProfiles,
    updateStatus: updateThirdPartyProfilesStatus,
    errorText: thirdPartyProfileErrorText,
    detailForProfile: (profile) => {
      const adapter = profile?.adapter === 'newapi-token'
        ? t('settings.thirdparty.detailNewApiKey')
        : profile?.adapter === 'custom'
          ? t('settings.thirdparty.detailCustom')
          : profile?.adapter === 'sub2api'
            ? t('settings.thirdparty.detailSub2Api')
            : t('settings.thirdparty.detailNewApiAccount');
      let host = '';
      try { host = new URL(String(profile?.baseUrl || '')).host; } catch (_) {}
      return [adapter, host].filter(Boolean).join(' · ');
    }
  });
}
let draftRevision = 0;

function resetThirdPartyDraft() {
  draftRevision += 1;
  const inputs = ['BaseUrl', 'AccessToken', 'RefreshToken', 'ApiKey', 'UserId', 'EndpointPath',
    'RemainingPath', 'UsedPath', 'TotalPath', 'Currency', 'Divisor'];
  for (const field of inputs) {
    const input = document.getElementById(`thirdparty${field}Input`);
    if (input) input.value = input.defaultValue ?? '';
  }
  for (const [id, value] of Object.entries({ thirdpartyPlatformInput: 'newapi', thirdpartyModeInput: 'account', thirdpartyAuthModeInput: 'bearer' })) {
    const select = document.getElementById(id);
    if (select) select.value = value;
  }
  const name = document.getElementById('thirdpartyProfileName');
  name.value = '';
  name.readOnly = false;
  setThirdPartyAdapterFields();
  updateThirdPartyHttpWarning();
}
function setThirdPartyAddExpanded(expanded) {
  const next = Boolean(expanded);
  if (!next) draftRevision += 1;
  document.getElementById('thirdpartyAddToggle')?.setAttribute('aria-expanded', String(next));
  document.getElementById('thirdpartyAddDetails')?.classList.toggle('hidden', !next);
  document.getElementById('thirdpartyAddForm')?.classList.toggle('expanded', next);
}
function setup() {
  const thirdpartyToggle = document.getElementById('thirdpartySettingsToggle');
  if (thirdpartyToggle) {
    thirdpartyToggle.addEventListener('click', () => {
      const expanding = !state.thirdPartyAccountExpanded;
      setThirdPartyAccountExpanded(expanding);
      if (expanding) renderThirdPartyProfiles();
    });
    setThirdPartyAccountExpanded(false);

    const addToggle = document.getElementById('thirdpartyAddToggle');
    const platformInput = document.getElementById('thirdpartyPlatformInput');
    const modeInput = document.getElementById('thirdpartyModeInput');
    const baseUrlInput = document.getElementById('thirdpartyBaseUrlInput');
    platformInput?.addEventListener('change', setThirdPartyAdapterFields);
    modeInput?.addEventListener('change', setThirdPartyAdapterFields);
    baseUrlInput?.addEventListener('input', updateThirdPartyHttpWarning);
    setThirdPartyAdapterFields();
    updateThirdPartyHttpWarning();
    addToggle?.classList.add('hidden');

    const profileSubmit = document.getElementById('thirdpartyProfileSubmit');
    profileSubmit?.addEventListener('click', () => accountProfileSaves.run('thirdparty', profileSubmit, async () => {
      const nameInput = document.getElementById('thirdpartyProfileName');
      const accessTokenInput = document.getElementById('thirdpartyAccessTokenInput');
      const refreshTokenInput = document.getElementById('thirdpartyRefreshTokenInput');
      const userIdInput = document.getElementById('thirdpartyUserIdInput');
      const keyInput = document.getElementById('thirdpartyApiKeyInput');
      const endpointPathInput = document.getElementById('thirdpartyEndpointPathInput');
      const authModeInput = document.getElementById('thirdpartyAuthModeInput');
      const remainingPathInput = document.getElementById('thirdpartyRemainingPathInput');
      const usedPathInput = document.getElementById('thirdpartyUsedPathInput');
      const totalPathInput = document.getElementById('thirdpartyTotalPathInput');
      const currencyInput = document.getElementById('thirdpartyCurrencyInput');
      const divisorInput = document.getElementById('thirdpartyDivisorInput');
      const name = String(nameInput?.value || '').trim() || 'default';
      const adapter = selectedThirdPartyAdapter();
      const baseUrl = String(baseUrlInput?.value || '').trim();
      const accessToken = String(accessTokenInput?.value || '').trim();
      const refreshToken = String(refreshTokenInput?.value || '').trim();
      const userId = String(userIdInput?.value || '').trim();
      const apiKey = String(keyInput?.value || '').trim();
      setAccountShellError('thirdparty', '');
      if (!nameInput?.readOnly && Object.hasOwn(state.settings.thirdPartyProfiles || {}, name)) {
        setAccountShellError('thirdparty', t('settings.slots.duplicate'));
        return;
      }
      const revision = draftRevision;
      const draftInputs = [...document.getElementById('thirdpartyAddDetails').querySelectorAll('input, select')];
      const draftValues = draftInputs.map(input => input.value);
      const result = await window.tokenMonitor.thirdparty.saveProfile({
        name,
        adapter,
        baseUrl,
        accessToken,
        refreshToken,
        userId,
        apiKey,
        endpointPath: String(endpointPathInput?.value || '').trim(),
        authMode: String(authModeInput?.value || '').trim(),
        remainingPath: String(remainingPathInput?.value || '').trim(),
        usedPath: String(usedPathInput?.value || '').trim(),
        totalPath: String(totalPathInput?.value || '').trim(),
        currency: String(currencyInput?.value || '').trim(),
        divisor: String(divisorInput?.value || '').trim()
      });
      if (result?.ok) {
        const unchanged = revision === draftRevision
          && draftInputs.every((input, index) => input.value === draftValues[index]);
        if (unchanged) {
          resetThirdPartyDraft();
        }
        renderThirdPartyProfiles();
        setAccountShellError(
          'thirdparty',
          result.warning === 'newApiMissingUsageScope' ? t('settings.thirdparty.missingUsageScope') : '',
          result.warning ? 'warning' : 'error'
        );
        await refreshStats({ force: true });
      } else {
        setAccountShellError('thirdparty', thirdPartyProfileErrorText(result, adapter));
      }
    }));
  }


}
 return { state, setThirdPartyAccountExpanded, selectedThirdPartyAdapter, updateThirdPartyHttpWarning, setThirdPartyAdapterFields, thirdPartyProfileStatusText, updateNamedApiProfilesStatus, updateThirdPartyProfilesStatus, thirdPartyProfileErrorText, renderNamedApiProfiles, renderThirdPartyProfiles, setup };
});
