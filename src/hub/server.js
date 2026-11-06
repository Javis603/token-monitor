'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { UPLOAD_HEADER, UPLOAD_VERSION, createUploadBaselines } = require('../shared/uploadDelta');
const {
  aggregateDevices,
  mergeSyncDeviceRecord,
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
  encodeSseEvent,
  prepareSseFanout,
  sseClientKinds,
  sseFrameForClient,
  hubStatsContentKey,
  wantsFreshnessEvents,
  wantsDeltaEvents,
  wantsMinimalResponse
} = require('../shared/hubProtocol');
const { readJsonBody, requestSecret, sendJson, sendText, timingSafeEqualText } = require('../shared/http');
const { loadDotEnv, parseArgs, projectRoot, readJson, writeJsonAtomic } = require('../shared/config');
const { createLanAdvertiser, lanIpv4Addresses } = require('./lanDiscovery');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

// Mobile devices pair with a short-lived code and receive a revocable,
// read-only bearer token instead of the hub's admin secret. Keeping this
// boundary inside the Node hub means the Worker stays exactly as it was.
const HUB_LINK_TTL_MS = 300000;
const HUB_LINK_MAX_ATTEMPTS = 8;
const LINK_LAST_SEEN_PERSIST_MS = 300000;
const PAIR_LINK_SCHEME = 'tokenmonitor://pair';
const HUB_ID_PATTERN = /^[a-f0-9]{16}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const DEVICE_PLATFORM_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const DEVICE_READ_PATHS = new Set(['/api/stats', '/api/history', '/api/link']);

function sanitizeHubName(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 60) || 'Token Monitor';
}

// Derive the identity from the data file location and hostname so it survives
// restarts even before the store has been written for the first time (the
// existing persistence contract deliberately does not create the file until
// there is data). The value is persisted on the first write and then wins, so
// moving the data file later does not change the identity.
function deriveHubId(dataFile) {
  return crypto.createHash('sha256')
    .update(`token-monitor-hub-v1\u0000${path.resolve(String(dataFile || ''))}\u0000${os.hostname()}`)
    .digest('hex')
    .slice(0, 16);
}

