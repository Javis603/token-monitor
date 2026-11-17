// @ts-check
'use strict';
const { normalizeSharedSyncValue } = require('../../shared/syncContent');
const KIND = 'limitAccountPresentation';
/** @param {any} value @param {any[]} operations */
function replayPresentation(value, operations) {
  const next = structuredClone(value || {});
  for (const operation of operations) {
    const { provider, key, type } = operation;
    const group = next[provider] ||= { labels: {}, order: [] };
    if (type === 'rename') group.labels = Object.fromEntries(Object.entries({ ...group.labels, [key]: operation.label }).slice(-200));
    if (type === 'order') {
      // Preserve accounts added by another writer while honoring the new order.
      group.order = [...new Set([...operation.order, ...group.order])].slice(0, 200);
    }
  }
  return normalizeSharedSyncValue(KIND, next);
}
/** @param {any} options */
function createAccountPresentationSync({ getContext, identity, getSeed, getLocalLabels = () => [], getCacheIdentity, apply, request }) {
  let lane = Promise.resolve();
  /** @type {Promise<void> | null} */
  let refreshPending = null;
  let refreshAgain = false;
  let binding = '';
  let revision = -1;
  let unsupported = false;
  /** @type {any[]} */
  let pending = [];
  const connected = () => ['client', 'host'].includes(getContext()?.mode) && getContext()?.url;
  /** @param {any[]} operations */
  async function reconcile(operations) {
    if (!connected()) return;
    const context = { ...getContext() };
    const captured = identity(context);
    if (!captured) return;
    if (binding !== captured) { binding = captured; revision = -1; unsupported = false; pending = []; }
    if (unsupported) return;
    pending.push(...operations);
    const current = () => connected() && identity(getContext()) === captured;
    try {
      let response = await request(context, `/api/sync/settings/${KIND}`, 'GET');
      if (!current()) return;
      if ([400, 404].includes(response.status)) { unsupported = true; pending = []; return; }
      if (response.status !== 200) return;
      let document = response.body;
      // This device's own slot names are its input, so they fill gaps on the
      // first connection to each destination; only a Hub cache is never a seed.
      const localLabels = getCacheIdentity() !== captured ? getLocalLabels() : [];
      // A cache of any Hub is never a seed, even when that Hub cleared its map.
      const seed = document.value === null && !getCacheIdentity() ? getSeed() : {};
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!current()) return;
        let base = document.value === null ? seed : normalizeSharedSyncValue(KIND, document.value);
        if (document.value !== null && Object.keys(seed).length) {
          // Another device won first initialization. Keep its choices, and
          // carry across only names/order entries it has never named.
          base = structuredClone(base);
          for (const [provider, local] of Object.entries(seed)) {
            const shared = base[provider] ||= { labels: {}, order: [] };
            shared.labels = { ...local.labels, ...shared.labels };
            shared.order = [...new Set([...shared.order, ...local.order])].slice(0, 200);
          }
        }
        const missingLocalLabels = localLabels.filter((/** @type {any} */ operation) =>
          !Object.hasOwn(base[operation.provider]?.labels || {}, operation.key));
        const value = replayPresentation(base, [...missingLocalLabels, ...pending]);
        if (!pending.length && (document.value !== null ? JSON.stringify(value) === JSON.stringify(document.value) : !Object.keys(seed).length)) {
          await apply(value, captured);
          revision = document.revision;
          return;
        }
        response = await request(context, `/api/sync/settings/${KIND}`, 'PUT', { baseRevision: document.revision, value });
        if (!current()) return;
        if ([400, 404].includes(response.status)) { unsupported = true; pending = []; return; }
        if (response.status === 409) {
          // Always reread; never retarget a stale replacement to a new revision.
          response = await request(context, `/api/sync/settings/${KIND}`, 'GET');
          if (!current() || response.status !== 200) return;
          document = response.body;
          continue;
        }
        if (response.status !== 200) return;
        pending = [];
        await apply(normalizeSharedSyncValue(KIND, response.body.value), captured);
        revision = response.body.revision;
        return;
      }
    } catch (_) { /* Offline or old Hubs leave the durable local editor usable. */ }
  }
  /** @param {any[]} operations */
  function publish(operations) {
    const captured = identity(getContext());
    const task = lane.then(() => {
      if (identity(getContext()) !== captured) return;
      return reconcile(operations);
    });
    lane = task.catch(() => {});
    return task;
  }
  function refresh() {
    if (!refreshPending) refreshPending = publish([]).finally(() => {
      refreshPending = null;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    });
    return refreshPending;
  }
  return { publish, refresh, notifyStats(/** @type {any} */ stats) {
    // Pending edits retry on the next frame even when the Hub's revision has
    // not moved, so a transient failure cannot strand them.
    if (connected() && (pending.length || binding !== identity(getContext()) || stats?.syncSettingsRevisions?.[KIND] !== revision)) {
      if (refreshPending) refreshAgain = true;
      else void refresh();
    }
  } };
}
module.exports = { createAccountPresentationSync, replayPresentation };
