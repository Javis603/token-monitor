'use strict';

const http = require('node:http');
const {
  createFixedRangeUploads, fixedRangeRequestPages, retireFixedRangeSnapshot, rememberFixedRangeObservation,
  hasCurrentFixedRangeObservation, withoutFixedRangeObservation
} = require('../shared/fixedRangeUploads');
const { dailyRangeKeys, decodeFixedRangePeriod, legacyFixedRangeView, rangesMatchDeviceDay, redactDailyRangeSnapshot, removedPagedClients, restorePagedClientSessions, FIXED_RANGE_HEADER, FIXED_RANGE_VERSION } = require('../shared/fixedRangeSync');
const { UPLOAD_HEADER, UPLOAD_VERSION, createUploadBaselines } = require('../shared/uploadDelta');
const path = require('node:path');
const { URL } = require('node:url');
const {
  mergePeriods, aggregateDevices,
  mergeSyncDeviceRecord, restoreDeviceHistory,
  aggregateHistory,
  stripSessionTextFromDeviceRecord
} = require('../shared/usage');
const {
  SHARED_SYNC_KINDS, emptySharedSyncDocument, nextSharedSyncDocument,
  syncContentCapability, syncSessionTitlesEnabled, normalizeTitlePolicy, nextTitlePolicy, acceptsSessionTitles
} = require('../shared/syncContent');
const { DEFAULT_STALE_AFTER_MS } = require('../shared/syncUploadInterval');
const { deviceHistoryRevision, historyPreview, historyRevision } = require('../shared/history');
const {
  emptySubscriptionDocument,
  isStaleSubscriptionWrite,
  subscriptionDocument
} = require('../shared/subscriptionDisplay');
const { CURRENCY_CODES, normalizeCurrency } = require('../shared/currency');
const { currentHubBuild } = require('../shared/hubBuildIdentity');
const {
  SSE_BACKLOG_LIMIT_BYTES,
  encodeSseEvent,
  prepareSseFanout,
  sseClientKinds,
  sseFrameForClient,
  hubStatsContentKey,
  wantsFreshnessEvents,
  wantsDeltaEvents,
  wantsMinimalResponse
} = require('../shared/hubProtocol');
const { isAuthorized, readJsonBody, sendJson, sendText } = require('../shared/http');
const { loadDotEnv, parseArgs, projectRoot, readJson, writeJsonAtomic } = require('../shared/config');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

// Without a secret the hub cannot tell its own widget from any other caller, so it
// must not expose account identity (email/plan/key) to the network. Binding to
// loopback keeps an unauthenticated hub usable locally while refusing LAN/remote
// reach; set a secret to bind a non-loopback address and accept other devices.
function resolveBindHost(host, secret) {
  const requested = String(host || '').trim() || '0.0.0.0';
  if (secret) return requested;
  return LOOPBACK_HOSTS.has(requested.toLowerCase()) ? requested : '127.0.0.1';
}

