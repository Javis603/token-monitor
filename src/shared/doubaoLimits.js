'use strict';

const net = require('net');
const crypto = require('crypto');

const { hashKey } = require('./hashKey');
const { normalizeLimitProvider } = require('./limits');
const { runWithProbeDeadline } = require('./probeDeadline');

const DOUBAO_FETCH_TIMEOUT_MS = 12_000;
const DOUBAO_DEFAULT_CDP_PORT = 9333;
const DOUBAO_CDP_HOST = '127.0.0.1';
const DOUBAO_TARGET_PREFIX = 'https://www.doubao.com/';
const DOUBAO_TARGET_WAIT_MS = 8_000;
const DOUBAO_TARGET_POLL_MS = 400;

function cleanPort(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  if (port <= 0 || port > 65535) return null;
  return port;
}

function doubaoCdpPort(env = process.env, options = {}) {
  const fromSettings = cleanPort(options?.doubaoCdpPort);
  if (fromSettings !== null) return fromSettings;
  for (const name of ['TOKEN_MONITOR_DOUBAO_CDP_PORT', 'DOUBAO_CDP_PORT']) {
    const fromEnv = cleanPort(env?.[name]);
    if (fromEnv !== null) return fromEnv;
  }
  return DOUBAO_DEFAULT_CDP_PORT;
}

