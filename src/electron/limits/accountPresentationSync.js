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
    if (type === 'rename') {
      // Reinsert so the latest rename is the newest entry when the cap trims.
      const { [key]: _previous, ...rest } = group.labels;
      group.labels = Object.fromEntries(Object.entries({ ...rest, [key]: operation.label }).slice(-200));
    }
    if (type === 'order') {
      // Preserve accounts added by another writer while honoring the new order.
      group.order = [...new Set([...operation.order, ...group.order])].slice(0, 200);
    }
  }
  return normalizeSharedSyncValue(KIND, next);
}
/** @param {any} options */
function createAccountPresentationSync({ getContext, identity, getSeed, getLocalLabels = () => [], getCacheIdentity, apply, request,
  loadJournal = () => [], saveJournal = () => {} }) {
  let lane = Promise.resolve();
  /** @type {Promise<void> | null} */
  let refreshPending = null;
  let refreshAgain = false;
  let binding = '';
  let revision = -1;
  let unsupported = false;
  /** @type {any[]} */
  let pending = [];
  // Edits published while an earlier pass is in flight. They are kept apart
  // from `pending` until their own pass, but any snapshot applied meanwhile
  // replays them, so a refresh can never put an older name back.
  // A journal left by an earlier run starts as queued edits for its destination.
  /** @type {any[]} */
  let queued = [];
  try { queued = (loadJournal() || []).filter((/** @type {any} */ item) => item?.destination && item.operation); } catch (_) { queued = []; }
  /** @param {any} value */
  /** @param {any} value @param {string} destination */
  const withQueued = (value, destination) => {
    const own = queued.filter(item => item.destination === destination).map(item => item.operation);
    return own.length ? replayPresentation(value, own) : value;
  };
  // Edits not yet acknowledged by their Hub survive a restart: a device that
  // edits offline and quits publishes them on its next connection.
  const persist = () => {
    try {
      saveJournal([...pending.map(operation => ({ destination: binding, operation })), ...queued].slice(-200));
    } catch (_) { /* The local edit is saved; only its later publication is at risk. */ }
  };
  const connected = () => ['client', 'host'].includes(getContext()?.mode) && getContext()?.url;
  /** @param {any[]} operations */
  async function reconcile(operations) {
    if (!connected()) return;
    const context = { ...getContext() };
    const captured = identity(context);
    if (!captured) return;
    if (binding !== captured) {
      // Keep unacknowledged edits bound to their original destination. A later
      // connection to that Hub can retry them, including after a restart.
      queued = [...pending.map(operation => ({ destination: binding, operation })), ...queued];
      binding = captured; revision = -1; unsupported = false; pending = [];
    }
    // Only consume this Hub's queue; never replay another Hub's edits here.
    const mine = queued.filter(item => item.destination === captured).map(item => item.operation);
    queued = queued.filter(item => item.destination !== captured);
    pending.push(...mine, ...operations);
    persist();
    if (unsupported) return;
    const current = () => connected() && identity(getContext()) === captured;
    try {
      let response = await request(context, `/api/sync/settings/${KIND}`, 'GET');
      if (!current()) return;
      if ([400, 404].includes(response.status)) { unsupported = true; return; }
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
        if (!pending.length && (document.value !== null ? JSON.stringify(value) === JSON.stringify(document.value) : !Object.keys(seed).length && !missingLocalLabels.length)) {
          await apply(withQueued(value, captured), captured);
          revision = document.revision;
          return;
        }
        response = await request(context, `/api/sync/settings/${KIND}`, 'PUT', { baseRevision: document.revision, value });
        if (!current()) return;
        if ([400, 404].includes(response.status)) { unsupported = true; return; }
        if (response.status === 409) {
          // Always reread; never retarget a stale replacement to a new revision.
          response = await request(context, `/api/sync/settings/${KIND}`, 'GET');
          if (!current() || response.status !== 200) return;
          document = response.body;
          continue;
        }
        if (response.status !== 200) return;
        pending = [];
        persist();
        await apply(withQueued(normalizeSharedSyncValue(KIND, response.body.value), captured), captured);
        revision = response.body.revision;
        return;
      }
    } catch (_) { /* Offline or old Hubs leave the durable local editor usable. */ }
  }
  /** @param {any[]} operations */
  function publish(operations) {
    const captured = identity(getContext());
    if (!captured) return Promise.resolve();
    queued.push(...operations.map(operation => ({ destination: captured, operation })));
    if (operations.length) persist();
    const task = lane.then(() => {
      if (identity(getContext()) !== captured) return;
      return reconcile([]);
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
    if (!connected()) return;
    const captured = identity(getContext());
    // A local stats update can arrive before the Hub snapshot. Only an
    // advertised revision can indicate a remote change or an upgraded Hub.
    const advertisedRevision = stats?.syncSettingsRevisions?.[KIND];
    const hasRevision = Number.isSafeInteger(advertisedRevision) && advertisedRevision >= 0;
    if (unsupported && binding === captured) {
      if (!hasRevision) return;
      unsupported = false;
    }
    // Pending edits retry on the next frame even when the Hub's revision has
    // not moved, so a transient failure cannot strand them.
    if (pending.length || queued.some(item => item.destination === captured)
      || binding !== captured || (hasRevision && advertisedRevision !== revision)) {
      if (refreshPending) refreshAgain = true;
      else void refresh();
    }
  } };
}
module.exports = { createAccountPresentationSync, replayPresentation };
