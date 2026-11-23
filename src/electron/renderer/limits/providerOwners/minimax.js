'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorMinimaxAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, localProviderStatuses, limitProviderEnabled, limitProviderPresentationApi, accountShellApi, t, translatedLimitProviderTag, isSettingsSurfaceVisible, accountProfileRequests, accountProfileSaves, setAccountShellError, refreshStats, renderSettingsSummaries, setExternalAccountExpanded } = host;
 const state = {minimaxAccountExpanded: host.initial.minimaxAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function updateMinimaxApiKeysStatus() {
  const rows = localProviderStatuses('minimax');
  const enabled = limitProviderEnabled('minimax');
  const remote = host.getAccountContext().records?.filter(row => row.provider === 'minimax') || [];
  const provider = enabled ? limitProviderPresentationApi.limitProviderSettingsRecord(rows.length ? rows : remote, 'minimax') : null;
  accountShellApi.render({
    status: document.getElementById('minimaxStatus'),
    statusText: !enabled
      ? t('settings.limits.status.disabled')
      : provider
        ? translatedLimitProviderTag(limitProviderPresentationApi.limitProviderStatusLabel(provider))
        : t(accountList?.summary().total ? 'settings.common.checking' : 'settings.minimax.statusNotSet')
  });
  accountList?.updateReadings(rows.filter(row => row.source === 'api'));
}

function minimaxKeyErrorText(result) {
  const key = result?.status === 'required' ? 'settings.common.credentialRequired'
    : result?.status === 'invalidFormat' ? 'settings.common.credentialInvalidFormat'
    : result?.status === 'notConfigured' ? 'settings.minimax.statusNotSet'
    : result?.status === 'unauthorized' ? 'settings.minimax.statusInvalid'
    : 'settings.common.unavailable';
  return result?.error || t(key);
}

function minimaxBillingUrl(key) {
  const rows = localProviderStatuses('minimax').filter(row => row.source === 'api');
  const row = key.accountKey ? rows.find(row => row.accountKey === key.accountKey) : null;
  const region = key.apiRegion || state.settings?.minimaxApiRegion || 'auto';
  const intl = region === 'intl' || (region === 'auto' && row?.region !== 'cn');
  const origin = intl ? 'https://platform.minimax.io' : 'https://platform.minimaxi.com';
  return `${origin}/user-center/payment/${key.billingMode === 'api' ? 'balance' : 'token-plan'}`;
}

async function renderMinimaxApiKeys() {
  if (!isSettingsSurfaceVisible()) return;
  const list = document.getElementById('minimaxKeyList');
  const isCurrent = accountProfileRequests.begin('minimax');
  try {
    const keys = await window.tokenMonitor.minimax.getKeys();
    if (!isCurrent() || !isSettingsSurfaceVisible()) return;
  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: () => t('settings.limits.sources.apiKey'),
      editor: { submit: 'minimaxKeySubmit', nodes: ['minimaxAddDetails', 'minimaxErrorMessage'], visibility: 'minimaxAddDetails' },
    document, provider: 'minimax', label: host.providerLabel || 'MiniMax',
    add: () => { document.getElementById('minimaxAddDetails')?.classList.toggle('hidden'); document.getElementById('minimaxApiKeyInput')?.focus(); }, container: list, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => window.tokenMonitor.limits.accountSlots.setEnabled('minimax', account.id, value),
    statusReading: (_account, reading) => limitProviderEnabled('minimax') ? reading : { status: 'disabled' },
    secondaryText: account => t(account.billingMode === 'api' ? 'settings.minimax.billingApi' : 'settings.minimax.billingTokenPlan'),
    actions: () => [{ label: t('settings.minimax.openBrowser'), run: account => window.tokenMonitor.openExternal(minimaxBillingUrl(account)) }],
    remove: account => window.tokenMonitor.minimax.removeKey(account.id),
    changed: _result => {  }, refresh: renderMinimaxApiKeys, busy: () => document.getElementById('minimaxKeySubmit')?.disabled === true
  });
  accountList.update(keys.map((key, index) => ({ ...key, accountName: t("settings.minimax.accountFallback", { number: index + 1 }) })), host.localProviderStatuses('minimax').filter(row => row.source === 'api'));
    updateMinimaxApiKeysStatus();
    renderSettingsSummaries();
  } catch (_) {
    if (!isCurrent() || !isSettingsSurfaceVisible()) return;
    accountShellApi.render({
      status: document.getElementById('minimaxStatus'),
      statusText: t('settings.common.unavailable')
    });
  }
}
function setup() {
  const minimaxToggle = document.getElementById('minimaxSettingsToggle');
  if (minimaxToggle) {
    minimaxToggle.addEventListener('click', () => {
      const expanded = !state.minimaxAccountExpanded;
      setExternalAccountExpanded('minimax', expanded);
      if (expanded) renderMinimaxApiKeys();
    });
    document.getElementById('minimaxOpenBrowser').addEventListener('click', () => {
      const billingMode = document.getElementById('minimaxBillingModeInput').value;
      const apiRegion = document.getElementById('minimaxApiRegionInput').value;
      window.tokenMonitor.openExternal(minimaxBillingUrl({ billingMode, apiRegion }));
    });
    const submit = document.getElementById('minimaxKeySubmit');
    submit.addEventListener('click', () => accountProfileSaves.run('minimax', submit, async () => {
      setAccountShellError('minimax', '');
      const input = document.getElementById('minimaxApiKeyInput');
      const mode = document.getElementById('minimaxBillingModeInput');
      const region = document.getElementById('minimaxApiRegionInput');
      const draft = { apiKey: input.value, billingMode: mode.value, apiRegion: region.value };
      const result = await window.tokenMonitor.minimax.addKey(draft);
      const unchanged = input.value === draft.apiKey && mode.value === draft.billingMode
        && region.value === draft.apiRegion;
      if (!result?.ok) {
        if (unchanged) setAccountShellError('minimax', minimaxKeyErrorText(result));
        return;
      }
      if (unchanged) input.value = '';
      await renderMinimaxApiKeys();
      await refreshStats();
    }));
  }


}
 return { state, updateMinimaxApiKeysStatus, refreshReadings: updateMinimaxApiKeysStatus, minimaxKeyErrorText, minimaxBillingUrl, renderMinimaxApiKeys, setup };
});
