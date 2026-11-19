'use strict';
(function expose(root, factory) {
 if (typeof module === 'object' && module.exports) module.exports = { create: factory };
 if (root) root.TokenMonitorClaudeAccountOwner = { create: factory };
})(typeof window !== 'undefined' ? window : null, /**
 * @param {{document: Document, window: Window & any, initial: object,
 * getSettings: () => object, getAccountContext: () => object,
 * preserveScroll: Function, localProviderStatuses: Function, [capability: string]: any}} host
 * Named host callbacks compose provider state with shared settings publication.
 * The owner retains login/cancellation and editor generations across repaints.
 */ function create(host) {
 let accountList;
 const automaticAccounts = typeof module === 'object' && module.exports ? require('../automaticAccountList') : host.window.TokenMonitorAutomaticAccountList;
 // Host exposes named capabilities, never the application state object.
 const { document, window, accountShellApi, t, setAccountPanelMessage, renderExternalProviderStatus, commitAccountCredential, refreshStats, localProviderStatuses } = host;
 const editor = { revision: 0, accountId: 'new', open: false };
 const claudeAccountActions = accountShellApi.createBusyGuard();
 const state = {};
 Object.defineProperty(state, 'settings', { get: host.getSettings });
function renderClaudeOrganizationChoices(choices, selectedId = state.settings?.claudeWebOrganizationId || '') {
  const select = document.getElementById('claudeWebOrganizationIdInput');
  if (!select) return false;
  document.getElementById('claudeWebOrganizationRow')?.classList.toggle('hidden', choices.length === 0);
  select.options.length = 0;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('settings.claude.organizationChoose');
  select.append(placeholder);
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = [choice.name || choice.id, choice.plan ? choice.plan[0].toUpperCase() + choice.plan.slice(1) : ''].filter(Boolean).join(' · ');
    select.append(option);
  }
  const selectedAvailable = choices.some((choice) => choice.id === selectedId);
  select.value = selectedAvailable ? selectedId : !selectedId && choices.length === 1 ? choices[0].id : '';
  select.disabled = choices.length === 0;
  return selectedAvailable;
}

async function loadClaudeOrganizationChoices() {
  const revision = ++editor.revision;
  try {
    const result = await window.tokenMonitor.limits.listOrganizationChoices('claude');
    if (revision !== editor.revision) return;
    if (result.status === 'ok') {
      const selectedAvailable = renderClaudeOrganizationChoices(result.choices);
      if (!selectedAvailable && (state.settings?.claudeWebOrganizationId || result.choices.length > 1)) {
        setAccountPanelMessage('claude', { key: state.settings?.claudeWebOrganizationId
          ? 'settings.claude.organizationUnavailable'
          : 'settings.claude.organizationSelect', tone: 'notice' });
      }
    } else setAccountPanelMessage('claude', { key: 'settings.claude.organizationLoadFailed', tone: 'notice' });
  } catch (_) {
    if (revision !== editor.revision) return;
    setAccountPanelMessage('claude', { key: 'settings.claude.organizationLoadFailed', tone: 'notice' });
  }
}

function editClaudeWebAccount(account = null) {
  editor.revision += 1;
  editor.accountId = account?.id || 'new';
  editor.open = true;
  const input = document.getElementById('claudeWebCookieInput');
  if (input) input.value = '';
  renderClaudeOrganizationChoices(account?.organizationId
    ? [{ id: account.organizationId, name: account.accountName || account.organizationId }]
    : [], account?.organizationId || '');
  setAccountPanelMessage('claude', null);
  renderExternalProviderStatus('claude');
  input?.focus();
  if (account?.id === 'legacy') void loadClaudeOrganizationChoices();
}

function cancelClaudeWebAccountEdit(restoreFocus = document.activeElement?.id === 'claudeCancelWebAccountButton') {
  editor.revision += 1;
  editor.accountId = 'new';
  editor.open = false;
  const input = document.getElementById('claudeWebCookieInput');
  if (input) input.value = '';
  renderClaudeOrganizationChoices([]);
  setAccountPanelMessage('claude', null);
  renderExternalProviderStatus('claude');
  if (restoreFocus) document.getElementById('claudeWebAccountList')?.querySelector('.slot-add')?.focus({ preventScroll: true });
}

async function runClaudeAccountAction(button, operation) {
  return claudeAccountActions.run('claude', button, async () => {
    setAccountPanelMessage('claude', null);
    try {
      const result = await commitAccountCredential(operation);
      if (!result?.ok) throw new Error(t('settings.common.error'));
      await refreshStats();
      renderExternalProviderStatus('claude');
      return result;
    } catch (error) {
      setAccountPanelMessage('claude', { key: 'settings.claude.saveFailed', params: { message: error.message } });
      renderExternalProviderStatus('claude');
      return null;
    }
  });
}

function claudeWebSettingsAccounts(providers) {
  const accounts = [...(state.settings?.claudeManagedAccounts || [])];
  if (state.settings?.claudeWebLegacyCookieConfigured) {
    const legacy = state.settings.claudeWebLegacyAccount || providers.find((provider) => provider.source === 'web'
      && !accounts.some((account) => account.accountKey === provider.accountKey));
    accounts.unshift({ ...legacy, id: 'legacy', enabled: true, organizationId: state.settings.claudeWebOrganizationId || '' });
  }
  return accounts;
}

function claudeAutomaticAccounts(providers, accounts) {
  return automaticAccounts.accountsFromReadings('claude', providers, {
    represented: accounts, localDeviceId: host.getAccountContext().localDeviceId, label: host.providerLabel || 'Claude',
    sourceName: reading => t(`settings.limits.sources.${reading.source}`)
  });
}

// Runs after renderClaudeWebAccounts(), so the list already holds this tick's
// accounts and readings, other devices' included.
function claudeAccountStatusText(fallback) {
  const summary = accountList?.summary();
  return summary?.total ? t('settings.slots.connectedCount', summary) : fallback;
}

function renderClaudeWebAccounts() {
  const list = document.getElementById('claudeWebAccountList');
  if (!list) return;
  const providers = (host.strictLocalProviderStatuses || localProviderStatuses)('claude');
  const accounts = claudeWebSettingsAccounts(providers);
  const automatic = claudeAutomaticAccounts(providers, accounts);
  if (!accountList) {
    const container = document.createElement('div');
    list.prepend(container);
    accountList = window.TokenMonitorLegacyAccountList.create({
      busy: () => document.getElementById('claudeCredentialSubmit')?.disabled === true,
      sourceLabel: account => account.source === 'automatic' ? account.sourceName : t(account.id === 'legacy' && state.settings?.claudeWebLegacyCookieSource === 'env' ? 'settings.limits.sources.env' : 'settings.limits.sources.web'),
      editor: { isOpen: () => Boolean(editor.open), submit: 'claudeCredentialSubmit', nodes: ['claudeOpenBrowser', 'claudeWebOrganizationRow', 'claudeManualPanel'], visibility: 'claudeManualPanel', cancel: () => cancelClaudeWebAccountEdit(true) },
      document, provider: 'claude', label: host.providerLabel || 'Claude',
      add: () => claudeAccountActions.run('claude', null, () => editClaudeWebAccount()), container, t, bridge: window.tokenMonitor,
      getContext: host.getAccountContext, preserveScroll: host.preserveScroll,
      edit: editClaudeWebAccount,
      // Login health belongs to the saved Web credential, not merged OAuth quota.
      secondaryText: account => account.source === 'automatic' && account.accountKey && (account.observation.accountName || account.accountEmail) ? account.sourceName : '',
      statusReading: (account, reading) => {
        if (account.source === 'remote') return reading;
        if (account.source === 'automatic') return account.observation;
        const status = state.settings?.claudeWebLoginStatuses?.[account.id];
        return status ? { status } : reading?.source === 'web' ? reading : undefined;
      },
      enabled: (account, value) => window.tokenMonitor.claude.setAccountEnabled(account.id, value),
      remove: account => runClaudeAccountAction(null, async () => {
        const result = account.id === 'legacy'
          ? { ...(await window.tokenMonitor.limits.clearCredential('claude')), ok: true }
          : await window.tokenMonitor.claude.removeWebAccount(account.id);
        if (result?.ok && editor.accountId === account.id) { editor.accountId = 'new'; editor.open = false; renderClaudeOrganizationChoices([]); }
        return result;
      }),
      changed: result => { if (result?.settings) host.applySettings(result.settings); },
      refresh: () => renderExternalProviderStatus('claude')
    });
  }
  // Saved rows hold a Web session; the reading they match may be the same account's OAuth quota.
  accountList.update([...accounts.map(account => ({ ...account, sourceIconKind: 'web', canPause: account.id !== 'legacy',
    removable: !(account.id === 'legacy' && state.settings?.claudeWebLegacyCookieSource === 'env') })), ...automatic], providers.filter(row => row.accountKey));

}
 return { state, editor, claudeAccountActions, renderClaudeOrganizationChoices, loadClaudeOrganizationChoices, editClaudeWebAccount, cancelClaudeWebAccountEdit, runClaudeAccountAction, claudeWebSettingsAccounts, claudeAccountStatusText, renderClaudeWebAccounts };
});
