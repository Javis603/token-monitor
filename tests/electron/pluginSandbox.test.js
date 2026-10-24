'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPluginSandbox } = require('../../src/electron/plugins/sandbox');
const wire = require('../../src/electron/plugins/host/message');

test('bounded JSON envelopes reject binary, cycles, excessive depth and malformed scalars', () => {
  const circular = {}; circular.self = circular;
  let deep = 1; for (let i = 0; i < 30; i++) deep = { child: deep };
  for (const extra of [new ArrayBuffer(8 * 1024 * 1024), new Map(), new Set(), new Uint8Array(8), circular, deep, 'x'.repeat(70 * 1024)]) {
    assert.equal(wire.validMessage({ type: 'log', text: 'binary', extra }), false);
  }
  assert.equal(wire.validMessage({ type: 'subscribe', source: { toString: 0 } }), false);
  assert.equal(wire.validMessage({ type: 'publish', metric: 'cpu', value: 42 }), true);
  assert.equal(wire.validMessage({ type: 'heartbeat' }), false);
});

test('trusted host never forwards structured-clone binary across the bridge', () => {
  const forwarded = [];
  let receive, worker;
  class Worker {
    constructor() { worker = this; }
    terminate() {}
    postMessage() {}
  }
  const context = vm.createContext({ window: { tmPluginHost: { send: m => forwarded.push(m), onMessage: cb => { receive = cb; } } },
    TextEncoder, performance, Worker, Blob, URL, setInterval() {} });
  const host = path.resolve(__dirname, '../../src/electron/plugins/host');
  vm.runInContext(fs.readFileSync(path.join(host, 'message.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(host, 'runtime.js'), 'utf8'), context);
  receive({ type: 'boot', source: '' });
  // Build payloads in the same realm as the browser-side validator.
  context.deliver = message => worker.onmessage({ data: message });
  vm.runInContext("deliver({type:'log',text:'binary',extra:new ArrayBuffer(8*1024*1024)}); deliver({type:'log',text:'valid'});", context);
  assert.equal(forwarded.some(m => m.extra), false);
  assert.equal(forwarded.filter(m => m.type === 'log').length, 1);
});

test('late failure callbacks from a retired host cannot stop its replacement', async () => {
  const windows = [];
  class Window {
    constructor() {
      windows.push(this);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { ipc: new EventEmitter(), setWindowOpenHandler() {}, setWebRTCIPHandlingPolicy() {}, send() {}, isDestroyed: () => this.destroyed });
    }
    loadURL() { return new Promise((resolve, reject) => { this.rejectLoad = reject; }); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return Boolean(this.destroyed); }
  }
  const session = { fromPartition: () => ({ protocol: { handle() {} }, webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} }) };
  const exits = [];
  const sandbox = createPluginSandbox({ electron: { BrowserWindow: Window, session, app: { getAppMetrics: () => [] } }, onMessage() {}, onExit: (...args) => exits.push(args) });
  const options = { codeFile: path.resolve(__dirname, '../../docs/plugins/examples/token-pulse/main.js') };
  sandbox.start('pulse', options);
  sandbox.start('pulse', options);
  windows[0].rejectLoad(new Error('retired'));
  windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  windows[0].webContents.emit('did-fail-load', {}, -1, 'retired');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows[1].isDestroyed(), false);
  assert.equal(sandbox.isRunning('pulse'), true);
  assert.deepEqual(exits, []);
  sandbox.stopAll();
});

