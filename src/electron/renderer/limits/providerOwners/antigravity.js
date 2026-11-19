'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorAntigravityAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, isSettingsSurfaceVisible, accountShellApi, t, renderSettingsSummaries, refreshStats } = host;
 const state = {antigravityAccountError: host.initial.antigravityAccountError, antigravitySignInBusy: host.initial.antigravitySignInBusy, antigravityAccountExpanded: host.initial.antigravityAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setAntigravityAccountExpanded(expanded) {
  setAccountGroupExpanded('antigravity', expanded, 'antigravityAccountExpanded');
}

function renderAntigravityStatus() {
  if (!isSettingsSurfaceVisible()) return;
  const statusEl = document.getElementById('antigravityAccountStatus');
  const listEl = document.getElementById('antigravityAccountList');
  const errorEl = document.getElementById('antigravityAccountErrorMessage');
  const statusMessage = document.getElementById('antigravityLoginStatus');
  const addButton = document.getElementById('antigravityAddAccountButton');
  const cancelButton = document.getElementById('antigravityCancelLoginButton');
  if (!statusEl || !listEl || !errorEl || !addButton || !cancelButton) return;
  const accounts = state.settings?.antigravityManagedAccounts || [];
  const enabledCount = accounts.filter((account) => account.enabled !== false).length;
  accountShellApi.render({
    status: statusEl,
    statusText: accounts.length === 0
      ? t('settings.antigravity.notConfigured')
      : t('settings.antigravity.connected', { linked: enabledCount, total: accounts.length }),
    error: errorEl,
    errorText: state.antigravityAccountError,
    progress: statusMessage,
    progressText: state.antigravitySignInBusy ? t('settings.antigravity.loginStatus') : ''
  });
  addButton.classList.add('hidden');
  addButton.disabled = state.antigravitySignInBusy;
  addButton.textContent = t(state.antigravitySignInBusy
    ? 'settings.antigravity.waitingForGoogle'
    : 'settings.antigravity.addAccount');
  cancelButton.classList.toggle('hidden', !state.antigravitySignInBusy);

  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: () => t('settings.limits.sources.oauth'),
      editor: { retryAvailable: () => Boolean(state.antigravityAccountError), isOpen: () => state.antigravitySignInBusy || Boolean(state.antigravityAccountError), allowBusyCancel: true, nodes: ['antigravityLoginStatus', 'antigravityAccountErrorMessage', 'antigravityCancelLoginButton'], cancel: () => { if (state.antigravitySignInBusy) document.getElementById('antigravityCancelLoginButton')?.click(); else { state.antigravityAccountError = ''; renderAntigravityStatus(); } } },
    document, provider: 'antigravity', label: host.providerLabel || 'Antigravity', add: startAntigravityLogin, container: listEl, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => window.tokenMonitor.antigravity.setAccountEnabled(account.id, value),
    remove: account => window.tokenMonitor.antigravity.removeAccount(account.id),
    changed: result => { if (result.accounts) state.settings.antigravityManagedAccounts = result.accounts; }, refresh: renderAntigravityStatus, busy: () => state.antigravitySignInBusy
  });
  accountList.update(accounts, host.localProviderStatuses('antigravity'));
  renderSettingsSummaries();
}
async function startAntigravityLogin() {
  if (state.antigravitySignInBusy) return;
  state.antigravitySignInBusy = true;
  state.antigravityAccountError = '';
  renderAntigravityStatus();
  let result;
  try {
    result = await window.tokenMonitor.antigravity.addAccount();
  } catch (error) {
    result = { ok: false, error: error.message };
  } finally {
    state.antigravitySignInBusy = false;
  }
  if (!result?.ok && result?.errorCode !== 'cancelled') {
    const errorKeys = {
      OAUTH_CLIENT_NOT_FOUND: 'settings.antigravity.oauthClientMissing',
      TIMEOUT: 'settings.antigravity.loginTimeout',
      STATE_MISMATCH: 'settings.antigravity.loginStateMismatch',
      credentialStorageUnavailable: 'settings.antigravity.credentialStorageUnavailable',
      loginInProgress: 'settings.antigravity.loginInProgress'
    };
    state.antigravityAccountError = errorKeys[result?.errorCode]
      ? t(errorKeys[result.errorCode])
      : result?.error || t('settings.antigravity.loginFailed');
  } else if (result?.ok) {
    state.antigravityAccountError = '';
    state.settings.antigravityManagedAccounts = result.accounts || [];
    // Match the Codex account flow: the account is connected as soon as its
    // credential is stored. Quota onboarding and refresh continue in the
    // background instead of leaving the login button visually busy.
    refreshStats({ force: true }).catch(() => {});
  }
  renderAntigravityStatus();

}
function setup() {
  const antigravityToggle = document.getElementById('antigravitySettingsToggle');
  if (antigravityToggle && window.tokenMonitor.antigravity) {
    antigravityToggle.addEventListener('click', () => {
      setAntigravityAccountExpanded(!state.antigravityAccountExpanded);
    });
    setAntigravityAccountExpanded(false);
    renderAntigravityStatus();

    window.tokenMonitor.antigravity.onAccounts((accounts) => {
      state.settings.antigravityManagedAccounts = accounts || [];
      renderAntigravityStatus();
    });
    window.tokenMonitor.antigravity.accounts().then((accounts) => {
      state.settings.antigravityManagedAccounts = accounts || [];
      renderAntigravityStatus();
    }).catch(() => {});


    document.getElementById('antigravityCancelLoginButton').addEventListener('click', async () => {
      await window.tokenMonitor.antigravity.cancelLogin();
      // The add request owns busy until its cancellation and cleanup settle.
      renderAntigravityStatus();
    });
  }


}
 return { state, setAntigravityAccountExpanded, renderAntigravityStatus, startAntigravityLogin, setup };
});
