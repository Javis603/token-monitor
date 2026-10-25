'use strict';

// Capabilities a sandboxed plugin can ask main for: publishing its declared
// metrics, a persistent store, rate-limited notifications and requests
// to the hosts its manifest lists. Every request is re-validated here; the
// Worker-side API in host/prelude.js is only a convenience.

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeDisplayList, normalizeRows } = require('../../shared/plugins/viewSpec');
const { hostAllowed } = require('../../shared/plugins/permissions');

// Content limits bound one value, not what a plugin may express. Worker
// messages separately stay within the 64 KiB IPC envelope (host/message.js),
// which is why an object metric stops short of it.
const LIMITS = Object.freeze({
  textChars: 4096,
  seriesLength: 240,
  objectBytes: 56 * 1024,
  objectDepth: 8,
  objectKeys: 1024,
  storageBytes: 5 * 1024 * 1024,
  storageKeyChars: 64,
  requestBodyBytes: 256 * 1024,
  responseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  requestHeaders: 20,
  headerValueChars: 2048,
  notifyTitleChars: 64,
  notifyBodyChars: 240
});

const FORBIDDEN_HEADERS = new Set([
  'host', 'cookie', 'cookie2', 'origin', 'referer', 'connection', 'content-length', 'date', 'expect',
  'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'dnt', 'access-control-request-headers',
  'access-control-request-method'
]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'retry-after', 'location', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

function plainObject(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (depth >= LIMITS.objectDepth) return false;
  if (Array.isArray(value)) return value.length <= LIMITS.objectKeys && value.every((entry) => plainObject(entry, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length <= LIMITS.objectKeys && keys.every((key) => key.length <= 64 && plainObject(value[key], depth + 1));
}

// Returns { ok, value } with a normalised value, or { ok: false, error }.
function validateMetricValue(kind, value) {
  if (value === null) return { ok: true, value: null };
  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'expected a finite number' };
    case 'text':
      return typeof value === 'string' ? { ok: true, value: value.replace(/[\u0000-\u001f]/g, ' ').slice(0, LIMITS.textChars) } : { ok: false, error: 'expected a string' };
    case 'series':
      if (!Array.isArray(value)) return { ok: false, error: 'expected an array of numbers' };
      return { ok: true, value: value.slice(-LIMITS.seriesLength).map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null)) };
    case 'draw':
      if (!Array.isArray(value)) return { ok: false, error: 'expected a display list' };
      return { ok: true, value: sanitizeDisplayList(value) };
    case 'rows':
      if (!Array.isArray(value)) return { ok: false, error: 'expected an array of rows' };
      return { ok: true, value: normalizeRows(value) };
    case 'object': {
      if (!plainObject(value)) return { ok: false, error: 'expected a plain JSON object' };
      const json = JSON.stringify(value);
      return json.length <= LIMITS.objectBytes ? { ok: true, value: JSON.parse(json) } : { ok: false, error: 'object too large' };
    }
    default:
      return { ok: false, error: 'unknown metric kind' };
  }
}

function validateNetRequest(manifest, args) {
  if (!manifest.permissions.includes('network')) return { ok: false, error: 'network permission not granted' };
  let url;
  try {
    url = new URL(String(args?.url || ''));
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    return { ok: false, error: 'only https URLs on the default port are allowed' };
  }
  if (!hostAllowed(url.hostname, manifest.network.hosts)) return { ok: false, error: `host ${url.hostname} is not in network.hosts` };
  const init = args?.init && typeof args.init === 'object' ? args.init : {};
  const method = String(init.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return { ok: false, error: `method ${method} not allowed` };
  const headers = {};
  const rawHeaders = init.headers && typeof init.headers === 'object' ? Object.entries(init.headers) : [];
  for (const [name, value] of rawHeaders.slice(0, LIMITS.requestHeaders)) {
    const key = String(name).trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(key) || FORBIDDEN_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('sec-')) continue;
    const text = String(value ?? '');
    if (text.length > LIMITS.headerValueChars || /[\r\n]/.test(text)) continue;
    headers[key] = text;
  }
  let body;
  if (init.body !== undefined && init.body !== null) {
    if (method === 'GET' || method === 'HEAD') return { ok: false, error: 'GET and HEAD requests cannot have a body' };
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    if (Buffer.byteLength(body) > LIMITS.requestBodyBytes) return { ok: false, error: 'request body too large' };
  }
  return { ok: true, request: { url: url.toString(), method, headers, body } };
}

