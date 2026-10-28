import { publicLimits } from './shared/limits/core.js';
import subscriptionDisplay from './shared/subscriptionDisplay.js';
import currency from './shared/currency.js';
import syncContent from './shared/syncContent.js';
import {
  aggregateDevices,
  mergeSyncDeviceRecord,
  aggregateHistory,
  stripSessionTextFromDeviceRecord
} from './shared/usage.js';
import { DEFAULT_STALE_AFTER_MS } from './shared/syncUploadInterval.js';
import { deviceHistoryRevision, historyPreview, historyRevision } from './shared/history.js';
import hubBuildIdentity from './shared/hubBuildIdentity.js';
import hubProtocol from './shared/hubProtocol.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-token-monitor-secret,x-token-monitor-response,x-token-monitor-stream'
};

function jsonResponse(status, payload, extra = {}, request = null) {
  const body = JSON.stringify(payload);
  const shouldCompress = hubProtocol.acceptsEncoding(request, 'gzip')
    && new TextEncoder().encode(body).byteLength >= 1024;
  const responseBody = shouldCompress
    ? new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
    : body;
  return new Response(responseBody, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(shouldCompress ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
      ...CORS_HEADERS,
      ...extra
    },
    ...(shouldCompress ? { encodeBody: 'manual' } : {})
  });
}

function textResponse(status, body, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType, ...CORS_HEADERS } });
}

function requestSecret(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const headerSecret = String(request.headers.get('x-token-monitor-secret') || '').trim();
  if (headerSecret) return headerSecret;
  // Compatibility path for iOS widget runtimes that cannot set Authorization.
  // Prefer a header; do not add this fallback to new first-party clients.
  try {
    const url = new URL(request.url);
    return String(url.searchParams.get('secret') || '').trim();
  } catch (_) { return ''; }
}

// Compare SHA-256 digests rather than the raw strings, so the compare always
// runs over 32 bytes and never leaks the secret's length. Web Crypto's standard
// surface has no timing-safe compare (Cloudflare's crypto.subtle.timingSafeEqual
// is a non-standard extension the Node test runner lacks), hence the XOR loop.
async function timingSafeEqualText(actual, expected) {
  const encoder = new TextEncoder();
  const digest = async (value) => new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(String(value ?? '')))
  );
  const [left, right] = await Promise.all([digest(actual), digest(expected)]);
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

async function isAuthorized(request, expectedSecret) {
  if (!expectedSecret) return true;
  return timingSafeEqualText(requestSecret(request), expectedSecret);
}

const SUBSCRIPTIONS_KEY = 'subscriptions';
const SETTINGS_PREFIX = 'sync-settings:';
const TITLE_POLICY_PREFIX = 'title-policy:';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return textResponse(204, '');
    const id = env.HUB.idFromName('hub');
    const stub = env.HUB.get(id);
    return stub.fetch(request);
  }
};

