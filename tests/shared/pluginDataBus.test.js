'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDataBus } = require('../../src/shared/plugins/dataBus');
const { evaluateAlert, alertMessage } = require('../../src/shared/plugins/alerts');

// A manual clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        await due[1].fn();
      }
      now = target;
    }
  };
}

function busWith(clock) {
  const changes = [];
  const bus = createDataBus({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, defer: (fn) => fn() });
  bus.subscribe((changed) => changes.push([...changed]));
  return { bus, changes };
}

test('a source with no demand is never sampled', async () => {
  const clock = fakeClock();
  const { bus } = busWith(clock);
  let calls = 0;
  bus.defineSource('sys.cpu', { sample: () => ++calls });
  await clock.advance(60_000);
  assert.equal(calls, 0);
  assert.equal(clock.pending(), 0);
});

test('visible demand samples at its interval and stops when cleared', async () => {
  const clock = fakeClock();
  const { bus } = busWith(clock);
  let calls = 0;
  bus.defineSource('sys.cpu', { sample: () => ++calls });
  bus.setDemand('view:home:x', { sources: ['sys.cpu'], lifecycle: 'visible', intervalMs: 2000 });
  await clock.advance(10_000);
  assert.equal(calls, 6, 'immediately, then every 2 s');
  bus.clearDemand('view:home:x');
  await clock.advance(60_000);
  assert.equal(calls, 6);
  assert.equal(clock.pending(), 0);
});

test('background and visible demands run at the fastest current cadence, then fall back', async () => {
  const clock = fakeClock();
  const { bus } = busWith(clock);
  let calls = 0;
  bus.defineSource('sys.cpu', { sample: () => ++calls });
  bus.setDemand('alert:p:hot', { sources: ['sys.cpu'], lifecycle: 'background', intervalMs: 15_000 });
  await clock.advance(30_000);
  assert.equal(calls, 3);
  bus.setDemand('view:notch:p/v', { sources: ['sys.cpu'], lifecycle: 'visible', intervalMs: 2000 });
  assert.deepEqual(bus.sourceDemand('sys.cpu'), { intervalMs: 2000, lifecycles: ['background', 'visible'] });
  const before = calls;
  await clock.advance(10_000);
  assert.ok(calls - before >= 5);
  bus.clearDemand('view:notch:p/v');
  const visibleDone = calls;
  await clock.advance(30_000);
  assert.equal(calls - visibleDone, 2, 'the hidden UI leaves only the background cadence');
});

test('a minimum interval protects expensive sources', async () => {
  const clock = fakeClock();
  const { bus } = busWith(clock);
  let calls = 0;
  bus.defineSource('sys.memory', { sample: () => ++calls, minIntervalMs: 5000 });
  bus.setDemand('fast', { sources: ['sys.memory'], intervalMs: 250 });
  await clock.advance(10_000);
  assert.equal(calls, 3);
});

test('history keeps a bounded ring and projects object fields', async () => {
  const clock = fakeClock();
  const bus = createDataBus({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, defer: (fn) => fn(), historyLimit: 3 });
  for (const percent of [10, 20, 30, 40]) bus.publish('sys.memory', { percent });
  bus.publish('sys.memory', { percent: 'n/a' });
  assert.deepEqual(bus.history('sys.memory', 10, 'percent'), [30, 40, null]);
  assert.equal(bus.read('missing'), null);
});

test('publishes are batched into one change notification per tick', async () => {
  const pending = [];
  const bus = createDataBus({ defer: (fn) => pending.push(fn) });
  const changes = [];
  bus.subscribe((changed) => changes.push([...changed].sort()));
  bus.publish('tm.today', { tokens: 1 });
  bus.publish('tm.month', { tokens: 2 });
  bus.publish('tm.today', { tokens: 3 });
  assert.equal(changes.length, 0);
  pending.shift()();
  assert.deepEqual(changes, [['tm.month', 'tm.today']]);
});

test('a failing sampler is counted and retried, not fatal', async () => {
  const clock = fakeClock();
  const errors = [];
  const bus = createDataBus({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, defer: (fn) => fn(), onError: (error) => errors.push(error.message) });
  let calls = 0;
  bus.defineSource('sys.cpu', { sample: () => { calls += 1; if (calls === 1) throw new Error('boom'); return 5; } });
  bus.setDemand('v', { sources: ['sys.cpu'], intervalMs: 1000 });
  await clock.advance(1500);
  assert.deepEqual(errors, ['boom']);
  assert.equal(bus.read('sys.cpu').value, 5);
});

test('a failing alias does not leave later aliases of the same sample stale', async () => {
  const clock = fakeClock();
  const errors = [];
  const bus = createDataBus({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, defer: (fn) => fn(), onError: (error) => errors.push(error.message) });
  bus.defineSource('sys.memory', { sample: () => ({ percent: 40 }) });
  bus.defineAlias('sys.memoryBroken', 'sys.memory', () => { throw new Error('alias boom'); });
  bus.defineAlias('sys.memoryPercent', 'sys.memory', (value) => value.percent);
  bus.setDemand('v', { sources: ['sys.memoryBroken', 'sys.memoryPercent'], intervalMs: 1000 });
  await clock.advance(10);
  assert.deepEqual(errors, ['alias boom']);
  assert.equal(bus.read('sys.memory').value.percent, 40);
  assert.equal(bus.read('sys.memoryPercent')?.value, 40);
  assert.equal(bus.stats()['sys.memory'].errors, 0, 'the source sample itself succeeded');
});

