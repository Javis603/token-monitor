'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setImmediate: immediate } = require('node:timers/promises');
const { workerSource } = require('../../src/electron/plugins/sandbox');
const { createCapabilityLane, createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');

function worker(onCall = () => {}) {
  const sent = [], handlers = {};
  const self = { postMessage(value) {
    const message = JSON.parse(JSON.stringify(value));
    sent.push(message);
    if (message.type === 'call') onCall(message);
  }, addEventListener(name, fn) { handlers[name] = fn; } };
  const context = vm.createContext(Object.assign(self, { self, TextEncoder }));
  vm.runInContext(workerSource(''), context);
  return { sent, tm: self.tm, message: data => handlers.message({ data }) };
}

for (const mode of ['visible', 'background']) test(`first ${mode} activation admits pending history and sixteen subscriptions exactly once`, async t => {
  let release, loads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createBusinessDataService({ loadHistory: async () => { loads++; await gate; return { daily: [] }; } });
  const period = { totalTokens: 100, costUsd: 1 };
  service.publish({ periods: { today: period, month: period, allTime: period } });
  const api = createPluginCapabilities({ businessData: service }), lane = createCapabilityLane();
  const replies = [], failures = [], tasks = [], owner = {};
  const context = { auth: () => ({ pluginId: 'startup', active: true, revision: 1, permissions: ['tm.data.history', 'tm.data.usage'] }), send() {} };
  const w = worker(message => {
    try {
      tasks.push(lane.run(message.op, message.args, () => api.call(owner, message.op, message.args, context), message.id)
        .then(value => { replies.push(message.id); return w.message({ type: 'result', id: message.id, ok: true, value }); })
        .catch(error => { failures.push(error.code || error.message); }));
    } catch (error) { failures.push(error.code || error.message); }
  });
  t.after(async () => { release(); await Promise.all(tasks); lane.close(); api.dispose(); service.dispose(); });
  void w.tm.data.query({ version: 1, resource: 'history' });
  for (let i = 0; i < 16; i++) w.tm.data.subscribe({ version: 1, resource: 'usage', period: ['today', 'month', 'allTime'][i % 3] }, () => {});
  await immediate();
  await w.message({ type: 'mode', mode });
  assert.equal(loads, 1);
  assert.equal(replies.length, 0);
  assert.equal(w.sent.filter(m => m.type === 'call').length, 17);
  assert.deepEqual(failures, []);
  release(); await Promise.all(tasks);
  assert.equal(replies.length, 17);
  assert.deepEqual(failures, []);
  await w.message({ type: 'mode', mode: 'idle' });
  api.release(owner);
  await w.message({ type: 'mode', mode });
  assert.equal(w.sent.filter(m => m.op === 'data.subscribe').length, 32, 'sixteen subscriptions restore after suspension');
  await Promise.all(tasks);
  assert.deepEqual(failures, []);
});

for (const lateReply of [false, true]) test(`first action-only activation restores subscription intent (${lateReply ? 'late' : 'early'} suspended reply)`, async () => {
  const w = worker(), query = { version: 1, resource: 'usage' }, seen = [];
  w.tm.data.subscribe(query, value => seen.push(value));
  const first = w.sent.find(m => m.op === 'data.subscribe');
  const suspended = { type: 'result', id: first.id, ok: false, code: 'capability-suspended' };
  if (!lateReply) await w.message(suspended);
  await w.message({ type: 'mode', mode: 'action' });
  const off = w.tm.data.subscribe(query, () => {});
  assert.equal(w.sent.filter(m => m.op === 'data.subscribe').length, 1, 'action handlers do not acquire live subscriptions');
  off();
  await w.message({ type: 'mode', mode: 'visible' });
  if (lateReply) await w.message(suspended);
  const calls = w.sent.filter(m => m.op === 'data.subscribe');
  assert.equal(calls.length, 2);
  await w.message({ type: 'business-data', id: calls[1].args.id, value: 'current' });
  assert.deepEqual(seen, ['current']);
  await w.message({ type: 'mode', mode: 'background' });
  assert.equal(w.sent.filter(m => m.op === 'data.subscribe').length, 2);
  assert.equal(w.sent.some(m => m.type === 'error'), false);
});

test('first action-only activation preserves permitted one-shot queries and settings calls', async () => {
  const w = worker();
  const query = w.tm.data.query({ version: 1, resource: 'usage' });
  const settings = w.tm.settings.get();
  const requests = w.sent.filter(m => m.type === 'call');
  await w.message({ type: 'mode', mode: 'action' });
  for (const request of requests) await w.message({ type: 'result', id: request.id, ok: true, value: request.op });
  assert.deepEqual(await Promise.all([query, settings]), ['data.query', 'settings.get']);
});

test('a rejected replay removes its subscription while an old suspended reply cannot remove a new activation', async () => {
  const w = worker(), query = { version: 1, resource: 'usage' };
  w.tm.data.subscribe(query, () => {});
  await w.message({ type: 'mode', mode: 'visible' });
  await w.message({ type: 'mode', mode: 'idle' });
  await w.message({ type: 'mode', mode: 'visible' });
  const replay = w.sent.findLast(m => m.op === 'data.subscribe');
  await w.message({ type: 'result', id: replay.id, ok: false, code: 'invalidQuery', error: 'bad query' });
  await immediate();
  const count = w.sent.filter(m => m.op === 'data.subscribe').length;
  await w.message({ type: 'mode', mode: 'idle' });
  await w.message({ type: 'mode', mode: 'visible' });
  assert.equal(w.sent.filter(m => m.op === 'data.subscribe').length, count);
  assert.equal(w.sent.filter(m => m.type === 'error').length, 1);
});
