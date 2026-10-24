'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
test('Worker actions serialize async handlers, acknowledge errors and continue to the next action', async () => {
  const messages = [], listeners = {}, events = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const self = { postMessage: value => messages.push(value), addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/electron/plugins/host/prelude.js'), 'utf8'), { self, Error });
  self.tm.onAction('first', async event => { events.push(event.surface); await gate; events.push('released'); });
  self.tm.onAction('bad', () => { throw new Error('broken action'); });
  self.tm.onAction('last', () => events.push('last'));
  self.tm.onAction('not-callable', {});
  for (const [index, action] of ['first', 'bad', 'last', '__proto__', 'not-callable'].entries()) await listeners.message({ data: { type: 'interaction', seq: index + 1, view: 'test', surface: 'page', event: { action, type: 'press' } } });
  assert.deepEqual(events, ['page']); release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['page', 'released', 'last']);
  assert.deepEqual(messages.filter(m => m.type === 'interaction-done').map(m => m.seq), [1, 2, 3, 4, 5]);
  assert(messages.some(m => m.type === 'error' && m.message.includes('broken action')));
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
