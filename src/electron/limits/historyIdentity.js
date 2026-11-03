'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitsHistoryIdentity = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  function historyRowKey(provider) {
    // Shared by the row builder and main's lookup of the current account.
    // Labels are a fallback only; stable account keys survive plan changes.
    return JSON.stringify([
      historyAccountKey(provider),
      provider.sourceDetail || '', provider.sourceDeviceId || ''
    ]);
  }
  function historyAccountKey(provider) {
    // A reporting device is provenance, not ownership of a shared allowance.
    // Keep authoritative account/workspace and product variants distinct. A
    // display name alone cannot prove that two devices signed into one account.
    const anonymous = !provider.accountKey
      || provider.provider === 'antigravity' && !provider.accountEmail
      || provider.provider === 'kiro' && provider.source === 'cli' && !provider.accountEmail;
    return JSON.stringify([
      provider.provider, provider.adapterId || '',
      provider.accountKey || [provider.accountEmail || '', provider.accountName || ''],
      provider.region || '', provider.workspaceKind || '',
      ...(provider.provider === 'muse' ? [provider.source || ''] : []),
      ...(anonymous ? ['unverified', provider.sourceDeviceId || '', provider.sourceDetail || ''] : [])
    ]);
  }
  return { historyAccountKey, historyRowKey };
});
