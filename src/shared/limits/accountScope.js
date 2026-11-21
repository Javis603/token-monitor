'use strict';

// How a limits refresh scope names an account, and which rows it names. One
// copy for LimitsRuntime, which files a scoped probe's rows by it, and for the
// renderers, which match a probe in flight against the rows they draw — so a
// row cannot spin for a probe the runtime would not file under it.
(function exposeLimitAccountScope(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitAccountScope = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitAccountScopeApi() {
  function clean(value) {
    return String(value || '').trim();
  }

  // Strongest first: the first field a scope fills is the one it names.
  const IDENTITY_FIELDS = [
    ['accountKey', (value) => value?.accountKey],
    ['id', (value) => value?.accountId ?? value?.managedAccountId ?? value?.id],
    ['email', (value) => value?.accountEmail ?? value?.email],
    ['name', (value) => value?.accountName ?? value?.name],
    ['label', (value) => value?.accountLabel]
  ];
  const IDENTITY_FIELD = new Map(IDENTITY_FIELDS);

  function accountIdentityDescriptor(value) {
    for (const [name, read] of IDENTITY_FIELDS) {
      const normalized = clean(read(value)).toLowerCase();
      if (normalized) return { name, value: normalized, part: `${name}:${normalized}` };
    }
    return null;
  }

  // User-facing selection keys distinguish Alibaba plans without changing the
  // portable account identity used by collection, history and synchronization.
  function accountSelectionKey(provider, accountKey, region) {
    const key = clean(accountKey);
    return key && provider === 'alibaba' ? `${key}:${clean(region) || 'cn'}` : key;
  }

  function accountIdentityField(value, name) {
    return IDENTITY_FIELD.get(name)?.(value) ?? '';
  }

  function rowMatchesScope(row, scope) {
    const descriptor = accountIdentityDescriptor(scope);
    if (!descriptor) return false;
    return clean(accountIdentityField(row, descriptor.name)).toLowerCase() === descriptor.value
      && (scope.provider !== 'alibaba' || !clean(scope.region) || clean(row?.region).toLowerCase() === clean(scope.region).toLowerCase());
  }

  // Which account a running probe is for, named by the identity field rows are
  // matched on — never the credential an account scope may carry instead. A
  // credential-only scope names no row, so it is reported as unmatched.
  function probeAccount(scope) {
    const descriptor = accountIdentityDescriptor(scope);
    return descriptor ? { field: descriptor.name, value: descriptor.value, ...(scope.provider === 'alibaba' && clean(scope.region) ? { region: clean(scope.region).toLowerCase() } : {}) } : { field: 'private', value: '' };
  }

  // Whether a probe in flight is refreshing this row: a provider-wide probe
  // answers for every row of its provider, an account probe for its own.
  function probeCoversRow(probe, row) {
    if (!probe || probe.provider !== row?.provider) return false;
    if (!probe.account) return true;
    if (!IDENTITY_FIELD.has(probe.account.field)) return false;
    return clean(accountIdentityField(row, probe.account.field)).toLowerCase() === probe.account.value
      && (probe.provider !== 'alibaba' || !probe.account.region || clean(row?.region).toLowerCase() === probe.account.region);
  }

  return {
    accountIdentityDescriptor,
    accountSelectionKey,
    accountIdentityField,
    probeAccount,
    probeCoversRow,
    rowMatchesScope
  };
});
