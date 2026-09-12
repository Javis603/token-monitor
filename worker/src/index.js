import { publicLimits } from './shared/limits/core.js';
import subscriptionDisplay from './shared/subscriptionDisplay.js';
import currency from './shared/currency.js';
import {
  aggregateDevices,
  mergeDeviceRecord,
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
  try {
    const url = new URL(request.url);
    return String(url.searchParams.get('secret') || '').trim();
  } catch (_) { return ''; }
}

function isAuthorized(request, expectedSecret) {
  if (!expectedSecret) return true;
  return requestSecret(request) === expectedSecret;
}

const SUBSCRIPTIONS_KEY = 'subscriptions';

function sseFormat(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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
    this.encoder = new TextEncoder();
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
    return stats;
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer || this.sseClients.size === 0) return;
    this.heartbeatTimer = setInterval(() => {
      const chunk = this.encoder.encode(': hb\n\n');
      for (const client of this.sseClients) {
        client.writer.write(chunk).catch(() => this.dropClient(client));
      }
      if (this.sseClients.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }, 30000);
  }

  dropClient(client) {
    this.sseClients.delete(client);
    try { client.writer.close(); } catch (_) {}
    if (this.sseClients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sseClients.size === 0) {
      this.lastSseContentKey = '';
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  writeClient(client, event, data) {
    client.writer.write(this.encoder.encode(sseFormat(event, data))).catch(() => this.dropClient(client));
  }

  async broadcast(reason = 'update') {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    if (this.sseClients.size === 0) return;
    const stats = await this.statsWithSubscriptionVersion();
    this.lastSseContentKey = hubProtocol.hubStatsContentKey(stats);
    const at = new Date().toISOString();
    for (const client of this.sseClients) {
      this.writeClient(client, 'stats', { type: 'stats', reason, stats, at });
    }
  }

  async flushBroadcast() {
    this.broadcastTimer = null;
    if (this.sseClients.size === 0) return;
    const stats = await this.statsWithSubscriptionVersion();
    const nextContentKey = hubProtocol.hubStatsContentKey(stats);
    const at = new Date().toISOString();
    if (!this.lastSseContentKey || nextContentKey !== this.lastSseContentKey) {
      this.lastSseContentKey = nextContentKey;
      for (const client of this.sseClients) {
        this.writeClient(client, 'stats', { type: 'stats', reason: 'ingest', stats, at });
      }
      return;
    }
    const event = hubProtocol.freshnessEvent(stats, 'ingest', at);
    for (const client of this.sseClients) {
      if (client.freshnessEvents) {
        this.writeClient(client, 'freshness', event);
      } else {
        this.writeClient(client, 'stats', { type: 'stats', reason: 'ingest', stats, at });
      }
    }
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
    if (!isAuthorized(request, this.secret)) return jsonResponse(401, { error: 'unauthorized' });

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
      writer.write(this.encoder.encode(sseFormat('snapshot', {
        type: 'stats', reason: 'snapshot', stats, at: new Date().toISOString()
      }))).catch(() => {});
      const client = { writer, freshnessEvents: hubProtocol.wantsFreshnessEvents(request) };
      if (this.sseClients.size === 0) this.lastSseContentKey = hubProtocol.hubStatsContentKey(stats);
      this.sseClients.add(client);
      this.ensureHeartbeat();
      request.signal.addEventListener('abort', () => this.dropClient(client));
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
      if (!payload.deviceId && !payload.id) return jsonResponse(400, { error: 'deviceId_required' });
      const deviceId = String(payload.deviceId || payload.id);
      const existing = stripSessionTextFromDeviceRecord(await this.state.storage.get(`dev:${deviceId}`));
      const incoming = stripSessionTextFromDeviceRecord(payload);
      const record = mergeDeviceRecord(existing, { ...incoming, receivedAt: new Date().toISOString() });
      await this.state.storage.put(`dev:${record.deviceId}`, record);
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
      this.broadcast('subscriptions').catch(() => {});
      return jsonResponse(200, { ok: true, ...next });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      await this.state.storage.delete(`dev:${deviceId}`);
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
        ...safe
      } = session;
      return [key, safe];
      }))
    }];
  }));
}

export { publicPeriods };