function hubLinkTokenHash(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function parseDiscoveryFlag(value) {
  if (value === true || value === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function publicLinkRecord(link) {
  return {
    id: link.id,
    name: link.name,
    platform: link.platform,
    createdAt: link.createdAt,
    lastSeenAt: link.lastSeenAt || null
  };
}

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
  host = '0.0.0.0',
  secret = '',
  syncSessionTitles = false,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  broadcastDelayMs = 100,
  persistIntervalMs = 0,
  dataFile = path.join(projectRoot(), 'data', 'devices.json'),
  hubName = '',
  discovery = false,
  pairingTtlMs = HUB_LINK_TTL_MS,
  pairingMaxAttempts = HUB_LINK_MAX_ATTEMPTS,
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
  if (!HUB_ID_PATTERN.test(String(store.hubId || ''))) store.hubId = deriveHubId(dataFile);
  store.hubName = sanitizeHubName(store.hubName || hubName || os.hostname());
  store.links = Object.assign(Object.create(null), store.links || {});
  let pairing = null;
  let advertiser = null;
  let listeningPort = null;
  const linkSeenAt = new Map();
  const bindHost = resolveBindHost(host, secret);
  const uploadBaselines = createUploadBaselines();
  let persistTimer = null;
  let persistPending = false;
  let stopping = false;
  let stopPromise = null;

  // Apply the permission at startup, including records from offline devices.
  // Keep disabled policies as tombstones so re-enabling cannot reuse old tokens.
  const beforeCleanup = JSON.stringify([store.devices, store.syncTitlePolicies]);
  for (const [id, policy] of Object.entries(store.syncTitlePolicies)) {
    if (!serverTitlesEnabled && policy?.enabled === true) store.syncTitlePolicies[id] = nextTitlePolicy(policy, false);
  }
  for (const [id, record] of Object.entries(store.devices)) {
    store.devices[id] = stripSessionTextFromDeviceRecord(record, {
      preserveSessionTitles: serverTitlesEnabled && normalizeTitlePolicy(store.syncTitlePolicies[id]).enabled
    });
  }
  if (JSON.stringify([store.devices, store.syncTitlePolicies]) !== beforeCleanup) persist();

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
    return Object.values(store.devices);
  }

  const sseClients = new Set();
  const statsListeners = new Set();
  let broadcastTimer = null;
  let lastSseContentKey = '';
  let lastSseStats = null;
  let streamRevision = 0;

  function writeSseFrame(client, frame) {
    if (!frame) return false;
    if (client.blocked) {
      client.needsSnapshot = true;
      return false;
    }
    try {
      if (client.res.write(frame) === false) {
        client.blocked = true;
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

  function ingestRecord(payload) {
    if (!payload || (!payload.deviceId && !payload.id)) {
      throw new Error('deviceId_required');
    }
    const deviceId = String(payload.deviceId || payload.id);
    uploadBaselines.forget(deviceId);
    const record = mergeSyncDeviceRecord(store.devices[deviceId], { ...payload, receivedAt: new Date().toISOString() }, {
      preserveSessionTitles: acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[deviceId], payload.sessionTitleSyncGeneration)
    });
    store.devices[record.deviceId] = record;
    queuePersist();
    if (statsListeners.size > 0) notifyStatsListeners('ingest');
    queueStatsBroadcast();
    return record;
  }

  function deleteDevice(deviceId) {
    uploadBaselines.forget(deviceId);
    // Commit deletion and revocation together, keeping a generation tombstone.
    const previousPolicy = store.syncTitlePolicies[deviceId];
    const previousDevice = store.devices[deviceId];
    const previousSavedAt = store.savedAt;
    store.syncTitlePolicies[deviceId] = nextTitlePolicy(previousPolicy, false);
    delete store.devices[deviceId];
    try { persist(); } catch (error) {
      if (previousPolicy) store.syncTitlePolicies[deviceId] = previousPolicy;
      else delete store.syncTitlePolicies[deviceId];
      if (previousDevice) store.devices[deviceId] = previousDevice;
      store.savedAt = previousSavedAt;
      throw error;
    }
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
    const previousSavedAt = store.savedAt;
    store.syncTitlePolicies[deviceId] = next;
    if (!enabled && previousDevice) store.devices[deviceId] = stripSessionTextFromDeviceRecord(previousDevice);
    try { persist(); } catch (error) {
      if (previous) store.syncTitlePolicies[deviceId] = previous;
      else delete store.syncTitlePolicies[deviceId];
      if (previousDevice) store.devices[deviceId] = previousDevice;
      store.savedAt = previousSavedAt;
      throw error;
    }
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

  function hubPort() {
    return Number.isInteger(listeningPort) && listeningPort > 0 ? listeningPort : port;
  }

  function hubAddresses() {
    const addresses = lanIpv4Addresses().map((entry) => entry.address);
    // A hub bound to one interface is only reachable there; do not advertise
    // the machine's other addresses, which would send clients to a dead port.
    if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::' && /^\d+\.\d+\.\d+\.\d+$/.test(bindHost)) {
      return [bindHost];
    }
    return addresses;
  }

  function getHubIdentity() {
    return { id: store.hubId, name: store.hubName, port: hubPort(), addresses: hubAddresses() };
  }

  function pairLink(code) {
    const identity = getHubIdentity();
    // encodeURIComponent, not URLSearchParams: the latter form-encodes spaces
    // as "+", which phone URL parsers may not decode back into a space.
    const entries = [
      ['v', '1'],
      ['id', identity.id],
      ['name', identity.name],
      ['code', code],
      ['port', String(identity.port)]
    ];
    if (identity.addresses.length > 0) {
      entries.push(['host', identity.addresses[0]]);
      entries.push(['addrs', identity.addresses.map((address) => `${address}:${identity.port}`).join(',')]);
    }
    return `${PAIR_LINK_SCHEME}?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
  }

  function pairingStatus() {
    if (pairing && pairing.expiresAt <= Date.now()) pairing = null;
    if (!pairing) return { active: false };
    return { active: true, code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() };
  }

  function startPairing() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    // A short TTL is only safer; the cap keeps a session from outliving the
    // desktop UI that shows it.
    const ttlMs = Math.max(1, Math.min(Number(pairingTtlMs) || HUB_LINK_TTL_MS, 900000));
    pairing = { code, expiresAt: Date.now() + ttlMs, attempts: 0 };
    return { code, expiresAt: new Date(pairing.expiresAt).toISOString(), ttlMs, link: pairLink(code), hub: getHubIdentity() };
  }

  function cancelPairing() {
    const active = Boolean(pairing);
    pairing = null;
    return active;
  }

  function getLinks() {
    return Object.values(store.links)
      .map(publicLinkRecord)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function touchLink(link) {
    link.lastSeenAt = new Date().toISOString();
    const persisted = linkSeenAt.get(link.id) || 0;
    if (Date.now() - persisted < LINK_LAST_SEEN_PERSIST_MS) return;
    linkSeenAt.set(link.id, Date.now());
    try { queuePersist(); } catch (error) {
      (logger.warn || console.warn)('Hub failed to persist link activity:', error.message);
    }
  }

  function closeLinkStreams(linkId) {
    for (const client of Array.from(sseClients)) {
      if (!client.linkId || client.linkId !== linkId) continue;
      client.cleanup();
      try { client.res.end(); } catch (_) {}
    }
  }

  function authorizeRequest(req) {
    if (!secret) return { ok: true, role: 'admin', linkId: null };
    const presented = requestSecret(req);
    if (!presented) return { ok: false };
    if (timingSafeEqualText(presented, secret)) return { ok: true, role: 'admin', linkId: null };
    const presentedHash = hubLinkTokenHash(presented);
    for (const link of Object.values(store.links)) {
      if (!link?.tokenHash) continue;
      if (!timingSafeEqualText(presentedHash, link.tokenHash)) continue;
      touchLink(link);
      return { ok: true, role: 'device', linkId: link.id };
    }
    return { ok: false };
  }

  function deviceCanRead(req, pathname) {
    if (req.method !== 'GET') return false;
    if (pathname === '/api/stats/stream') return true;
    return DEVICE_READ_PATHS.has(pathname);
  }

  function pairDevice(payload) {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const deviceId = String(body.deviceId ?? '').trim();
    const deviceName = String(body.deviceName ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const platform = String(body.platform ?? '').trim().toLowerCase();
    const code = String(body.code ?? '').trim();
    if (!DEVICE_ID_PATTERN.test(deviceId)) return { error: 'bad_request', field: 'deviceId' };
    if (!deviceName) return { error: 'bad_request', field: 'deviceName' };
    if (!DEVICE_PLATFORM_PATTERN.test(platform)) return { error: 'bad_request', field: 'platform' };
    if (!/^\d{6}$/.test(code)) return { error: 'bad_request', field: 'code' };
    if (!pairing) return { error: 'pairing_inactive' };
    if (pairing.expiresAt <= Date.now()) {
      pairing = null;
      return { error: 'pairing_expired' };
    }
    const maxAttempts = Math.max(1, Math.min(Number(pairingMaxAttempts) || HUB_LINK_MAX_ATTEMPTS, 100));
    if (pairing.attempts >= maxAttempts) {
      pairing = null;
      return { error: 'pairing_locked' };
    }
    if (!timingSafeEqualText(code, pairing.code)) {
      pairing.attempts += 1;
      if (pairing.attempts >= maxAttempts) {
        pairing = null;
        return { error: 'pairing_locked' };
      }
      return { error: 'invalid_code', attemptsRemaining: maxAttempts - pairing.attempts };
    }
    const token = `tmk_${crypto.randomBytes(32).toString('base64url')}`;
    const link = {
      id: deviceId,
      name: deviceName,
      platform,
      tokenHash: hubLinkTokenHash(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null
    };
    const previous = store.links[deviceId];
    const previousSavedAt = store.savedAt;
    store.links[deviceId] = link;
    try {
      persist();
    } catch (error) {
      if (previous) store.links[deviceId] = previous;
      else delete store.links[deviceId];
      store.savedAt = previousSavedAt;
      (logger.error || console.error)('Hub failed to save a paired device:', error.message);
      return { error: 'storage_failed' };
    }
    pairing = null;
    linkSeenAt.delete(deviceId);
    closeLinkStreams(deviceId);
    return { token, link, hub: getHubIdentity() };
  }

  function revokeLink(id) {
    const key = String(id ?? '');
    const link = store.links[key];
    if (!link) return false;
    const previousSavedAt = store.savedAt;
    delete store.links[key];
    try {
      persist();
    } catch (error) {
      store.links[key] = link;
      store.savedAt = previousSavedAt;
      throw error;
    }
    linkSeenAt.delete(key);
    closeLinkStreams(key);
    return true;
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
        version: store.version || 1,
        hubBuild: currentHubBuild('node-hub'),
        hubId: store.hubId,
        hubName: store.hubName,
        deviceCount: Object.keys(store.devices).length,
        secretRequired: Boolean(secret),
        now: new Date().toISOString()
      });
    }

    // Pairing is the only unauthenticated write: a device that has never seen
    // this hub cannot hold its secret yet. The 6-digit code is generated by an
    // authenticated client, single-use, short-lived and attempt-capped.
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        if (error.code === 'payload_too_large') {
          res.shouldKeepAlive = false;
          return sendJson(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
        }
        return sendJson(res, 400, { error: 'bad_request', message: 'invalid JSON body' });
      }
      const result = pairDevice(payload);
      if (result.error === 'bad_request') return sendJson(res, 400, { error: 'bad_request', field: result.field });
      if (result.error === 'pairing_inactive') return sendJson(res, 404, { error: 'pairing_inactive' });
      if (result.error === 'pairing_expired') return sendJson(res, 410, { error: 'pairing_expired' });
      if (result.error === 'invalid_code') return sendJson(res, 401, { error: 'invalid_code', attemptsRemaining: result.attemptsRemaining });
      if (result.error === 'pairing_locked') return sendJson(res, 429, { error: 'pairing_locked' });
      if (result.error === 'storage_failed') return sendJson(res, 500, { error: 'storage_failed' });
      return sendJson(res, 200, {
        ok: true,
        token: result.token,
        hub: result.hub,
        device: { id: result.link.id, name: result.link.name }
      });
    }

    const auth = authorizeRequest(req);
    if (!auth.ok) return sendJson(res, 401, { error: 'unauthorized' });
    if (auth.role === 'device' && !deviceCanRead(req, url.pathname)) {
      return sendJson(res, 403, { error: 'read_only' });
    }

    if (req.method === 'POST' && url.pathname === '/api/pair/start') {
      const session = startPairing();
      const { hub, ...pairingSession } = session;
      return sendJson(res, 200, { ok: true, pairing: pairingSession, hub });
    }

    if (req.method === 'GET' && url.pathname === '/api/pair/status') {
      return sendJson(res, 200, { ok: true, pairing: pairingStatus() });
    }

    if (req.method === 'POST' && url.pathname === '/api/pair/cancel') {
      return sendJson(res, 200, { ok: true, cancelled: cancelPairing() });
    }

    if (req.method === 'GET' && url.pathname === '/api/link') {
      const link = auth.role === 'device' ? publicLinkRecord(store.links[auth.linkId]) : null;
      return sendJson(res, 200, { ok: true, hub: getHubIdentity(), role: auth.role, link });
    }

    if (req.method === 'GET' && url.pathname === '/api/links') {
      return sendJson(res, 200, { ok: true, links: getLinks() });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/links/')) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/links/'.length));
      let revoked;
      try {
        revoked = revokeLink(deviceId);
      } catch (error) {
        (logger.error || console.error)('Hub failed to revoke a linked device:', error.message);
        return sendJson(res, 500, { error: 'storage_failed' });
      }
      if (!revoked) return sendJson(res, 404, { error: 'unknown_link' });
      return sendJson(res, 200, { ok: true, id: deviceId });
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/content') return sendJson(res, 200, getSyncContent());

    const settingsMatch = url.pathname.match(/^\/api\/sync\/settings\/(modelAliases|customPricing)$/);
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
      const client = {
        res,
        freshnessEvents: wantsFreshnessEvents(req),
        deltaEvents: wantsDeltaEvents(req),
        streamRevision: null,
        blocked: false,
        needsSnapshot: false,
        linkId: auth.role === 'device' ? auth.linkId : null
      };
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
        // A skipped frame invalidates both freshness and delta baselines.
        client.streamRevision = null;
        try {
          writeSseFrame(client, encodeSseEvent('stats', {
            type: 'stats', reason: 'snapshot', stats: getStats(), at: new Date().toISOString()
          }));
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

    if (req.method === 'POST' && ['/api/ingest', '/api/ingest/delta'].includes(url.pathname)) {
      try {
        const incoming = await readJsonBody(req);
        const delta = url.pathname === '/api/ingest/delta';
        const payload = delta ? uploadBaselines.prepare(incoming) : incoming;
        const record = ingestRecord(payload);
        const upload = delta || req.headers[UPLOAD_HEADER] === UPLOAD_VERSION
          ? uploadBaselines.commit(record.deviceId, stripSessionTextFromDeviceRecord(payload, {
              preserveSessionTitles: acceptsSessionTitles(serverTitlesEnabled, store.syncTitlePolicies[record.deviceId], payload.sessionTitleSyncGeneration)
            })) : undefined;
        const response = { ok: true, deviceId: record.deviceId, ...(upload ? { upload } : {}) };
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
        const address = server.address();
        listeningPort = address && typeof address === 'object' && address.port ? address.port : port;
        if (discovery && secret && !LOOPBACK_HOSTS.has(String(bindHost).toLowerCase())) {
          try {
            advertiser = createLanAdvertiser({
              hubId: store.hubId,
              hubName: store.hubName,
              port: listeningPort,
              logger
            });
            advertiser.start();
          } catch (error) {
            advertiser = null;
            (logger.warn || console.warn)('Hub LAN discovery unavailable:', error.message);
          }
        }
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
      if (advertiser) {
        advertiser.stop();
        advertiser = null;
      }
      listeningPort = null;
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
    hubId: store.hubId,
    hubName: store.hubName,
    getHubIdentity,
    startPairing,
    cancelPairing,
    pairingStatus,
    getPairingLink: () => (pairing ? pairLink(pairing.code) : null),
    getLinks,
    revokeLink
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
  const hubName = String(args.hubName || args['hub-name'] || process.env.TOKEN_MONITOR_HUB_NAME || '').trim();
  const discovery = parseDiscoveryFlag(
    args.discovery !== undefined
      ? args.discovery
      : args['no-discovery'] !== undefined
        ? '0'
        : (process.env.TOKEN_MONITOR_DISCOVERY ?? '1')
  );
  const hub = createHub({ port, host, secret, staleAfterMs, dataFile, syncSessionTitles, persistIntervalMs, hubName, discovery });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      hub.stop().catch((error) => {
        console.error(`Hub failed to stop: ${error.message}`);
        process.exitCode = 1;
      });
    });
  }
  hub.start().then(() => {
    console.log(`Token Monitor hub listening on http://${hub.bindHost}:${port}`);
    console.log(`Data file: ${dataFile}`);
    console.log(`Persistence interval: ${persistIntervalMs}ms`);
    console.log(`Hub identity: ${hub.hubId} (${hub.hubName}); LAN discovery ${discovery ? 'enabled' : 'disabled'}`);
    if (!secret) {
      console.warn(`Warning: TOKEN_MONITOR_SECRET is not set, so the hub is bound to ${hub.bindHost} (localhost only) to keep account identity off the network. Set a secret to accept connections from other devices.`);
    }
  }).catch((err) => {
    console.error(`Hub failed to start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createHub, resolveBindHost };
