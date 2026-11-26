import uploadDelta from './shared/uploadDelta.js';
import fixedRangeUploads from './shared/fixedRangeUploads.js';
import { FIXED_RANGE_HEADER, FIXED_RANGE_VERSION, legacyFixedRangeView, rangesMatchDeviceDay, redactDailyRangeSnapshot, removedPagedClients, restorePagedClientSessions } from './shared/fixedRangeSync.js';
import { publicLimits } from './shared/limits/core.js';
import subscriptionDisplay from './shared/subscriptionDisplay.js';
import currency from './shared/currency.js';
import syncContent from './shared/syncContent.js';
import {
  aggregateDevices,
  mergeSyncDeviceRecord, restoreDeviceHistory,
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
  'access-control-allow-headers': 'authorization,content-type,x-token-monitor-secret,x-token-monitor-response,x-token-monitor-stream,x-token-monitor-upload,x-token-monitor-fixed-ranges'
};

// SQLite Durable Object storage allows 8 MB for the key and its value. Keep
// headroom for the serializer's per-value overhead.
const MAX_DEVICE_STORAGE_BYTES = 7 * 1024 * 1024;

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

// Bound full and delta ingest bytes before JSON materialization, including
// requests without Content-Length.
async function readIngestJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return JSON.parse('');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > uploadDelta.MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('payload_too_large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
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

function fixedRangePageKey(deviceId, revision, page) {
  return `fixedRangePage:${encodeURIComponent(deviceId)}:${revision}:${page}`;
}

export class HubDO {
  constructor(state, env) {
    this.state = state;
    this.uploadBaselines = uploadDelta.createUploadBaselines();
    this.fixedRangeUploads = fixedRangeUploads.createFixedRangeUploads();
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

  async clearFixedRanges(storage, deviceId, index) {
    if (this.legacyRangeView?.deviceId === deviceId) this.legacyRangeView = null;
    if (!index) return;
    for (let page = 0; page < index.pageCount; page++) {
      await storage.delete(fixedRangePageKey(deviceId, index.revision, page));
    }
  }

  async revokeFixedRangeTitles(storage, id, index, record) {
    const key = `fixedRanges:${id}`;
    const revisionKey = `fixedRangeRevision:${id}`;
    const day = record?.periodWindows?.today?.key;
    let safe;
    if (day && Object.hasOwn(index.ranges || {}, day)) {
      const pages = await Promise.all(Array.from({ length: index.pageCount }, (_, page) =>
        storage.get(fixedRangePageKey(id, index.revision, page))));
      if (pages.every(Array.isArray)) safe = redactDailyRangeSnapshot({ ...index, pages }, day);
    }
    await this.clearFixedRanges(storage, id, index);
    if (!safe) {
      await storage.put(key, fixedRangeUploads.retireFixedRangeSnapshot(index));
      await storage.delete(revisionKey);
      return;
    }
    const { pages, ...metadata } = safe;
    for (const [page, rows] of pages.entries()) await storage.put(fixedRangePageKey(id, metadata.revision, page), rows);
    await storage.put(key, metadata);
    await storage.put(revisionKey, { observedAt: metadata.observedAt, revision: metadata.revision, day, daily: true });
  }

  async handleFixedRanges(request, url) {
    const deviceId = url.searchParams.get('deviceId') || '';
    if (!deviceId) return jsonResponse(400, { error: 'deviceId_required' });
    const key = `fixedRanges:${deviceId}`;
    if (request.method === 'PUT') {
      let payload;
      try { payload = await readIngestJson(request); }
      catch (error) { return jsonResponse(error.status === 413 ? 413 : 400, { error: 'bad_fixed_range_page' }); }
      const result = await this.mutate(() => this.withStorageTransaction(async (storage) => {
        const pages = fixedRangeUploads.fixedRangeRequestPages(payload);
        if (!pages) return jsonResponse(400, { error: 'bad_fixed_range_page' });
        const device = await storage.get(`dev:${deviceId}`);
        const policy = await storage.get(`${TITLE_POLICY_PREFIX}${deviceId}`);
        const preserveTitles = syncContent.acceptsSessionTitles(this.syncSessionTitles, policy, pages[0]?.sessionTitleSyncGeneration);
        const previous = await storage.get(key);
        let accepted;
        for (const page of pages) {
          let published = previous;
          if (previous && previous.revision === page?.revision && Number.isInteger(page.page) && page.page >= 0) {
            const rows = previous.pageCount === 0 && page.page === 0 ? []
              : page.page < previous.pageCount
                ? await storage.get(fixedRangePageKey(deviceId, previous.revision, page.page)) : undefined;
            published = { ...previous, rows };
          } else if (previous?.revision && previous.revision === page?.delta?.baseRevision
            && Number.isSafeInteger(page.delta.basePage) && page.delta.basePage >= 0
            && page.delta.basePage < previous.pageCount) {
            const baseRows = await storage.get(fixedRangePageKey(deviceId, previous.revision, page.delta.basePage));
            published = { ...previous, baseRows };
          }
          accepted = this.fixedRangeUploads.accept(deviceId, page, device, preserveTitles, published);
          if (accepted.status !== 200) return jsonResponse(accepted.status, {
            error: accepted.status === 409 ? 'fixed_range_revision_mismatch' : 'bad_fixed_range_page'
          });
        }
        const { complete, snapshot } = accepted;
        if (snapshot) {
          const { pages, ...index } = snapshot;
          for (const [page, rows] of pages.entries()) {
            await storage.put(fixedRangePageKey(deviceId, index.revision, page), rows);
          }
          await storage.put(key, { ...index, pageCount: pages.length });
          const day = device.periodWindows.today.key;
          await storage.put(`fixedRangeRevision:${deviceId}`, {
            observedAt: index.observedAt, revision: index.revision, day, daily: Object.hasOwn(index.ranges, day)
          });
          if (previous?.revision !== index.revision) await this.clearFixedRanges(storage, deviceId, previous);
        }
        return jsonResponse(200, { complete });
      }));
      if (result.ok && (await result.clone().json()).complete) this.queueBroadcast();
      return result;
    }
    if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' });
    const [index, device] = await Promise.all([
      this.state.storage.get(key), this.state.storage.get(`dev:${deviceId}`)
    ]);
    if (!index?.revision || !fixedRangeUploads.hasCurrentFixedRangeObservation(device) || index.observedAt !== device.updatedAt
      || !rangesMatchDeviceDay(index.ranges, device.periodWindows?.today?.key)) {
      return jsonResponse(404, { error: 'not_found' });
    }
    const day = device.periodWindows?.today?.key;
    const legacy = url.searchParams.get('daily') !== '1' && Object.hasOwn(index.ranges, day);
    let view = index;
    let legacyPages;
    if (legacy) {
      const cacheKey = JSON.stringify([deviceId, index.revision]);
      if (this.legacyRangeView?.key !== cacheKey) {
        const pages = await Promise.all(Array.from({ length: index.pageCount }, (_, page) =>
          this.state.storage.get(fixedRangePageKey(deviceId, index.revision, page))));
        if (pages.some(page => !Array.isArray(page))) return jsonResponse(404, { error: 'not_found' });
        this.legacyRangeView = { key: cacheKey, deviceId, ...legacyFixedRangeView(index.ranges, pages, day) };
      }
      legacyPages = this.legacyRangeView.pages;
      view = { ...index, ranges: this.legacyRangeView.ranges, pageCount: legacyPages.length };
    }
    if (!url.searchParams.has('page')) {
      const { retiredRevisions: _retired, ...metadata } = view;
      return jsonResponse(200, metadata, {}, request);
    }
    if (url.searchParams.get('revision') !== index.revision) {
      return jsonResponse(409, { error: 'fixed_range_revision_mismatch' });
    }
    const page = url.searchParams.get('page');
    const rows = /^(0|[1-9]\d*)$/.test(page) && Number(page) < view.pageCount
      ? legacyPages?.[Number(page)] ?? await this.state.storage.get(fixedRangePageKey(deviceId, index.revision, Number(page))) : null;
    return rows ? jsonResponse(200, { rows }, {}, request) : jsonResponse(404, { error: 'not_found' });
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
    this.uploadBaselines.clear();
    const enabled = this.syncSessionTitles;
    await this.withStorageTransaction(async (storage) => {
      const policies = await storage.list({ prefix: TITLE_POLICY_PREFIX });
      for (const [key, policy] of policies) {
        if (key.startsWith(TITLE_POLICY_PREFIX) && !enabled && policy?.enabled === true) {
          await storage.put(key, syncContent.nextTitlePolicy(policy, false));
        }
      }
      const rangeIndexes = policies.size ? await storage.list({ prefix: 'fixedRanges:' }) : [];
      for (const [key, index] of rangeIndexes) {
        const id = key.slice('fixedRanges:'.length);
        const policy = policies.get(`${TITLE_POLICY_PREFIX}${id}`);
        if (index?.titleGeneration && !syncContent.acceptsSessionTitles(enabled, policy, index.titleGeneration)) {
          await this.revokeFixedRangeTitles(storage, id, index, await storage.get(`dev:${id}`));
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
      this.uploadBaselines.forget(deviceId);
      await storage.put(key, next);
      if (!enabled) {
        const record = await storage.get(`dev:${deviceId}`);
        if (record) await storage.put(`dev:${deviceId}`, stripSessionTextFromDeviceRecord(record));
        const rangeKey = `fixedRanges:${deviceId}`;
        const rangeIndex = await storage.get(rangeKey);
        if (rangeIndex?.titleGeneration) {
          await this.revokeFixedRangeTitles(storage, deviceId, rangeIndex, record);
        }
      }
      this.fixedRangeUploads.discard(deviceId);
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

  async getStats(devices) {
    devices ??= await this.listDevices();
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
    const devices = await this.listDevices();
    const stats = await this.getStats(devices);
    stats.subscriptionsUpdatedAt = (await this.getSubscriptions())?.updatedAt || '';
    const rangeRevisions = await this.state.storage.list({ prefix: 'fixedRangeRevision:' });
    stats.fixedRangeRevisions = Object.fromEntries(devices.filter(fixedRangeUploads.hasCurrentFixedRangeObservation).flatMap(({ deviceId, updatedAt, periodWindows }) => {
      const stamp = rangeRevisions.get(`fixedRangeRevision:${deviceId}`);
      return stamp?.observedAt === updatedAt && stamp.day === periodWindows?.today?.key ? [[deviceId, stamp.revision]] : [];
    }));
    stats.syncSettingsRevisions = Object.fromEntries(await Promise.all(syncContent.SHARED_SYNC_KINDS.map(async (kind) => [kind, (await this.getSyncSettings(kind)).revision])));
    return stats;
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer || this.sseClients.size === 0) return;
    let pending = false;
    this.heartbeatTimer = setInterval(async () => {
      if (pending) return;
      pending = true;
      const generation = this.sseGeneration;
      try {
        // A replaced DO can keep its old timer/response alive without receiving
        // new ingests. Storage access checks ownership before a heartbeat can
        // keep those orphaned streams looking healthy. This key is never written.
        await this.state.storage.get('sse-liveness', { noCache: true });
        if (generation !== this.sseGeneration) return;
        const chunk = this.encoder.encode(': hb\n\n');
        for (const client of this.sseClients) {
          if (!client.pendingBytes) this.writeEncoded(client, chunk);
        }
      } catch (error) {
        if (generation === this.sseGeneration) {
          for (const client of this.sseClients) this.dropClient(client, error);
        }
      } finally {
        pending = false;
      }
    }, 30000);
  }

  dropClient(client, error = null) {
    this.sseClients.delete(client);
    client.onDrop?.();
    try {
      Promise.resolve(error ? client.writer.abort?.(error) : client.writer.close?.()).catch(() => {});
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

  // Same bound as the Node Hub: frames queue in order behind the write in
  // flight up to SSE_BACKLOG_LIMIT_BYTES of unresolved writes; past that, the
  // connection skips frames and resyncs once every accepted write has settled.
  writeEncoded(client, chunk) {
    if (!this.sseClients.has(client)) return false;
    const pendingBytes = client.pendingBytes || 0;
    if (pendingBytes && (client.needsSnapshot || pendingBytes + chunk.byteLength > client.backlogLimit)) {
      client.needsSnapshot = true;
      return false;
    }
    if (!pendingBytes) client.backlogLimit = chunk.byteLength + hubProtocol.SSE_BACKLOG_LIMIT_BYTES;
    client.pendingBytes = pendingBytes + chunk.byteLength;
    let write;
    try { write = client.writer.write(chunk); }
    catch (_) { this.dropClient(client); return false; }
    Promise.resolve(write).then(() => {
      if (!this.sseClients.has(client)) return;
      client.pendingBytes -= chunk.byteLength;
      if (client.pendingBytes || !client.needsSnapshot) return;
      client.needsSnapshot = false;
      // Resync to the baseline the last fan-out established, so the next
      // update resumes with freshness or delta frames, not another snapshot.
      client.streamRevision = null;
      if (this.writeEncoded(client, this.encoder.encode(hubProtocol.encodeSseEvent('stats', {
        type: 'stats', reason: 'snapshot', stats: this.lastSseStats, at: new Date().toISOString(),
        ...(client.deltaEvents ? { revision: this.streamRevision } : {})
      }))) && client.deltaEvents) client.streamRevision = this.streamRevision;
    }, () => this.dropClient(client)).catch(() => this.dropClient(client));
    return true;
  }

  fanoutSseFrames(frames) {
    // Encode only selected frames, once for all peers that need the same bytes.
    const chunks = new Map();
    for (const client of this.sseClients) {
      const frame = hubProtocol.sseFrameForClient(frames, client);
      if (!frame) continue;
      if (!chunks.has(frame)) chunks.set(frame, this.encoder.encode(frame));
      if (this.writeEncoded(client, chunks.get(frame)) && client.deltaEvents) client.streamRevision = frames.revision;
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

    if (url.pathname === '/api/fixed-ranges') return this.handleFixedRanges(request, url);

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/api/sync/content') {
      return jsonResponse(200, syncContent.syncContentCapability(this.syncSessionTitles));
    }
    const settingsMatch = url.pathname.match(/^\/api\/sync\/settings\/(modelAliases|customPricing|limitAccountPresentation)$/);
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
      return jsonResponse(200, { devices: devices.map(fixedRangeUploads.withoutFixedRangeObservation) }, {}, request);
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

    if (request.method === 'POST' && ['/api/ingest', '/api/ingest/delta', '/api/ingest/compact'].includes(url.pathname)) {
      const compact = url.pathname === '/api/ingest/compact';
      const delta = compact || url.pathname === '/api/ingest/delta';
      let payload;
      try { payload = await readIngestJson(request); }
      catch (error) {
        return jsonResponse(error.status === 413 ? 413 : 400, {
          error: error.status === 413 ? 'payload_too_large' : 'bad_request', message: error.message
        });
      }
      let record, upload, fixedRangeRevision = null, historyCalendarRetained = false;
      try {
        record = await this.mutate(async () => {
          const incoming = delta ? this.uploadBaselines.prepare(payload) : payload;
          if (!incoming || (!incoming.deviceId && !incoming.id)) throw Object.assign(new Error('deviceId_required'), { status: 400, code: 'deviceId_required' });
          const deviceId = String(incoming.deviceId || incoming.id);
          const policy = await this.state.storage.get(`${TITLE_POLICY_PREFIX}${deviceId}`);
          const existing = await this.state.storage.get(`dev:${deviceId}`);
          if (compact) {
            const stamp = await this.state.storage.get(`fixedRangeRevision:${deviceId}`);
            if (!fixedRangeUploads.hasCurrentFixedRangeObservation(existing) || existing.updatedAt !== incoming.updatedAt
              || stamp?.daily !== true || stamp.observedAt !== incoming.updatedAt
              || stamp.day !== incoming.periodWindows?.today?.key) {
              throw Object.assign(new Error('fixed_range_revision_mismatch'), { status: 409, code: 'fixed_range_revision_mismatch' });
            }
          }
          const removed = removedPagedClients(existing, incoming);
          let previousWithSessions = existing;
          if (removed.length && fixedRangeUploads.hasCurrentFixedRangeObservation(existing)) {
            const index = await this.state.storage.get(`fixedRanges:${deviceId}`);
            if (index?.revision && index.observedAt === existing.updatedAt
              && Object.hasOwn(index.ranges, existing.periodWindows?.today?.key)) {
              const pages = await Promise.all(Array.from({ length: index.pageCount }, (_, page) =>
                this.state.storage.get(fixedRangePageKey(deviceId, index.revision, page))));
              if (pages.every(Array.isArray)) previousWithSessions = restorePagedClientSessions(existing, index.ranges, pages, removed);
            }
          }
          const preserveSessionTitles = syncContent.acceptsSessionTitles(this.syncSessionTitles, policy, incoming.sessionTitleSyncGeneration);
          const next = compact ? restoreDeviceHistory(existing, incoming) : mergeSyncDeviceRecord(previousWithSessions, {
            ...incoming, receivedAt: new Date().toISOString()
          }, { preserveSessionTitles });
          historyCalendarRetained = !compact && incoming.history?.dailyTotalsOmitted > 0
            && Boolean(incoming.history.dailyTotalsRevision)
            && incoming.history.dailyTotalsRevision === next.history?.dailyTotalsRevision
            && next.history.summary?.activeDaysComplete === true;
          const storageKey = `dev:${next.deviceId}`;
          const encoder = new TextEncoder();
          const storageBytes = encoder.encode(storageKey).byteLength
            + encoder.encode(JSON.stringify(next)).byteLength;
          if (storageBytes > MAX_DEVICE_STORAGE_BYTES) {
            throw Object.assign(new Error('payload_too_large'), { status: 413, code: 'payload_too_large' });
          }
          // The private clock uses the storage headroom, outside the device
          // budget exposed to existing producers.
          fixedRangeUploads.rememberFixedRangeObservation(next, existing);
          const projectsChanged = (existing?.projectsEnabled !== false) !== (next.projectsEnabled !== false);
          const dayChanged = existing?.periodWindows?.today?.key !== next.periodWindows?.today?.key;
          const revisionKey = `fixedRangeRevision:${deviceId}`;
          if (projectsChanged) {
            await this.withStorageTransaction(async storage => {
              const indexKey = `fixedRanges:${deviceId}`;
              const index = await storage.get(indexKey);
              if (index?.revision) {
                await this.clearFixedRanges(storage, deviceId, index);
                await storage.put(indexKey, fixedRangeUploads.retireFixedRangeSnapshot(index));
                await storage.delete(revisionKey);
              }
              await storage.put(storageKey, next);
            });
          } else {
            await this.state.storage.put(storageKey, next);
          }
          if (existing?.updatedAt !== next.updatedAt || dayChanged || projectsChanged) this.fixedRangeUploads.discard(deviceId);
          if (!projectsChanged && request.headers.get(FIXED_RANGE_HEADER) === FIXED_RANGE_VERSION
            && fixedRangeUploads.hasCurrentFixedRangeObservation(next)) {
            const stamp = await this.state.storage.get(revisionKey);
            if (stamp?.observedAt === next.updatedAt && stamp.day === next.periodWindows?.today?.key) fixedRangeRevision = stamp.revision;
          }
          if (!compact) this.uploadBaselines.forget(deviceId);
          if (!compact && (delta || request.headers.get(uploadDelta.UPLOAD_HEADER) === uploadDelta.UPLOAD_VERSION)) {
            upload = this.uploadBaselines.commit(deviceId, stripSessionTextFromDeviceRecord(incoming, { preserveSessionTitles }));
          }
          return next;
        });
      } catch (error) {
        if (error.status) return jsonResponse(error.status, { error: error.code });
        throw error;
      }
      this.queueBroadcast();
      const response = {
        ok: true, deviceId: record.deviceId,
        ...(request.headers.get(FIXED_RANGE_HEADER) === FIXED_RANGE_VERSION ? { fixedRanges: 1, fixedRangeDelta: 1, fixedRangeBatch: 1, fixedRangeIndexDelta: 1, dailySessionRanges: 1, fixedRangeRevision } : {}),
        ...(upload ? { upload } : {}),
        ...(historyCalendarRetained ? { historyCalendarRetained: true } : {})
      };
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
        this.uploadBaselines.forget(deviceId);
        const key = `${TITLE_POLICY_PREFIX}${deviceId}`;
        await storage.put(key, syncContent.nextTitlePolicy(await storage.get(key), false));
        await storage.delete(`dev:${deviceId}`);
        const rangeKey = `fixedRanges:${deviceId}`;
        await this.clearFixedRanges(storage, deviceId, await storage.get(rangeKey));
        await storage.delete(rangeKey);
        await storage.delete(`fixedRangeRevision:${deviceId}`);
        this.fixedRangeUploads.discard(deviceId);
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
