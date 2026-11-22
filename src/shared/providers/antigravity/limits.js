'use strict';
const { mergedOwnerAccounts } = require('../../limits/ownerAccountSlots');

// Antigravity limits provider: RPC snapshot plus the OAuth/probe helpers in
// this folder. Reached through providerFetchers() in src/shared/limits/collector.js.

const antigravityOAuth = require('./oauth');
const antigravityProbe = require('./probe');
const { quotaGroupFromLabel } = require('./corePolicy');
const {
  normalizeLimitProvider
} = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
  cleanPlanText,
  nowIso,
  planLabelFromParts,
  providerStatusFromError
} = require('../../limits/providerHelpers');

function groupedWindowGroupKey(window) {
  if (typeof window?.windowMinutes !== 'number') return '';
  return quotaGroupFromLabel(window.label).toLowerCase();
}

function mergeMissingOAuthGroups(local, existing) {
  const localGroups = new Set(local.windows.map(groupedWindowGroupKey).filter(Boolean));
  if (localGroups.size === 0) return local;
  const missingWindows = existing.windows.filter((window) => {
    const groupKey = groupedWindowGroupKey(window);
    return groupKey && !localGroups.has(groupKey);
  });
  if (missingWindows.length === 0) return local;
  const merged = normalizeLimitProvider({ ...local, windows: [...local.windows, ...missingWindows] });
  return { ...merged, rpcSourceKey: local.rpcSourceKey };
}

function antigravityPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  const raw = cleanPlanText(text, ['google', 'ai']);
  if (!raw) return '';
  return planLabelFromParts(raw);
}

function mapAntigravitySnapshot(snapshot, { nowMs, source = 'rpc', account = null } = {}) {
  const updatedAt = nowIso(nowMs ?? Date.now());
  const accountEmail = String(snapshot?.accountEmail || account?.accountEmail || '').trim().toLowerCase();
  const accountLabel = snapshot?.accountPlan ? antigravityPlanLabelFromParts(snapshot.accountPlan) : '';
  const accountKeySeed = accountEmail || snapshot?.accountPlan || account?.id || 'default';
  const legacyPools = source === 'oauth' ? snapshot?.pools || [] : [];
  const windows = Array.isArray(snapshot?.windows)
    ? snapshot.windows.map((window) => ({
        kind: window.kind,
        label: window.name,
        usedPercent: typeof window.remainingFraction === 'number'
          ? Math.max(0, Math.min(100, (1 - window.remainingFraction) * 100))
          : null,
        resetsAt: window.resetTime || null,
        resetDescription: window.resetDescription || '',
        windowMinutes: window.kind === 'session' ? 300 : window.kind === 'weekly' ? 10_080 : null,
        showMeter: window.showMeter !== false
      }))
    : legacyPools.map((pool) => ({
        kind: 'weekly',
        label: pool.name,
        usedPercent: Number.isFinite(pool.remainingFraction)
          ? Math.max(0, Math.min(100, (1 - pool.remainingFraction) * 100))
          : null,
        resetsAt: pool.resetTime || null,
        windowMinutes: null,
        showMeter: Number.isFinite(pool.remainingFraction)
      }));
  const row = normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: accountEmail ? antigravityOAuth.accountKey(accountEmail) : hashKey('antigravity', accountKeySeed),
    accountLabel,
    accountEmail,
    source,
    sourceDetail: snapshot?.sourceDetail || '',
    // OAuth can identify the account and plan even when Google withholds both
    // quota payloads. Preserve that identity, but do not present an empty
    // response as a live zero-usage quota.
    status: windows.length > 0 ? 'ok' : 'unavailable',
    updatedAt,
    windows
  });
  return source === 'rpc' ? { ...row, rpcSourceKey: snapshot?.sourceKey ?? null } : row;
}

function antigravityAccountError(account, error, nowMs) {
  const verificationRequired = error?.status === 'verificationRequired';
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: account?.accountKey || antigravityOAuth.accountKey(account?.accountEmail),
    accountLabel: '',
    accountEmail: account?.accountEmail || '',
    source: 'oauth',
    sourceDetail: 'oauth',
    status: verificationRequired
      ? 'unauthorized'
      : error?.status === 'permissionDenied' ? 'unavailable' : providerStatusFromError(error),
    ...(verificationRequired ? { actionRequired: 'accountVerification' } : {}),
    updatedAt: nowIso(nowMs),
    windows: []
  });
}

const RPC_SOURCE_BINDINGS_STATE_KEY = 'antigravity.rpc-source-bindings';
const RPC_SOURCE_BINDINGS_MAX_ENTRIES = 16;

