'use strict';

const crypto = require('node:crypto');
const {
  PROVIDER_CLEANUP_GRACE_MS,
  normalizeLimitsRefreshMs,
  parseBoolean,
  parseLimitProviders,
  probeLimitProvider,
  providerPhysicalBoundMs
} = require('./limitCollector');
const { normalizeLimitProvider, normalizeLimitsSummary } = require('./limits');
const {
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
} = require('./limitResetBoundary');
const { runWithProbeDeadline } = require('./probeDeadline');

const TRANSIENT_STATUSES = new Set([
  'timeout',
  'rateLimited',
  'sourceRateLimited',
  'unavailable',
  'error'
]);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
  return copy;
}

function clean(value) {
  return String(value || '').trim();
}

function providerId(value) {
  return clean(value).toLowerCase();
}

function privateCredentialDigest(provider, value) {
  return crypto.createHash('sha256').update(`${provider}\0${value}`).digest('hex').slice(0, 24);
}

function accountIdentityDescriptor(value) {
  for (const [name, raw] of [
    ['accountKey', value?.accountKey],
    ['id', value?.accountId ?? value?.managedAccountId ?? value?.id],
    ['email', value?.accountEmail ?? value?.email],
    ['name', value?.accountName ?? value?.name],
    ['label', value?.accountLabel]
  ]) {
    const normalized = clean(raw).toLowerCase();
    if (normalized) return { name, value: normalized, part: `${name}:${normalized}` };
  }
  return null;
}

function accountIdentityPart(value) {
  return accountIdentityDescriptor(value)?.part || '';
}

function accountIdentityField(value, name) {
  if (name === 'accountKey') return value?.accountKey;
  if (name === 'id') return value?.accountId ?? value?.managedAccountId ?? value?.id;
  if (name === 'email') return value?.accountEmail ?? value?.email;
  if (name === 'name') return value?.accountName ?? value?.name;
  if (name === 'label') return value?.accountLabel;
  return '';
}

function rowMatchesScope(row, scope) {
  const descriptor = accountIdentityDescriptor(scope);
  if (!descriptor) return false;
  return clean(accountIdentityField(row, descriptor.name)).toLowerCase() === descriptor.value;
}

function credentialIdentityPart(provider, value) {
  for (const field of ['credential', 'token', 'apiKey', 'cookie', 'accessToken', 'refreshToken']) {
    const raw = clean(value?.[field]);
    if (raw) return `private:${privateCredentialDigest(provider, raw)}`;
  }
  return '';
}

function scopeIdentityKey(scope) {
  const provider = providerId(scope?.provider);
  const identity = accountIdentityPart(scope) || credentialIdentityPart(provider, scope);
  return identity ? `${provider}:${identity}` : `${provider}:*`;
}

function isAccountScope(scope) {
  return Boolean(accountIdentityPart(scope) || credentialIdentityPart(providerId(scope?.provider), scope));
}

function normalizedScope(scope) {
  if (!scope || typeof scope !== 'object') return { provider: '' };
  return { ...cloneValue(scope), provider: providerId(scope.provider) };
}

function rowIdentityKey(row) {
  const provider = providerId(row?.provider);
  const identity = accountIdentityPart(row);
  return identity ? `${provider}:${identity}` : `${provider}:*`;
}

function publicAttemptStatus(status) {
  return status === 'timeout' ? 'error' : status || 'unavailable';
}

