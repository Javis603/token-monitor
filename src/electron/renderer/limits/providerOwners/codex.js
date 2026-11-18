'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorCodexAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, accountShellApi, t, isSettingsSurfaceVisible, renderSettingsSummaries, refreshStats, copyToClipboard } = host;
 const state = {codexSignInBusy: host.initial.codexSignInBusy, codexLoginStatus: host.initial.codexLoginStatus, codexWorkspaceChoices: host.initial.codexWorkspaceChoices, codexWorkspaceId: host.initial.codexWorkspaceId, codexLoginUrl: host.initial.codexLoginUrl, codexLoginOutput: host.initial.codexLoginOutput, codexAccountError: host.initial.codexAccountError, codexSignInFlowId: host.initial.codexSignInFlowId, codexAccountExpanded: host.initial.codexAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setCodexAccountExpanded(expanded) {
  setAccountGroupExpanded('codex', expanded, 'codexAccountExpanded');
}

function renderCodexLoginStatus() {
  const addButton = document.getElementById('codexAddAccountButton');
  const cancelButton = document.getElementById('codexCancelLoginButton');
  const openButton = document.getElementById('codexOpenLoginUrlButton');
  const copyButton = document.getElementById('codexCopyLoginUrlButton');
  const statusEl = document.getElementById('codexLoginStatus');
  const workspaceSelection = document.getElementById('codexWorkspaceSelection');
  const workspaceSelect = document.getElementById('codexWorkspaceSelect');
  const urlActions = document.getElementById('codexLoginUrlActions');
  const details = document.getElementById('codexLoginDetails');
  const output = document.getElementById('codexLoginOutput');
  if (!addButton || !cancelButton || !openButton || !copyButton || !statusEl || !workspaceSelection || !workspaceSelect || !urlActions || !details || !output) return;

  addButton.classList.add('hidden');
  cancelButton.classList.toggle('hidden', !state.codexSignInBusy);
  accountShellApi.render({ progress: statusEl, progressText: state.codexLoginStatus });
  workspaceSelection.classList.toggle('hidden', state.codexWorkspaceChoices.length === 0);
  workspaceSelect.replaceChildren(...state.codexWorkspaceChoices.map((workspace) => {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = workspace.workspaceKind === 'personal'
      ? t('settings.codex.personalWorkspace')
      : workspace.label || workspace.id;
    option.selected = workspace.id === state.codexWorkspaceId;
    return option;
  }));
  urlActions.classList.toggle('hidden', !state.codexSignInBusy);
  openButton.classList.toggle('hidden', !state.codexLoginUrl);
  copyButton.classList.toggle('hidden', !state.codexLoginUrl);
  output.textContent = state.codexLoginOutput;
  details.classList.toggle('hidden', !state.codexLoginOutput);
}

function renderCodexAccounts() {
  if (!isSettingsSurfaceVisible()) return;
  const statusEl = document.getElementById('codexAccountStatus');
  const listEl = document.getElementById('codexAccountList');
  const errorEl = document.getElementById('codexAccountErrorMessage');
  if (!statusEl || !listEl || !errorEl) return;

  const accounts = state.settings?.codexManagedAccounts || [];
  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: (_account, reading) => {
        const source = reading?.source === 'rpc' ? reading.sourceDetail : reading?.source;
        return t(`settings.limits.sources.${source === 'app' ? 'desktop' : source === 'cli' ? 'cli' : 'oauth'}`);
      },
      editor: { retryAvailable: () => Boolean(state.codexAccountError) && !state.codexWorkspaceChoices.length, isOpen: () => state.codexSignInBusy || state.codexWorkspaceChoices.length > 0 || Boolean(state.codexAccountError), allowBusyCancel: true, nodes: ['codexAccountDescription', 'codexLoginStatus', 'codexWorkspaceSelection', 'codexLoginUrlActions', 'codexLoginDetails', 'codexAccountErrorMessage'], cancel: () => { if (state.codexSignInBusy) document.getElementById('codexCancelLoginButton')?.click(); else { state.codexAccountError = ''; state.codexLoginStatus = ''; renderCodexLoginStatus(); renderCodexAccounts(); } } },
    document, provider: 'codex', label: host.providerLabel || 'Codex', add: startCodexLogin, container: listEl, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => window.tokenMonitor.codex.setAccountEnabled(account.id, value),
    remove: account => window.tokenMonitor.codex.removeAccount(account.id),
    changed: result => { if (result.accounts) state.settings.codexManagedAccounts = result.accounts; }, refresh: refreshCodexAccounts, busy: () => state.codexSignInBusy
  });
  // Codex accountLabel is a plan type, not a user-chosen account name.
  accountList.update(accounts.map(({ accountLabel, ...account }) => ({ ...account, planLabel: accountLabel })), host.localProviderStatuses('codex'));
  const summary = accountList.summary();
  accountShellApi.render({
    status: statusEl, error: errorEl, errorText: state.codexAccountError,
    statusText: summary.total ? t('settings.opencode.connected', summary) : t('settings.codex.notConfigured')
  });
  renderSettingsSummaries();
}