async function readLimited(response, limit) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error('response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch {}
      throw new Error('response too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// fetchImpl is the app's outbound transport (proxy-aware, cookie-free).
async function performNetRequest(fetchImpl, request, { timeoutMs = LIMITS.requestTimeoutMs, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    });
    const text = request.method === 'HEAD' ? '' : await readLimited(response, LIMITS.responseBytes);
    const headers = {};
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers?.get?.(name);
      if (value) headers[name] = String(value).slice(0, 512);
    }
    return { status: response.status, ok: response.ok, headers, text };
  } finally {
    clearTimeout(timer);
  }
}

// JSON store per plugin under userData/plugin-data/<id>.json, written
// atomically and coalesced so a chatty plugin cannot thrash the disk.
function createPluginStorage({ dir, pluginId, flushDelayMs = 1000, fsImpl = fs, onError = () => {} }) {
  const file = path.join(dir, `${pluginId}.json`);
  let data = null;
  let timer = null;
  let dirty = false;
  let retries = 0;
  let bytes = 0;
  // An upper bound on one `"key":value,` member. Tracking the store's size as
  // the sum of its members keeps a set proportional to its own value instead
  // of re-serialising the whole store on every write.
  const memberBytes = (id, value) => Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(value)) + 2;

  function load() {
    if (data) return data;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      data = {};
    }
    bytes = 2;
    for (const [id, value] of Object.entries(data)) bytes += memberBytes(id, value);
    return data;
  }

  function flush() {
    timer = null;
    if (!data || !dirty) return;
    fsImpl.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fsImpl.renameSync(temp, file);
    dirty = false;
    retries = 0;
  }

  function schedule(delayMs = flushDelayMs) {
    if (timer) return;
    timer = setTimeout(() => {
      try { flush(); } catch (error) {
        onError(error);
        if (++retries <= 3) schedule(5000);
      }
    }, delayMs);
    timer.unref?.();
  }

  function key(value) {
    const name = String(value || '');
    if (!name || name.length > LIMITS.storageKeyChars) throw new Error('invalid storage key');
    return name;
  }

  return {
    get(name) {
      const store = load();
      const id = key(name);
      return Object.hasOwn(store, id) ? store[id] : null;
    },
    set(name, value) {
      const id = key(name);
      if (!plainObject(value)) throw new Error('storage values must be plain JSON');
      const store = load();
      const next = bytes - (Object.hasOwn(store, id) ? memberBytes(id, store[id]) : 0) + memberBytes(id, value);
      if (next > LIMITS.storageBytes) throw new Error('storage quota exceeded');
      // defineProperty keeps keys such as "__proto__" as ordinary entries.
      Object.defineProperty(store, id, { value, enumerable: true, writable: true, configurable: true });
      bytes = next;
      dirty = true;
      retries = 0;
      schedule();
      return true;
    },
    delete(name) {
      const store = load();
      const id = key(name);
      if (!Object.hasOwn(store, id)) return false;
      bytes -= memberBytes(id, store[id]);
      delete store[id];
      dirty = true;
      retries = 0;
      schedule();
      return true;
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    }
  };
}

function validateNotification(options) {
  const title = typeof options?.title === 'string' ? options.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.notifyTitleChars) : '';
  const body = typeof options?.body === 'string' ? options.body.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.notifyBodyChars) : '';
  return title ? { ok: true, title, body } : { ok: false, error: 'notify needs a title' };
}

module.exports = {
  LIMITS,
  createPluginStorage,
  performNetRequest,
  validateMetricValue,
  validateNetRequest,
  validateNotification
};