function createLimitsRuntime(initialOptions = {}, deps = {}) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const scheduleMicrotask = deps.queueMicrotask || queueMicrotask;
  const probeProvider = deps.probeProvider || probeLimitProvider;
  const physicalBound = deps.providerPhysicalBoundMs || providerPhysicalBoundMs;
  const resetBoundary = deps.nextLimitsResetBoundary || nextLimitsResetBoundary;
  const cleanupGraceMs = Number.isFinite(Number(deps.cleanupGraceMs))
    ? Math.max(0, Number(deps.cleanupGraceMs))
    : PROVIDER_CLEANUP_GRACE_MS;

  let config = cloneValue(initialOptions);
  let enabled = parseBoolean(config.limitsEnabled ?? config.enabled, true);
  let refreshMs = normalizeLimitsRefreshMs(config.limitsRefreshMs ?? config.refreshMs);
  let configuredProviders = new Set(parseLimitProviders(config.limitProviders ?? config.providers));
  let runtimeEpoch = 1;
  let stopped = false;
  let started = false;
  let sequence = 0;
  let executorActive = false;
  let pumpQueued = false;
  let intervalTimer = null;
  let resetTimer = null;
  let lastScheduledFullAt = 0;
  const listeners = new Set();
  const lanes = new Map();
  const providerQueue = [];
  const queuedProviders = new Set();
  const attemptedResetBoundaries = new Set();
  let snapshot = normalizeLimitsSummary({ updatedAt: null, refreshMs, providers: [] });

  function laneFor(provider) {
    if (!lanes.has(provider)) {
      lanes.set(provider, {
        provider,
        epoch: 0,
        accountRevisions: new Map(),
        pending: new Map(),
        active: null,
        identities: new Map()
      });
    }
    return lanes.get(provider);
  }

  function finishIntent(intent, result) {
    if (!intent || intent.settled) return;
    intent.settled = true;
    intent.resolve(result);
  }

  function cancelLane(lane, reason = 'superseded') {
    lane.epoch += 1;
    lane.active?.controller.abort(new Error(reason));
    finishIntent(lane.active?.intent, { superseded: true, reason });
    for (const intent of lane.pending.values()) {
      finishIntent(intent, { superseded: true, reason });
    }
    lane.pending.clear();
  }

  function providerRows(provider) {
    const lane = lanes.get(provider);
    if (!lane) return [];
    const rows = [];
    for (const state of lane.identities.values()) {
      const attempt = state.lastAttempt;
      if (!attempt) continue;
      const status = publicAttemptStatus(attempt.status);
      const row = state.lastGood
        ? normalizeLimitProvider({ ...state.lastGood, status })
        : normalizeLimitProvider({
            ...(attempt.row || {}),
            provider,
            status,
            updatedAt: attempt.at,
            windows: []
          });
      if (row) rows.push(row);
    }
    return rows;
  }

  function rebuildSnapshot() {
    const providers = [];
    if (enabled && !stopped) {
      for (const provider of configuredProviders) providers.push(...providerRows(provider));
    }
    snapshot = normalizeLimitsSummary({
      updatedAt: new Date(now()).toISOString(),
      refreshMs,
      providers
    });
    pruneAttemptedResetBoundaries(snapshot, attemptedResetBoundaries);
    scheduleResetTimer();
    const published = cloneValue(snapshot);
    deps.onUpdate?.(published);
    for (const listener of listeners) listener(published);
    return published;
  }

  function scheduleResetTimer() {
    if (resetTimer !== null) {
      clearTimer(resetTimer);
      resetTimer = null;
    }
    if (!started || stopped || !enabled) return;
    const next = resetBoundary(snapshot, now(), attemptedResetBoundaries);
    if (!next) return;
    resetTimer = setTimer(() => {
      resetTimer = null;
      for (const key of next.keys || []) attemptedResetBoundaries.add(key);
      for (const scope of next.scopes || []) {
        const provider = providerId(scope.provider);
        const rows = snapshot.providers.filter((row) => row.provider === provider);
        const strongIdentity = clean(scope.accountKey || scope.accountEmail || scope.accountName);
        if (!configuredProviders.has(provider) || (rows.length > 1 && !strongIdentity)) continue;
        void refresh(scope, 'reset-boundary');
      }
      scheduleResetTimer();
    }, next.delayMs);
  }

  function clearIntervalTimer() {
    if (intervalTimer !== null) clearTimer(intervalTimer);
    intervalTimer = null;
  }

  function scheduleInterval(delayMs = refreshMs) {
    clearIntervalTimer();
    if (!started || stopped || !enabled) return;
    intervalTimer = setTimer(() => {
      intervalTimer = null;
      runScheduledFullRefresh();
    }, Math.max(0, delayMs));
  }

  function runScheduledFullRefresh() {
    if (!started || stopped || !enabled) return;
    lastScheduledFullAt = now();
    void refresh({}, 'interval');
    scheduleInterval(refreshMs);
  }

  function enqueueProvider(provider) {
    const lane = lanes.get(provider);
    if (!lane || lane.active || lane.pending.size === 0 || queuedProviders.has(provider)) return;
    queuedProviders.add(provider);
    providerQueue.push(provider);
    if (!pumpQueued) {
      pumpQueued = true;
      scheduleMicrotask(() => {
        pumpQueued = false;
        void pump();
      });
    }
  }

  function nextIntent(lane) {
    let selected = null;
    for (const intent of lane.pending.values()) {
      if (!selected || intent.sequence < selected.sequence) selected = intent;
    }
    if (selected) lane.pending.delete(selected.key);
    return selected;
  }

  function accountRevisionStillCurrent(lane, identityKey, dispatch) {
    return (lane.accountRevisions.get(identityKey) || 0) === (dispatch.accountRevisions.get(identityKey) || 0);
  }

  function applyAttempt(lane, identityKey, row, status, at) {
    const existing = lane.identities.get(identityKey) || {
      identityKey,
      lastGood: null,
      lastAttempt: null
    };
    if (status === 'ok') {
      existing.lastGood = row;
    } else if (!TRANSIENT_STATUSES.has(status)) {
      existing.lastGood = null;
    }
    existing.lastAttempt = { status, at, row };
    lane.identities.set(identityKey, existing);
  }

  function matchingIdentityKeys(lane, scope) {
    const keys = new Set([scopeIdentityKey(scope)]);
    for (const [identityKey, state] of lane.identities) {
      if (rowMatchesScope(state.lastGood, scope) || rowMatchesScope(state.lastAttempt?.row, scope)) {
        keys.add(identityKey);
      }
    }
    return keys;
  }

  function commitRows(lane, dispatch, rawRows, attemptError = null) {
    if (stopped || runtimeEpoch !== dispatch.runtimeEpoch || !enabled || !configuredProviders.has(lane.provider)) return false;
    if (lane.epoch !== dispatch.providerEpoch) return false;
    if (dispatch.accountScoped) {
      const currentRevision = lane.accountRevisions.get(dispatch.identityKey) || 0;
      if (currentRevision !== dispatch.accountRevision) return false;
    }

    const attemptAt = new Date(now()).toISOString();
    const normalizedRows = (Array.isArray(rawRows) ? rawRows : rawRows?.providers || [])
      .map((row) => normalizeLimitProvider({ ...row, provider: lane.provider }))
      .filter(Boolean);
    const expected = new Set(dispatch.expectedIdentityKeys);
    const represented = new Set();

    if (attemptError) {
      const status = attemptError.status || (attemptError.code === 'PROBE_TIMEOUT' ? 'timeout' : 'unavailable');
      const targets = dispatch.accountScoped
        ? [dispatch.identityKey]
        : expected.size ? [...expected] : [`${lane.provider}:*`];
      for (const identityKey of targets) {
        if (!accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
        applyAttempt(lane, identityKey, { provider: lane.provider }, status, attemptAt);
      }
      rebuildSnapshot();
      return true;
    }

    const genericTerminal = normalizedRows.length === 1
      && rowIdentityKey(normalizedRows[0]) === `${lane.provider}:*`
      && !TRANSIENT_STATUSES.has(normalizedRows[0].status)
      && normalizedRows[0].status !== 'ok';
    if (genericTerminal && !dispatch.accountScoped) lane.identities.clear();

    for (const row of normalizedRows) {
      let identityKey = rowIdentityKey(row);
      if (identityKey === `${lane.provider}:*` && dispatch.accountScoped) identityKey = dispatch.identityKey;
      if (!accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
      if (dispatch.accountScoped && identityKey !== dispatch.identityKey) identityKey = dispatch.identityKey;

      if (identityKey === `${lane.provider}:*` && TRANSIENT_STATUSES.has(row.status) && expected.size > 0) {
        for (const expectedKey of expected) {
          if (!accountRevisionStillCurrent(lane, expectedKey, dispatch)) continue;
          represented.add(expectedKey);
          applyAttempt(lane, expectedKey, row, row.status, attemptAt);
        }
        continue;
      }

      represented.add(identityKey);
      applyAttempt(lane, identityKey, row, row.status, attemptAt);
    }

    if (!dispatch.accountScoped && !genericTerminal) {
      for (const identityKey of expected) {
        if (represented.has(identityKey) || !accountRevisionStillCurrent(lane, identityKey, dispatch)) continue;
        applyAttempt(lane, identityKey, { provider: lane.provider }, 'unavailable', attemptAt);
      }
    }
    rebuildSnapshot();
    return true;
  }

  async function dispatchIntent(lane, intent) {
    const controller = new AbortController();
    const dispatch = {
      runtimeEpoch,
      providerEpoch: lane.epoch,
      accountScoped: intent.accountScoped,
      identityKey: intent.identityKey,
      accountRevision: lane.accountRevisions.get(intent.identityKey) || 0,
      accountRevisions: new Map(lane.accountRevisions),
      expectedIdentityKeys: [...lane.identities.keys()]
    };
    lane.active = { intent, controller, dispatch };
    try {
      const resolved = deps.resolveConfigSnapshot
        ? await deps.resolveConfigSnapshot(cloneValue(intent.scope), cloneValue(config))
        : config;
      const configSnapshot = cloneValue(resolved || config);
      configSnapshot.limitProviders = [lane.provider];
      if (intent.accountScoped) configSnapshot.limitRefreshScope = cloneValue(intent.scope);
      else delete configSnapshot.limitRefreshScope;
      const physicalMs = Number(physicalBound(lane.provider, configSnapshot, deps));
      const deadlineMs = physicalMs + cleanupGraceMs;
      const rows = await runWithProbeDeadline(
        ({ signal }) => probeProvider(lane.provider, configSnapshot, {
          signal: AbortSignal.any([signal, controller.signal]),
          deadlineMs,
          scope: cloneValue(intent.scope),
          reason: intent.reason
        }, deps),
        { deadlineMs }
      );
      const committed = commitRows(lane, dispatch, rows);
      finishIntent(intent, { superseded: !committed, snapshot: getSnapshot() });
    } catch (error) {
      const committed = commitRows(lane, dispatch, [], error);
      finishIntent(intent, { superseded: !committed, error, snapshot: getSnapshot() });
    } finally {
      if (lane.active?.intent === intent) lane.active = null;
    }
  }

  async function pump() {
    if (executorActive || stopped) return;
    while (providerQueue.length > 0) {
      const provider = providerQueue.shift();
      queuedProviders.delete(provider);
      const lane = lanes.get(provider);
      if (!lane || lane.active || lane.pending.size === 0 || !configuredProviders.has(provider)) continue;
      const intent = nextIntent(lane);
      if (!intent) continue;
      executorActive = true;
      try {
        await dispatchIntent(lane, intent);
      } finally {
        executorActive = false;
        if (lane.pending.size > 0) enqueueProvider(provider);
        for (const queuedProvider of [...providerQueue]) enqueueProvider(queuedProvider);
      }
    }
  }

  function queueScope(scope, reason) {
    const provider = providerId(scope.provider);
    if (!provider || stopped || !enabled || !configuredProviders.has(provider)) {
      return Promise.resolve({ superseded: true, reason: 'disabled' });
    }
    const lane = laneFor(provider);
    const accountScoped = isAccountScope(scope);
    const identityKey = scopeIdentityKey(scope);
    const key = accountScoped ? identityKey : `${provider}:*`;

    if (accountScoped) {
      lane.accountRevisions.set(identityKey, (lane.accountRevisions.get(identityKey) || 0) + 1);
      if (lane.active?.intent.key === key) {
        lane.active.controller.abort(new Error('superseded'));
        finishIntent(lane.active.intent, { superseded: true, reason: 'superseded' });
      }
    } else {
      lane.epoch += 1;
      lane.active?.controller.abort(new Error('superseded'));
      finishIntent(lane.active?.intent, { superseded: true, reason: 'superseded' });
      for (const pending of lane.pending.values()) {
        finishIntent(pending, { superseded: true, reason: 'provider-wide' });
      }
      lane.pending.clear();
    }

    const previous = lane.pending.get(key);
    finishIntent(previous, { superseded: true, reason: 'superseded' });
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const intent = {
      sequence: ++sequence,
      key,
      identityKey,
      accountScoped,
      scope: cloneValue(scope),
      reason,
      resolve,
      settled: false
    };
    lane.pending.set(key, intent);
    enqueueProvider(provider);
    return promise;
  }

  function refresh(scope = {}, reason = 'manual') {
    const normalized = normalizedScope(scope);
    if (normalized.provider) return queueScope(normalized, reason);
    if (reason === 'manual' && started && enabled && !stopped) {
      lastScheduledFullAt = now();
      scheduleInterval(refreshMs);
    }
    return Promise.all([...configuredProviders].map((provider) => queueScope({ provider }, reason)))
      .then(() => getSnapshot());
  }

  function clear(scope = {}, reason = 'removed') {
    const normalized = normalizedScope(scope);
    const providers = normalized.provider ? [normalized.provider] : [...configuredProviders];
    for (const provider of providers) {
      const lane = lanes.get(provider);
      if (!lane) continue;
      if (!isAccountScope(normalized)) {
        cancelLane(lane, reason);
        lane.identities.clear();
        lane.accountRevisions.clear();
        continue;
      }
      const identityKeys = matchingIdentityKeys(lane, normalized);
      for (const identityKey of identityKeys) {
        lane.accountRevisions.set(identityKey, (lane.accountRevisions.get(identityKey) || 0) + 1);
        lane.identities.delete(identityKey);
        const pending = lane.pending.get(identityKey);
        finishIntent(pending, { superseded: true, reason });
        lane.pending.delete(identityKey);
      }
      if (identityKeys.has(lane.active?.intent.identityKey)) {
        lane.active.controller.abort(new Error(reason));
        finishIntent(lane.active.intent, { superseded: true, reason });
      }
    }
    return rebuildSnapshot();
  }

  function reconfigure(nextOptions = {}) {
    const previousEnabled = enabled;
    const previousRefreshMs = refreshMs;
    const previousProviders = configuredProviders;
    config = { ...config, ...cloneValue(nextOptions) };
    enabled = parseBoolean(config.limitsEnabled ?? config.enabled, true);
    refreshMs = normalizeLimitsRefreshMs(config.limitsRefreshMs ?? config.refreshMs);
    configuredProviders = new Set(parseLimitProviders(config.limitProviders ?? config.providers));

    for (const provider of previousProviders) {
      if (configuredProviders.has(provider)) continue;
      const lane = lanes.get(provider);
      if (lane) {
        cancelLane(lane, 'provider removed');
        lane.identities.clear();
      }
      lanes.delete(provider);
    }

    if (!enabled) {
      clearIntervalTimer();
      if (resetTimer !== null) clearTimer(resetTimer);
      resetTimer = null;
      for (const lane of lanes.values()) {
        cancelLane(lane, 'limits disabled');
        lane.identities.clear();
      }
      rebuildSnapshot();
      return getSnapshot();
    }

    if (!previousEnabled && enabled) {
      for (const provider of configuredProviders) void queueScope({ provider }, 'enabled');
      lastScheduledFullAt = now();
    } else {
      for (const provider of configuredProviders) {
        if (!previousProviders.has(provider)) void queueScope({ provider }, 'provider-added');
      }
    }

    if (started) {
      const elapsed = lastScheduledFullAt ? Math.max(0, now() - lastScheduledFullAt) : 0;
      if (refreshMs !== previousRefreshMs && lastScheduledFullAt && elapsed >= refreshMs) {
        runScheduledFullRefresh();
      } else {
        scheduleInterval(lastScheduledFullAt ? Math.max(0, refreshMs - elapsed) : refreshMs);
      }
    }
    rebuildSnapshot();
    return getSnapshot();
  }

  function getSnapshot() {
    return cloneValue(snapshot);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function start() {
    if (started || stopped) return;
    started = true;
    if (!enabled) return;
    lastScheduledFullAt = now();
    void refresh({}, 'startup');
    scheduleInterval(refreshMs);
    scheduleResetTimer();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    runtimeEpoch += 1;
    clearIntervalTimer();
    if (resetTimer !== null) clearTimer(resetTimer);
    resetTimer = null;
    for (const lane of lanes.values()) cancelLane(lane, 'runtime stopped');
    providerQueue.length = 0;
    queuedProviders.clear();
    listeners.clear();
  }

  for (const row of normalizeLimitsSummary(config.previousLimits || {}).providers) {
    if (!configuredProviders.has(row.provider)) continue;
    const lane = laneFor(row.provider);
    const identityKey = rowIdentityKey(row);
    const at = row.updatedAt || new Date(now()).toISOString();
    if (TRANSIENT_STATUSES.has(row.status) && row.windows.length > 0) {
      lane.identities.set(identityKey, {
        identityKey,
        lastGood: normalizeLimitProvider({ ...row, status: 'ok' }),
        lastAttempt: { status: row.status, at, row }
      });
    } else {
      applyAttempt(lane, identityKey, row, row.status, at);
    }
  }
  rebuildSnapshot();
  if (deps.autoStart !== false) start();

  return {
    clear,
    getSnapshot,
    reconfigure,
    refresh,
    start,
    stop,
    subscribe
  };
}

module.exports = {
  TRANSIENT_STATUSES,
  accountIdentityPart,
  createLimitsRuntime,
  rowIdentityKey,
  scopeIdentityKey
};
