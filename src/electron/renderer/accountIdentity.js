'use strict';

(function exposeAccountIdentity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAccountIdentity = api;
})(typeof window !== 'undefined' ? window : null, function createAccountIdentityApi() {
  function maskEmailAddress(value) {
    const email = String(value || '').trim();
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return email;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const first = local[0] || '';
    const last = local.length > 1 ? local.at(-1) : '';
    return `${first}***${last}@${domain}`;
  }

  function codexAccountEmail(account) {
    return String(account?.email || account?.accountEmail || '').trim();
  }

  function codexAccountWorkspace(account) {
    return String(account?.workspaceLabel || account?.accountName || '').trim();
  }

  function codexAccountDisplayLabel(account, accounts = [], options = {}) {
    const email = codexAccountEmail(account);
    const workspace = codexAccountWorkspace(account);
    if (!email) return workspace;

    const peers = Array.isArray(accounts) && accounts.length > 0 ? accounts : [account];
    const maskEmail = options.maskEmail === true;
    const visibleEmail = maskEmail ? maskEmailAddress(email) : email;
    const normalizedEmail = email.toLowerCase();
    const normalizedVisibleEmail = visibleEmail.toLowerCase();
    const duplicateEmail = peers.filter(
      (peer) => codexAccountEmail(peer).toLowerCase() === normalizedEmail
    ).length > 1;
    const maskedCollision = maskEmail && peers.filter((peer) => {
      const peerEmail = codexAccountEmail(peer);
      return peerEmail && maskEmailAddress(peerEmail).toLowerCase() === normalizedVisibleEmail;
    }).length > 1;

    return workspace && (duplicateEmail || maskedCollision)
      ? `${visibleEmail} · ${workspace}`
      : visibleEmail;
  }

  function codexAccountMatchesProvider(account, provider) {
    if (!account || !provider || provider.provider !== 'codex') return false;
    const accountKey = String(account.accountKey || '').trim();
    const providerKey = String(provider.accountKey || '').trim();
    if (accountKey && providerKey) return accountKey === providerKey;
    const accountEmail = String(account.email || account.accountEmail || '').trim().toLowerCase();
    const providerEmail = String(provider.accountEmail || provider.email || '').trim().toLowerCase();
    return Boolean(accountEmail && providerEmail && accountEmail === providerEmail);
  }

  function codexAccountIdForProvider(accounts, provider) {
    return (accounts || []).find((account) => codexAccountMatchesProvider(account, provider))?.id || '';
  }

  function isCodexLiveAccount(provider) {
    return String(provider?.provider || '').trim().toLowerCase() === 'codex'
      && String(provider?.status || '').trim() === 'ok'
      && String(provider?.sourceDetail || '').trim().toLowerCase() !== 'managed';
  }

  function localDeviceLimitsProviders(stats, localDeviceId = '') {
    const devices = stats?.devices;
    if (!Array.isArray(devices)) return null;
    const local = localDeviceId
      ? devices.find((device) => device?.deviceId === localDeviceId)
      : (devices.length === 1 ? devices[0] : null);
    return local?.limits?.providers || [];
  }

  function localLiveCodexProvider(stats, localDeviceId = '') {
    const localProviders = localDeviceLimitsProviders(stats, localDeviceId);
    const providers = localProviders !== null ? localProviders : (stats?.limits?.providers || []);
    return providers.find(isCodexLiveAccount) || null;
  }

  return {
    codexAccountDisplayLabel,
    codexAccountIdForProvider,
    codexAccountMatchesProvider,
    isCodexLiveAccount,
    localDeviceLimitsProviders,
    localLiveCodexProvider,
    maskEmailAddress
  };
});
