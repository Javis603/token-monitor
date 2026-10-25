'use strict';
const { workerSource } = require('../../src/electron/plugins/sandbox');
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
test('Worker actions serialize async handlers, acknowledge errors and continue to the next action', async () => {
  const messages = [], listeners = {}, events = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const self = { postMessage: value => messages.push(value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext(Object.assign(self, { self, Error, TextEncoder }));
  vm.runInContext(workerSource(''), context);
  self.tm.onAction('first', async event => { events.push(event.surface); await gate; events.push('released'); });
  self.tm.onAction('bad', () => { throw new Error('broken action'); });
  self.tm.onAction('last', () => events.push('last'));
  self.tm.onAction('not-callable', {});
  for (const [index, action] of ['first', 'bad', 'last', '__proto__', 'not-callable'].entries()) await listeners.message({ data: { type: 'interaction', seq: index + 1, view: 'test', surface: 'page', event: { action, type: 'press' } } });
  assert.deepEqual(events, ['page']); release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['page', 'released', 'last']);
  assert.deepEqual(messages.filter(m => m.type === 'interaction-done').map(m => m.seq), [1, 2, 3, 4, 5]);
  // Completions say how each action ended, so a Rich tm.send can reject.
  assert.deepEqual(messages.filter(m => m.type === 'interaction-done').map(m => m.result), ['done', 'failed', 'done', 'unhandled', 'unhandled']);
  assert.equal(messages.find(m => m.type === 'interaction-done' && m.seq === 3).value, 3, 'a return value rides the completion');
  assert(messages.some(m => m.type === 'error' && m.message.includes('broken action')));
});
test('Worker action return values must be plain JSON within the completion budget', async () => {
  const messages = [], listeners = {};
  const self = { postMessage: value => messages.push(value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext(Object.assign(self, { self, Error, TextEncoder }));
  vm.runInContext(workerSource(''), context);
  vm.runInContext("tm.onAction('test', async () => ({ ok: true, latencyMs: 42, models: ['a', 'b'] }))", context);
  self.tm.onAction('huge', () => 'x'.repeat(61 * 1024));
  self.tm.onAction('circular', () => { const value = {}; value.self = value; return value; });
  self.tm.onAction('fn', () => () => 1);
  for (const [index, action] of ['test', 'huge', 'circular', 'fn'].entries()) await listeners.message({ data: { type: 'interaction', seq: index + 1, view: 'settings', surface: 'web', event: { action, type: 'send' } } });
  await new Promise(resolve => setImmediate(resolve));
  const done = messages.filter(m => m.type === 'interaction-done');
  assert.deepEqual(JSON.parse(JSON.stringify(done.map(m => [m.result, m.value]))), [['done', { ok: true, latencyMs: 42, models: ['a', 'b'] }], ['unreturnable', null], ['unreturnable', null], ['unreturnable', null]]);
});
test('an action-only wake keeps data subscriptions suspended until the Worker is live', async () => {
  const messages = [], listeners = {};
  const self = { postMessage: value => messages.push(value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext(Object.assign(self, { self, Error, TextEncoder }));
  vm.runInContext(workerSource(''), context);
  self.tm.data.subscribe({ version: 1, resource: 'usage' }, () => {});
  const first = messages.find(m => m.type === 'call' && m.op === 'data.subscribe');
  await listeners.message({ data: { type: 'result', id: first.id, ok: false, error: { message: 'capability suspended', code: 'capability-suspended' } } });
  await listeners.message({ data: { type: 'mode', mode: 'action' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.filter(m => m.op === 'data.subscribe').length, 1, 'action mode does not replay subscriptions');
  assert.equal(messages.some(m => m.type === 'error'), false, 'a suspension is not reported as an error');
  await listeners.message({ data: { type: 'mode', mode: 'visible' } });
  assert.equal(messages.filter(m => m.op === 'data.subscribe').length, 2, 'the kept subscription replays once live');
});
test('every rejected action return still produces a deliverable completion', async () => {
  const messages = [], listeners = {};
  const self = { postMessage: value => messages.push(value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(workerSource(`
    tm.onAction('deep', () => { let v = {}; for (let i = 0; i < 18; i++) v = { nested: v }; return v; });
    tm.onAction('many', () => Array(3000).fill(0));
    tm.onAction('date', () => new Date());
    tm.onAction('nan', () => NaN);
    tm.onAction('nestedFunction', () => ({ fn() {} }));
  `), Object.assign(self, { self, TextEncoder }));
  for (const [index, action] of ['deep', 'many', 'date', 'nan', 'nestedFunction'].entries()) await listeners.message({ data: { type: 'interaction', seq: index + 1, event: { action } } });
  await new Promise(resolve => setImmediate(resolve));
  const done = messages.filter(m => m.type === 'interaction-done');
  assert.equal(done.length, 5);
  const { validMessage } = require('../../src/electron/plugins/host/message');
  for (const completion of done) {
    assert.equal(completion.result, 'unreturnable');
    assert.equal(validMessage(JSON.parse(JSON.stringify(completion))), true);
  }
});
test('Sketch Pad restores saved content and keeps drawing output within budgets', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../docs/plugins/examples/sketch-pad/main.js'), 'utf8');
  const storage = new Map(), metrics = new Map();
  async function start() {
    const actions = new Map();
    const tm = { storage: { get: async k => storage.get(k), set: async (k,v) => storage.set(k,v) }, onTick() {}, onAction: (k,fn) => actions.set(k,fn), publish: (k,v) => metrics.set(k,structuredClone(v)), warn() {} };
    vm.runInNewContext(source, { tm }); await new Promise(resolve => setImmediate(resolve)); return actions;
  }
  let actions = await start(); await actions.get('note')({ value: 'My personal content' });
  for (let stroke = 0; stroke < 5; stroke++) {
    await actions.get('canvas')({ type: 'pointerdown', x: 20, y: 20 });
    for (let n = 0; n < 60; n++) await actions.get('canvas')({ type: 'pointermove', x: n * 3, y: 40 });
    await actions.get('canvas')({ type: 'pointerup', x: 200, y: 50 });
  }
  const before = JSON.stringify(metrics.get('drawing')); assert(metrics.get('drawing').length < 400); assert(Buffer.byteLength(before) < 65536);
  actions = await start(); assert.equal(metrics.get('state').note, 'My personal content'); assert.equal(JSON.stringify(metrics.get('drawing')), before);
  await actions.get('clear')(); assert.equal(metrics.get('state').empty, true);
});
