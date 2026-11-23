'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorCursorAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 let statusRevision = 0;
 // Host exposes named capabilities, never the application state object.
 const { document, window, setAccountGroupExpanded, isSettingsSurfaceVisible, accountShellApi, t, accountShellErrors, setCursorStatusText, setSettingsSectionExpanded, renderSettingsSummaries, refreshStats, setAccountShellError, accountProfileSaves } = host;
 const state = {cursorAccount: host.initial.cursorAccount, cursorAccountExpanded: host.initial.cursorAccountExpanded};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function setCursorAccountExpanded(expanded) {
  setAccountGroupExpanded('cursor', expanded, 'cursorAccountExpanded');
}

function renderCursorStatus() {
  if (!isSettingsSurfaceVisible()) return;
  const statusEl = document.getElementById('cursorAccountStatus');
  const listEl = document.getElementById('cursorAccountList');
  const errorEl = document.getElementById('cursorErrorMessage');
  if (!statusEl || !listEl || !errorEl) return;

  accountShellApi.render({
    error: errorEl,
    errorText: state.cursorAccount.error
      ? t('settings.cursor.statusCheckFailed', { message: state.cursorAccount.error })
      : accountShellErrors.cursor || ''
  });

  const status = state.cursorAccount.status;
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const managementBlocked = status?.managementBlocked === true;
  if (!accountList) accountList = window.TokenMonitorLegacyAccountList.create({
      sourceLabel: account => account.sourceName,
      blocked: () => state.cursorAccount.status?.managementBlocked === true,
      editor: { submit: 'cursorManualSubmit', nodes: ['cursorManualDetails'], visibility: 'cursorManualDetails', cancel: () => setCursorManualExpanded(false) },
    document, provider: 'cursor', label: host.providerLabel || 'Cursor',
    add: () => setCursorManualExpanded(document.getElementById('cursorManualDetails')?.classList.contains('hidden')), container: listEl, t, bridge: window.tokenMonitor,
    getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
    enabled: (account, value) => window.tokenMonitor.cursor.setAccountEnabled(account.id, value),
    remove: account => window.tokenMonitor.cursor.logout(account.id),
    changed: result => { if (result.status) { statusRevision++; state.cursorAccount = { status: result.status, error: "", busy: false }; } }, refresh: refreshCursorStatus, busy: () => state.cursorAccount.busy || state.cursorAccount.status?.managementBlocked,
    readings: () => host.localProviderStatuses('cursor'),
    // A failed or pending status check says so in place of the count.
    status: { element: () => document.getElementById('cursorAccountStatus'), empty: () => t('settings.cursor.notLoggedIn'),
      active: () => !state.cursorAccount.error && Boolean(state.cursorAccount.status) }
  });
  accountList.update(accounts.map(account => ({ ...account, sourceId: account.removable ? 'manual' : 'desktop', sourceName: t(account.removable ? 'settings.limits.sources.web' : 'settings.limits.sources.desktop'), canPause: !managementBlocked, removable: account.removable === true && !managementBlocked })), host.localProviderStatuses('cursor'));

  if (state.cursorAccount.error) {
    setCursorStatusText(statusEl, t('settings.common.error'));
    setCursorCheckboxesEnabled(Boolean(state.cursorAccount.status?.accounts?.length));
    setSettingsSectionExpanded('limits', true);
    setCursorAccountExpanded(true);
    renderSettingsSummaries();
    return;
  }

  if (!status) {
    setCursorStatusText(statusEl, t('settings.common.checking'));
    renderSettingsSummaries();
    return;
  }

  document.getElementById('cursorAgentActiveNote')?.classList.toggle('hidden', !managementBlocked);
  const addButton = document.getElementById('cursorAddAccountButton');
  if (addButton) addButton.disabled = managementBlocked;
  setCursorCheckboxesEnabled(accounts.some((account) => !account.expired && !account.error));
  renderSettingsSummaries();
}

async function refreshCursorStatus({ force = false, discover = false } = {}) {
  const revision = ++statusRevision;
  setAccountShellError('cursor', '');
  state.cursorAccount = { ...state.cursorAccount, error: '', busy: true };
  renderCursorStatus();
  try {
    const status = await window.tokenMonitor.cursor.status({ force, discover });
    if (revision !== statusRevision) return;
    state.cursorAccount = { status, error: '', busy: false };
  } catch (err) {
    if (revision !== statusRevision) return;
    state.cursorAccount = { ...state.cursorAccount, error: err.message, busy: false };
  }
  renderCursorStatus();
}

function setCursorCheckboxesEnabled(enabled) {
  const row = document.querySelector('#clientDisplayList .tool-preference-row[data-client="cursor"]');
  const input = row?.querySelector('input[data-preference="track"]');
  row?.classList.toggle('disabled', !enabled);
  if (input) {
    input.disabled = !enabled;
    input.setAttribute('aria-description', enabled ? '' : t('settings.cursor.loginRequired'));
  }
}
function setCursorManualExpanded(expanded) {
  const next = Boolean(expanded);
  document.getElementById('cursorAddAccountButton')?.setAttribute('aria-expanded', String(next));
  document.getElementById('cursorManualDetails')?.classList.toggle('hidden', !next);
  document.getElementById('cursorManualPanel')?.classList.toggle('expanded', next);
}
function setup() {
  document.getElementById('cursorSettingsToggle').addEventListener('click', () => {
    const expanding = !state.cursorAccountExpanded;
    setCursorAccountExpanded(expanding);
    if (expanding && !state.cursorAccount.busy) void refreshCursorStatus({ discover: true });
  });
  setCursorAccountExpanded(false);

  const cursorAddAccountButton = document.getElementById('cursorAddAccountButton');
  cursorAddAccountButton?.classList.toggle('hidden', true);
  const cursorManualDetails = document.getElementById('cursorManualDetails');

  cursorAddAccountButton?.addEventListener('click', () => {
    setCursorManualExpanded(cursorManualDetails?.classList.contains('hidden'));
  });
  setCursorManualExpanded(false);

  document.getElementById('cursorLoginButton').addEventListener('click', () => {
    window.tokenMonitor.openExternal('https://cursor.com');
  });

  const cursorManualSubmit = document.getElementById('cursorManualSubmit');
  cursorManualSubmit.addEventListener('click', () => accountProfileSaves.run('cursor', cursorManualSubmit, async () => {
    const input = document.getElementById('cursorManualInput');
    setAccountShellError('cursor', '');
    const draft = input.value;
    const result = await window.tokenMonitor.cursor.loginManual(draft);
    if (!result.ok) {
      const message = result.code === 'EXTERNAL_AGENT_ACTIVE'
        ? t('settings.cursor.agentActive')
        : result.error;
      setAccountShellError('cursor', t('settings.cursor.loginFailed', { message }));
      return;
    }
    const unchanged = input.value === draft;
    if (unchanged) input.value = '';
    setAccountShellError('cursor', '');
    statusRevision++;
    state.cursorAccount = { status: result.status, error: '', busy: false };
    renderCursorStatus();
    if (unchanged) setCursorManualExpanded(false);
    await refreshStats({ force: true });
  }));

  refreshCursorStatus({ discover: true });


}
 return { state, setCursorAccountExpanded, renderCursorStatus, refreshReadings: () => accountList?.refreshReadings(), refreshCursorStatus, setCursorCheckboxesEnabled, setup };
});
