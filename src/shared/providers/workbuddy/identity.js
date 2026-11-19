'use strict';

(function exposeWorkbuddyIdentity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWorkbuddyIdentity = api;
})(typeof window !== 'undefined' ? window : null, function createWorkbuddyIdentityApi() {
  // Legacy discovery hashes a realm-specific local-app sentinel without a UID
  // or token. Keep its wire key compatible, but distinguish it from real known
  // accounts whose credentials are temporarily missing. Names and a healthy
  // reading still establish an account; saved bindings are restored separately.
  const PLACEHOLDER_KEYS = new Set([
    'sha256:6ff2121c4f5c0196427ef836a66871994d1208557ff71d282c5ada1964378185',
    'sha256:89611f6e433217c45827d1bc99bcabe93a3dc58ff826efd996601ca74349348b'
  ]);

  function isWorkbuddyPlaceholder(provider) {
    return provider?.provider === 'workbuddy' && provider.status !== 'ok'
      && !provider.accountName && !provider.accountEmail && !provider.email
      && PLACEHOLDER_KEYS.has(provider.accountKey);
  }

  return { isWorkbuddyPlaceholder };
});