function doubaoCdpListUrl(port = DOUBAO_DEFAULT_CDP_PORT) {
  return `http://${DOUBAO_CDP_HOST}:${port}/json`;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIsoOrNull(value) {
  const ms = numberOrNull(value);
  if (ms === null || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function doubaoWindowKind(windowType) {
  if (windowType === 1) return { kind: 'session', label: '5-hour', windowMinutes: 300 };
  if (windowType === 2) return { kind: 'weekly', label: 'Weekly', windowMinutes: null };
  return null;
}

function parseDoubaoOverview(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Doubao subscription response is not an object');
  }
  const code = numberOrNull(body.code);
  if (code !== null && code !== 0) {
    const error = new Error(`Doubao subscription response returned code ${code}`);
    error.status = code === 401 || code === 403 ? 'unauthorized' : 'error';
    throw error;
  }
  const data = body.data && typeof body.data === 'object' ? body.data : null;
  if (!data) throw new Error('Doubao subscription response has no data payload');

  const groups = Array.isArray(data.window_limit_section?.window_limit_groups)
    ? data.window_limit_section.window_limit_groups
    : [];
  const windows = [];
  for (const group of groups) {
    const limits = Array.isArray(group?.window_limits) ? group.window_limits : [];
    for (const limit of limits) {
      const shape = doubaoWindowKind(limit?.window_type);
      if (!shape) continue;
      const total = numberOrNull(limit.total_amount);
      const used = numberOrNull(limit.used_amount);
      // A window without absolute amounts (percent-only) cannot back a meter
      // row; publishing it would show a fabricated balance. Skip rather than
      // approximate, and fail closed when every window is percent-only.
      if (total === null || used === null || total < 0 || used < 0) continue;
      const remaining = Math.max(0, total - used);
      const usedPercent = total > 0 ? Math.min(100, (used / total) * 100) : used > 0 ? 100 : 0;
      windows.push({
        kind: shape.kind,
        label: shape.label,
        metric: 'credits',
        currency: 'CREDITS',
        used,
        limit: total,
        remaining,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: toIsoOrNull(limit.end_time),
        ...(shape.windowMinutes !== null ? { windowMinutes: shape.windowMinutes } : {}),
        showMeter: true
      });
    }
  }
  if (windows.length === 0) {
    throw new Error('Doubao subscription response has no window amounts');
  }

  const subscription = data.current_subscription && typeof data.current_subscription === 'object'
    ? data.current_subscription
    : {};
  const endsAt = toIsoOrNull(subscription.end_time);
  const planLabel = typeof subscription.display?.short_name === 'string' && subscription.display.short_name.trim()
    ? subscription.display.short_name.trim()
    : '';
  const planStatus = subscription.sku_key && endsAt ? 'active' : '';
  const accountKey = hashKey('doubao', String(subscription.subscription_id || 'local-app'));
  return { windows, planLabel, planStatus, accountKey, subscriptionEndsAt: endsAt };
}

function listCdpTargets(port, deps = {}) {
  const fetchLike = deps.doubaoCdpFetch || fetch;
  return fetchLike(doubaoCdpListUrl(port)).then(async (response) => {
    if (!response.ok) throw new Error(`Doubao Work CDP endpoint returned ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('Doubao Work CDP endpoint returned no target list');
    return targets;
  });
}

// Minimal RFC 6455 client for CDP: text frames only, client frames masked,
// server ping answered with pong. CDP sessions exchange JSON text messages and
// never need binary frames, compression, or fragmentation-on-send.
class CdpWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.pendingMessages = [];
    this.waiters = [];
    this.calls = new Map();
    this.nextCallId = 0;
    this.closed = false;
    socket.on('data', (chunk) => this.onData(chunk));
    const gone = () => this.shutdown(new Error('Doubao Work CDP socket closed'));
    socket.on('error', gone);
    socket.on('close', () => this.shutdown(new Error('Doubao Work CDP socket closed')));
  }

  shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    for (const { reject } of this.calls.values()) reject(error);
    this.calls.clear();
    try { this.socket.destroy(); } catch (_) { /* already gone */ }
  }

  onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.handleFrame()) { /* drain */ }
  }

  handleFrame() {
    if (this.closed) return false;
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < offset + 2) return false;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return false;
      const high = this.buffer.readUInt32BE(offset);
      const low = this.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return false;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + length) return false;
    let payload = this.buffer.subarray(offset, offset + length);
    this.buffer = this.buffer.subarray(offset + length);
    if (maskKey) {
      const unmasked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    if (opcode === 0x8) {
      this.shutdown(new Error('Doubao Work CDP socket closed by peer'));
      return false;
    }
    if (opcode === 0x9) {
      this.sendFrame(0x0a, payload);
      return true;
    }
    if (opcode === 0x0a) return true;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.dispatchMessage(message);
      }
    }
    return true;
  }

  dispatchMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    if (message && message.id !== undefined && this.calls.has(message.id)) {
      const { resolve, reject } = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(text);
    else this.pendingMessages.push(text);
  }

  nextRawMessage() {
    if (this.pendingMessages.length > 0) {
      return Promise.resolve(this.pendingMessages.shift());
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  sendFrame(opcode, payload) {
    if (this.closed) throw new Error('Doubao Work CDP socket is closed');
    const maskKey = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ maskKey[i % 4];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 2 ** 16) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(payload.length / 2 ** 32), 2);
      header.writeUInt32BE(payload.length % 2 ** 32, 6);
    }
    this.socket.write(Buffer.concat([header, maskKey, masked]));
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Doubao Work CDP socket is closed'));
    const id = ++this.nextCallId;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      try { this.sendText(JSON.stringify({ id, method, params })); }
      catch (error) { this.calls.delete(id); reject(error); }
    });
  }

  close() {
    if (this.closed) return;
    try { this.sendFrame(0x8, Buffer.alloc(0)); } catch (_) { /* already closed */ }
    this.shutdown(new Error('Doubao Work CDP session closed'));
  }
}

function parseWebSocketUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:') throw new Error('Doubao Work CDP endpoint must use ws://');
  return { host: parsed.hostname, port: Number(parsed.port) || 80, path: parsed.pathname + parsed.search };
}

function connectCdpWebSocket(url) {
  const { host, port, path } = parseWebSocketUrl(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const key = crypto.randomBytes(16).toString('base64');
    socket.once('error', (error) => reject(new Error(`Doubao Work CDP connection failed: ${error.message}`)));
    let handshake = Buffer.alloc(0);
    socket.once('data', function onHandshake(chunk) {
      handshake = Buffer.concat([handshake, chunk]);
      const marker = handshake.indexOf('\r\n\r\n');
      if (marker === -1) return;
      socket.removeListener('data', onHandshake);
      const head = handshake.subarray(0, marker).toString('utf8');
      if (!/^HTTP\/1\.1 101/.test(head)) {
        socket.destroy();
        reject(new Error('Doubao Work CDP endpoint refused the websocket upgrade'));
        return;
      }
      const session = new CdpWebSocket(socket);
      const rest = handshake.subarray(marker + 4);
      if (rest.length > 0) session.onData(rest);
      resolve(session);
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\n`
      + `Host: ${host}:${port}\r\n`
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${key}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });
}

async function connectCdpSession(url) {
  const socket = await connectCdpWebSocket(url);
  return {
    call: (method, params) => socket.call(method, params),
    close: () => socket.close()
  };
}

async function evaluateJson(session, expression) {
  const result = await session.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  const exception = result?.exceptionDetails;
  if (exception) {
    throw new Error(`Doubao Work CDP evaluation failed: ${exception.text || 'exception'}`);
  }
  const value = result?.result?.value;
  if (typeof value !== 'string') {
    throw new Error('Doubao Work CDP evaluation returned no value');
  }
  try { return JSON.parse(value); } catch (error) {
    throw new Error('Doubao Work CDP evaluation returned invalid JSON', { cause: error });
  }
}

// The overview endpoint only returns the spendable amounts (total_amount /
// used_amount) when the request identifies itself as the Doubao Work desktop
// client. aid=497858 is the public Doubao web app id; web_platform=work_desktop
// marks the caller as the desktop client. Neither msToken nor a_bogus is
// required with these two parameters present. The URL and body stay inlined as
// literals because Runtime.evaluate compiles this string as code.
const OVERVIEW_EXPRESSION = `(async()=>{try{const r=await fetch('/alice/commerce/sale/subscription/overview/?aid=497858&web_platform=work_desktop',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json, text/plain, */*'},body:'{"product_line":"membership"}'});let b=null;try{b=await r.json();}catch(_){b=null;}return JSON.stringify({httpStatus:r.status,body:b});}catch(e){return JSON.stringify({__fetchError:String(e&&e.message||e)});}})()`;

function doubaoHttpError(httpStatus) {
  const error = new Error(`Doubao subscription request returned HTTP ${httpStatus}`);
  error.status = httpStatus === 401 || httpStatus === 403
    ? 'unauthorized'
    : httpStatus === 429
      ? 'sourceRateLimited'
      : 'unavailable';
  return error;
}

function findDoubaoTarget(targets) {
  return targets.find((target) => target
    && typeof target.url === 'string'
    && target.url.startsWith(DOUBAO_TARGET_PREFIX)
    && typeof target.webSocketDebuggerUrl === 'string'
    && target.webSocketDebuggerUrl) || null;
}

function findDoubaoHostPageTarget(targets) {
  return targets.find((target) => target
    && target.type === 'page'
    && typeof target.url === 'string'
    && target.url.startsWith('doubaowork://')
    && typeof target.webSocketDebuggerUrl === 'string'
    && target.webSocketDebuggerUrl) || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The Doubao Work main window runs on doubaowork:// pages; its www.doubao.com
// iframes exist only while a web surface (drive, quota page) is open. Attach a
// hidden embed iframe when none is open so the quota API can be fetched in a
// first-party context. The frame stays in the DOM: later probes reuse it.
async function ensureDoubaoTarget(targets, listTargets, connect, deps = {}) {
  const direct = findDoubaoTarget(targets);
  if (direct) return direct;

  const host = findDoubaoHostPageTarget(targets);
  if (!host) return null;
  const session = await connect(host.webSocketDebuggerUrl);
  try {
    await session.call('Runtime.enable');
    await session.call('Runtime.evaluate', {
      expression: `(function(){var id='token-monitor-doubao-probe';if(document.getElementById(id)){return 'exists';}var f=document.createElement('iframe');f.id=id;f.src='https://www.doubao.com/drive-iframe/drive/home/';f.setAttribute('aria-hidden','true');f.style.display='none';f.style.width='0';f.style.height='0';f.style.border='0';(document.body||document.documentElement).appendChild(f);return 'created';})()`,
      returnByValue: true
    });
  } finally {
    session.close();
  }

  const waitMs = Number(deps.doubaoCdpTargetWaitMs || DOUBAO_TARGET_WAIT_MS);
  const pollMs = Number(deps.doubaoCdpTargetPollMs || DOUBAO_TARGET_POLL_MS);
  const deadline = Date.now() + waitMs;
  for (;;) {
    await sleep(pollMs);
    const fresh = await listTargets();
    const target = findDoubaoTarget(fresh);
    if (target) return target;
    if (Date.now() + pollMs >= deadline) return null;
  }
}

function doubaoStatusFromError(error) {
  if (error?.status === 'unauthorized' || error?.status === 'sourceRateLimited') return error.status;
  if (error?.status === 'timeout' || error?.name === 'AbortError') return 'unavailable';
  return 'unavailable';
}

async function fetchDoubaoLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const port = doubaoCdpPort(env, options);
  const listTargets = (refreshPort = port) => (deps.doubaoCdpListTargets || listCdpTargets)(refreshPort, deps);
  const connect = deps.doubaoCdpConnect || connectCdpSession;
  const source = {
    provider: 'doubao',
    source: 'local',
    sourceDetail: 'app',
    updatedAt,
    windows: []
  };

  let targets;
  try {
    targets = await listTargets();
  } catch (_) {
    // The CDP endpoint ships with the Doubao Work app; ECONNREFUSED means the
    // app is simply not running, which is the setup hint, not a failure.
    return normalizeLimitProvider({ ...source, status: 'notConfigured' });
  }

  try {
    const target = await runWithProbeDeadline(
      async () => ensureDoubaoTarget(targets, listTargets, connect, deps),
      { signal: deps.signal, deadlineMs: deps.doubaoCdpTimeoutMs || DOUBAO_FETCH_TIMEOUT_MS }
    );
    if (!target) {
      return normalizeLimitProvider({ ...source, status: 'notConfigured' });
    }

    const session = await connect(target.webSocketDebuggerUrl);
    let evaluation;
    try {
      evaluation = await evaluateJson(session, OVERVIEW_EXPRESSION);
    } finally {
      session.close();
    }
    if (evaluation && typeof evaluation === 'object' && typeof evaluation.__fetchError === 'string') {
      throw new Error(`Doubao quota fetch failed in app context: ${evaluation.__fetchError}`);
    }
    const httpStatus = Number(evaluation?.httpStatus || 0);
    if (httpStatus < 200 || httpStatus >= 300) throw doubaoHttpError(httpStatus);

    const parsed = parseDoubaoOverview(evaluation?.body);
    return normalizeLimitProvider({
      ...source,
      accountKey: parsed.accountKey,
      accountLabel: 'Doubao Work',
      planLabel: parsed.planLabel,
      ...(parsed.planStatus ? { balance: {
        amount: parsed.windows[0].remaining,
        currency: 'CREDITS',
        planStatus: parsed.planStatus,
        expiresAt: parsed.subscriptionEndsAt
      } } : {}),
      status: 'ok',
      windows: parsed.windows
    });
  } catch (error) {
    if (error?.status === 'notConfigured') {
      return normalizeLimitProvider({ ...source, status: 'notConfigured' });
    }
    const status = ['notConfigured', 'unauthorized', 'sourceRateLimited', 'error'].includes(error?.status)
      ? error.status
      : doubaoStatusFromError(error);
    return normalizeLimitProvider({ ...source, status });
  }
}

module.exports = {
  DOUBAO_CDP_HOST,
  DOUBAO_DEFAULT_CDP_PORT,
  DOUBAO_FETCH_TIMEOUT_MS,
  doubaoCdpListUrl,
  doubaoCdpPort,
  fetchDoubaoLimits,
  parseDoubaoOverview
};
