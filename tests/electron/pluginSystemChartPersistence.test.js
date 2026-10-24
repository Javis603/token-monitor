'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const chartFile = path.resolve(__dirname, '../../src/electron/plugins/builtin/system-monitor/ui/chart.js');
const brokerFile = path.resolve(__dirname, '../../src/electron/plugins/broker.js');

async function harness(saved = {}) {
  let now = 0, wall = 1700000000000, nextId = 0, calls = 0, writes = 0, subscriptions = 0;
  const timers = new Map(), frames = new Map(), events = new Map();
  const disk = { ...saved }, nodes = new Map();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(brokerFile, 'utf8'), {
    module, exports: module.exports, require: createRequire(brokerFile), Buffer, process,
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  }, { filename: brokerFile });
  const storage = module.exports.createPluginStorage({ dir: '/fixture', pluginId: 'system-monitor', fsImpl: {
    readFileSync: () => JSON.stringify(disk), mkdirSync() {},
    writeFileSync: (_file, value) => { writes++; Object.assign(disk, JSON.parse(value)); }, renameSync() {}
  } });
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    return nodes.get(key);
  };
  const context = vm.createContext({
    document: { hidden: false, querySelectorAll: () => ['cpu', 'memory'].map(metric => ({ dataset: { metric }, querySelector: selector => node(metric + selector) })),
      documentElement: { style: { setProperty() {} } }, body: { style: {} }, addEventListener() {} },
    window: { addEventListener: (name, fn) => { events.set(name, [...(events.get(name) || []), fn]); } },
    Date: { now: () => wall }, performance: { now: () => now },
    requestAnimationFrame: fn => { const id = ++nextId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    tm: { onContext: () => () => {}, context: async () => ({ theme: { colors: {}, reducedMotion: false } }),
      storage: { get: async key => storage.get(key), set: async (key, value) => { calls++; return storage.set(key, value); } },
      onData: () => () => {}, subscribe: async () => { subscriptions++; return {}; } }
  });
  vm.runInContext(fs.readFileSync(process.env.TM_CHART_SOURCE || chartFile, 'utf8'), context);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return {
    advance(ms) {
      now += ms; wall += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn();
    },
    sample() { context.values = { 'sys.cpu': { at: wall, value: 35 }, 'sys.memory': { at: wall, value: { percent: 60, used: 6, total: 10 } } }; vm.runInContext('data(values)', context); },
    jump(ms) { wall += ms; },
    read: () => JSON.parse(vm.runInContext('JSON.stringify(charts.map(c => ({at:c.at,end:c.end,points:c.points})))', context)),
    counts: () => ({ calls, writes, subscriptions, timers: timers.size }),
    disk, nodes, frames,
    pagehide() { for (const fn of events.get('pagehide') || []) fn(); }
  };
}

test('two-minute chart checkpoints reduce real broker writes without dropping samples or smooth playback', async () => {
  const h = await harness();
  for (let i = 0; i < 120; i++) { h.sample(); h.advance(2000); }
  console.log('CHART_WRITES', JSON.stringify({ samplesPerMetric: 120, ...h.counts() }));
  assert.equal(h.counts().calls, 48);
  assert.equal(h.counts().writes, 24);
  assert.equal(h.counts().subscriptions, 1);
  for (const chart of h.read()) {
    assert.equal(chart.points.length, 63);
    assert.equal(chart.points.at(-1).at, chart.at);
    assert.equal(chart.at - chart.end, 250);
  }
  const before = h.nodes.get('cpu.line').attrs.transform;
  h.advance(100);
  assert.notEqual(h.nodes.get('cpu.line').attrs.transform, before);
  assert.equal(h.counts().calls, 48);
  h.advance(10000);
  assert.equal(h.frames.size, 0);
  assert.equal(h.counts().timers, 0);
  assert.equal(h.counts().calls, 48);
});

test('park without pagehide keeps live history and eviction restores the last checkpoint', async () => {
  const h = await harness();
  for (let i = 0; i < 5; i++) { h.sample(); h.advance(2000); }
  assert.equal(h.read()[0].points.length, 5);
  assert.equal(h.counts().calls, 2);
  const restored = await harness(h.disk);
  assert.equal(restored.read()[0].points.length, 1);
  h.advance(20000); h.sample(); // retained document resumes on its existing subscription
  assert.equal(h.counts().calls, 4);
  assert.equal(h.counts().subscriptions, 1);
  assert.equal(h.read()[0].points.length, 7); // five samples, gap, resumed sample
  h.pagehide(); assert.equal(h.frames.size, 0);
});

test('wall-clock corrections and duplicate deliveries cannot bypass the monotonic write bound', async () => {
  const h = await harness();
  h.sample(); h.sample();
  h.advance(2000); h.jump(60000); h.sample();
  h.advance(2000); h.jump(-120000); h.sample();
  assert.equal(h.counts().calls, 2);
  assert.equal(h.read()[0].points.length, 1);
  h.advance(6000); h.sample();
  assert.equal(h.counts().calls, 4);
});
