'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorWorkbuddyAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 let realmChoicesOpen = false;
 // Host exposes named capabilities, never the application state object.
 const { document, window, t, renderSettingsSummaries, renderSubscriptionSettings, refreshStats, accountShellApi, setAccountGroupExpanded } = host;
 const state = {workbuddyAccountsRevision: host.initial.workbuddyAccountsRevision, workbuddyMutationBusy: host.initial.workbuddyMutationBusy, workbuddySignInBusy: host.initial.workbuddySignInBusy, workbuddyCancelBusy: host.initial.workbuddyCancelBusy, workbuddyAccountError: host.initial.workbuddyAccountError, workbuddyLoginAttempt: host.initial.workbuddyLoginAttempt, workbuddyPendingLoginResult: host.initial.workbuddyPendingLoginResult, workbuddyLoginStatusKey: host.initial.workbuddyLoginStatusKey, workbuddyAccountExpanded: host.initial.workbuddyAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function workbuddyAccountError(code, fallback = 'loginFailed') {
  const keys = {
    TIMEOUT: 'loginTimeout',
    STATE_MISMATCH: 'loginStateMismatch',
    INVALID_STATE: 'loginStateMismatch',
    INVALID_LOGIN_URL: 'loginStateMismatch',
    CONTEXT_CHANGED: 'loginStateMismatch',
    credentialStorageUnavailable: 'credentialStorageUnavailable',
    PERSISTENCE_FAILED: 'credentialStorageUnavailable',
    ROLLBACK_FAILED: 'credentialStorageUnavailable',
    loginInProgress: 'loginInProgress'
  };
  return t(`settings.workbuddy.${Object.hasOwn(keys, code) ? keys[code] : fallback}`);
}

function applyWorkbuddyAccounts(accounts) {
  if (!state.settings || !Array.isArray(accounts)) return;
  state.workbuddyAccountsRevision = (state.workbuddyAccountsRevision || 0) + 1;
  state.settings.workbuddyManagedAccounts = accounts;
  renderWorkbuddyStatus();
  renderSettingsSummaries();
  renderSubscriptionSettings();
}

async function mutateWorkbuddyAccount(id, operation, enabled) {
  if (state.workbuddyMutationBusy || state.workbuddySignInBusy || state.workbuddyCancelBusy) return { ok: false };
  state.workbuddyMutationBusy = true;
  state.workbuddyAccountError = '';
  renderWorkbuddyStatus();
  try {
    const api = window.tokenMonitor.workbuddy;
    const result = operation === 'remove'
      ? await api.removeAccount(id)
      : await api.setAccountEnabled(id, enabled);
    if (!result?.ok) {
      state.workbuddyAccountError = workbuddyAccountError(result?.errorCode,
        operation === 'remove' ? 'removeFailed' : 'toggleFailed');
    } else {
      applyWorkbuddyAccounts(result.accounts);
      refreshStats({ force: true }).catch(() => {});
    }
    return result || { ok: false };
  } catch (_) {
    state.workbuddyAccountError = workbuddyAccountError('', operation === 'remove' ? 'removeFailed' : 'toggleFailed');
    return { ok: false };
  } finally {
    state.workbuddyMutationBusy = false;
    renderWorkbuddyStatus();
  }
}

function finishWorkbuddyLogin(attempt, result) {
  if (state.workbuddyLoginAttempt !== attempt) return;
  if (state.workbuddyCancelBusy) {
    state.workbuddyPendingLoginResult = { attempt, result };
    return;
  }
  state.workbuddySignInBusy = false;
  state.workbuddyAccountError = '';
  if (result?.ok) {
    applyWorkbuddyAccounts(result.accounts);
    state.workbuddyLoginStatusKey = '';
    refreshStats({ force: true }).catch(() => {});
  } else if (['CANCELED', 'CANCELLED'].includes(result?.errorCode)) {
    state.workbuddyLoginStatusKey = 'loginCancelled';
  } else {
    state.workbuddyLoginStatusKey = '';
    state.workbuddyAccountError = workbuddyAccountError(result?.errorCode);
  }
  renderWorkbuddyStatus();
}

async function startWorkbuddyLogin(realm) {
  if (!['cn', 'ai'].includes(realm) || state.workbuddySignInBusy || state.workbuddyCancelBusy || state.workbuddyMutationBusy) return;
  const attempt = (state.workbuddyLoginAttempt || 0) + 1;
  state.workbuddyLoginAttempt = attempt;
  realmChoicesOpen = false;
  state.workbuddySignInBusy = true;
  state.workbuddyPendingLoginResult = null;
  state.workbuddyAccountError = '';
  state.workbuddyLoginStatusKey = 'loginStatus';
  renderWorkbuddyStatus();
  let result;
  try {
    result = await window.tokenMonitor.workbuddy.addAccount(realm);
  } catch (_) {
    result = { ok: false };
  }
  finishWorkbuddyLogin(attempt, result);
}

async function cancelWorkbuddyLogin() {
  if (!state.workbuddySignInBusy || state.workbuddyCancelBusy) return;
  state.workbuddyCancelBusy = true;
  state.workbuddyAccountError = '';
  renderWorkbuddyStatus();
  let cancelled = false;
  try {
    const result = await window.tokenMonitor.workbuddy.cancelLogin();
    cancelled = result === true || result?.ok === true;
  } catch (_) {}
  state.workbuddyCancelBusy = false;
  if (cancelled) {
    // A cancelled IPC promise may settle later, including after the next login.
    state.workbuddyLoginAttempt = (state.workbuddyLoginAttempt || 0) + 1;
    state.workbuddySignInBusy = false;
    state.workbuddyPendingLoginResult = null;
    state.workbuddyLoginStatusKey = 'loginCancelled';
  } else if (state.workbuddyPendingLoginResult) {
    const pending = state.workbuddyPendingLoginResult;
    state.workbuddyPendingLoginResult = null;
    finishWorkbuddyLogin(pending.attempt, pending.result);
  } else {
    state.workbuddyAccountError = workbuddyAccountError('', 'cancelFailed');
  }
  renderWorkbuddyStatus();
}

function renderWorkbuddyStatus() {
  const list = document.getElementById('workbuddyAccountList');
  if (!list || !state.settings) return;
  const accounts = Array.isArray(state.settings.workbuddyManagedAccounts) ? state.settings.workbuddyManagedAccounts : [];
  const busy = Boolean(state.workbuddySignInBusy || state.workbuddyCancelBusy || state.workbuddyMutationBusy);
  accountShellApi.render({
    progress: document.getElementById('workbuddyLoginStatus'),
    progressText: state.workbuddyCancelBusy
      ? t('settings.workbuddy.cancelling')
      : state.workbuddyLoginStatusKey ? t(`settings.workbuddy.${state.workbuddyLoginStatusKey}`) : '',
    error: document.getElementById('workbuddyAccountErrorMessage'),
    errorText: state.workbuddyAccountError
  });
  for (const [id, key] of [['workbuddyAddCnAccountButton', 'addCnAccount'], ['workbuddyAddAiAccountButton', 'addAiAccount']]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.classList.toggle('hidden', !realmChoicesOpen || busy);
    button.disabled = busy;
    button.textContent = t(`settings.workbuddy.${key}`);
  }
  const cancel = document.getElementById('workbuddyCancelLoginButton');
  if (cancel) {
    cancel.classList.toggle('hidden', !state.workbuddySignInBusy && !state.workbuddyCancelBusy);
    cancel.disabled = Boolean(state.workbuddyCancelBusy);
  }
  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: account => [t('settings.limits.sources.oauth'), account.realm === 'cn' ? t('settings.workbuddy.realmCn')
        : account.realm === 'ai' ? t('settings.workbuddy.realmAi') : ''].filter(Boolean).join(' · '),
      editor: { retryAvailable: () => Boolean(state.workbuddyAccountError) && !realmChoicesOpen, isOpen: () => realmChoicesOpen || state.workbuddySignInBusy || state.workbuddyCancelBusy || Boolean(state.workbuddyAccountError), allowBusyCancel: true, nodes: ['workbuddyAddCnAccountButton', 'workbuddyAddAiAccountButton', 'workbuddyLoginStatus', 'workbuddyAccountErrorMessage', 'workbuddyCancelLoginButton'], cancel: () => { if (state.workbuddySignInBusy) return cancelWorkbuddyLogin(); realmChoicesOpen = false; state.workbuddyAccountError = ''; renderWorkbuddyStatus(); } },
    document, provider: 'workbuddy', label: host.providerLabel || 'WorkBuddy',
    add: () => { realmChoicesOpen = !realmChoicesOpen; renderWorkbuddyStatus(); }, container: list, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => mutateWorkbuddyAccount(account.id, 'enabled', value),
    remove: account => mutateWorkbuddyAccount(account.id, 'remove'),
    changed: result => { if (result.accounts) state.settings.workbuddyManagedAccounts = result.accounts; }, refresh: renderWorkbuddyStatus, busy: () => state.workbuddySignInBusy || state.workbuddyCancelBusy || state.workbuddyMutationBusy,
    readings: () => host.localProviderStatuses('workbuddy'),
    status: { element: () => document.getElementById('workbuddyAccountStatus'), empty: () => t('settings.workbuddy.notConfigured') }
  });
  accountList.update(accounts, host.localProviderStatuses('workbuddy'));
}

