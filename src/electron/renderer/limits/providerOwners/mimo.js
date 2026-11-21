'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorMimoAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, t, isSettingsSurfaceVisible, accountShellApi, renderSettingsSummaries, refreshStats } = host;
 const state = {mimoAccountError: host.initial.mimoAccountError, mimoAccountExpanded: host.initial.mimoAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setMimoAccountExpanded(expanded) {
  setAccountGroupExpanded('mimo', expanded, 'mimoAccountExpanded');
}

async function refreshMimoAccounts() {
  try {
    state.settings.mimoManagedAccounts = await window.tokenMonitor.mimo.accounts() || [];
    renderMimoStatus();
  } catch (_) {}
}

function mimoSettingsAccountTitle(account, index) {
  // The discovered session has no address to name it by — nothing was pasted for
  // it — so it is named after the app it comes from.
  if (account?.removable === false) return t('settings.mimo.desktopAccount');
  return String(account?.accountEmail || '').trim() || `Account ${index + 1}`;
}

function renderMimoStatus() {
  if (!isSettingsSurfaceVisible()) return;
  const statusEl = document.getElementById('mimoAccountStatus');
  const listEl = document.getElementById('mimoAccountList');
  const emptyEl = document.getElementById('mimoAccountEmpty');
  const errorEl = document.getElementById('mimoAccountErrorMessage');
  if (!statusEl || !listEl || !emptyEl || !errorEl) return;
  const accounts = state.settings?.mimoManagedAccounts || [];

  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: account => t(account.removable === false ? 'settings.limits.sources.desktop' : 'settings.limits.sources.web'),
      editor: { submit: 'mimoSaveAccountButton', nodes: ['mimoAddDetails'], visibility: 'mimoAddDetails', cancel: () => setMimoAddExpanded(false) },
    document, provider: 'mimo', label: host.providerLabel || 'MiMo',
    add: () => setMimoAddExpanded(document.getElementById('mimoAddDetails')?.classList.contains('hidden')), container: listEl, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => window.tokenMonitor.mimo.setAccountEnabled(account.id, value),
    remove: account => window.tokenMonitor.mimo.removeAccount(account.id),
    changed: result => { if (result.accounts) state.settings.mimoManagedAccounts = result.accounts; }, refresh: refreshMimoAccounts, busy: () => document.getElementById('mimoSaveAccountButton')?.disabled === true,
    readings: () => host.localProviderStatuses('mimo'),
    status: { element: () => document.getElementById('mimoAccountStatus'), empty: () => t('settings.mimo.notConfigured') }
  });
  accountList.update(accounts.map((account, index) => ({ ...account, canPause: account.removable !== false, accountName: mimoSettingsAccountTitle(account, index) })), host.localProviderStatuses('mimo'));
  accountShellApi.render({ error: errorEl, errorText: state.mimoAccountError });
  emptyEl.classList.add('hidden');
  renderSettingsSummaries();
}
function setMimoAddExpanded(expanded) {
  const next = Boolean(expanded);
  document.getElementById('mimoAddToggle')?.setAttribute('aria-expanded', String(next));
  document.getElementById('mimoAddDetails')?.classList.toggle('hidden', !next);
  document.getElementById('mimoManualPanel')?.classList.toggle('expanded', next);
}
function setup() {
  const mimoToggle = document.getElementById('mimoSettingsToggle');
  if (mimoToggle) {
    mimoToggle.addEventListener('click', () => {
      const expanding = !state.mimoAccountExpanded;
      setMimoAccountExpanded(expanding);
      if (expanding) void refreshMimoAccounts();
    });

    const addToggle = document.getElementById('mimoAddToggle');
    addToggle?.classList.toggle('hidden', true);
    const addDetails = document.getElementById('mimoAddDetails');

    addToggle?.addEventListener('click', () => setMimoAddExpanded(addDetails?.classList.contains('hidden')));
    setMimoAccountExpanded(false);
    renderMimoStatus();

    window.tokenMonitor.mimo.onAccounts((accounts) => {
      state.settings.mimoManagedAccounts = accounts || [];
      renderMimoStatus();
    });

    void refreshMimoAccounts();

    document.getElementById('mimoOpenConsoleButton').addEventListener('click', async () => {
      const result = await window.tokenMonitor.mimo.openConsole();
      if (!result?.ok) {
        state.mimoAccountError = result?.error || t('settings.mimo.openFailed');
        renderMimoStatus();
        return;
      }
      state.mimoAccountError = '';
      renderMimoStatus();
    });

    document.getElementById('mimoSaveAccountButton').addEventListener('click', async () => {
      const input = document.getElementById('mimoCookieInput');
      const saveButton = document.getElementById('mimoSaveAccountButton');
      saveButton.disabled = true;
      saveButton.textContent = t('settings.mimo.checking');
      renderMimoStatus();
      const draft = input.value;
      let result;
      try {
        result = await window.tokenMonitor.mimo.addAccount(draft);
      } catch (_) {
        result = { ok: false, errorCode: 'validationUnavailable' };
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = t('settings.mimo.saveAccount');
      }
      if (!result?.ok) {
        if (result?.errorCode === 'missingRequiredCookies') {
          state.mimoAccountError = t('settings.mimo.missingCookies', { cookies: (result.missingCookies || []).join(', ') });
        } else if (result?.errorCode === 'invalidCookie') {
          state.mimoAccountError = t('settings.mimo.invalidCookie');
        } else if (result?.errorCode === 'validationRateLimited') {
          state.mimoAccountError = t('settings.mimo.validationRateLimited');
        } else if (result?.errorCode === 'validationUnavailable') {
          state.mimoAccountError = t('settings.mimo.validationUnavailable');
        } else if (result?.errorCode === 'credentialStorageUnavailable') {
          state.mimoAccountError = t('settings.mimo.credentialStorageUnavailable');
        } else {
          state.mimoAccountError = result?.error || t('settings.mimo.addFailed');
        }
        renderMimoStatus();
        return;
      }
      const unchanged = input.value === draft;
      if (unchanged) input.value = '';
      state.mimoAccountError = '';
      state.settings.mimoManagedAccounts = await window.tokenMonitor.mimo.accounts();
      renderMimoStatus();
      if (unchanged && input.value === '') setMimoAddExpanded(false);
      await refreshStats({ force: true });
    });
  }



}
 return { state, setMimoAccountExpanded, refreshReadings: () => accountList?.refreshReadings(), refreshMimoAccounts, mimoSettingsAccountTitle, renderMimoStatus, setup };
});
