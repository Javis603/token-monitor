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

function richPreload(reply) {
  const listeners = new Map(), calls = []; let tm;
  const ipcRenderer = {
    on(name, listener) { const entries = listeners.get(name) || []; entries.push(listener); listeners.set(name, entries); },
    removeListener() {},
    invoke(channel, op, args) { calls.push(op); return reply(op, args); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/webPreload.js'), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(_name, value) { tm = value; } } }),
    window: { addEventListener() {} }, clearTimeout, setTimeout
  });
  const emit = (name, value) => { for (const listener of listeners.get(name) || []) listener({}, value); };
  return { tm: () => tm, calls, emit };
}
const ok = value => Promise.resolve({ __tmCapability: 1, ok: true, value });
const failed = (code, message = code) => Promise.resolve({ __tmCapability: 1, ok: false, error: { message, code, fields: {} } });

test('Rich preload unwraps errors and reveals a resumed document only after replayed subscriptions deliver', async () => {
  let resume;
  const bridge = richPreload(op => {
    if (op === 'resumed') return new Promise(resolve => { resume = resolve; });
    if (op === 'settings.update') return Promise.resolve({ __tmCapability: 1, ok: false, error: { message: 'invalid', code: 'invalid-settings-values', fields: { count: 'range' } } });
    return ok(op === 'settings.get' ? { revision: 7 } : true);
  });
  const tm = bridge.tm(), { calls } = bridge;
  await assert.rejects(tm.settings.update({}), error => error.code === 'invalid-settings-values' && error.fields.count === 'range');
  const received = []; tm.settings.onChange(() => { throw new Error('observer'); }); tm.settings.onChange(value => received.push(value));
  const snapshots = []; tm.data.subscribe({}, value => snapshots.push(value)); await flush(); calls.length = 0;
  bridge.emit('plugins:web:resume', 3);
  assert.deepEqual(calls, ['resumed']); resume(true); await flush();
  assert.deepEqual(calls, ['resumed', 'data.subscribe', 'settings.get']); assert.equal(received[0].revision, 7);
  // Registration alone is not fresh data: the reveal waits for the snapshot.
  await flush(); assert.equal(calls.includes('refreshed'), false);
  bridge.emit('plugins:web:business', { id: 'q1', value: { type: 'snapshot', value: 'fresh' } }); await flush();
  assert.deepEqual(calls.slice(-1), ['refreshed']); assert.deepEqual(snapshots, [{ type: 'snapshot', value: 'fresh' }]);
});

test('Rich preload keeps a subscription interrupted by parking and replays it on resume', async () => {
  let pending;
  const bridge = richPreload(op => {
    if (op === 'data.subscribe' && !pending) return new Promise(resolve => { pending = resolve; });
    return ok(true);
  });
  const tm = bridge.tm(), { calls } = bridge;
  const events = []; tm.data.subscribe({ version: 1, resource: 'sessions' }, value => events.push(value));
  await flush(); pending({ __tmCapability: 1, ok: false, error: { message: 'capability suspended', code: 'capability-suspended', fields: {} } }); await flush();
  assert.deepEqual(events, [], 'a lifecycle interruption is not an author-visible error');
  calls.length = 0; bridge.emit('plugins:web:resume', 2); await flush();
  assert.deepEqual(calls, ['resumed', 'data.subscribe']);
  bridge.emit('plugins:web:business', { id: 'q1', value: { type: 'snapshot', value: 1 } }); await flush();
  assert.deepEqual(events, [{ type: 'snapshot', value: 1 }]); assert.equal(calls.at(-1), 'refreshed');
});

test('Rich preload reports a real subscription failure once and does not wait on it during resume', async () => {
  const bridge = richPreload(op => op === 'data.subscribe' ? failed('denied') : ok(true));
  const tm = bridge.tm(), { calls } = bridge;
  const events = []; tm.data.subscribe({}, value => events.push(value)); await flush();
  assert.deepEqual(events.map(event => event.code), ['denied']);
  calls.length = 0; bridge.emit('plugins:web:resume', 4); await flush();
  assert.deepEqual(calls, ['resumed', 'refreshed']);
});
