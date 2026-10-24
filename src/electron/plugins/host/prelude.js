'use strict';

// Runs first inside every plugin Worker and defines the `tm` global, the
// plugin's whole API. Each call becomes a message the host validates by
// sender; nothing here is a security boundary, it is only the convenient
// shape of the protocol.
(() => {
  const post = self.postMessage.bind(self);
  const tickHandlers = [];
  const actionHandlers = new Map();
  let actions = Promise.resolve();
  const subscriptions = new Map();
  const latest = new Map();
  const pending = new Map();
  const dataSubscriptions = new Map();
  const settingsListeners = new Set();
  let dataSeq = 0;
  let callSeq = 0;
  let mode = 'idle';
  let lifecycle = 0;

  function describe(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function report(error) {
    post({ type: 'error', message: describe(error).slice(0, 500) });
  }

  function call(op, args) {
    return new Promise((resolve, reject) => {
      callSeq += 1;
      pending.set(callSeq, { resolve, reject, op });
      post({ type: 'call', id: callSeq, op, args });
    });
  }

  self.addEventListener('message', async (event) => {
    const message = event.data || {};
    if (message.type === 'ping') {
      post({ type: 'pong', seq: message.seq });
    } else if (message.type === 'tick') {
      mode = message.mode;
      const runs = tickHandlers.map((handler) => Promise.resolve()
        .then(() => handler({ mode: message.mode, now: message.now }))
        .catch(report));
      await Promise.all(runs);
      post({ type: 'tick-done', seq: message.seq });
    } else if (message.type === 'interaction') {
      actions = actions.then(async () => {
        const handler = actionHandlers.get(message.event?.action);
        if (typeof handler === 'function') await handler({ ...message.event, view: message.view, surface: message.surface });
      }).catch(report).finally(() => post({ type: 'interaction-done', seq: message.seq }));
    } else if (message.type === 'data') {
      latest.set(message.source, message.value);
      for (const handler of subscriptions.get(message.source) || []) {
        try { handler(message.value); } catch (error) { report(error); }
      }
    } else if (message.type === 'author-settings') {
      for (const listener of settingsListeners) { try { listener(message.value); } catch (error) { report(error); } }
    } else if (message.type === 'business-data') {
      const entry = dataSubscriptions.get(message.id);
      if (entry) { try { entry.callback(message.value); } catch (error) { report(error); } }
    } else if (message.type === 'mode') {
      const previous = mode;
      mode = message.mode;
      if (mode === 'idle') {
        lifecycle++;
        for (const [id, entry] of pending) {
          if (!/^(data|settings)\./.test(entry.op)) continue;
          pending.delete(id);
          entry.reject(Object.assign(new Error('capability suspended'), { code: 'capability-suspended' }));
        }
      }
      if (previous === 'idle' && mode !== 'idle') {
        for (const [id, entry] of dataSubscriptions) void call('data.subscribe', { id, query: entry.query }).catch(report);
        if (settingsListeners.size) void call('settings.get', {}).then(value => {
          for (const listener of settingsListeners) { try { listener(value); } catch (error) { report(error); } }
        }).catch(report);
      }
    } else if (message.type === 'result') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else {
        const detail = message.error;
        entry.reject(Object.assign(new Error(detail?.message || detail || 'Request failed'), { code: message.code ?? detail?.code, fields: message.fields ?? detail?.fields }));
      }
    }
  });

  self.addEventListener('unhandledrejection', (event) => report(event.reason));

  const tm = Object.freeze({
    apiVersion: 1,
    get mode() { return mode; },
    onAction(action, handler) {
      if (typeof action === 'string' && typeof handler === 'function' && actionHandlers.size < 200) actionHandlers.set(action, handler);
    },
    onTick(handler) {
      if (typeof handler === 'function') tickHandlers.push(handler);
    },
    subscribe(source, handler) {
      const id = String(source);
      if (!subscriptions.has(id)) {
        subscriptions.set(id, new Set());
        post({ type: 'subscribe', source: id });
      }
      if (typeof handler === 'function') subscriptions.get(id).add(handler);
    },
    read(source) {
      return latest.has(String(source)) ? latest.get(String(source)) : null;
    },
    publish(metric, value) {
      post({ type: 'publish', metric: String(metric), value });
    },
    settings: Object.freeze({
      get: () => call('settings.get', {}),
      update: input => call('settings.update', input),
      reset: input => call('settings.reset', input),
      onChange(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback required');
        settingsListeners.add(callback); return () => settingsListeners.delete(callback);
      }
    }),
    data: Object.freeze({
      query: query => call('data.query', { query }),
      subscribe(query, callback) {
        if (typeof callback !== 'function') throw new TypeError('callback required');
        if (dataSubscriptions.size >= 16) throw new Error('subscription limit');
        const id = `q${++dataSeq}`;
        dataSubscriptions.set(id, { query, callback });
        const epoch = lifecycle;
        void call('data.subscribe', { id, query }).catch(error => { if (epoch === lifecycle) dataSubscriptions.delete(id); report(error); });
        return () => { dataSubscriptions.delete(id); void call('data.unsubscribe', { id }).catch(report); };
      }
    }),
    storage: Object.freeze({
      get: (key) => call('storage.get', { key: String(key) }),
      set: (key, value) => call('storage.set', { key: String(key), value }),
      delete: (key) => call('storage.delete', { key: String(key) })
    }),
    notify: (options) => call('notify', options || {}),
    net: Object.freeze({
      fetch: (url, init) => call('net.fetch', { url: String(url), init: init || {} })
    }),
    log: (...args) => post({ type: 'log', level: 'info', text: args.map(describe).join(' ').slice(0, 1000) }),
    warn: (...args) => post({ type: 'log', level: 'warn', text: args.map(describe).join(' ').slice(0, 1000) })
  });
  Object.defineProperty(self, 'tm', { value: tm, enumerable: true });
})();
