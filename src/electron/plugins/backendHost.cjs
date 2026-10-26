'use strict';

// Trusted Node code. This process boundary isolates crashes, not credentials or files.
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const port = process.parentPort;
const [entry, dataDirectory] = process.argv.slice(2);
const pending = new Map();
let nextId = 0, instance, closing = false;
const send = message => port.postMessage(message);
const callHost = (method, args) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  send({ type: 'host-call', id, method, args });
});
port.on('message', async ({ data: message }) => {
  if (message.type === 'host-reply') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    return;
  }
  if (closing) return;
  try {
    if (message.type === 'call') {
      if (typeof instance?.call !== 'function') throw new Error('Plugin backend does not implement call');
      const value = await instance.call(message.method, message.args);
      send({ type: 'reply', id: message.id, value });
    } else if (message.type === 'context') await instance?.update?.(message.value);
    else if (message.type === 'stop') {
      closing = true;
      await instance?.dispose?.();
      process.exit(0);
    }
  } catch (error) {
    send({ type: message.type === 'call' ? 'reply' : 'error', id: message.id, error: String(error?.message || error) });
  }
});
(async () => {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const module = await import(pathToFileURL(entry).href);
  const activate = module.activate || module.default?.activate;
  if (typeof activate !== 'function') throw new Error('Plugin backend must export activate(context)');
  instance = await activate({ dataDirectory, host: { call: callHost },
    publish: value => send({ type: 'data', value }),
    log: message => send({ type: 'log', value: String(message) }) });
  send({ type: 'ready' });
})().catch(error => { send({ type: 'error', error: String(error?.stack || error) }); process.exit(1); });
