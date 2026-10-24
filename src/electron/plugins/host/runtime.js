'use strict';

// Trusted host page for one plugin. It owns the plugin's Worker, relays
// messages in both directions and watches the Worker's event loop. Everything
// the Worker sends is treated as untrusted data: main validates it again by
// sender, so this page only bounds size and liveness.
(() => {
  const bridge = window.tmPluginHost;
  const PING_MS = 1000;
  const HANG_MS = 5000;
  let worker = null;
  let workerUrl = '';
  let lastPong = 0;
  let pingSeq = 0;
  let tokens = 200;
  let tokenAt = performance.now();
  let dropped = 0;
  const requests = new Set();
  const capabilityOps = new Set(['data.query', 'data.subscribe', 'data.unsubscribe', 'settings.get', 'settings.update', 'settings.reset']);

  function stop() {
    requests.clear();
    if (worker) worker.terminate();
    worker = null;
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = '';
  }

  function fail(reason, detail) {
    stop();
    bridge.send({ type: 'fatal', reason, detail: String(detail || '').slice(0, 500) });
  }

  function boot(message) {
    stop();
    tokens = 200; tokenAt = performance.now(); dropped = 0;
    workerUrl = URL.createObjectURL(new Blob([String(message.source || '')], { type: 'text/javascript' }));
    try {
      worker = new Worker(workerUrl, { name: 'plugin' });
    } catch (error) {
      fail('boot', error && error.message);
      return;
    }
    lastPong = Date.now();
    const activeWorker = worker;
    worker.onmessage = (event) => {
      if (worker !== activeWorker) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.type === 'pong') {
        lastPong = Date.now();
        return;
      }
      // A plugin cannot impersonate the trusted host heartbeat, or flood IPC
      // before main gets an opportunity to enforce its own budget.
      if (!['ready', 'tick-done', 'interaction-done', 'publish', 'subscribe', 'call', 'log', 'error'].includes(data.type)) return;
      const at = performance.now();
      tokens = Math.min(200, tokens + (at - tokenAt) / 10);
      tokenAt = at;
      const valid = window.TokenMonitorPluginMessage.validMessage(data);
      // This relay validates the wire envelope; main validates query/schema and
      // authority and owns byte/work scheduling. Only matched replies free slots.
      const request = valid && data.type === 'call' && capabilityOps.has(data.op);
      if (request && (requests.size >= 32 || requests.has(data.id))) {
        fail('protocol-rate-limit', 'worker capability request limit');
        return;
      }
      if (!request && tokens < 1) {
        // Losing a request/completion strands promises or the tick scheduler.
        // Fail this worker once; main applies its bounded restart/circuit policy.
        if (['ready', 'tick-done', 'interaction-done', 'call'].includes(data.type)) {
          fail('protocol-rate-limit', 'worker control message budget exceeded');
          return;
        }
        if (++dropped >= 400) fail('flooding', 'worker message budget exceeded');
        return;
      }
      if (!request) tokens -= 1;
      if (!valid) {
        if (data.type === 'call' && Number.isSafeInteger(data.id)) worker.postMessage({ type: 'result', id: data.id, ok: false, error: 'invalid message or message quota exceeded' });
        bridge.send({ type: 'dropped', reason: 'invalid-message', kind: String(data.type).slice(0, 32) });
        return;
      }
      if (request) requests.add(data.id);
      bridge.send(data);
    };
    worker.onmessageerror = () => bridge.send({ type: 'dropped', reason: 'unserializable' });
    worker.onerror = (event) => {
      event.preventDefault();
      bridge.send({ type: 'error', message: String(event.message || 'Uncaught error').slice(0, 500), line: Number(event.lineno) || 0 });
    };
  }

  bridge.onMessage((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'boot') {
      boot(message);
      return;
    }
    if (message.type === 'stop') {
      stop();
      return;
    }
    if (message.type === 'result') requests.delete(message.id);
    if (worker) worker.postMessage(message);
  });

  // A Worker stuck in synchronous code never answers a ping. Async waits keep
  // the event loop free, so they are not mistaken for a hang.
  setInterval(() => {
    if (!worker) return;
    if (Date.now() - lastPong > HANG_MS) {
      fail('hung', `no response for ${HANG_MS} ms`);
      return;
    }
    pingSeq += 1;
    worker.postMessage({ type: 'ping', seq: pingSeq });
  }, PING_MS);

  setInterval(() => bridge.send({ type: 'heartbeat' }), 2000);
  bridge.send({ type: 'host-ready' });
})();
