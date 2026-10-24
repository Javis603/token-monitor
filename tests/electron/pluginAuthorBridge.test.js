'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Worker idle rejects pending calls, retains subscriptions, resumes with current settings and structured errors', async () => {
  const sent = [], handlers = {};
  const self = { postMessage: message => sent.push(message), addEventListener: (name, fn) => { handlers[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/host/prelude.js'), 'utf8'), { self });
  const message = data => handlers.message({ data });
  const changes = [];
  self.tm.settings.onChange(value => changes.push(value));
  await message({ type: 'mode', mode: 'visible' });
  const off = self.tm.data.subscribe({ version: 1, resource: 'usage' }, () => {});
  const old = sent.findLast(value => value.op === 'data.subscribe');
  const pending = self.tm.settings.get(); const rejected = assert.rejects(pending, error => error.code === 'capability-suspended');
  await message({ type: 'mode', mode: 'idle' }); await rejected; await flush();
  await message({ type: 'result', id: old.id, ok: true, value: true });
  await message({ type: 'mode', mode: 'visible' });
  assert.equal(sent.filter(value => value.op === 'data.subscribe').length, 2);
  const current = sent.findLast(value => value.op === 'settings.get');
  await message({ type: 'result', id: current.id, ok: true, value: { revision: 9, values: { count: 2 } } }); await flush();
  assert.equal(changes.at(-1).revision, 9);
  const failure = self.tm.settings.update({});
  const check = assert.rejects(failure, error => error.code === 'invalid-settings-values' && error.fields.count === 'range');
  const request = sent.findLast(value => value.op === 'settings.update');
  await message({ type: 'result', id: request.id, ok: false, error: 'invalid', code: 'invalid-settings-values', fields: { count: 'range' } }); await check;
  off();
});

test('Rich preload unwraps errors and waits for resumed acknowledgement before refreshing subscriptions/settings', async () => {
  const listeners = new Map(), calls = []; let tm, resume;
  const ipcRenderer = {
    on(name, listener) { const entries = listeners.get(name) || []; entries.push(listener); listeners.set(name, entries); },
    removeListener() {},
    invoke(channel, op) {
      calls.push(op);
      if (op === 'resumed') return new Promise(resolve => { resume = resolve; });
      if (op === 'settings.update') return Promise.resolve({ __tmCapability: 1, ok: false, error: { message: 'invalid', code: 'invalid-settings-values', fields: { count: 'range' } } });
      return Promise.resolve({ __tmCapability: 1, ok: true, value: op === 'settings.get' ? { revision: 7 } : true });
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/webPreload.js'), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { tm = value; } } }),
    window: { addEventListener() {} }, clearTimeout, setTimeout
  });
  await assert.rejects(tm.settings.update({}), error => error.code === 'invalid-settings-values' && error.fields.count === 'range');
  const received = []; tm.settings.onChange(() => { throw new Error('observer'); }); tm.settings.onChange(value => received.push(value));
  tm.data.subscribe({}, () => {}); await flush(); calls.length = 0;
  for (const listener of listeners.get('plugins:web:resume')) listener({}, 3);
  assert.deepEqual(calls, ['resumed']); resume(true); await flush();
  assert.deepEqual(calls, ['resumed', 'data.subscribe', 'settings.get']); assert.equal(received[0].revision, 7);
});