export class HubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sseClients = new Set();
    this.heartbeatTimer = null;
    this.broadcastTimer = null;
    this.lastSseContentKey = '';
    this.lastSseStats = null;
    this.streamRevision = 0;
    this.sseGeneration = 0;
    this.broadcastTail = Promise.resolve();
    this.pendingBroadcast = null;
    this.broadcasting = false;
    this.encoder = new TextEncoder();
    this.mutationTail = Promise.resolve();
    this.titlePrivacyServerEnabled = null;
    this.titlePrivacyCleanup = null;
    this.ready = this.scheduleTitlePrivacy();
  }

  // Storage awaits allow request interleaving. Every record/policy/config write
  // shares this lane, including startup cleanup and device deletion. The DO
  // input gate also prevents requests from entering during a compound mutation.
  mutate(callback) {
    const operation = this.mutationTail.then(async () => {
      if (!this.state.blockConcurrencyWhile) return callback();
      // Throwing inside the input gate resets the DO. Return expected validation
      // and CAS failures through it, then reject outside without dropping SSE.
      const outcome = await this.state.blockConcurrencyWhile(async () => {
        try { return { value: await callback() }; } catch (error) { return { error }; }
      });
      if (outcome.error) throw outcome.error;
      return outcome.value;
    });
    this.mutationTail = operation.catch(() => {});
    return operation;
  }

  async withStorageTransaction(callback) {
    return this.state.storage.transaction
      ? this.state.storage.transaction(callback)
      : callback(this.state.storage);
  }

  get syncSessionTitles() {
    return syncContent.syncSessionTitlesEnabled(this.env.TOKEN_MONITOR_SYNC_SESSION_TITLES);
  }

  async cleanTitlePrivacy() {
    const enabled = this.syncSessionTitles;
    await this.withStorageTransaction(async (storage) => {
      const policies = await storage.list({ prefix: TITLE_POLICY_PREFIX });
      for (const [key, policy] of policies) {
        if (key.startsWith(TITLE_POLICY_PREFIX) && !enabled && policy?.enabled === true) {
          await storage.put(key, syncContent.nextTitlePolicy(policy, false));
        }
      }
      const devices = await storage.list({ prefix: 'dev:' });
      for (const [key, record] of devices) {
        if (!key.startsWith('dev:')) continue;
        const policy = policies.get(`${TITLE_POLICY_PREFIX}${record.deviceId}`);
        const safe = stripSessionTextFromDeviceRecord(record, {
          preserveSessionTitles: enabled && syncContent.normalizeTitlePolicy(policy).enabled
        });
        if (JSON.stringify(safe) !== JSON.stringify(record)) await storage.put(key, safe);
      }
    });
    this.titlePrivacyServerEnabled = enabled;
  }

  scheduleTitlePrivacy() {
    if (this.titlePrivacyCleanup) return this.titlePrivacyCleanup;
    const operation = this.mutate(async () => {
      // Recheck inside the mutation lane so concurrent readers share one scan.
      if (this.titlePrivacyServerEnabled !== this.syncSessionTitles) await this.cleanTitlePrivacy();
    });
    this.titlePrivacyCleanup = operation;
    const settled = () => { this.titlePrivacyCleanup = null; };
    // Attach the rejection handler immediately, before the first request exists.
    // The original promise still rejects to callers; the next read retries.
    operation.then(settled, settled);
    return operation;
  }

  async ensureTitlePrivacy() {
    while (this.titlePrivacyCleanup || this.titlePrivacyServerEnabled !== this.syncSessionTitles) {
      await this.scheduleTitlePrivacy();
    }
  }

  async getSyncSettings(kind) {
    return await this.state.storage.get(`${SETTINGS_PREFIX}${kind}`) || syncContent.emptySharedSyncDocument();
  }

  async setSyncSettings(kind, payload) {
    return this.mutate(async () => {
      const next = syncContent.nextSharedSyncDocument(kind, await this.getSyncSettings(kind), payload);
      await this.state.storage.put(`${SETTINGS_PREFIX}${kind}`, next);
      return next;
    });
  }

  async setSyncTitlePolicy(deviceId, enabled) {
    let changed = false;
    const policy = await this.mutate(() => this.withStorageTransaction(async (storage) => {
      if (enabled === true && !this.syncSessionTitles) {
        const error = new Error('session title sync is disabled on the server');
        error.code = 'forbidden';
        throw error;
      }
      const key = `${TITLE_POLICY_PREFIX}${deviceId}`;
      const previous = await storage.get(key);
      const next = syncContent.nextTitlePolicy(previous, enabled);
      if (enabled && syncContent.normalizeTitlePolicy(previous).enabled) return next;
      await storage.put(key, next);
      if (!enabled) {
        const record = await storage.get(`dev:${deviceId}`);
        if (record) await storage.put(`dev:${deviceId}`, stripSessionTextFromDeviceRecord(record));
      }
      changed = true;
      return next;
    }));
    // Agents revalidate an enabled policy every minute; that stores nothing, so
    // only a stored change broadcasts, matching the Node Hub.
    if (changed) this.broadcast('sync-titles').catch(() => {});
    return policy;
  }

  get secret() {
    return String(this.env.TOKEN_MONITOR_SECRET || '').trim();
  }

  get staleAfterMs() {
    return Number(this.env.STALE_AFTER_MS || DEFAULT_STALE_AFTER_MS);
  }

  get publicStatsEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(String(this.env.PUBLIC_STATS_ENABLED || '').trim().toLowerCase());
  }

  // Devices live under the `dev:` prefix; the shared subscription document is a
  // single key outside it, so listDevices() never picks it up.
  async getSubscriptions() {
    const stored = await this.state.storage.get(SUBSCRIPTIONS_KEY);
    return stored || subscriptionDisplay.emptySubscriptionDocument();
  }

  async listDevices() {
    await this.ensureTitlePrivacy();
    const entries = await this.state.storage.list({ prefix: 'dev:' });
    return Array.from(entries.values());
  }

  async getStats() {
    const devices = await this.listDevices();
    const stats = aggregateDevices(devices, this.staleAfterMs);
    stats.staleAfterMs = this.staleAfterMs;
    const history = aggregateHistory(devices);
    stats.historyPreview = historyPreview(history);
    stats.historyRevision = historyRevision(history);
    stats.deviceHistoryRevision = deviceHistoryRevision(devices);
    return stats;
  }

  // The version of the shared subscription list, never the list itself. A device
  // compares it against the copy it holds and re-reads only when it has been
  // overtaken, so learning about another device's edit costs nothing in the
  // steady state and does not put what the user pays into every frame.
  //
  // Deliberately not folded into getStats(): /api/public/stats is the one
  // unauthenticated route, it is built by spreading whatever getStats() returns,
  // and the money document is the last thing that should be reached for on that
  // path. Adding it here means the public route neither reads it nor has to
  // remember to drop it back out — every caller below is behind the secret.
  async statsWithSubscriptionVersion() {
    const stats = await this.getStats();
    stats.subscriptionsUpdatedAt = (await this.getSubscriptions())?.updatedAt || '';
    stats.syncSettingsRevisions = Object.fromEntries(await Promise.all(syncContent.SHARED_SYNC_KINDS.map(async (kind) => [kind, (await this.getSyncSettings(kind)).revision])));
    return stats;
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer || this.sseClients.size === 0) return;
    this.heartbeatTimer = setInterval(() => {
      const chunk = this.encoder.encode(': hb\n\n');
      for (const client of this.sseClients) {
        if (!client.busy) this.writeEncoded(client, chunk);
      }
      if (this.sseClients.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }, 30000);
  }

  dropClient(client) {
    this.sseClients.delete(client);
    client.onDrop?.();
    try {
      const stop = client.writer.close;
      Promise.resolve(stop?.call(client.writer)).catch(() => {});
    } catch (_) {}
    if (this.sseClients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sseClients.size === 0) {
      this.lastSseContentKey = '';
      this.lastSseStats = null;
      this.sseGeneration++;
      this.pendingBroadcast?.resolve();
      this.pendingBroadcast = null;
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  writeEncoded(client, chunk) {
    if (!this.sseClients.has(client)) return false;
    if (client.busy) {
      client.needsSnapshot = true;
      return false;
    }
    client.busy = true;
    let write;
    try { write = client.writer.write(chunk); }
    catch (_) { this.dropClient(client); return false; }
    Promise.resolve(write).then(async () => {
      if (!this.sseClients.has(client)) return;
      if (!client.needsSnapshot) { client.busy = false; return; }
      // No queued frames: the pending write plus one dirty bit bounds memory.
      // Keep busy during the read, so a concurrent broadcast cannot overtake it.
      client.needsSnapshot = false;
      client.streamRevision = null;
      const stats = await this.statsWithSubscriptionVersion();
      if (!this.sseClients.has(client)) return;
      client.busy = false;
      this.writeEncoded(client, this.encoder.encode(hubProtocol.encodeSseEvent('stats', {
        type: 'stats', reason: 'snapshot', stats, at: new Date().toISOString(),
        ...(Number.isSafeInteger(client.streamRevision) ? { revision: client.streamRevision } : {})
      })));
    }, () => this.dropClient(client)).catch(() => this.dropClient(client));
    return true;
  }

  fanoutSseFrames(frames) {
    // Reuse the same encoded frame across all subscribers of each kind.
    const chunks = new Map();
    for (const frame of [frames.stats, frames.freshness, frames.delta]) {
      if (frame) chunks.set(frame, this.encoder.encode(frame));
    }
    for (const client of this.sseClients) {
      const chunk = chunks.get(hubProtocol.sseFrameForClient(frames, client));
      if (chunk && this.writeEncoded(client, chunk) && client.deltaEvents) client.streamRevision = frames.revision;
    }
  }

  publishStats(reason, allowFreshness) {
    // One active read and one pending batch, shared by all waiting updates.
    // A later ingest must not downgrade an explicit mutation's full snapshot.
    if (this.pendingBroadcast) {
      if (!allowFreshness) Object.assign(this.pendingBroadcast, { reason, allowFreshness: false });
      return this.pendingBroadcast.promise;
    }
    const batch = { reason, allowFreshness, generation: this.sseGeneration };
    batch.promise = new Promise((resolve, reject) => Object.assign(batch, { resolve, reject }));
    this.pendingBroadcast = batch;
    this.broadcastTail = batch.promise.catch(() => {});
    this.state.waitUntil?.(this.broadcastTail);
    if (!this.broadcasting) {
      this.broadcasting = true;
      void this.drainBroadcasts();
    }
    return batch.promise;
  }

  async drainBroadcasts() {
    while (this.pendingBroadcast) {
      const batch = this.pendingBroadcast;
      this.pendingBroadcast = null;
      try {
        if (this.sseClients.size && batch.generation === this.sseGeneration) {
          const stats = await this.statsWithSubscriptionVersion();
          if (this.sseClients.size && batch.generation === this.sseGeneration) {
            const frames = hubProtocol.prepareSseFanout({
              reason: batch.reason, stats, at: new Date().toISOString(),
              lastContentKey: this.lastSseContentKey,
              previousStats: this.lastSseStats,
              revision: ++this.streamRevision,
              ...hubProtocol.sseClientKinds(this.sseClients), allowFreshness: batch.allowFreshness
            });
            this.lastSseContentKey = frames.contentKey;
            this.lastSseStats = stats;
            this.fanoutSseFrames(frames);
          }
        }
        batch.resolve();
      } catch (error) { batch.reject(error); }
    }
    this.broadcasting = false;
  }

  broadcast(reason = 'update') {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    return this.publishStats(reason, false);
  }

  flushBroadcast() {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    return this.publishStats('ingest', true);
  }

  queueBroadcast() {
    if (this.sseClients.size === 0 || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      void this.flushBroadcast().catch(() => {});
    }, 100);
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureTitlePrivacy();

    if (url.pathname === '/api/health') {
      const devices = await this.listDevices();
      return jsonResponse(200, {
        ok: true,
        role: 'hub',
        runtime: 'cloudflare-worker',
        version: 1,
        hubBuild: hubBuildIdentity.currentHubBuild('cloudflare-worker'),
        deviceCount: devices.length,
        secretRequired: Boolean(this.secret),
        now: new Date().toISOString()
      }, {}, request);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/public/stats') {
      if (!this.publicStatsEnabled) return jsonResponse(404, { error: 'not_found' });
      const stats = await this.getStats();
      const { devices, limits, periods, ...rest } = stats;
      delete rest.deviceHistoryRevision;
      return jsonResponse(200, {
        ok: true,
        source: 'cloudflare-worker',
        deviceCount: devices.length,
        limits: publicLimits(limits),
        periods: publicPeriods(periods),
        ...rest
      }, { 'cache-control': 'public, max-age=15, s-maxage=15' }, request);
    }

    // A Worker is an internet-facing URL with no trusted-LAN fallback, so it must
    // never serve data unauthenticated. Without a secret every data route is refused
    // (health and the opt-in, already-scrubbed /api/public/stats are handled above).
    if (!this.secret) {
      return jsonResponse(503, { error: 'secret_required', message: 'TOKEN_MONITOR_SECRET must be set on the worker; unauthenticated access is refused.' });
    }
    if (!(await isAuthorized(request, this.secret))) return jsonResponse(401, { error: 'unauthorized' });

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/sync/content') {
      return jsonResponse(200, syncContent.syncContentCapability(this.syncSessionTitles));
    }
    const settingsMatch = url.pathname.match(/^\/api\/sync\/settings\/(modelAliases|customPricing)$/);
    if (settingsMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return jsonResponse(200, { ok: true, ...(await this.getSyncSettings(settingsMatch[1])) });
    }
    const titlesMatch = url.pathname.match(/^\/api\/sync\/titles\/([^/]+)$/);
    if (request.method === 'PUT' && (settingsMatch || titlesMatch)) {
      try {
        const payload = await request.json();
        if (settingsMatch) {
          const next = await this.setSyncSettings(settingsMatch[1], payload);
          this.broadcast('sync-settings').catch(() => {});
          return jsonResponse(200, { ok: true, ...next });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => key !== 'enabled') || typeof payload.enabled !== 'boolean') {
          return jsonResponse(400, { error: 'bad_request', message: 'enabled must be a boolean' });
        }
        const policy = await this.setSyncTitlePolicy(decodeURIComponent(titlesMatch[1]), payload.enabled);
        return jsonResponse(200, { ok: true, ...policy });
      } catch (error) {
        if (error.code === 'stale_write') return jsonResponse(409, { error: 'stale_write', ...error.current });
        if (error.code === 'forbidden') return jsonResponse(403, { error: 'forbidden', message: error.message });
        return jsonResponse(400, { error: 'bad_request', message: error.message });
      }
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/stats') {
      return jsonResponse(200, await this.statsWithSubscriptionVersion(), {}, request);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/devices') {
      const devices = await this.listDevices();
      return jsonResponse(200, { devices }, {}, request);
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/history') {
      const devices = await this.listDevices();
      return jsonResponse(200, aggregateHistory(devices), {}, request);
    }

    if (request.method === 'GET' && url.pathname === '/api/stats/stream') {
      const stats = await this.statsWithSubscriptionVersion();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const client = {
        writer, freshnessEvents: hubProtocol.wantsFreshnessEvents(request),
        deltaEvents: hubProtocol.wantsDeltaEvents(request), streamRevision: null
      };
      if (this.sseClients.size === 0) {
        this.lastSseContentKey = hubProtocol.hubStatsContentKey(stats);
        this.lastSseStats = stats;
        if (client.deltaEvents) client.streamRevision = this.streamRevision;
      }
      this.sseClients.add(client);
      this.writeEncoded(client, this.encoder.encode(hubProtocol.encodeSseEvent('snapshot', {
        type: 'stats', reason: 'snapshot', stats, at: new Date().toISOString(),
        ...(Number.isSafeInteger(client.streamRevision) ? { revision: client.streamRevision } : {})
      })));
      this.ensureHeartbeat();
      const onAbort = () => this.dropClient(client);
      request.signal.addEventListener('abort', onAbort, { once: true });
      client.onDrop = () => request.signal.removeEventListener('abort', onAbort);
      if (request.signal.aborted) this.dropClient(client);
      return new Response(readable, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
          ...CORS_HEADERS
        }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/ingest') {
      let payload;
      try { payload = await request.json(); }
      catch (error) { return jsonResponse(400, { error: 'bad_request', message: error.message }); }
      if (!payload || (!payload.deviceId && !payload.id)) return jsonResponse(400, { error: 'deviceId_required' });
      const deviceId = String(payload.deviceId || payload.id);
      const record = await this.mutate(async () => {
        const policy = await this.state.storage.get(`${TITLE_POLICY_PREFIX}${deviceId}`);
        const existing = await this.state.storage.get(`dev:${deviceId}`);
        const next = mergeSyncDeviceRecord(existing, { ...payload, receivedAt: new Date().toISOString() }, {
          preserveSessionTitles: syncContent.acceptsSessionTitles(this.syncSessionTitles, policy, payload.sessionTitleSyncGeneration)
        });
        await this.state.storage.put(`dev:${next.deviceId}`, next);
        return next;
      });
      this.queueBroadcast();
      const response = { ok: true, deviceId: record.deviceId };
      return jsonResponse(
        200,
        hubProtocol.wantsMinimalResponse(request)
          ? response
          : { ...response, stats: await this.statsWithSubscriptionVersion() },
        {},
        request
      );
    }

    // Shared by every device on this hub rather than owned by one of them, and
    // behind the same secret gate as every other data route: this is the one
    // place the user records money. It is never part of /api/public/stats, which
    // is built from device records alone.
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/subscriptions') {
      return jsonResponse(200, { ok: true, ...(await this.getSubscriptions()) });
    }

    if (request.method === 'PUT' && url.pathname === '/api/subscriptions') {
      let payload;
      try { payload = await request.json(); }
      catch (error) { return jsonResponse(400, { error: 'bad_request', message: error.message }); }
      // A non-array would normalize to an empty list and store as a perfectly
      // successful replacement, wiping records that exist nowhere else. An
      // intentional clear still sends [].
      if (!Array.isArray(payload?.subscriptions)) {
        return jsonResponse(400, { error: 'bad_request', message: 'subscriptions must be an array' });
      }
      const result = await this.mutate(async () => {
        const stored = await this.getSubscriptions();
        // Staleness first, matching the Node hub: a stale write is exactly the case
        // where the client needs the stored document back to re-base, and answering
        // 400 for a request that is both stale and malformed would withhold it.
        if (subscriptionDisplay.isStaleSubscriptionWrite(stored, payload?.baseUpdatedAt)) {
          return jsonResponse(409, { error: 'stale_write', ...stored });
        }
        // A currency with no exchange rate would be coerced to USD and reported as
        // an amount the user never entered.
        const unsupported = payload.subscriptions.find(
          (entry) => entry?.currency && !currency.CURRENCY_CODES.includes(String(entry.currency).trim().toUpperCase())
        );
        if (unsupported) {
          return jsonResponse(400, {
            error: 'bad_request',
            message: `unsupported currency: ${String(unsupported.currency).trim().toUpperCase()}`
          });
        }
        const next = subscriptionDisplay.subscriptionDocument(payload.subscriptions, {
          previousUpdatedAt: stored?.updatedAt,
          currencyApi: { normalizeCurrency: currency.normalizeCurrency }
        });
        await this.state.storage.put(SUBSCRIPTIONS_KEY, next);
        // Same reason ingest broadcasts: the other devices are holding a copy that
        // has just been overtaken, and without this they only find out on their
        // next poll — which is five minutes apart while the stream is up.
        return { next };
      });
      if (result instanceof Response) return result;
      const { next } = result;
      this.broadcast('subscriptions').catch(() => {});
      return jsonResponse(200, { ok: true, ...next });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      await this.mutate(() => this.withStorageTransaction(async (storage) => {
        const key = `${TITLE_POLICY_PREFIX}${deviceId}`;
        await storage.put(key, syncContent.nextTitlePolicy(await storage.get(key), false));
        await storage.delete(`dev:${deviceId}`);
      }));
      this.broadcast('delete').catch(() => {});
      return jsonResponse(200, { ok: true, deviceId });
    }

    return jsonResponse(404, { error: 'not_found' });
  }
}

function publicPeriods(periods) {
  return Object.fromEntries(Object.entries(periods || {}).map(([name, period]) => {
    const safePeriod = { ...(period || {}) };
    delete safePeriod.projects;
    return [name, {
      ...safePeriod,
      sessions: Object.fromEntries(Object.entries(period?.sessions || {}).map(([key, session]) => {
      const {
        projectId, projectLabel, projectPath,
        title, sessionTitle, session_title, name, preview, firstUserMessage, first_user_message,
        customTitle, custom_title, aiTitle, ai_title,
        ...safe
      } = session;
      return [key, safe];
      }))
    }];
  }));
}

export { publicPeriods };