function createHub({
  port = 17321,
  deployment,
  host = '0.0.0.0',
  secret = '',
  syncSessionTitles = false,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  broadcastDelayMs = 100,
  persistIntervalMs = 0,
  dataFile = path.join(projectRoot(), 'data', 'devices.json'),
  logger = console
} = {}) {
  if (!Number.isFinite(persistIntervalMs) || persistIntervalMs < 0 || persistIntervalMs > 2147483647) {
    throw new RangeError('persistIntervalMs must be a finite number between 0 and 2147483647 milliseconds');
  }
  const store = readJson(dataFile, { version: 1, devices: {} }) || { version: 1, devices: {} };
  if (!store.devices || typeof store.devices !== 'object') store.devices = {};
  // Subscriptions are shared by every device on this hub rather than owned by one
  // of them, so they sit beside the device map rather than inside it.
  if (!store.subscriptions || typeof store.subscriptions !== 'object') {
    store.subscriptions = emptySubscriptionDocument();
  }
  const serverTitlesEnabled = syncSessionTitlesEnabled(syncSessionTitles);
  store.devices = Object.assign(Object.create(null), store.devices);
  store.syncTitlePolicies = Object.assign(Object.create(null), store.syncTitlePolicies || {});
  store.syncSettings = Object.assign(Object.create(null), store.syncSettings || {});
  store.fixedRanges = Object.assign(Object.create(null), store.fixedRanges || {});
  const fixedRangeUploads = createFixedRangeUploads();
  const legacyRangeViews = new WeakMap();
  function getFixedRanges(id) {
    const snapshot = store.fixedRanges[id];
    const device = store.devices[id];
    return snapshot?.revision && hasCurrentFixedRangeObservation(device)
      && snapshot.observedAt === device.updatedAt
      && rangesMatchDeviceDay(snapshot.ranges, device.periodWindows?.today?.key) ? snapshot : undefined;
  }

  function readFixedRange(id, name, window, revision) {
    const snapshot = getFixedRanges(id);
    if (!snapshot || snapshot.revision !== revision) return null;
    const daily = !Object.hasOwn(snapshot.ranges, name);
    const names = daily ? dailyRangeKeys(window) : [name];
    if (!names.length) return null;
    const periods = [];
    for (const key of names) {
      const range = snapshot.ranges[key];
      if (range?.start !== (daily ? key : window.start) || range.end !== (daily ? key : window.end)) return null;
      const decoded = decodeFixedRangePeriod(snapshot.ranges, snapshot.pages.slice(range.firstPage, range.firstPage + range.pageCount), key);
      if (!decoded) return null;
      periods.push(decoded);
    }
    return daily ? mergePeriods(...periods) : periods[0];
  }

  function acceptFixedRange(deviceId, payload) {
    const pages = fixedRangeRequestPages(payload);
    if (!pages) return { status: 400 };
    const preserveTitles = acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[deviceId], pages[0]?.sessionTitleSyncGeneration);
    const previous = store.fixedRanges[deviceId];
    let result;
    for (const page of pages) {
      const published = previous && previous.revision === page?.revision ? {
        ...previous,
        pageCount: previous.pages.length,
        rows: previous.pages.length === 0 && page.page === 0 ? [] : previous.pages[page.page]
      } : previous;
      result = fixedRangeUploads.accept(deviceId, page, store.devices[deviceId], preserveTitles, published);
      if (result.status !== 200) return result;
    }
    if (result.snapshot) publishFixedRanges(deviceId, result.snapshot);
    return result;
  }

  function publishFixedRanges(id, snapshot) {
    const previous = store.fixedRanges[id];
    store.fixedRanges[id] = snapshot;
    try { queuePersist(); } catch (error) {
      if (previous) store.fixedRanges[id] = previous;
      else delete store.fixedRanges[id];
      throw error;
    }
    if (statsListeners.size > 0) notifyStatsListeners('fixed-ranges');
    queueStatsBroadcast();
  }
  const bindHost = resolveBindHost(host, secret);
  const uploadBaselines = createUploadBaselines();
  let persistTimer = null;
  let persistPending = false;
  let stopping = false;
  let stopPromise = null;

  // Apply the permission at startup, including records from offline devices.
  // Keep disabled policies as tombstones so re-enabling cannot reuse old tokens.
  const beforeCleanup = JSON.stringify([store.devices, store.syncTitlePolicies, store.fixedRanges]);
  for (const [id, policy] of Object.entries(store.syncTitlePolicies)) {
    if (!serverTitlesEnabled && policy?.enabled === true) store.syncTitlePolicies[id] = nextTitlePolicy(policy, false);
  }
  for (const [id, record] of Object.entries(store.devices)) {
    store.devices[id] = stripSessionTextFromDeviceRecord(record, {
      preserveSessionTitles: serverTitlesEnabled && normalizeTitlePolicy(store.syncTitlePolicies[id]).enabled
    });
  }
  for (const id of Object.keys(store.fixedRanges)) {
    const snapshot = store.fixedRanges[id];
    if (snapshot.titleGeneration && !acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[id], snapshot.titleGeneration)) {
      store.fixedRanges[id] = redactDailyRangeSnapshot(snapshot, store.devices[id]?.periodWindows?.today?.key)
        || retireFixedRangeSnapshot(snapshot);
    }
  }
  if (JSON.stringify([store.devices, store.syncTitlePolicies, store.fixedRanges]) !== beforeCleanup) persist();

  function persist() {
    store.version = 1;
    store.savedAt = new Date().toISOString();
    writeJsonAtomic(dataFile, store, 0);
    clearTimeout(persistTimer);
    persistTimer = null;
    persistPending = false;
  }

  function queuePersist() {
    if (persistIntervalMs === 0) return persist();
    persistPending = true;
    // Admitted HTTP uploads can finish during stop; its final flush owns them.
    if (stopping) return;
    // Keep the first deadline: continuous uploads must not postpone saving.
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try { persist(); } catch (error) {
        (logger.error || console.error)('Hub failed to save pending device records:', error);
      }
    }, persistIntervalMs);
    persistTimer.unref();
  }

  function getStats() {
    const stats = aggregateDevices(Object.values(store.devices), staleAfterMs);
    stats.staleAfterMs = staleAfterMs;
    const history = aggregateHistory(Object.values(store.devices));
    stats.historyPreview = historyPreview(history);
    stats.historyRevision = historyRevision(history);
    stats.deviceHistoryRevision = deviceHistoryRevision(Object.values(store.devices));
    stats.fixedRangeRevisions = Object.fromEntries(Object.keys(store.fixedRanges)
      .flatMap(id => {
        const snapshot = getFixedRanges(id);
        return snapshot ? [[id, snapshot.revision]] : [];
      }));
    // The version of the shared subscription list, never the list itself. A
    // device compares it against the copy it holds and re-reads only when it has
    // been overtaken, so learning about another device's edit costs nothing in
    // the steady state and does not put what the user pays into every frame.
    stats.subscriptionsUpdatedAt = store.subscriptions?.updatedAt || '';
    stats.syncSettingsRevisions = Object.fromEntries(SHARED_SYNC_KINDS.map((kind) => [kind, getSyncSettings(kind).revision]));
    return stats;
  }

  function getHistory() {
    return aggregateHistory(Object.values(store.devices));
  }

  function getDevices() {
    return Object.values(store.devices).map(withoutFixedRangeObservation);
  }

  const sseClients = new Set();
  const statsListeners = new Set();
  let broadcastTimer = null;
  let lastSseContentKey = '';
  let lastSseStats = null;
  let streamRevision = 0;

  // Once write() reports backpressure, later frames still queue in order behind
  // the frame in flight, up to SSE_BACKLOG_LIMIT_BYTES. Past that budget the
  // connection skips frames and resyncs once its transport drains.
  function writeSseFrame(client, frame) {
    if (!frame) return false;
    if (client.blocked && (client.needsSnapshot || client.res.writableLength + Buffer.byteLength(frame) > client.backlogLimit)) {
      client.needsSnapshot = true;
      return false;
    }
    try {
      if (client.res.write(frame) === false && !client.blocked) {
        client.blocked = true;
        client.backlogLimit = client.res.writableLength + SSE_BACKLOG_LIMIT_BYTES;
        client.res.once('drain', client.onDrain);
      }
      return true;
    } catch (_) {
      client.cleanup();
      return false;
    }
  }

  function fanoutSseFrames(frames) {
    for (const client of sseClients) {
      if (writeSseFrame(client, sseFrameForClient(frames, client)) && client.deltaEvents) client.streamRevision = frames.revision;
    }
  }

  function notifyStatsListeners(reason, stats = getStats(), at = new Date().toISOString()) {
    for (const listener of statsListeners) {
      try { listener(stats, reason, at); } catch (_) { /* listener errors must not break ingest */ }
    }
  }

  function broadcastStats(reason = 'update') {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    if (sseClients.size === 0 && statsListeners.size === 0) return;
    const stats = getStats();
    const at = new Date().toISOString();
    if (sseClients.size > 0) {
      const frames = prepareSseFanout({
        reason,
        stats,
        at,
        lastContentKey: lastSseContentKey,
        previousStats: lastSseStats,
        revision: ++streamRevision,
        ...sseClientKinds(sseClients),
        allowFreshness: false
      });
      lastSseContentKey = frames.contentKey;
      lastSseStats = stats;
      fanoutSseFrames(frames);
    }
    // Embedded widgets add local presentation metadata to their snapshot. Do
    // not expose the immutable SSE delta baseline to those observers.
    notifyStatsListeners(reason, sseClients.size > 0 && statsListeners.size > 0 ? getStats() : stats, at);
  }

  function flushQueuedStatsBroadcast() {
    broadcastTimer = null;
    if (sseClients.size === 0) return;
    const stats = getStats();
    const at = new Date().toISOString();
    const frames = prepareSseFanout({
      reason: 'ingest',
      stats,
      at,
      lastContentKey: lastSseContentKey,
      previousStats: lastSseStats,
      revision: ++streamRevision,
      ...sseClientKinds(sseClients)
    });
    lastSseContentKey = frames.contentKey;
    lastSseStats = stats;
    fanoutSseFrames(frames);
  }

  function queueStatsBroadcast() {
    if (sseClients.size === 0 || broadcastTimer) return;
    broadcastTimer = setTimeout(flushQueuedStatsBroadcast, Math.max(0, Number(broadcastDelayMs) || 0));
  }

  // Transport-agnostic core: both the HTTP POST handler and the same-process
  // widget call these, so a host-mode widget never has to loopback to itself.
  function ingest(payload) {
    if (stopping) throw Object.assign(new Error('Hub is stopping'), { code: 'hub_stopping' });
    return ingestRecord(payload);
  }

  function ingestRecord(payload, { historyOnly = false } = {}) {
    if (!payload || (!payload.deviceId && !payload.id)) {
      throw new Error('deviceId_required');
    }
    const deviceId = String(payload.deviceId || payload.id);
    if (!historyOnly) uploadBaselines.forget(deviceId);
    const previous = store.devices[deviceId];
    const removed = removedPagedClients(previous, payload);
    const published = removed.length ? getFixedRanges(deviceId) : null;
    const previousWithSessions = published
      ? restorePagedClientSessions(previous, published.ranges, published.pages, removed) : previous;
    const record = historyOnly ? restoreDeviceHistory(previous, payload) : mergeSyncDeviceRecord(previousWithSessions, { ...payload, receivedAt: new Date().toISOString() }, {
      preserveSessionTitles: acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[deviceId], payload.sessionTitleSyncGeneration)
    });
    rememberFixedRangeObservation(record, previous);
    const projectsChanged = (previous?.projectsEnabled !== false) !== (record.projectsEnabled !== false);
    const dayChanged = previous?.periodWindows?.today?.key !== record.periodWindows?.today?.key;
    if (previous?.updatedAt !== record.updatedAt || dayChanged || projectsChanged) fixedRangeUploads.discard(deviceId);
    const snapshot = store.fixedRanges[deviceId];
    if (projectsChanged && snapshot?.revision) store.fixedRanges[deviceId] = retireFixedRangeSnapshot(snapshot);
    store.devices[record.deviceId] = record;
    queuePersist();
    if (statsListeners.size > 0) notifyStatsListeners('ingest');
    queueStatsBroadcast();
    return withoutFixedRangeObservation(record);
  }

  function deleteDevice(deviceId) {
    uploadBaselines.forget(deviceId);
    // Commit deletion and revocation together, keeping a generation tombstone.
    const previousPolicy = store.syncTitlePolicies[deviceId];
    const previousDevice = store.devices[deviceId];
    const previousRanges = store.fixedRanges[deviceId];
    const previousSavedAt = store.savedAt;
    store.syncTitlePolicies[deviceId] = nextTitlePolicy(previousPolicy, false);
    delete store.devices[deviceId];
    delete store.fixedRanges[deviceId];
    try { persist(); } catch (error) {
      if (previousPolicy) store.syncTitlePolicies[deviceId] = previousPolicy;
      else delete store.syncTitlePolicies[deviceId];
      if (previousDevice) store.devices[deviceId] = previousDevice;
      if (previousRanges) store.fixedRanges[deviceId] = previousRanges;
      store.savedAt = previousSavedAt;
      throw error;
    }
    fixedRangeUploads.discard(deviceId);
    broadcastStats('delete');
  }

  function getSyncContent() {
    return syncContentCapability(serverTitlesEnabled);
  }

  function getSyncSettings(kind) {
    if (!SHARED_SYNC_KINDS.includes(kind)) {
      const error = new Error('unknown shared settings kind');
      error.code = 'bad_request';
      throw error;
    }
    return store.syncSettings[kind] || emptySharedSyncDocument();
  }

  function setSyncSettings(kind, payload) {
    const next = nextSharedSyncDocument(kind, getSyncSettings(kind), payload);
    const previous = store.syncSettings[kind];
    const previousSavedAt = store.savedAt;
    store.syncSettings[kind] = next;
    try { persist(); } catch (error) {
      if (previous) store.syncSettings[kind] = previous;
      else delete store.syncSettings[kind];
      store.savedAt = previousSavedAt;
      throw error;
    }
    broadcastStats('sync-settings');
    return next;
  }

  function setSyncTitlePolicy(deviceId, enabled) {
    if (enabled === true && !serverTitlesEnabled) {
      const error = new Error('session title sync is disabled on the server');
      error.code = 'forbidden';
      throw error;
    }
    const previous = store.syncTitlePolicies[deviceId];
    const next = nextTitlePolicy(previous, enabled);
    if (enabled && normalizeTitlePolicy(previous).enabled) return next;
    uploadBaselines.forget(deviceId);
    const previousDevice = store.devices[deviceId];
    const previousRanges = store.fixedRanges[deviceId];
    const previousSavedAt = store.savedAt;
    store.syncTitlePolicies[deviceId] = next;
    if (!enabled && previousDevice) store.devices[deviceId] = stripSessionTextFromDeviceRecord(previousDevice);
    if (!enabled && previousRanges?.titleGeneration) {
      store.fixedRanges[deviceId] = redactDailyRangeSnapshot(previousRanges, previousDevice?.periodWindows?.today?.key)
        || retireFixedRangeSnapshot(previousRanges);
    }
    try { persist(); } catch (error) {
      if (previous) store.syncTitlePolicies[deviceId] = previous;
      else delete store.syncTitlePolicies[deviceId];
      if (previousDevice) store.devices[deviceId] = previousDevice;
      if (previousRanges) store.fixedRanges[deviceId] = previousRanges;
      store.savedAt = previousSavedAt;
      throw error;
    }
    fixedRangeUploads.discard(deviceId);
    broadcastStats('sync-titles');
    return next;
  }

  function getSubscriptions() {
    return store.subscriptions;
  }

  // Transport-agnostic like ingest(), so a host-mode widget writes its own hub
  // in-process instead of looping back over HTTP to itself.
  function setSubscriptions(subscriptions, baseUpdatedAt) {
    // A non-array would normalize to an empty list and be stored as a perfectly
    // successful replacement, wiping records that exist nowhere else. An
    // intentional clear still sends [].
    if (!Array.isArray(subscriptions)) {
      const error = new Error('subscriptions must be an array');
      error.code = 'bad_subscriptions';
      throw error;
    }
    if (isStaleSubscriptionWrite(store.subscriptions, baseUpdatedAt)) {
      const error = new Error('stale_write');
      error.code = 'stale_write';
      error.current = store.subscriptions;
      throw error;
    }
    // A currency with no exchange rate would be coerced to USD and reported as
    // an amount the user never entered. The endpoint says it validates, so it
    // refuses rather than quietly rewriting what somebody pays.
    const unsupported = subscriptions.find(
      (entry) => entry?.currency && !CURRENCY_CODES.includes(String(entry.currency).trim().toUpperCase())
    );
    if (unsupported) {
      const error = new Error(`unsupported currency: ${String(unsupported.currency).trim().toUpperCase()}`);
      error.code = 'bad_subscriptions';
      throw error;
    }
    const next = subscriptionDocument(subscriptions, {
      previousUpdatedAt: store.subscriptions?.updatedAt,
      currencyApi: { normalizeCurrency }
    });
    // Persist before the in-memory list moves. Otherwise a failed write leaves
    // this process serving records the file does not have, and a restart quietly
    // reverts to the old ones — the worst shape for data that exists nowhere else.
    const previous = store.subscriptions;
    const previousSavedAt = store.savedAt;
    store.subscriptions = next;
    try {
      persist();
    } catch (error) {
      store.subscriptions = previous;
      store.savedAt = previousSavedAt;
      throw error;
    }
    // Same reason ingest() broadcasts: the other devices are holding a copy that
    // has just been overtaken, and without this they only find out on their next
    // poll — which is five minutes apart while the stream is up.
    broadcastStats('subscriptions');
    return store.subscriptions;
  }

  function onStats(listener) {
    statsListeners.add(listener);
    return () => statsListeners.delete(listener);
  }

  async function handleRequest(req, res) {
    // Existing sockets can finish their headers after server.close(). In
    // particular, do not admit a new SSE stream after ending the old streams.
    if (stopping) {
      res.shouldKeepAlive = false;
      return sendJson(res, 503, { error: 'hub_stopping' }, { connection: 'close' });
    }
    if (req.method === 'OPTIONS') return sendText(res, 204, '');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        role: 'hub',
        runtime: 'node-hub',
        ...(deployment ? { deployment } : {}),
        version: store.version || 1,
        hubBuild: currentHubBuild('node-hub'),
        deviceCount: Object.keys(store.devices).length,
        secretRequired: Boolean(secret),
        now: new Date().toISOString()
      });
    }

    if (!isAuthorized(req, secret)) return sendJson(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/api/fixed-ranges') {
      const deviceId = url.searchParams.get('deviceId') || '';
      if (!deviceId) return sendJson(res, 400, { error: 'deviceId_required' });
      if (req.method === 'PUT') {
        try {
          const payload = await readJsonBody(req);
          const { status, complete } = acceptFixedRange(deviceId, payload);
          return sendJson(res, status, status === 200 ? { complete } : {
            error: status === 409 ? 'fixed_range_revision_mismatch' : 'bad_fixed_range_page'
          });
        } catch (error) {
          const status = error.code === 'payload_too_large' ? 413 : 400;
          return sendJson(res, status, { error: status === 413 ? 'payload_too_large' : 'bad_fixed_range_page' });
        }
      }
      if (req.method === 'GET') {
        const snapshot = getFixedRanges(deviceId);
        if (!snapshot) {
          return sendJson(res, 404, { error: 'not_found' });
        }
        let view = snapshot;
        const day = store.devices[deviceId]?.periodWindows?.today?.key;
        if (url.searchParams.get('daily') !== '1' && Object.hasOwn(snapshot.ranges, day)) {
          let legacy = legacyRangeViews.get(snapshot);
          if (!legacy) {
            legacy = legacyFixedRangeView(snapshot.ranges, snapshot.pages, day);
            legacyRangeViews.set(snapshot, legacy);
          }
          view = { ...snapshot, ...legacy };
        }
        if (!url.searchParams.has('page')) {
          const { pages: _pages, retiredRevisions: _retired, ...index } = view;
          return sendJson(res, 200, index);
        }
        if (url.searchParams.get('revision') !== snapshot.revision) {
          return sendJson(res, 409, { error: 'fixed_range_revision_mismatch' });
        }
        const page = url.searchParams.get('page');
        const rows = /^(0|[1-9]\d*)$/.test(page) ? view.pages[Number(page)] : null;
        return rows ? sendJson(res, 200, { rows }) : sendJson(res, 404, { error: 'not_found' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/content') return sendJson(res, 200, getSyncContent());

    const settingsMatch = url.pathname.match(/^\/api\/sync\/settings\/(modelAliases|customPricing|limitAccountPresentation)$/);
    if (settingsMatch && req.method === 'GET') return sendJson(res, 200, { ok: true, ...getSyncSettings(settingsMatch[1]) });
    const titlesMatch = url.pathname.match(/^\/api\/sync\/titles\/([^/]+)$/);
    if (req.method === 'PUT' && (settingsMatch || titlesMatch)) {
      try {
        const payload = await readJsonBody(req);
        if (settingsMatch) return sendJson(res, 200, { ok: true, ...setSyncSettings(settingsMatch[1], payload) });
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => key !== 'enabled') || typeof payload.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'bad_request', message: 'enabled must be a boolean' });
        }
        const policy = setSyncTitlePolicy(decodeURIComponent(titlesMatch[1]), payload.enabled);
        return sendJson(res, 200, { ok: true, ...policy });
      } catch (error) {
        if (error.code === 'stale_write') return sendJson(res, 409, { error: 'stale_write', ...error.current });
        if (error.code === 'forbidden') return sendJson(res, 403, { error: 'forbidden', message: error.message });
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, getStats());
    if (req.method === 'GET' && url.pathname === '/api/devices') return sendJson(res, 200, { devices: getDevices() });
    if (req.method === 'GET' && url.pathname === '/api/history') return sendJson(res, 200, getHistory());

    if (req.method === 'GET' && url.pathname === '/api/stats/stream') {
      const stats = getStats();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const client = { res, freshnessEvents: wantsFreshnessEvents(req), deltaEvents: wantsDeltaEvents(req), streamRevision: null, blocked: false, backlogLimit: 0, needsSnapshot: false };
      let heartbeat = null;
      client.cleanup = () => {
        clearInterval(heartbeat);
        res.off('drain', client.onDrain);
        sseClients.delete(client);
        if (sseClients.size === 0) {
          lastSseContentKey = '';
          lastSseStats = null;
          if (broadcastTimer) clearTimeout(broadcastTimer);
          broadcastTimer = null;
        }
      };
      client.onDrain = () => {
        client.blocked = false;
        if (!client.needsSnapshot) return;
        client.needsSnapshot = false;
        // Resync to the baseline the last fan-out established, so the next
        // update resumes with freshness or delta frames, not another snapshot.
        client.streamRevision = null;
        try {
          if (writeSseFrame(client, encodeSseEvent('stats', {
            type: 'stats', reason: 'snapshot', stats: lastSseStats, at: new Date().toISOString(),
            ...(client.deltaEvents ? { revision: streamRevision } : {})
          })) && client.deltaEvents) client.streamRevision = streamRevision;
        } catch (_) { client.cleanup(); }
      };
      res.on('close', client.cleanup);
      res.on('error', client.cleanup);
      if (sseClients.size === 0) {
        lastSseContentKey = hubStatsContentKey(stats);
        lastSseStats = stats;
        if (client.deltaEvents) client.streamRevision = streamRevision;
      }
      sseClients.add(client);
      heartbeat = setInterval(() => {
        if (!client.blocked) writeSseFrame(client, ': hb\n\n');
      }, 30000);
      writeSseFrame(client, encodeSseEvent('snapshot', { type: 'stats', reason: 'snapshot', stats, at: new Date().toISOString(),
        ...(Number.isSafeInteger(client.streamRevision) ? { revision: client.streamRevision } : {}) }));
      return;
    }

    if (req.method === 'POST' && ['/api/ingest', '/api/ingest/delta', '/api/ingest/compact'].includes(url.pathname)) {
      try {
        const incoming = await readJsonBody(req);
        const compact = url.pathname === '/api/ingest/compact';
        const delta = compact || url.pathname === '/api/ingest/delta';
        const payload = delta ? uploadBaselines.prepare(incoming) : incoming;
        if (compact) {
          const published = getFixedRanges(payload.deviceId);
          const day = payload.periodWindows?.today?.key;
          if (!published || published.observedAt !== payload.updatedAt || !Object.hasOwn(published.ranges, day)) {
            return sendJson(res, 409, { error: 'fixed_range_revision_mismatch' });
          }
        }
        const record = ingestRecord(payload, { historyOnly: compact });
        const upload = !compact && (delta || req.headers[UPLOAD_HEADER] === UPLOAD_VERSION)
          ? uploadBaselines.commit(record.deviceId, stripSessionTextFromDeviceRecord(payload, {
              preserveSessionTitles: acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[record.deviceId], payload.sessionTitleSyncGeneration)
            })) : undefined;
        const response = {
          ok: true, deviceId: record.deviceId,
          ...(req.headers[FIXED_RANGE_HEADER] === FIXED_RANGE_VERSION ? {
            fixedRanges: 1, fixedRangeDelta: 1, fixedRangeBatch: 1, fixedRangeIndexDelta: 1, dailySessionRanges: 1,
            fixedRangeRevision: getFixedRanges(record.deviceId)?.revision ?? null
          } : {}),
          ...(upload ? { upload } : {}),
          ...(!compact && payload.history?.dailyTotalsOmitted > 0 && payload.history.dailyTotalsRevision
            && payload.history.dailyTotalsRevision === record.history?.dailyTotalsRevision
            && record.history.summary?.activeDaysComplete === true
            ? { historyCalendarRetained: true } : {})
        };
        return sendJson(res, 200, wantsMinimalResponse(req) ? response : { ...response, stats: getStats() });
      } catch (error) {
        if (error.status) return sendJson(res, error.status, { error: error.code });
        if (error.message === 'deviceId_required') return sendJson(res, 400, { error: 'deviceId_required' });
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: error.message });
      }
    }

    // Shared, and deliberately behind the same secret gate as every other data
    // route: this is the one place the user records money.
    if (req.method === 'GET' && url.pathname === '/api/subscriptions') {
      return sendJson(res, 200, { ok: true, ...getSubscriptions() });
    }

    if (req.method === 'PUT' && url.pathname === '/api/subscriptions') {
      try {
        const payload = await readJsonBody(req);
        const stored = setSubscriptions(payload?.subscriptions, payload?.baseUpdatedAt);
        return sendJson(res, 200, { ok: true, ...stored });
      } catch (error) {
        if (error.code === 'stale_write') {
          return sendJson(res, 409, { error: 'stale_write', ...error.current });
        }
        if (error.code === 'bad_subscriptions') {
          return sendJson(res, 400, { error: 'bad_request', message: error.message });
        }
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: error.message });
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      deleteDevice(deviceId);
      return sendJson(res, 200, { ok: true, deviceId });
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    res.once('finish', () => {
      // A request can become idle after close() has already swept idle sockets.
      if (stopping) server.closeIdleConnections();
    });
    handleRequest(req, res).catch((error) => {
      (logger.error || console.error)(error);
      sendJson(res, 500, { error: 'internal_error', message: error.message });
    });
  });

  function start() {
    if (stopPromise) return Promise.reject(new Error('Hub is stopping'));
    stopping = false;
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => {
        server.off('error', onError);
        if (persistPending) queuePersist();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, bindHost);
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    const operation = new Promise((resolve, reject) => {
      clearTimeout(persistTimer);
      persistTimer = null;
      if (broadcastTimer) clearTimeout(broadcastTimer);
      broadcastTimer = null;
      for (const client of sseClients) {
        client.cleanup();
        try { client.res.end(); } catch (_) {}
      }
      // Save acknowledged uploads even if another request never finishes.
      // A transient failure still gets a second attempt after draining.
      try { if (persistPending) persist(); } catch (error) {
        (logger.error || console.error)('Hub failed to save before draining requests:', error);
      }
      const deadline = setTimeout(() => server.closeAllConnections(), SHUTDOWN_DRAIN_TIMEOUT_MS);
      deadline.unref();
      server.close((error) => {
        clearTimeout(deadline);
        try {
          // Include uploads whose bodies completed while connections drained.
          if (persistPending) persist();
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    stopPromise = operation.finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return {
    start, stop, server, getStats, getHistory, getDevices, ingest, deleteDevice, onStats, bindHost,
    getSubscriptions, setSubscriptions, getSyncContent, getSyncSettings, setSyncSettings, setSyncTitlePolicy,
    acceptFixedRange, readFixedRange, restoreHistory: payload => ingestRecord(payload, { historyOnly: true })
  };
}

if (require.main === module) {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.persistIntervalMs === true || (typeof args.persistIntervalMs === 'string' && !args.persistIntervalMs.trim())) {
    console.error('Hub failed to start: --persistIntervalMs requires a numeric value');
    process.exit(1);
  }
  const port = Number(args.port || process.env.TOKEN_MONITOR_PORT || 17321);
  const host = String(args.host || process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
  const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
  const staleAfterMs = Number(args.staleAfterMs || process.env.TOKEN_MONITOR_STALE_AFTER_MS || DEFAULT_STALE_AFTER_MS);
  const persistIntervalMs = Number(args.persistIntervalMs ?? process.env.TOKEN_MONITOR_PERSIST_INTERVAL_MS ?? 0);
  const dataFile = String(args.dataFile || process.env.TOKEN_MONITOR_DATA_FILE || path.join(projectRoot(), 'data', 'devices.json'));

  const syncSessionTitles = syncSessionTitlesEnabled(args.syncSessionTitles ?? args['sync-session-titles'] ?? process.env.TOKEN_MONITOR_SYNC_SESSION_TITLES);
  const hub = createHub({ port, host, deployment: 'standalone', secret, staleAfterMs, dataFile, syncSessionTitles, persistIntervalMs });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      hub.stop().catch((error) => {
        console.error(`Hub failed to stop: ${error.message}`);
        process.exitCode = 1;
      });
    });
  }
  hub.start().then(() => {
    console.log(`Token Monitor hub listening on http://${hub.bindHost}:${hub.server.address().port}`);
    console.log(`Data file: ${dataFile}`);
    console.log(`Persistence interval: ${persistIntervalMs}ms`);
    if (!secret) {
      console.warn(`Warning: TOKEN_MONITOR_SECRET is not set, so the hub is bound to ${hub.bindHost} (localhost only) to keep account identity off the network. Set a secret to accept connections from other devices.`);
    }
  }).catch((err) => {
    console.error(`Hub failed to start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createHub, resolveBindHost };
