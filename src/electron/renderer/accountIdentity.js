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

  function codexAccountMatchesProvider(account, provider) {
    if (!account || !provider || provider.provider !== 'codex') return false;
    const accountKey = String(account.accountKey || '').trim();
    const providerKey = String(provider.accountKey || '').trim();
    if (accountKey && providerKey && accountKey === providerKey) return true;
    const accountEmail = String(account.email || account.accountEmail || '').trim().toLowerCase();
    const providerEmail = String(provider.accountEmail || '').trim().toLowerCase();
    return Boolean(accountEmail && providerEmail && accountEmail === providerEmail);
  }

  return { codexAccountMatchesProvider, maskEmailAddress };
});