test('alerts hold for their duration, fire once, and re-arm after recovery and cooldown', () => {
  const rule = { op: '>=', value: 90, forMs: 60_000, cooldownMs: 30 * 60_000 };
  let state = {};
  const step = (value, at) => {
    const result = evaluateAlert(rule, value, at, state);
    state = result.state;
    return result.fire;
  };
  assert.equal(step(95, 0), false);
  assert.equal(step(95, 30_000), false);
  assert.equal(step(80, 40_000), false, 'a dip restarts the hold');
  assert.equal(step(95, 50_000), false);
  assert.equal(step(95, 110_000), true);
  assert.equal(step(99, 120_000), false, 'still firing: no repeat');
  assert.equal(step(null, 125_000), false, 'a missing reading proves nothing');
  assert.equal(state.phase, 'firing');
  assert.equal(step(50, 130_000), false);
  assert.equal(step(95, 200_000), false);
  assert.equal(step(95, 300_000), false, 'held, but inside the cooldown');
  assert.equal(step(50, 2_000_000), false);
  assert.equal(step(95, 2_100_000), false);
  assert.equal(step(95, 2_200_000), true, 'after recovery and the cooldown it fires again');
  assert.equal(alertMessage('CPU at {value} ({value})', '95%'), 'CPU at 95% (95%)');
});

test('a reading published at time zero is available', () => {
  const clock = fakeClock();
  const { bus } = busWith(clock);
  bus.publish('sys.cpu', 0);
  assert.deepEqual(bus.read('sys.cpu'), { value: 0, at: 0 });
});

test('changing demand during an asynchronous sample cannot create overlapping retries', async () => {
  let finish;
  const timers = new Map();
  let id = 0;
  const bus = createDataBus({ setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key) });
  bus.defineSource('slow', { sample: () => new Promise(resolve => { finish = resolve; }) });
  bus.setDemand('first', { sources: ['slow'] });
  const [key, start] = [...timers][0];
  timers.delete(key);
  const pending = start();
  bus.setDemand('second', { sources: ['slow'], intervalMs: 1000 });
  assert.equal(timers.size, 0, 'the in-flight sample owns rescheduling');
  finish(42);
  await pending;
  assert.equal(timers.size, 1);
  bus.dispose();
});


test('plugin publishes never block host sources, evict their history, or affect each other', () => {
  const bus = createDataBus({ historyBytesLimit: 4000, currentBytesLimit: 6000 });
  for (let i = 0; i < 5; i++) bus.publish('sys.cpu', { percent: i });
  const hostHistory = bus.history('sys.cpu', 120, 'percent');
  for (let i = 0; i < 5; i++) bus.publish('plugin.calm.n', i);
  // A heavy plugin may exceed the host budget several times over...
  for (let i = 0; i < 8; i++) bus.publish(`plugin.heavy.m${i}`, 'x'.repeat(5000));
  for (let i = 0; i < 200; i++) bus.publish(`plugin.heavy.h${i % 8}`, { n: i });
  assert.equal(bus.read('plugin.heavy.m7').value.length, 5000);
  // ...without touching host readings or another plugin's history.
  assert.deepEqual(bus.history('sys.cpu', 120, 'percent'), hostHistory, 'host history survives plugin pressure');
  assert.deepEqual(bus.history('plugin.calm.n'), [0, 1, 2, 3, 4], 'another plugin keeps its history');
  bus.publish('tm.today', 'y'.repeat(1500));
  assert.equal(bus.read('tm.today').value.length, 1500, 'host publishes keep their own budget');
  // Each value stays individually bounded, and the host budget still applies to host sources.
  assert.throws(() => bus.publish('plugin.heavy.big', 'x'.repeat(90_000)), /storage budget/);
  assert.throws(() => bus.publish('tm.month', 'z'.repeat(600)), /storage budget/);
  bus.clearSourcesWithPrefix('plugin.');
  assert.equal(bus.read('tm.today').value.length, 1500);
  assert.deepEqual(bus.history('sys.cpu', 120, 'percent'), [...hostHistory]);
  bus.dispose();
});

test('host histories and current readings obey their byte budgets', () => {
  const bus = createDataBus({ historyBytesLimit: 200, currentBytesLimit: 2000 });
  for (let i = 0; i < 100; i++) bus.publish('one', { percent: i, drawing: Array(50).fill('x') });
  assert.ok(bus.memoryUsage().historyBytes <= 200);
  assert.equal(bus.history('one', 120, 'percent').at(-1), 99);
  assert.throws(() => bus.publish('two', 'x'.repeat(1000)), /storage budget/);
  bus.clearSourcesWithPrefix('one');
  assert.deepEqual(bus.memoryUsage(), { currentBytes: 0, historyBytes: 0 });
  bus.dispose();
});
