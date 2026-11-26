// @ts-check
'use strict';

/** @param {any} root @param {any} create */
(function expose(root, create) {
  if (typeof module === 'object' && module.exports) module.exports = { create };
  if (root) root.TokenMonitorQwenworkAccountOwner = { create };
})(/** @type {any} */ (typeof window !== 'undefined' ? window : null),
/** @param {Record<string, any>} host */
function create(host) {
  const { document, bridge, t, accountShellApi, limitProviderPresentationApi } = host;
  let flowId = '';
  let cancelable = false;
  let progress = '';
  let error = '';

  const element = (/** @type {string} */ name) => document.getElementById(`qwenwork${name}`);
  function refreshReadings() {
    const status = element('AccountStatus');
    if (!status) return;
    const settings = host.getSettings();
    const configured = Boolean(settings?.qwenworkSessionConfigured);
    const stored = settings?.qwenworkSessionSource === 'settings';
    const reading = host.getReading();
    const enabled = host.isEnabled();
    const accountStatus = limitProviderPresentationApi.apiKeyAccountStatus(reading, configured, enabled);
    /** @type {Record<string, string>} */
    const statusKeys = {
      linked: stored ? 'settings.qwenwork.statusSet' : 'settings.qwenwork.statusAuto',
      invalid: 'settings.qwenwork.statusExpired',
      notConfigured: 'settings.qwenwork.statusNotSet',
      checking: 'settings.qwenwork.statusSet',
      limited: 'settings.limits.status.limited',
      disabled: 'settings.limits.status.disabled',
      notChecked: 'settings.common.notChecked',
      error: 'settings.common.error'
    };
    accountShellApi.render({
      status,
      statusText: (accountStatus === 'linked' && String(reading?.accountName || '').trim())
        || t(statusKeys[accountStatus] || 'settings.qwenwork.statusUnavailable'),
      error: element('ErrorMessage'),
      errorText: error,
      progress: element('LoginStatus'),
      progressText: progress && t(progress)
    });
    element('SignInButton').classList.toggle('hidden', Boolean(flowId) || (stored && reading?.status === 'ok'));
    element('CancelSignInButton').classList.toggle('hidden', !flowId || !cancelable);
    element('LogoutButton').classList.toggle('hidden', !configured || !stored || Boolean(flowId));
    element('RefreshButton').classList.toggle('hidden', !configured || Boolean(flowId));
  }

  function clearFlow() {
    flowId = '';
    cancelable = false;
    progress = '';
    refreshReadings();
  }

  async function signIn() {
    if (flowId) return;
    const requestId = `qwenwork-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    flowId = requestId;
    cancelable = true;
    progress = 'settings.qwenwork.loginOpening';
    error = '';
    refreshReadings();
    try {
      const result = await bridge.signIn({ flowId: requestId });
      if (flowId !== requestId) return;
      if (!result?.ok) {
        error = result?.error || t('settings.qwenwork.loginFailed');
      } else {
        await host.refreshStats();
        if (flowId === requestId && host.getReading()?.status === 'ok') host.setExpanded(false);
      }
    } catch (cause) {
      if (flowId === requestId) error = cause instanceof Error ? cause.message : t('settings.qwenwork.loginFailed');
    } finally {
      if (flowId === requestId) clearFlow();
    }
  }

  async function cancel() {
    const requestId = flowId;
    if (!requestId || !cancelable) return;
    try {
      await bridge.cancelSignIn({ flowId: requestId });
    } catch (cause) {
      if (flowId === requestId) {
        error = cause instanceof Error ? cause.message : t('settings.qwenwork.loginFailed');
        refreshReadings();
      }
      return;
    }
    if (flowId === requestId) {
      error = '';
      clearFlow();
    }
  }

  function setup() {
    const toggle = element('SettingsToggle');
    if (!toggle || !bridge) return;
    toggle.addEventListener('click', () => host.setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
    element('SignInButton').addEventListener('click', signIn);
    element('CancelSignInButton').addEventListener('click', cancel);
    element('LogoutButton').addEventListener('click', async () => {
      try {
        await bridge.signOut();
        error = '';
        await host.refreshStats();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : t('settings.qwenwork.loginFailed');
      }
      refreshReadings();
    });
    element('RefreshButton').addEventListener('click', host.refreshQuota);
    bridge.onLoginStatus((/** @type {{flowId?: string, phase?: string, error?: string}} */ status) => {
      if (!flowId || status?.flowId !== flowId) return;
      if (status.phase === 'authorize' || status.phase === 'polling') progress = 'settings.qwenwork.loginWaiting';
      else if (status.phase === 'success') {
        cancelable = false;
        progress = 'settings.qwenwork.loginSuccess';
      } else if (status.phase === 'error') {
        cancelable = false;
        progress = '';
        error = status.error || t('settings.qwenwork.loginFailed');
      }
      refreshReadings();
    });
    refreshReadings();
  }

  return { refreshReadings, setup };
});
