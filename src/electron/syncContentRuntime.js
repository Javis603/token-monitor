'use strict';

const crypto = require('node:crypto');

const KINDS = Object.freeze(['modelAliases', 'customPricing']);
const emptySelection = () => ({ sessionTitles: false, modelAliases: false, customPricing: false });
const clone = (value) => JSON.parse(JSON.stringify(value));

function destinationIdentity(context) {
  if (!context?.url || !['client', 'host'].includes(context.mode)) return '';
  const url = new URL(context.url);
  url.hash = '';
  return crypto.createHash('sha256').update(JSON.stringify([
    url.href.replace(/\/$/, ''), String(context.secret || ''), String(context.deviceId || '')
  ])).digest('hex');
}

function destinationLabel(context) {
  try { return new URL(context.url).host; } catch (_) { return ''; }
}

function normalizeSyncContentState(value) {
  const enabled = emptySelection();
  for (const key of Object.keys(enabled)) enabled[key] = value?.enabled?.[key] === true;
  return {
    identity: typeof value?.identity === 'string' ? value.identity : '',
    enabled,
    pendingTitleCleanup: Array.isArray(value?.pendingTitleCleanup)
      ? value.pendingTitleCleanup.filter((row) => row && typeof row.identity === 'string'
        && typeof row.deviceId === 'string').map((row) => ({
          identity: row.identity, deviceId: row.deviceId,
          destination: typeof row.destination === 'string' ? row.destination : ''
        })) : []
  };
}

function syncError(code) { return Object.assign(new Error(code), { code }); }