for (const message of [{ type: 'tick-done', seq: 1 }, { type: 'call', id: 1, op: 'storage.get', args: { key: 'x' } }]) {
  test(`host recovers instead of silently losing ${message.type} after a short burst`, () => {
    const forwarded = [];
    let receive, worker;
    class Worker {
      constructor() { worker = this; this.stopped = false; }
      terminate() { this.stopped = true; }
      postMessage() {}
    }
    const context = vm.createContext({ window: { tmPluginHost: { send: m => forwarded.push(m), onMessage: cb => { receive = cb; } } },
      TextEncoder, performance: { now: () => 0 }, Worker, Blob, URL, setInterval() {} });
    const host = path.resolve(__dirname, '../../src/electron/plugins/host');
    for (const file of ['message.js', 'runtime.js']) vm.runInContext(fs.readFileSync(path.join(host, file), 'utf8'), context);
    receive({ type: 'boot', source: '' });
    context.deliver = message => worker.onmessage({ data: message });
    vm.runInContext(`for(let i=0;i<200;i++) deliver({type:'log',text:'burst'}); deliver(${JSON.stringify(message)});`, context);
    assert.equal(worker.stopped, true);
    assert.equal(forwarded.at(-1).type, 'fatal');
    assert.equal(forwarded.at(-1).reason, 'protocol-rate-limit');
    receive({ type: 'boot', source: '' });
    vm.runInContext("deliver({type:'ready'});", context);
    assert.equal(forwarded.at(-1).type, 'ready', 'replacement gets a fresh budget');
  });
}

function capabilityHost(t) {
  const forwarded = [], replies = [], intervals = [];
  let receive, worker;
  class Worker {
    constructor() { worker = this; this.stopped = false; }
    terminate() { this.stopped = true; }
    postMessage(value) { replies.push(value); }
  }
  const context = vm.createContext({ window: { tmPluginHost: { send: m => forwarded.push(m), onMessage: cb => { receive = cb; } } },
    TextEncoder, performance: { now: () => 0 }, Worker, Blob, URL, setInterval(fn) { intervals.push(fn); } });
  const host = path.resolve(__dirname, '../../src/electron/plugins/host');
  for (const file of ['message.js', 'runtime.js']) vm.runInContext(fs.readFileSync(path.join(host, file), 'utf8'), context);
  receive({ type: 'boot', source: '' });
  context.deliver = message => worker.onmessage({ data: message });
  t.after(() => receive({ type: 'stop' }));
  return { forwarded, replies, receive, worker: () => worker, send(message) { context.raw = JSON.stringify(message); vm.runInContext('deliver(JSON.parse(raw))', context); } };
}
test('Worker host relay permits 2000 matched query/settings round trips without spending unsolicited budget', t => {
  const h = capabilityHost(t); let id = 0;
  for (let i = 0; i < 2000; i++) for (const op of ['data.query', 'settings.get']) {
    const message = { type: 'call', id: ++id, op, args: op === 'data.query' ? { query: { version: 1, resource: 'sessions', page: { limit: 1 } } } : {} };
    h.send(message); assert.equal(h.forwarded.at(-1).id, id);
    h.receive({ type: 'result', id, ok: true, value: {} });
  }
  assert.equal(h.worker().stopped, false); assert.equal(h.replies.filter(m => m.type === 'result').length, 4000);
  for (let i = 0; i < 200; i++) h.send({ type: 'log', text: 'burst' });
  h.send({ type: 'tick-done', seq: 1 }); assert.equal(h.worker().stopped, true, 'unsolicited bucket remains intact');
});
for (const mode of ['overflow', 'duplicate', 'forged-reply']) test(`Worker host request slots reject ${mode} before IPC flood`, t => {
  const h = capabilityHost(t);
  const send = id => h.send({ type: 'call', id, op: 'settings.get', args: {} });
  send(1);
  if (mode === 'duplicate') send(1);
  else {
    for (let i = 2; i <= 32; i++) send(i);
    if (mode === 'forged-reply') h.send({ type: 'result', id: 1, ok: true });
    send(33);
  }
  assert.equal(h.worker().stopped, true); assert.equal(h.forwarded.at(-1).reason, 'protocol-rate-limit');
  assert.ok(h.forwarded.filter(m => m.type === 'call').length <= 32);
});
