'use strict';

// Fixed-origin read-only transport following PlanMeter's public MIT implementation.
// This does NOT use the blocked /tbo directory route, scrape cookies, or start tasks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, pbkdf2Sync } = require('node:crypto');
const { error, identifier } = require('./cloudUsage');
const MAX_BYTES = 4_000_000;
const WS_URL = 'wss://codex-cloud-backend.chatgpt.com/';
const USAGE_ORIGIN = 'https://chatgpt.com';
const ROUTES = Object.freeze({ estimates: '/backend-api/wham/usage/thread-estimates/query', quotas: '/backend-api/wham/usage/thread_usage/query_v2' });
const READ_METHODS = new Set(['thread/list', 'thread/read', 'thread/turns/list']);
let lastScope = null;
function scopeFingerprint(accountId, userId) {
  // Reports need a stable, opaque identity across the observer and Electron.
  // Derive only from account/user identifiers, never OAuth token contents.
  // The domain salt distinguishes this v2 identifier from the old fast hash.
  const identity = JSON.stringify([accountId, userId]);
  if (lastScope?.identity !== identity) {
    lastScope = { identity, fingerprint: pbkdf2Sync(identity, 'token-monitor/codex-cloud-scope/v2', 600000, 32, 'sha256').toString('hex') };
  }
  // Cache one identity so hot credential-change checks do not repeat the KDF.
  return lastScope.fingerprint;
}
function readJson(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) throw error('SOURCE_TOO_LARGE');
    const buf = Buffer.alloc(maxBytes + 1); let n = 0;
    while (n < buf.length) { const size = fs.readSync(fd, buf, n, buf.length - n, null); if (!size) break; n += size; }
    if (n > maxBytes) throw error('SOURCE_TOO_LARGE');
    const raw = buf.subarray(0, n); return { data: JSON.parse(raw.toString('utf8')), hash: createHash('sha256').update(raw).digest('hex') };
  } catch (e) { if (e.code === 'SOURCE_TOO_LARGE') throw e; throw error('SOURCE_UNAVAILABLE'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function loadCredential(home) {
  const { codexOAuthRequestContext, decodeJwtPayload } = require('./auth');
  const file = path.join(home, 'auth.json'); const { data: auth, hash } = readJson(file, 256 * 1024);
  const c = codexOAuthRequestContext(auth);
  if (!c.accessToken || !c.accountId || !/^[A-Za-z0-9._-]{16,65536}$/.test(c.accessToken)) throw error('CHATGPT_LOGIN_REQUIRED');
  identifier(c.accountId);
  const payloads = [auth.tokens?.id_token, c.accessToken].filter(Boolean).map((t) => decodeJwtPayload(t) || {});
  let userId = null;
  for (const p of payloads) {
    const claims = p['https://api.openai.com/auth'] || {};
    const user = claims.chatgpt_user_id || claims.user_id || p.user_id;
    if (typeof user === 'string' && user) { userId = user; break; }
  }
  if (c.isFedrampAccount) throw error('UNSUPPORTED_ACCOUNT_ROUTE');
  return { ...c, userId, fileHash: hash, file, scopeFingerprint: scopeFingerprint(c.accountId, userId) };
}
function cachedReferences(home, credential) {
  // Never treat a stale/mismatched desktop cache as live service inventory.
  let state;
  try { state = readJson(path.join(home, '.codex-global-state.json'), 16 * 1024 * 1024).data; } catch (_) { return []; }
  const cache = state?.['electron-persisted-atom-state']?.['cloud-aeon-sidebar-cache-v1'];
  if (!credential.userId || cache?.accountId !== credential.accountId || cache?.userId !== credential.userId || cache?.hostId !== 'durable') return [];
  if (!Array.isArray(cache.threads) || cache.threads.length > 10000 || !Array.isArray(cache.attachments) || cache.attachments.length > 10000) return [];
  const parents = new Map(); const conflicts = new Set();
  for (const a of cache.attachments) {
    try { identifier(a.thread_id); const parent = a.parent_thread_id == null ? null : identifier(a.parent_thread_id);
      if (parents.has(a.thread_id) && parents.get(a.thread_id) !== parent) conflicts.add(a.thread_id);
      parents.set(a.thread_id, parent);
    } catch (_) { /* Invalid cached edges never enter a live binding. */ }
  }
  const { reference } = require('./cloudUsage'); const out = [];
  for (const t of cache.threads) {
    try {
      const r = reference(t); const profile = cache.profilesByThreadId?.[r.threadId];
      out.push({ ...r, delegationParentId: conflicts.has(r.threadId) ? null : parents.get(r.threadId) || null,
        dotId: typeof profile?.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(profile.id) ? profile.id : null,
        metadataSource: 'desktop-cache', bindingEvidence: 'cache-account-and-user-matched' });
    } catch (_) { /* Report remains limited to independently valid cache rows. */ }
  }
  return out;
}
class CloudTransport {
  constructor(options = {}, deps = {}) {
    this.home = path.resolve(options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    this.timeoutMs = options.timeoutMs ?? 15000; const budgetMs = options.budgetMs ?? 90000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000 || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 180000) throw error('INVALID_LIMIT');
    this.deps = deps; this.credential = (deps.loadCredential || loadCredential)(this.home);
    this.scopeFingerprint = this.credential.scopeFingerprint;
    this.pending = new Map(); this.nextId = 1; this.initialized = false; this.closed = false; this.bytesRead = 0;
    this.abort = new AbortController(); this.deadline = Date.now() + budgetMs;
    this.timer = setTimeout(() => this.fail('DEADLINE'), budgetMs);
    this.audit = { rpcRequests: 0, estimateQueries: 0, quotaQueries: 0, startedModelTurns: 0 };
  }
  assertIdentity() {
    if (this.closed) throw error(this.failure || 'CLOSED');
    if (Date.now() >= this.deadline) throw error('DEADLINE');
    this.verifyIdentity();
  }
  verifyIdentity() {
    if (!this.credential) throw error('LOGIN_CHANGED');
    const current = (this.deps.loadCredential || loadCredential)(this.home);
    if (current.fileHash !== this.credential.fileHash || current.scopeFingerprint !== this.scopeFingerprint) { this.fail('LOGIN_CHANGED'); throw error('LOGIN_CHANGED'); }
  }
  fail(code) {
    if (this.closed) return;
    this.closed = true; this.failure = code; this.abort.abort(); clearTimeout(this.timer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error(code)); } this.pending.clear();
    try { this.socket?.close(1000); } catch (_) {}
    this.dispatcher?.destroy().catch(() => {});
  }
  async initialize() {
    if (this.initialized) return;
    this.assertIdentity();
    const undici = this.deps.undici || require('undici');
    this.http = undici.request; this.dispatcher = new undici.Agent({ connectTimeout: this.timeoutMs,
      webSocket: { maxPayloadSize: MAX_BYTES, maxFragments: 1024 } });
    this.socket = new undici.WebSocket(WS_URL, { protocols: ['codex-app-server', 'codex-client.desktop', `openai-bearer.${this.credential.accessToken}`],
      headers: { 'ChatGPT-Account-ID': this.credential.accountId, 'X-OpenAI-Product-Sku': 'codex' }, dispatcher: this.dispatcher });
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (e) => this.onMessage(e.data));
    this.socket.addEventListener('error', () => this.fail('CLOUD_CONNECT_FAILED'));
    this.socket.addEventListener('close', () => this.fail('CLOUD_CLOSED'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); this.fail('CONNECT_TIMEOUT'); reject(error('CONNECT_TIMEOUT')); }, this.timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.socket.removeEventListener('open', opened); this.socket.removeEventListener('error', failed); this.socket.removeEventListener('close', failed); this.abort.signal.removeEventListener('abort', failed); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(error(this.failure || 'CLOUD_CONNECT_FAILED')); };
      this.socket.addEventListener('open', opened, { once: true }); this.socket.addEventListener('error', failed, { once: true });
      this.socket.addEventListener('close', failed, { once: true }); this.abort.signal.addEventListener('abort', failed, { once: true });
    });
    await this.send('initialize', { clientInfo: { name: 'token_monitor_cloud_usage', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: 'initialized', params: {} })); this.initialized = true;
  }
  onMessage(data) {
    if (this.closed) return;
    const b = typeof data === 'string' ? Buffer.from(data) : data instanceof ArrayBuffer ? Buffer.from(data) : null;
    if (!b || b.length > MAX_BYTES || (this.bytesRead += b.length) > 64 * MAX_BYTES) { this.fail('PAYLOAD_LIMIT'); return; }
    let m; try { m = JSON.parse(b.toString('utf8')); } catch (_) { this.fail('INVALID_RPC_JSON'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { this.fail('INVALID_RPC_MESSAGE'); return; }
    if (m.method) {
      if (m.id !== undefined) this.socket.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Read-only usage client' } }));
      return;
    }
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(error(m.error.code === -32601 ? 'UNSUPPORTED_METHOD' : m.error.code === -32602 ? 'INVALID_RPC_PARAMS' : 'CLOUD_RPC_ERROR'));
    else if (!m.result || typeof m.result !== 'object' || Array.isArray(m.result)) p.reject(error('INVALID_RPC_RESULT'));
    else p.resolve(m.result);
  }
  send(method, params) {
    this.assertIdentity(); if (this.pending.size >= 4) return Promise.reject(error('CONCURRENCY_LIMIT'));
    const id = this.nextId++; this.audit.rpcRequests += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(error('RPC_TIMEOUT')); }, Math.min(this.timeoutMs, this.deadline - Date.now()));
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (_) { clearTimeout(timer); this.pending.delete(id); reject(error('RPC_SEND_FAILED')); }
    });
  }
  request(method, params) {
    if (!this.initialized || !READ_METHODS.has(method)) return Promise.reject(error('READ_ONLY_METHOD_DENIED'));
    if (method === 'thread/read' && params.includeTurns !== false) return Promise.reject(error('MESSAGE_CONTENT_DENIED'));
    if (method === 'thread/turns/list' && params.itemsView !== 'notLoaded') return Promise.reject(error('MESSAGE_CONTENT_DENIED'));
    return this.send(method, params);
  }
  async query(kind, body) {
    this.assertIdentity();
    if (!this.initialized || !Object.hasOwn(ROUTES, kind) || !Array.isArray(body?.threads) || body.threads.length > 100) throw error('READ_ONLY_METHOD_DENIED');
    for (const t of body.threads) { identifier(t.thread_id); if (kind === 'estimates') { if (!Array.isArray(t.turn_ids) || t.turn_ids.length > 100) throw error('INVALID_QUERY'); t.turn_ids.forEach(identifier); } }
    if (kind === 'estimates' && body.threads.reduce((n, t) => n + t.turn_ids.length, 0) > 100) throw error('INVALID_QUERY');
    this.audit[kind === 'estimates' ? 'estimateQueries' : 'quotaQueries'] += 1;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.min(this.timeoutMs, Math.max(1, this.deadline - Date.now())))]);
    let response;
    try { response = await this.http(USAGE_ORIGIN + ROUTES[kind], { method: 'POST', body: JSON.stringify(body), dispatcher: this.dispatcher,
      headers: { Authorization: `Bearer ${this.credential.accessToken}`, 'ChatGPT-Account-ID': this.credential.accountId,
        'User-Agent': 'token-monitor-cloud-usage/0.1', Accept: 'application/json', 'Content-Type': 'application/json' }, maxRedirections: 0, signal }); }
    catch (_) { throw error(this.failure || (signal.aborted ? 'HTTP_TIMEOUT' : 'HTTP_FAILED')); }
    // Undici emits UND_ERR_ABORTED when destroying an unread response. Attach
    // an error sink before cancellation; report only our sanitized status code.
    response.body.on('error', () => {});
    if (response.statusCode !== 200) {
      response.body.destroy();
      throw error(response.statusCode === 401 ? 'UNAUTHORIZED' : response.statusCode === 403 ? 'FORBIDDEN' : response.statusCode === 429 ? 'RATE_LIMITED' : response.statusCode >= 300 && response.statusCode < 400 ? 'REDIRECT_REFUSED' : 'HTTP_STATUS');
    }
    const chunks = []; let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) { response.body.destroy(); throw error('PAYLOAD_LIMIT'); } chunks.push(chunk); } }
    catch (e) { throw error(e.code === 'PAYLOAD_LIMIT' ? e.code : 'HTTP_BODY_FAILED'); }
    this.assertIdentity();
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw error('INVALID_HTTP_JSON'); }
  }
  estimates(body) { return this.query('estimates', body); }
  quotas(body) { return this.query('quotas', body); }
  async close() { this.fail('CLOSED'); if (this.dispatcher) await this.dispatcher.destroy().catch(() => {}); this.credential = null; }
}
module.exports = { CloudTransport, loadCredential, cachedReferences, readJson, WS_URL, ROUTES, MAX_BYTES };