async function refreshCodexAccounts() {
  try {
    state.settings.codexManagedAccounts = await window.tokenMonitor.codex.accounts();
    state.codexAccountError = '';
  } catch (err) {
    state.codexAccountError = err.message;
  }
  renderCodexAccounts();
}

function nextCodexSignInFlowId() {
  return `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentCodexSignInFlow(flowId) {
  const current = String(state.codexSignInFlowId || '');
  const incoming = String(flowId || '');
  return current && incoming === current;
}
async function startCodexLogin() {
  const codexLoginDetails = document.getElementById('codexLoginDetails');
  if (state.codexSignInBusy) return;
  const flowId = nextCodexSignInFlowId();
  state.codexSignInFlowId = flowId;
  state.codexSignInBusy = true;
  state.codexLoginUrl = '';
  state.codexLoginOutput = '';
  state.codexWorkspaceChoices = [];
  state.codexWorkspaceId = '';
  state.codexLoginStatus = t('settings.codex.loginStarting');
  state.codexAccountError = '';
  if (codexLoginDetails) codexLoginDetails.open = false;
  renderCodexLoginStatus();
  renderCodexAccounts();
  try {
    const result = await window.tokenMonitor.codex.addAccount({ flowId });
    if (!isCurrentCodexSignInFlow(result?.flowId || flowId)) return;
    if (!result?.ok) {
      if (result?.outcome === 'cancelled') {
        state.codexLoginStatus = '';
        state.codexLoginOutput = '';
        state.codexAccountError = '';
        if (codexLoginDetails) codexLoginDetails.open = false;
        return;
      }
      state.codexAccountError = result?.error || t('settings.codex.loginFailed');
      state.codexLoginStatus = t('settings.codex.loginFailed');
      if (codexLoginDetails && state.codexLoginOutput) codexLoginDetails.open = true;
      setCodexAccountExpanded(true);
    } else {
      state.codexAccountError = '';
      state.codexLoginStatus = t('settings.codex.loginSuccess');
      renderCodexLoginStatus();
      state.settings.codexManagedAccounts = await window.tokenMonitor.codex.accounts();
      await refreshStats({ force: true });
      state.codexLoginStatus = '';
      state.codexLoginOutput = '';
      state.codexWorkspaceChoices = [];
      state.codexWorkspaceId = '';
    }
  } catch (err) {
    if (!isCurrentCodexSignInFlow(flowId)) return;
    state.codexAccountError = err.message;
    state.codexLoginStatus = t('settings.codex.loginFailed');
    if (codexLoginDetails && state.codexLoginOutput) codexLoginDetails.open = true;
  } finally {
    if (isCurrentCodexSignInFlow(flowId)) {
      state.codexSignInBusy = false;
      state.codexSignInFlowId = '';
      state.codexLoginUrl = '';
      state.codexWorkspaceChoices = [];
      state.codexWorkspaceId = '';
      renderCodexLoginStatus();
      renderCodexAccounts();
    }
  }

}
function setup() {
  const codexToggle = document.getElementById('codexSettingsToggle');
  if (codexToggle) {
    codexToggle.addEventListener('click', () => setCodexAccountExpanded(!state.codexAccountExpanded));
    setCodexAccountExpanded(false);
    renderCodexAccounts();

    const codexCancelButton = document.getElementById('codexCancelLoginButton');
    const codexOpenUrlButton = document.getElementById('codexOpenLoginUrlButton');
    const codexCopyUrlButton = document.getElementById('codexCopyLoginUrlButton');
    const codexWorkspaceSelect = document.getElementById('codexWorkspaceSelect');
    const codexConfirmWorkspaceButton = document.getElementById('codexConfirmWorkspaceButton');
    const codexLoginDetails = document.getElementById('codexLoginDetails');
    window.tokenMonitor.codex.onLoginStatus((status) => {
      if (!status || !isCurrentCodexSignInFlow(status.flowId)) return;
      if (status.phase === 'workspaceSelection') {
        state.codexWorkspaceChoices = Array.isArray(status.workspaces) ? status.workspaces : [];
        state.codexWorkspaceId = state.codexWorkspaceChoices.some((workspace) => workspace.id === status.currentWorkspaceId)
          ? status.currentWorkspaceId
          : state.codexWorkspaceChoices[0]?.id || '';
        state.codexLoginStatus = t('settings.codex.chooseWorkspace');
        renderCodexLoginStatus();
        return;
      }
      if (status.phase !== 'output') return;
      state.codexLoginOutput = (state.codexLoginOutput + String(status.text || '')).slice(-3000);
      if (status.loginUrl) state.codexLoginUrl = status.loginUrl;
      state.codexLoginStatus = t(state.codexLoginUrl ? 'settings.codex.loginWaiting' : 'settings.codex.loginStarting');
      renderCodexLoginStatus();
    });

    codexCancelButton.addEventListener('click', async () => {
      const flowId = state.codexSignInFlowId;
      if (!isCurrentCodexSignInFlow(flowId)) return;
      const result = await window.tokenMonitor.codex.cancelLogin({ flowId });
      if (!result?.cancelled || !isCurrentCodexSignInFlow(flowId)) return;
      state.codexSignInBusy = false;
      state.codexSignInFlowId = '';
      state.codexLoginUrl = '';
      state.codexLoginStatus = '';
      state.codexLoginOutput = '';
      state.codexWorkspaceChoices = [];
      state.codexWorkspaceId = '';
      state.codexAccountError = '';
      if (codexLoginDetails) codexLoginDetails.open = false;
      renderCodexLoginStatus();
      renderCodexAccounts();
    });

    codexWorkspaceSelect.addEventListener('change', () => {
      state.codexWorkspaceId = codexWorkspaceSelect.value;
    });

    codexConfirmWorkspaceButton.addEventListener('click', async () => {
      const flowId = state.codexSignInFlowId;
      const workspaceId = state.codexWorkspaceId;
      if (!isCurrentCodexSignInFlow(flowId) || !workspaceId) return;
      codexConfirmWorkspaceButton.disabled = true;
      try {
        const result = await window.tokenMonitor.codex.selectWorkspace({ flowId, workspaceId });
        if (!result?.ok || !isCurrentCodexSignInFlow(flowId)) return;
        state.codexWorkspaceChoices = [];
        state.codexWorkspaceId = '';
        state.codexLoginStatus = t('settings.codex.loginLoadingAccount');
        renderCodexLoginStatus();
      } finally {
        codexConfirmWorkspaceButton.disabled = false;
      }
    });

    codexOpenUrlButton.addEventListener('click', async () => {
      if (!state.codexLoginUrl) return;
      const result = await window.tokenMonitor.openExternal(state.codexLoginUrl);
      if (!result?.ok) {
        state.codexAccountError = result?.error || t('settings.codex.openLoginUrlFailed');
        renderCodexAccounts();
      }
    });

    codexCopyUrlButton.addEventListener('click', () => {
      if (state.codexLoginUrl) copyToClipboard(state.codexLoginUrl, codexCopyUrlButton);
    });

    renderCodexLoginStatus();

  }


}
 return { state, setCodexAccountExpanded, renderCodexLoginStatus, renderCodexAccounts, refreshCodexAccounts, nextCodexSignInFlowId, isCurrentCodexSignInFlow, startCodexLogin, setup };
});
