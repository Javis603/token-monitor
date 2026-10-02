'use strict';

const fs = require('node:fs');
const { Agent, EnvHttpProxyAgent, WebSocket } = require('undici');
const { resolveProxyConfig } = require('../../outboundFetch');
const { appVersion } = require('../../appVersion');
const { codexOAuthRequestContext, hashAccountKey } = require('./auth');
const { codexHomeDir } = require('./sessionMetadata');
const { localExecutorIds, localThreadEnvironment } = require('./localExecutor');
const { createLocalUsageStore } = require('./localUsageStore');

const APP_SERVER_URL = 'wss://codex-cloud-backend.chatgpt.com/';

function readAuth(options) {
  try {
    const auth = JSON.parse(fs.readFileSync(`${codexHomeDir(options)}/auth.json`, 'utf8'));
    return codexOAuthRequestContext(auth);
  } catch (_) {
    return null;
  }
}

function createLocalUsageSource(options = {}, deps = {}) {
  const env = options.env || process.env;
  const abortController = new AbortController();
  const store = options.store || createLocalUsageStore(options);
  const makeSocket = deps.makeSocket || ((context) => {
    const proxy = resolveProxyConfig(env);
    const dispatcher = proxy.httpProxy || proxy.httpsProxy
      ? new EnvHttpProxyAgent(proxy) : new Agent({ connect: { timeout: 15000 } });
    const socket = new WebSocket(APP_SERVER_URL, {
      protocols: ['codex-app-server', 'codex-client.desktop', `openai-bearer.${context.accessToken}`],
      headers: {
        'X-OpenAI-Product-Sku': 'codex', originator: 'token-monitor',
        'User-Agent': `Token-Monitor/${appVersion()}`,
        'ChatGPT-Account-Id': context.accountId
      }, dispatcher
    });
    return { socket, destroy: () => dispatcher.destroy().catch(() => {}) };
  });
  const findExecutors = deps.localExecutorIds || (() => localExecutorIds({ ...options, signal: abortController.signal }));
  const authContext = deps.readAuth || (() => readAuth(options));
  const now = deps.now || (() => new Date());
  const pollMs = deps.pollMs || 5000;
  const requestTimeoutMs = deps.requestTimeoutMs || 15000;
  const threads = new Map();
  const pending = new Map();
  const subscribing = new Set();
  let executorIds = new Set();
  let connection = null;
  let context = null;
  let timer = null;
  let handshakeTimer = null;
  let busy = false;
  let stopped = false;
  let started = false;
  let counter = 0;
  let retryAt = 0;
  let failures = 0;
  let discovery = Promise.resolve();
  let executorScan = Promise.resolve();
  let state = 'waiting';
  let lastFailureCode = null;
  let lastUsageAt = null;

  function changed() {
    if (!stopped) options.onChange?.();
  }

  function disconnect(code = null) {
    const previous = connection;
    connection = null;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex local usage connection closed'));
    }
    pending.clear();
    threads.clear();
    subscribing.clear();
    if (previous) {
      try { previous.socket.close(); } catch (_) { /* Dispatcher closes the socket too. */ }
      previous.destroy?.();
    }
    if (code) {
      state = 'retrying';
      lastFailureCode = code;
      retryAt = Date.now() + Math.min(60000, pollMs * 2 ** Math.min(failures++, 4));
    } else state = stopped ? 'stopped' : 'waiting';
  }

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!connection || connection.socket.readyState !== 1) return reject(new Error('Codex local usage disconnected'));
      const id = ++counter;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex local usage request timed out'));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer: timeout });
      try { connection.socket.send(JSON.stringify({ id, method, params })); } catch (_) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(new Error('Codex local usage request failed'));
      }
    });
  }

  async function subscribe(thread, current) {
    const local = localThreadEnvironment(thread, executorIds);
    if (!local) {
      if (thread?.id && threads.has(thread.id)) {
        threads.delete(thread.id);
        if (store.updateThread(hashAccountKey(context.accountId), thread.id, { nativeBacked: Boolean(thread.path) })) changed();
      }
      return;
    }
    const previous = threads.get(thread.id);
    if (previous) {
      previous.thread = thread;
      previous.local = local;
      if (store.updateThread(hashAccountKey(context.accountId), thread.id, {
        title: String(thread.name || '').trim(), turnEnded: thread.status?.type === 'idle'
      })) changed();
      return;
    }
    if (subscribing.has(thread.id)) return;
    subscribing.add(thread.id);
    // Install metadata before resume: the server can notify while its reply
    // is in flight. No turn/configuration/approval request is ever sent.
    threads.set(thread.id, { thread, local });
    try {
      await request('thread/resume', { threadId: thread.id, excludeTurns: true });
    } catch (_) {
      if (connection === current) threads.delete(thread.id);
    } finally {
      subscribing.delete(thread.id);
    }
  }

  async function discover(current) {
    let cursor = null;
    const cursors = new Set();
    do {
      const page = await request('thread/list', {
        archived: false, limit: 100, sortKey: 'updated_at', sortDirection: 'desc',
        originators: ['codex_work_cca'], ...(cursor ? { cursor } : {})
      });
      if (stopped || connection !== current) return;
      const candidates = Array.isArray(page.data) ? page.data : [];
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (!stopped && connection === current && index < candidates.length) {
          const thread = candidates[index++];
          await subscribe(thread, current);
        }
      }));
      cursor = page.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error('Codex local usage invalid pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  function notification(message, current) {
    const params = message.params || {};
    if (message.method === 'thread/started') {
      void subscribe(params.thread, current).catch(() => disconnect('local-usage-store-failed'));
      return;
    }
    const entry = threads.get(params.threadId);
    if (!entry || !localThreadEnvironment(entry.thread, executorIds)) return;
    const accountKey = hashAccountKey(context.accountId);
    if (message.method === 'model/rerouted' && params.toModel) entry.thread.model = params.toModel;
    if (message.method === 'thread/tokenUsage/updated') {
      if (store.observe({
        accountKey, thread: entry.thread, ...entry.local, turnId: params.turnId,
        tokenUsage: params.tokenUsage, now: now()
      })) {
        lastUsageAt = now().toISOString();
        changed();
      }
    } else if (message.method === 'turn/started' || message.method === 'turn/completed') {
      const ended = message.method === 'turn/completed';
      entry.thread.status = { type: ended ? 'idle' : 'active' };
      if (store.updateThread(accountKey, params.threadId, { turnEnded: ended })) changed();
    } else if (message.method === 'thread/name/updated') {
      entry.thread.name = params.threadName || '';
      if (store.updateThread(accountKey, params.threadId, { title: entry.thread.name })) changed();
    } else if (message.method === 'thread/environment/disconnected') {
      if (params.environmentId === entry.local.environmentId) threads.delete(params.threadId);
    }
  }

  function connect(next) {
    context = next;
    state = 'connecting';
    const current = makeSocket(next);
    connection = current;
    const socket = current.socket;
    const active = () => !stopped && connection === current;
    handshakeTimer = setTimeout(() => { if (active()) disconnect('local-usage-connect-timeout'); }, requestTimeoutMs);
    socket.addEventListener('open', () => {
      if (!active()) return;
      discovery = request('initialize', {
        clientInfo: { name: 'token_monitor', version: appVersion() }, capabilities: { experimentalApi: true }
      }).then(async () => {
        if (!active()) return;
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
        socket.send(JSON.stringify({ method: 'initialized', params: {} }));
        state = 'connected';
        lastFailureCode = null;
        failures = 0;
        busy = true;
        await discover(current);
      }).catch(() => { if (active()) disconnect('local-usage-discovery-failed'); })
        .finally(() => { busy = false; });
    });
    socket.addEventListener('message', (event) => {
      if (!active() || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      // Ignore requests (including approvals) and all message/tool content.
      if (message.id != null) {
        if (message.method) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error('Codex local usage RPC rejected'));
        else item.resolve(message.result);
        return;
      }
      try { notification(message, current); } catch (_) { disconnect('local-usage-store-failed'); }
    });
    socket.addEventListener('close', () => { if (active()) disconnect('local-usage-disconnected'); });
    socket.addEventListener('error', () => { if (active()) disconnect('local-usage-connect-failed'); });
  }

  async function poll() {
    if (stopped) return;
    try {
      const next = authContext();
      const ids = next?.accessToken && next.accountId && !next.isFedrampAccount ? await findExecutors() : new Set();
      if (stopped) return;
      const ownerChanged = [...executorIds].sort().join() !== [...ids].sort().join();
      executorIds = ids;
      if (!next?.accessToken || !next.accountId || !ids.size || next.isFedrampAccount) {
        disconnect();
      } else if (connection && (ownerChanged || context.accessToken !== next.accessToken || context.accountId !== next.accountId)) {
        disconnect();
      }
      if (next?.accessToken && next.accountId && ids.size && !next.isFedrampAccount) {
        if (!connection && Date.now() >= retryAt) connect(next);
        else if (state === 'connected' && !busy) {
          busy = true;
          const current = connection;
          discovery = discover(current).catch(() => { if (connection === current) disconnect('local-usage-discovery-failed'); })
            .finally(() => { busy = false; });
        }
      }
    } catch (_) {
      disconnect('local-usage-connect-failed');
    }
    if (!stopped) timer = setTimeout(() => { executorScan = poll(); }, pollMs);
  }

  return {
    store,
    start() { if (!started && !stopped) { started = true; executorScan = poll(); } },
    stop() {
      stopped = true;
      abortController.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      disconnect();
      if (!options.store) store.close();
    },
    whenIdle: () => Promise.all([executorScan, discovery]).then(() => {}),
    getDiagnostics: () => ({ state, subscriptions: threads.size, localExecutors: executorIds.size, lastFailureCode, lastUsageAt })
  };
}

module.exports = { createLocalUsageSource };
