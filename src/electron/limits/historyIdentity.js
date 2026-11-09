'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitsHistoryIdentity = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  // hashKey('claude-cli', 'claude-cli') is the parser's unidentified placeholder.
  // The real CLI mapper is covered by the identity regression test.
  const CLAUDE_CLI_UNIDENTIFIED_KEY = 'sha256:09367c2f144ddb36c5b877f5fb5bb1267ce8676be252618cd642aa9dc8d1d78f';
  function historyRowKey(provider) {
    // Shared by the row builder and main's lookup of the current account.
    // Labels are a fallback only; stable account keys survive plan changes.
    return JSON.stringify([
      historyAccountKey(provider),
      provider.sourceDetail || '', provider.sourceDeviceId || ''
    ]);
  }
  function portableHistoryAccount(provider) {
    return !!provider.accountKey
      && !(provider.provider === 'antigravity' && !provider.accountEmail)
      && !(provider.provider === 'kiro' && provider.source === 'cli' && !provider.accountEmail)
      // CLI output can hash an organization display label without identifying
      // its account. An opaque key plus that label alone is still ambiguous.
      && !(provider.provider === 'claude' && provider.source === 'cli'
        && (provider.accountKey === CLAUDE_CLI_UNIDENTIFIED_KEY || !provider.accountEmail && provider.accountName));
  }
  function historyAccountKey(provider) {
    // A reporting device is provenance, not ownership of a shared allowance.
    // Keep authoritative account/workspace and product variants distinct. A
    // display name alone cannot prove that two devices signed into one account.
    const anonymous = !portableHistoryAccount(provider);
    return JSON.stringify([
      provider.provider, provider.adapterId || '',
      provider.accountKey || [provider.accountEmail || '', provider.accountName || ''],
      provider.region || '', provider.workspaceKind || '',
      ...(provider.provider === 'muse' ? [provider.source || ''] : []),
      ...(anonymous ? ['unverified', provider.sourceDeviceId || '', provider.sourceDetail || ''] : [])
    ]);
  }
  return { historyAccountKey, historyRowKey, portableHistoryAccount };
});
