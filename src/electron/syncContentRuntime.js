'use strict';

const crypto = require('node:crypto');

const KINDS = Object.freeze(['modelAliases', 'customPricing']);
const emptySelection = () => ({ sessionTitles: false, modelAliases: false, customPricing: false });
const clone = (value) => JSON.parse(JSON.stringify(value));

// This binding remains private: it is compared directly inside CredentialStore,
// never hashed into a renderer-visible credential verifier.
function destinationBinding(context) {
  if (!context?.url || !['client', 'host'].includes(context.mode)) return null;
  try {
    const url = new URL(context.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return { mode: context.mode, url: url.href.replace(/\/$/, ''),
      secret: String(context.secret || ''), deviceId: String(context.deviceId || '') };
  } catch (_) { return null; }
}

function sameDestination(left, right) {
  return JSON.stringify(destinationBinding(left)) === JSON.stringify(destinationBinding(right));
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
    ...(typeof value?.committedTitleAdmission === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.committedTitleAdmission)
      ? { committedTitleAdmission: value.committedTitleAdmission } : {}),
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
  loadCleanupContexts = () => [], saveCleanupContext = () => {}, removeCleanupContext = () => {}, resolveIdentity
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
  let titleEnablePending = '';
  let uploadController = new AbortController();
  let lastCatchUp = { identity: '', key: '', at: -Infinity };
  const cleanupContexts = new Map();
  let cleanupLoaded = false;
  let storageBlocked = false;
  let recoveryFailed = false;
  let ephemeralBinding = null;
  let ephemeralIdentity = '';
  // Non-persistent adapters (e.g. an in-process protocol client) can omit this;
  // Electron always injects the existing CredentialStore-backed resolver.
  resolveIdentity ||= (next) => {
    if (!destinationBinding(next)) return '';
    if (!sameDestination(ephemeralBinding, next)) {
      ephemeralBinding = { ...next };
      ephemeralIdentity = crypto.randomUUID();
    }
    return ephemeralIdentity;
  };
  const cleanupContextWritesPending = new Set();
  let volatileState = null;

  const state = () => {
    try { return normalizeSyncContentState(volatileState || getState()); }
    catch (_) { storageBlocked = true; error = 'cleanup_pending'; return normalizeSyncContentState(null); }
  };
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
    try { next.identity = destinationBinding(next) ? resolveIdentity(next) : ''; }
    catch (_) { next.identity = ''; storageBlocked = true; error = 'cleanup_pending'; }
    return next;
  }
  const isCurrent = (captured) => Boolean(captured.identity) && sameDestination(captured, getContext()) && captured.identity === capture().identity;
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
      enabled: !storageBlocked && saved.identity === current.identity && current.identity ? saved.enabled : emptySelection(),
      revisions: Object.fromEntries(KINDS.map((kind) => [kind, documents[kind]?.revision || 0])),
      pendingTitleCleanup: storageBlocked || Boolean(volatileState) || saved.pendingTitleCleanup.length > 0 || cleanupContexts.size > 0,
      error: storageBlocked ? 'cleanup_pending' : current.identity ? error : 'unsupported'
    };
  }
  function emit() { onStatus(status()); }
  function addCleanup(previous, saved) {
    if (!previous?.identity || (!saved.enabled.sessionTitles && titleEnablePending !== previous.identity
      && !saved.pendingTitleCleanup.some(row => row.identity === previous.identity))) return saved;
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
      capabilityAt = -Infinity;
      try { persist({ ...withCleanup, identity: next.identity, enabled: emptySelection() }, true); }
      catch (_) { error = 'cleanup_pending'; }
    }
    // A saved consent remains valid across process restart at the same destination.
    return next;
  }
  function recoverStorage() {
    const resetConsent = recoveryFailed;
    storageBlocked = false;
    try {
      if (!cleanupLoaded) {
        for (const [key, value] of loadCleanupContexts()) cleanupContexts.set(key, value);
        cleanupLoaded = true;
      }
      const current = capture();
      if (storageBlocked) { recoveryFailed = true; return; }
      const saved = state();
      if (storageBlocked) throw syncError('cleanup_pending');
      let pending = saved.pendingTitleCleanup.map(row => {
        const migrated = [...cleanupContexts.values()].find(target => target.legacyIdentity === row.identity);
        if (migrated) return { ...row, identity: migrated.identity };
        // Keep unknown legacy obligations visible without retaining a verifier.
        return /^[a-f0-9]{64}$/.test(row.identity) ? { ...row, identity: crypto.randomUUID() } : row;
      });
      for (const target of cleanupContexts.values()) {
        // This random journal belongs to a durably committed admission, not
        // an OFF request. Retire it without revoking the successful consent.
        // OFF/destination changes use their own destination-identity journal.
        if (target.identity === saved.committedTitleAdmission) {
          try {
            removeCleanupContext(target.identity);
            cleanupContexts.delete(target.identity);
            cleanupContextWritesPending.delete(target.identity);
          } catch (_) { error = 'cleanup_pending'; }
          continue;
        }
        if (!pending.some(row => row.identity === target.identity)) pending.push({
          identity: target.identity, deviceId: target.deviceId, destination: destinationLabel(target)
        });
      }
      let next = { ...saved, pendingTitleCleanup: pending };
      const currentCleanup = pending.some(row => row.identity === current.identity
        || sameDestination(cleanupContexts.get(row.identity), current));
      if (resetConsent || saved.identity !== current.identity || currentCleanup) {
        // Legacy consent is never reused. If it may have admitted this device,
        // revoke the current context as well as retaining old cleanup journals.
        if (saved.enabled.sessionTitles && (resetConsent || saved.identity !== current.identity) && current.identity) {
          next = addCleanup(current, next);
        }
        next = { ...next, identity: current.identity, enabled: emptySelection() };
      }
      if (volatileState || JSON.stringify(next) !== JSON.stringify(saved)) persist(next, true);
      recoveryFailed = false;
    } catch (_) { recoveryFailed = true; storageBlocked = true; error = 'cleanup_pending'; }
  }
  recoverStorage();
  context = capture();
  identity = context.identity;

  // Called before main commits any replacement URL, credentials, mode or device.
  // Both the private old context and the OFF/pending preference must be durable.
  function beforeDestinationChange(nextContext) {
    if (sameDestination(context, nextContext)) return;
    abortUploads();
    capabilities = null;
    documents = {};
    capabilityAt = -Infinity;
    recoverStorage();
    const saved = state();
    const off = { ...saved, enabled: emptySelection() };
    try {
      if (storageBlocked || volatileState || cleanupContextWritesPending.size) throw syncError('cleanup_pending');
      const journal = addCleanup(context, saved);
      const next = { ...journal, enabled: emptySelection() };
      // Even if the context write failed, save the local OFF/pending row. Since
      // replacement is refused, the old active connection still permits retry.
      persist(next, true);
      if (cleanupContextWritesPending.size) throw syncError('cleanup_pending');
    } catch (_) {
      volatileState = { ...state(), enabled: off.enabled };
      error = 'cleanup_pending';
      emit();
      throw syncError('cleanup_pending');
    }
    emit();
  }

  async function api(captured, path, method = 'GET', body) {
    const response = await request(captured, path, method, body);
    if (!response || typeof response.status !== 'number') throw syncError('unreachable');
    if (response.status === 409) throw Object.assign(syncError('conflict'), { document: response.body });
    if (response.status === 404 || response.status === 405) throw syncError('unsupported');
    if (response.status === 401) throw syncError('unauthorized');
    if (response.status === 403) throw syncError('titles_not_allowed');
    if (response.status < 200 || response.status >= 300) throw syncError('unreachable');
    return response.body;
  }
  async function discover(captured, force = false) {
    if (storageBlocked || volatileState || cleanupContextWritesPending.size) throw syncError('cleanup_pending');
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
    recoverStorage();
    const current = invalidate();
    if (storageBlocked) return;
    // Disk recovery is independent of Hub recovery. Make the off choice and
    // old connection durable even while the server is still unreachable.
    if (volatileState) {
      try { persist(volatileState); } catch (_) { error = 'cleanup_pending'; }
    }
    for (const row of state().pendingTitleCleanup) {
      const target = row.identity === current.identity ? current : cleanupContexts.get(row.identity);
      if (!target) { error = 'cleanup_pending'; continue; }
      if (cleanupContextWritesPending.has(row.identity)) {
        try { saveCleanupContext(target); cleanupContextWritesPending.delete(row.identity); }
        catch (_) { error = 'cleanup_pending'; continue; }
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
        const previousDocument = documents[kind];
        documents[kind] = next;
        try {
          if (next.value !== null && fingerprint(kind, next.value) !== fingerprint(kind, getLocalValue(kind))) {
            // settings:push includes status while applying this map. Publish its
            // matching revision there, before renderer rows take a snapshot.
            await applyLocalValue(kind, clone(next.value));
            assertCurrent(captured);
          }
        } catch (failure) {
          if (isCurrent(captured)) documents[kind] = previousDocument;
          throw failure;
        }
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
    let admissionSignal = uploadController.signal;
    let admissionJournal = null;
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
            if (state().pendingTitleCleanup.some(row => row.identity === captured.identity
              || sameDestination(cleanupContexts.get(row.identity), captured))) throw syncError('cleanup_pending');
            if (options.confirmed !== true) throw syncError('confirmation_required');
            if (!capabilities.sessionTitles.enabled) throw syncError('titles_not_allowed');
            if (admissionSignal.aborted) throw syncError('hub_changed');
            if (cleanupContexts.has(state().committedTitleAdmission)) throw syncError('cleanup_pending');
            titleEnablePending = captured.identity;
            // A separate random journal ID lets restart distinguish a committed
            // admission from a later OFF journal at this same destination.
            admissionJournal = { ...captured, identity: crypto.randomUUID() };
            cleanupContexts.set(admissionJournal.identity, admissionJournal);
            try { saveCleanupContext(admissionJournal); }
            catch (_) {
              // No enable has been sent. Keep the ordinary current-context OFF
              // obligation, which restart can retry even if this write failed.
              cleanupContexts.delete(admissionJournal.identity);
              admissionJournal = null;
              throw syncError('cleanup_pending');
            }
            abortUploads();
            admissionSignal = uploadController.signal;
            const saved = state();
            persist({ ...saved, enabled: { ...saved.enabled, sessionTitles: false },
              pendingTitleCleanup: [...saved.pendingTitleCleanup, { identity: admissionJournal.identity,
                deviceId: captured.deviceId, destination: destinationLabel(captured) }] }, true);
            // Both stores now contain the obligation before the server can turn ON.
            await ensureTitlePolicy(captured, true);
            if (admissionSignal.aborted) throw syncError('hub_changed');
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
              const previousDocument = documents[kind];
              documents[kind] = remote;
              try {
                if (remote.value !== null) await applyLocalValue(kind, clone(remote.value));
                assertCurrent(captured);
              } catch (failure) {
                if (isCurrent(captured)) documents[kind] = previousDocument;
                throw failure;
              }
            }
          }
          const saved = state();
          persist({ ...saved, enabled: { ...saved.enabled, [kind]: true },
            ...(admissionJournal ? { committedTitleAdmission: admissionJournal.identity,
              pendingTitleCleanup: saved.pendingTitleCleanup.filter(row => row.identity !== admissionJournal.identity) } : {}) });
          if (admissionJournal) {
            // Consent and the marker commit together before journal deletion.
            // A failed deletion is safely retried on restart without revocation.
            try {
              removeCleanupContext(admissionJournal.identity);
              cleanupContexts.delete(admissionJournal.identity);
            } catch (_) { error = 'cleanup_pending'; }
          }
        }
        titleEnablePending = '';
        error = state().pendingTitleCleanup.length || cleanupContexts.size ? 'cleanup_pending' : '';
        emit();
        return { ok: true, status: status() };
      } catch (failure) {
        // An admitted remote generation whose local commit failed still needs
        // a durable revocation journal, even though no title upload was sent.
        if (titleEnablePending === captured.identity) {
          abortUploads();
          const saved = state();
          try { persist({ ...(admissionJournal ? saved : addCleanup(captured, saved)),
            enabled: { ...saved.enabled, sessionTitles: false } }, true); }
          catch (_) { error = 'cleanup_pending'; }
          titleEnablePending = '';
        }
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
        await retryCleanup();
        const desired = !storageBlocked && state().identity === captured.identity && state().enabled.sessionTitles;
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
    const editsSharedGroup = patch.modelAliases !== undefined || patch.modelAliasGrouping !== undefined
      || patch.customModelPricing !== undefined;
    if (!editsSharedGroup) return Promise.resolve();
    const original = invalidate();
    return enqueue(async () => {
      const captured = invalidate();
      if (original.identity !== captured.identity || !sameDestination(original, captured)
        || (base.identity !== undefined && base.identity !== captured.identity)) throw syncError('hub_changed');
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
  function receiverPermissionChanged(enabled = false) {
    const captured = invalidate();
    const saved = state();
    abortUploads();
    if (!enabled) {
      try { persist({ ...addCleanup(captured, saved), enabled: { ...saved.enabled, sessionTitles: false } }, true); }
      catch (_) { error = 'cleanup_pending'; }
    }
    capabilityAt = -Infinity;
    capabilities = null;
    titlePolicy = null;
    emit();
  }
  return { status, refresh, preview, configure, prepareUpload, publishPatch, notifyStats,
    invalidate, beforeDestinationChange, receiverPermissionChanged,
    retryCleanup: async () => { await enqueue(retryCleanup); emit(); return { ok: !status().pendingTitleCleanup, status: status() }; } };
}

module.exports = { createSyncContentRuntime, normalizeSyncContentState, destinationBinding, sameDestination, destinationLabel };