// One lane for shared documents and title policy changes. Destination checks are
// repeated after awaits; a delayed response never changes a different Hub's local
// settings. Preferences are persisted separately from remote document caches.
function createSyncContentRuntime({
  getContext, getState, saveState, getLocalValue, applyLocalValue,
  normalizeValue, request, onStatus = () => {}, now = Date.now,
  loadCleanupContexts = () => [], saveCleanupContext = () => {}, removeCleanupContext = () => {}
}) {
  let context = null;
  let identity = '';
  let capabilities = null;
  let capabilityAt = -Infinity;
  let documents = {};
  let error = '';
  let lane = Promise.resolve();
  let refreshPending = null;
  let titlePolicy = null;
  let uploadController = new AbortController();
  let lastCatchUp = { identity: '', key: '', at: -Infinity };
  const cleanupContexts = new Map(loadCleanupContexts());
  const cleanupContextWritesPending = new Set();
  let volatileState = null;

  const state = () => normalizeSyncContentState(volatileState || getState());
  function persist(next, retainOnFailure = false) {
    const normalized = normalizeSyncContentState(next);
    try { saveState(normalized); volatileState = null; }
    catch (failure) {
      if (retainOnFailure) volatileState = normalized;
      throw failure;
    }
  }
  function abortUploads() {
    uploadController.abort();
    uploadController = new AbortController();
    titlePolicy = null;
  }
  function capture() {
    const next = { ...getContext() };
    next.identity = destinationIdentity(next);
    return next;
  }
  const isCurrent = (captured) => captured.identity === destinationIdentity(getContext());
  function assertCurrent(captured) { if (!isCurrent(captured)) throw syncError('hub_changed'); }
  function enqueue(work) {
    const operation = lane.then(work);
    lane = operation.catch(() => {});
    return operation;
  }
  function status() {
    const current = capture();
    const saved = state();
    return {
      identity: current.identity, destination: destinationLabel(current),
      supported: Boolean(current.identity && identity === current.identity && capabilities?.version === 1),
      serverTitlesEnabled: Boolean(identity === current.identity && capabilities?.sessionTitles?.enabled === true),
      enabled: saved.identity === current.identity && current.identity ? saved.enabled : emptySelection(),
      revisions: Object.fromEntries(KINDS.map((kind) => [kind, documents[kind]?.revision || 0])),
      pendingTitleCleanup: saved.pendingTitleCleanup.length > 0 || cleanupContexts.size > 0,
      error: current.identity ? error : 'unsupported'
    };
  }
  function emit() { onStatus(status()); }
  function addCleanup(previous, saved) {
    if (!previous?.identity || !saved.enabled.sessionTitles) return saved;
    cleanupContexts.set(previous.identity, previous);
    try { saveCleanupContext(previous); cleanupContextWritesPending.delete(previous.identity); }
    catch (_) { cleanupContextWritesPending.add(previous.identity); error = 'cleanup_pending'; }
    const pending = saved.pendingTitleCleanup.filter((row) => row.identity !== previous.identity);
    pending.push({ identity: previous.identity, deviceId: previous.deviceId, destination: destinationLabel(previous) });
    return { ...saved, pendingTitleCleanup: pending };
  }
  function invalidate() {
    const next = capture();
    const saved = state();
    const changed = next.identity !== identity;
    if (changed || saved.identity !== next.identity) {
      abortUploads();
      const withCleanup = addCleanup(context, saved);
      context = next;
      identity = next.identity;
      capabilities = null;
      documents = {};
      titlePolicy = null;
      error = '';
      try { persist({ ...withCleanup, identity: next.identity, enabled: emptySelection() }, true); }
      catch (_) { error = 'cleanup_pending'; }
    }
    // A saved consent remains valid across process restart at the same destination.
    return next;
  }
  function initialize() {
    context = capture();
    identity = context.identity;
    const saved = state();
    if (saved.identity !== identity) persist({ ...saved, identity, enabled: emptySelection() });
  }
  initialize();

  async function api(captured, path, method = 'GET', body) {
    const response = await request(captured, path, method, body);
    if (!response || typeof response.status !== 'number') throw syncError('unreachable');
    if (response.status === 409) throw Object.assign(syncError('conflict'), { document: response.body });
    if (response.status === 404 || response.status === 405) throw syncError('unsupported');
    if (response.status === 403) throw syncError('titles_not_allowed');
    if (response.status < 200 || response.status >= 300) throw syncError('unreachable');
    return response.body;
  }
  async function discover(captured, force = false) {
    if (!captured.identity) throw syncError('unsupported');
    if (!force && now() - capabilityAt < 60_000) {
      if (capabilities) return capabilities;
      throw syncError(error || 'unsupported');
    }
    capabilityAt = now();
    const value = await api(captured, '/api/sync/content');
    assertCurrent(captured);
    if (value?.version !== 1 || value?.sharedSettings !== true
      || typeof value?.sessionTitles?.enabled !== 'boolean') throw syncError('unsupported');
    capabilities = value;
    capabilityAt = now();
    return value;
  }
  function document(kind, value) {
    if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !(value.value === null || value.value !== undefined)) throw syncError('unsupported');
    return { ...value, value: value.value === null ? null : normalizeValue(kind, value.value) };
  }
  async function readDocument(captured, kind) {
    const value = document(kind, await api(captured, `/api/sync/settings/${kind}`));
    assertCurrent(captured);
    return value;
  }
  const fingerprint = (kind, value) => JSON.stringify(normalizeValue(kind, value));
  function count(kind, value) {
    return kind === 'customPricing' ? value?.length || 0 : Object.keys(value?.modelAliases || {}).length;
  }
  async function revoke(captured) {
    await api(captured, `/api/sync/titles/${encodeURIComponent(captured.deviceId)}`, 'PUT', { enabled: false });
    const saved = state();
    // A pending row must never outlive the credentials needed to retry it.
    persist({ ...saved, pendingTitleCleanup: saved.pendingTitleCleanup.filter((row) => row.identity !== captured.identity) });
    try { removeCleanupContext(captured.identity); }
    catch (failure) {
      const pending = saved.pendingTitleCleanup.some((row) => row.identity === captured.identity)
        ? saved.pendingTitleCleanup : [...saved.pendingTitleCleanup, {
          identity: captured.identity, deviceId: captured.deviceId, destination: destinationLabel(captured)
        }];
      persist({ ...state(), pendingTitleCleanup: pending }, true);
      throw failure;
    }
    cleanupContexts.delete(captured.identity);
    cleanupContextWritesPending.delete(captured.identity);
    if (isCurrent(captured)) titlePolicy = { enabled: false };
  }
  async function retryCleanup() {
    const current = invalidate();
    // Disk recovery is independent of Hub recovery. Make the off choice and
    // old connection durable even while the server is still unreachable.
    if (volatileState) {
      try { persist(volatileState); } catch (_) { error = 'cleanup_pending'; }
    }
    // A crash between saving completion and deleting credentials leaves an
    // unreferenced context. It needs only local removal, since the scrub is done.
    for (const key of cleanupContexts.keys()) {
      if (state().pendingTitleCleanup.some((row) => row.identity === key)) continue;
      try {
        removeCleanupContext(key);
        cleanupContexts.delete(key);
        cleanupContextWritesPending.delete(key);
      } catch (_) { error = 'cleanup_pending'; }
    }
    for (const row of state().pendingTitleCleanup) {
      const target = row.identity === current.identity ? current : cleanupContexts.get(row.identity);
      if (!target) continue;
      if (cleanupContextWritesPending.has(row.identity)) {
        try { saveCleanupContext(target); cleanupContextWritesPending.delete(row.identity); }
        catch (_) { error = 'cleanup_pending'; }
      }
      try { await revoke(target); } catch (_) { error = 'cleanup_pending'; }
    }
    if (!state().pendingTitleCleanup.length && !cleanupContexts.size && error === 'cleanup_pending') error = '';
  }
  async function ensureTitlePolicy(captured, enabled, force = false) {
    if (!force && titlePolicy?.enabled === enabled) return titlePolicy;
    const value = await api(captured, `/api/sync/titles/${encodeURIComponent(captured.deviceId)}`, 'PUT', { enabled });
    assertCurrent(captured);
    if (value?.enabled !== enabled || !Number.isSafeInteger(value.generation) || value.generation < 1) {
      throw syncError('unsupported');
    }
    titlePolicy = value;
    return value;
  }
  async function refreshWork() {
    const captured = invalidate();
    try {
      await retryCleanup();
      await discover(captured, true);
      for (const kind of KINDS) {
        if (!state().enabled[kind]) continue;
        const next = await readDocument(captured, kind);
        if (next.value !== null && fingerprint(kind, next.value) !== fingerprint(kind, getLocalValue(kind))) {
          await applyLocalValue(kind, clone(next.value));
          assertCurrent(captured);
        }
        documents[kind] = next;
      }
      error = state().pendingTitleCleanup.length ? 'cleanup_pending' : '';
    } catch (failure) { if (isCurrent(captured)) error = failure.code || 'unreachable'; }
    emit();
    return status();
  }
  function refresh() {
    if (refreshPending) return refreshPending;
    refreshPending = enqueue(refreshWork).finally(() => { refreshPending = null; });
    return refreshPending;
  }
  async function preview(kind) {
    return enqueue(async () => {
      const captured = invalidate();
      try {
        if (!KINDS.includes(kind)) throw syncError('unsupported');
        await discover(captured, true);
        const remote = await readDocument(captured, kind);
        const local = normalizeValue(kind, getLocalValue(kind));
        documents[kind] = remote;
        emit();
        return { ok: true, identity: captured.identity, kind, revision: remote.revision,
          localFingerprint: fingerprint(kind, local), localCount: count(kind, local),
          serverCount: count(kind, remote.value), hasServerValue: remote.value !== null,
          equal: remote.value !== null && fingerprint(kind, remote.value) === fingerprint(kind, local) };
      } catch (failure) {
        if (isCurrent(captured)) error = failure.code || 'unreachable';
        emit();
        return { ok: false, error: failure.code || 'unreachable', status: status() };
      }
    });
  }
  function configure(options = {}) {
    const captured = invalidate();
    // Revocation is synchronous locally, before waiting behind any network work.
    if (options.kind === 'sessionTitles' && options.enabled === false && options.identity === captured.identity) {
      const saved = state();
      abortUploads();
      try { persist({ ...addCleanup(captured, saved), enabled: { ...saved.enabled, sessionTitles: false } }, true); }
      catch (_) { error = 'cleanup_pending'; }
      emit();
    }
    return enqueue(async () => {
      try {
        assertCurrent(captured);
        if (options.identity !== captured.identity || !captured.identity) throw syncError('hub_changed');
        const kind = options.kind;
        if (kind !== 'sessionTitles' && !KINDS.includes(kind)) throw syncError('unsupported');
        if (options.enabled === false) {
          if (kind === 'sessionTitles') await revoke(captured);
          else {
            const saved = state();
            persist({ ...saved, enabled: { ...saved.enabled, [kind]: false } });
          }
        } else {
          await discover(captured, true);
          if (kind === 'sessionTitles') {
            if (options.confirmed !== true) throw syncError('confirmation_required');
            if (!capabilities.sessionTitles.enabled) throw syncError('titles_not_allowed');
            await ensureTitlePolicy(captured, true);
          } else {
            if (!['local', 'server'].includes(options.source)) throw syncError('confirmation_required');
            const remote = await readDocument(captured, kind);
            if (remote.revision !== options.revision
              || fingerprint(kind, getLocalValue(kind)) !== options.localFingerprint) throw syncError('conflict');
            if (options.source === 'local') {
              const value = normalizeValue(kind, getLocalValue(kind));
              const result = await api(captured, `/api/sync/settings/${kind}`, 'PUT', { baseRevision: remote.revision, value });
              assertCurrent(captured);
              documents[kind] = document(kind, result);
            } else {
              if (remote.value !== null) await applyLocalValue(kind, clone(remote.value));
              assertCurrent(captured);
              documents[kind] = remote;
            }
          }
          const saved = state();
          persist({ ...saved, enabled: { ...saved.enabled, [kind]: true } });
        }
        error = state().pendingTitleCleanup.length ? 'cleanup_pending' : '';
        emit();
        return { ok: true, status: status() };
      } catch (failure) {
        const failureCode = options.kind === 'sessionTitles' && options.enabled === false
          && state().pendingTitleCleanup.length ? 'cleanup_pending' : failure.code || 'unreachable';
        if (isCurrent(captured)) error = failureCode;
        emit();
        return { ok: false, error: failureCode, status: status() };
      }
    });
  }
  async function prepareUpload() {
    return enqueue(async () => {
      const captured = invalidate();
      const disabled = { syncSessionTitles: false, identity: captured.identity, signal: uploadController.signal };
      try {
        const desired = state().enabled.sessionTitles;
        await retryCleanup();
        await discover(captured, desired);
        assertCurrent(captured);
        if (!desired || !state().enabled.sessionTitles || !capabilities.sessionTitles.enabled) {
          if (titlePolicy?.enabled !== false) await ensureTitlePolicy(captured, false);
          return disabled;
        }
        // The server can revoke generations while this process is offline (or
        // disable and re-enable receiving between uploads). Renew the admitted
        // generation rather than reusing an indefinitely cached permission.
        const policy = await ensureTitlePolicy(captured, true, true);
        if (!state().enabled.sessionTitles) return disabled;
        return { ...disabled, syncSessionTitles: true, sessionTitleSyncGeneration: policy.generation };
      } catch (failure) {
        if (isCurrent(captured)) error = state().pendingTitleCleanup.length ? 'cleanup_pending' : failure.code || 'unreachable';
        emit();
        return disabled;
      }
    });
  }
  function publishPatch(patch, base = {}) {
    return enqueue(async () => {
      const captured = invalidate();
      const editsSharedGroup = patch.modelAliases !== undefined || patch.modelAliasGrouping !== undefined
        || patch.customModelPricing !== undefined;
      if (editsSharedGroup && base.identity && base.identity !== captured.identity) throw syncError('hub_changed');
      for (const kind of KINDS) {
        const touched = kind === 'modelAliases'
          ? patch.modelAliases !== undefined || patch.modelAliasGrouping !== undefined
          : patch.customModelPricing !== undefined;
        if (!touched || !state().enabled[kind]) continue;
        try {
          if (base.identity !== captured.identity || !Number.isSafeInteger(base.revisions?.[kind])) throw syncError('conflict');
          await discover(captured);
          const value = kind === 'modelAliases' ? {
            ...getLocalValue(kind),
            ...(patch.modelAliases !== undefined ? { modelAliases: patch.modelAliases } : {}),
            ...(patch.modelAliasGrouping !== undefined ? { modelAliasGrouping: patch.modelAliasGrouping } : {})
          } : patch.customModelPricing;
          const result = await api(captured, `/api/sync/settings/${kind}`, 'PUT', {
            baseRevision: base.revisions[kind], value: normalizeValue(kind, value)
          });
          assertCurrent(captured);
          documents[kind] = document(kind, result);
          error = '';
          emit();
        } catch (failure) {
          if (isCurrent(captured)) error = failure.code || 'unreachable';
          emit();
          throw failure;
        }
      }
    });
  }
  function notifyStats(stats) {
    const saved = state();
    const revisions = stats?.syncSettingsRevisions;
    const changed = KINDS.some((kind) => saved.enabled[kind] && Number.isSafeInteger(revisions?.[kind])
      && revisions[kind] !== documents[kind]?.revision);
    const key = JSON.stringify(revisions);
    if ((changed || saved.pendingTitleCleanup.length)
      && (lastCatchUp.identity !== identity || lastCatchUp.key !== key || now() - lastCatchUp.at >= 60_000)) {
      lastCatchUp = { identity, key, at: now() };
      void refresh();
    }
  }
  function receiverPermissionChanged() {
    const captured = invalidate();
    const saved = state();
    abortUploads();
    try { persist({ ...addCleanup(captured, saved), enabled: { ...saved.enabled, sessionTitles: false } }, true); }
    catch (_) { error = 'cleanup_pending'; }
    capabilities = null;
    titlePolicy = null;
    emit();
  }
  return { status, refresh, preview, configure, prepareUpload, publishPatch, notifyStats,
    invalidate, receiverPermissionChanged,
    retryCleanup: async () => { await enqueue(retryCleanup); emit(); return { ok: !status().pendingTitleCleanup, status: status() }; } };
}

module.exports = { createSyncContentRuntime, normalizeSyncContentState, destinationIdentity, destinationLabel };