function initWorkbuddyAccountSettings() {
  const api = window.tokenMonitor.workbuddy;
  const toggle = document.getElementById('workbuddySettingsToggle');
  if (!api || !toggle) return;
  toggle.addEventListener('click', () => setAccountGroupExpanded('workbuddy', !state.workbuddyAccountExpanded, 'workbuddyAccountExpanded'));
  setAccountGroupExpanded('workbuddy', false, 'workbuddyAccountExpanded');
  renderWorkbuddyStatus();
  api.onAccounts(applyWorkbuddyAccounts);
  const revision = state.workbuddyAccountsRevision || 0;
  api.accounts().then((accounts) => {
    if ((state.workbuddyAccountsRevision || 0) === revision) applyWorkbuddyAccounts(accounts);
  }).catch(() => {
    if ((state.workbuddyAccountsRevision || 0) !== revision) return;
    state.workbuddyAccountError = workbuddyAccountError('', 'accountsFailed');
    renderWorkbuddyStatus();
  });
  document.getElementById('workbuddyAddCnAccountButton')?.addEventListener('click', () => startWorkbuddyLogin('cn'));
  document.getElementById('workbuddyAddAiAccountButton')?.addEventListener('click', () => startWorkbuddyLogin('ai'));
  document.getElementById('workbuddyCancelLoginButton')?.addEventListener('click', cancelWorkbuddyLogin);
}
function setup() {
  initWorkbuddyAccountSettings();


}
 return { state, workbuddyAccountError, applyWorkbuddyAccounts, mutateWorkbuddyAccount, finishWorkbuddyLogin, startWorkbuddyLogin, cancelWorkbuddyLogin, renderWorkbuddyStatus, refreshReadings: () => accountList?.refreshReadings(), initWorkbuddyAccountSettings, setup };
});