// A process kind can expose several sources across app restarts. Remember which
// source produced each account's reading so an authentication rejection clears
// only that reading, capped like the existing runtime identity caches.
function commitAcceptedReading(input, row, providerRuntimeState) {
  const { source, sourceDetail, accountKey } = row;
  if (source !== 'rpc' || !sourceDetail || !accountKey || !Object.hasOwn(input, 'rpcSourceKey')) return;
  const sourceKey = input.rpcSourceKey;
  let bindings = providerRuntimeState.get(RPC_SOURCE_BINDINGS_STATE_KEY);
  if (!(bindings instanceof Map)) {
    if (!sourceKey) return;
    bindings = new Map();
    providerRuntimeState.set(RPC_SOURCE_BINDINGS_STATE_KEY, bindings);
  }
  const key = `${sourceDetail}:${accountKey}`;
  bindings.delete(key);
  // An alternate endpoint of the same process proves no process credential. Its
  // reading must not stay bound to one, or a later rejection replaces it.
  if (!sourceKey) {
    if (bindings.size === 0) providerRuntimeState.delete(RPC_SOURCE_BINDINGS_STATE_KEY);
    return;
  }
  // A source serves one account at a time; a same-process account switch must
  // not leave the previous account bound to it.
  for (const [boundKey, boundSource] of bindings) {
    if (boundSource === sourceKey) bindings.delete(boundKey);
  }
  bindings.set(key, sourceKey);
  while (bindings.size > RPC_SOURCE_BINDINGS_MAX_ENTRIES) bindings.delete(bindings.keys().next().value);
}

function rpcSourceKeyForAccount(sourceDetail, accountKey, deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return '';
  return deps.providerRuntimeState.get(RPC_SOURCE_BINDINGS_STATE_KEY)?.get(`${sourceDetail}:${accountKey}`) || '';
}

async function fetchAntigravityLimits(options = {}, deps = {}) {
  if (options.antigravityAccountSlots?.length) options = { ...options, antigravityManagedAccounts: mergedOwnerAccounts(options, 'antigravity', options.antigravityManagedAccounts || []).map(account => ({ ...account, credentials: account.credentials })) };
  const nowMs = (deps.now || Date.now)();
  const probeFn = deps.antigravityProbe || antigravityProbe.probe;
  const scope = options.limitRefreshScope?.provider === 'antigravity' ? options.limitRefreshScope : null;
  const accounts = antigravityOAuth.normalizeManagedAccounts(
    options.antigravityManagedAccounts || deps.antigravityManagedAccounts,
    { includeCredentials: true }
  )
    .filter((account) => account.enabled !== false)
    .filter((account) => !scope
      || (!scope.accountKey || scope.accountKey === account.accountKey)
      && (!scope.accountEmail || scope.accountEmail === account.accountEmail));

  if (accounts.length === 0 && !scope) {
    try {
      return mapAntigravitySnapshot(await probeFn(deps), { nowMs, source: 'rpc' });
    } catch (error) {
      const base = {
        provider: 'antigravity',
        source: 'rpc',
        updatedAt: nowIso(nowMs),
        windows: []
      };
      const sourceFailures = error?.sourceFailures;
      let status = providerStatusFromError(sourceFailures ? error.cause : error);
      if (sourceFailures) {
        for (const { source, error: cause } of sourceFailures.values()) deps.noteLimitFailure?.(cause, { source });
        const previous = (options.previousLimits?.providers || []).filter(row => row.provider === 'antigravity');
        const rows = previous.filter(row => row.source === 'rpc' && row.accountKey)
          .map(({ accountKey, accountLabel, accountEmail, sourceDetail }) => {
            const sourceKey = rpcSourceKeyForAccount(sourceDetail, accountKey, deps);
            const failure = sourceKey ? sourceFailures.get(sourceKey) : null;
            return normalizeLimitProvider({
              ...base, accountKey, accountLabel, accountEmail, sourceDetail,
              status: providerStatusFromError(failure?.error)
            });
          });
        if (rows.length) return rows.length === 1 ? rows[0] : rows;
        if (previous.some(row => row.windows.length)) status = 'unavailable';
      } else deps.noteLimitFailure?.(error, { source: 'rpc' });
      return normalizeLimitProvider({ ...base, status });
    }
  }

  const localPromise = scope?.sourceDetail === 'oauth'
    ? Promise.resolve(null)
    : probeFn(deps).then(
        (snapshot) => mapAntigravitySnapshot(snapshot, { nowMs, source: 'rpc' }),
        () => null
      );
  const remotePromise = Promise.all(accounts.map(async (account) => {
    try {
      const snapshot = await antigravityOAuth.fetchRemoteSnapshot(account, {
        ...deps,
        collapsePools: antigravityProbe._collapsePools,
        quotaSummaryWindows: antigravityProbe._quotaSummaryWindows,
        onCredentialRenewed: (managedAccount, credentials, previous) => (
          deps.onAntigravityCredentialsRenewed?.({ account: managedAccount, credentials, previous })
        )
      });
      return mapAntigravitySnapshot(snapshot, { nowMs, source: 'oauth', account });
    } catch (error) {
      return antigravityAccountError(account, error, nowMs);
    }
  }));
  const [local, remote] = await Promise.all([localPromise, remotePromise]);
  const providers = [...remote];
  if (local?.accountKey) {
    const duplicateIndex = providers.findIndex((provider) => provider.accountKey === local.accountKey);
    if (duplicateIndex < 0) {
      providers.unshift(local);
    } else if (local.status === 'ok') {
      providers[duplicateIndex] = mergeMissingOAuthGroups(local, providers[duplicateIndex]);
    }
  }
  return providers;
}

module.exports = {
  commitAcceptedReading,
  fetchAntigravityLimits
};
