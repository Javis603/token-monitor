'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createSseBlockReader, parseSseBlock } = require('../../src/electron/sseEventReader');
const { classifyStreamFailure } = require('../../src/electron/syncConnection');
const { createStatsStreamReceiver, encodeSseEvent } = require('../../src/shared/hubProtocol');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const streamSource = main.slice(main.indexOf('function scheduleStreamRetry('), main.indexOf('\nfunction showPopover('));
const timerSource = renderer.slice(renderer.indexOf('function restartTimer()'), renderer.indexOf('\nfunction clamp('));
const pushSource = renderer.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)[0];

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
      }
      now = end;
    }
  };
}

function streamFixture(t, { pendingHeaders = false, ignoreAbort = false } = {}) {
  const time = clock();
  const connections = [];
  const statuses = [];
  const snapshots = [];
  let cached;
  const context = vm.createContext({
    sseAbortController: null, sseRetryTimer: null, hubModeGeneration: 1,
    settings: { hubMode: 'client' }, mode: 'sync',
    AbortController, TextDecoder, HUB_STREAM_HEADER: 'x-token-monitor-stream', HUB_STREAM_VERSION: '4',
    createSseBlockReader, parseSseBlock, createStatsStreamReceiver, classifyStreamFailure,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    postSyncPayload: { resetHistory() {} }, captureMacWidgetProducerOwner: () => ({}),
    currentHubStatsIdentity: () => 'hub-a', clearLatestHubStatsCache() {},
    hubModeRequestIsCurrent: generation => generation === context.hubModeGeneration && context.settings.hubMode === 'client',
    effectiveHubConfig: () => ({ url: 'https://hub.invalid', secret: '' }),
    sendStatus: (connected, failure) => statuses.push({ connected, ...failure }),
    sendPush() {},
    setLatestHubStatsCache: stats => { cached = stats; },
    requestSyncDisplayStats: () => snapshots.push(cached),
    fetch(_url, { signal }) {
      const connection = { signal };
      connections.push(connection);
      if (pendingHeaders) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const body = new ReadableStream({ start(controller) {
        connection.send = text => controller.enqueue(new TextEncoder().encode(text));
        connection.end = () => controller.close();
        if (!ignoreAbort) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } });
      return Promise.resolve({ ok: true, body });
    }
  });
  vm.runInContext(streamSource, context);
  t.after(async () => { context.stopStatsStream(); await settle(); });
  return { context, time, connections, statuses, snapshots };
}

test('a silently stalled Hub stream times out, reconnects and adopts fresh remote usage and limits', async t => {
  const f = streamFixture(t);
  void f.context.startStatsStream();
  await settle();
  const old = { devices: [{ deviceId: 'remote' }], periods: { today: { tokens: 10 } }, limits: { providers: [{ id: 'claude', status: 'ok' }] } };
  f.connections[0].send(encodeSseEvent('snapshot', { stats: old, revision: 1 }));
  await settle();
  await f.time.advance(90_000);
  assert.equal(f.connections[0].signal.aborted, true, 'missing heartbeats must abort the stale connection');
  assert.equal(f.statuses.at(-1).connected, false);
  assert.equal(f.statuses.at(-1).reason, 'timeout');
  await f.time.advance(3000);
  assert.equal(f.connections.length, 2);
  const fresh = { ...old, periods: { today: { tokens: 200 } }, limits: { providers: [{ id: 'claude', status: 'ok', remainingPercent: 60 }] } };
  f.connections[1].send(encodeSseEvent('snapshot', { stats: fresh, revision: 100 }));
  await settle();
  assert.deepEqual(f.snapshots.at(-1).periods, fresh.periods);
  assert.deepEqual(f.snapshots.at(-1).limits, fresh.limits);
  assert.equal(f.statuses.at(-1).connected, true);
});

test('heartbeat comments and partial frames keep a quiet or slow Hub connection alive', async t => {
  const f = streamFixture(t);
  void f.context.startStatsStream();
  await settle();
  for (const chunk of [': hb\n\n', ': hb\n\n', 'event: snapshot\ndata: ', '{"stats":{"devices":[]},', '"revision":1}\n\n']) {
    await f.time.advance(30_000);
    f.connections[0].send(chunk);
    await settle();
  }
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].signal.aborted, false);
  assert.equal(f.snapshots.length, 1);
  f.context.stopStatsStream();
  await settle();
  assert.equal(f.time.timers.size, 0, 'stopping clears the activity deadline and retries');
});

test('a Hub request that never returns headers also times out and retries', async t => {
  const f = streamFixture(t, { pendingHeaders: true });
  void f.context.startStatsStream();
  await settle();
  await f.time.advance(15_000);
  assert.equal(f.connections[0].signal.aborted, true);
  assert.equal(f.statuses.at(-1).reason, 'timeout');
  await f.time.advance(3000);
  assert.equal(f.connections.length, 2);
});

test('replacing a stream within the same Hub generation ignores late frames and EOF from the old reader', async t => {
  const f = streamFixture(t, { ignoreAbort: true });
  void f.context.startStatsStream();
  await settle();
  void f.context.startStatsStream();
  await settle();
  f.connections[0].send(encodeSseEvent('snapshot', { stats: { devices: [], marker: 'obsolete' }, revision: 1 }));
  await settle();
  f.connections[0].end();
  await settle();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.statuses.at(-1).connected, true);
  void f.context.startStatsStream();
  await settle();
  f.connections[1].end();
  await settle();
  assert.equal(f.statuses.at(-1).connected, true, 'an obsolete pending read reaching EOF cannot disconnect its replacement');
  await f.time.advance(3000);
  assert.equal(f.connections.length, 3);
});

test('EOF retries normally, while an explicit stop or mode change cancels recovery', async t => {
  const f = streamFixture(t);
  void f.context.startStatsStream();
  await settle();
  f.connections[0].end();
  await settle();
  assert.equal(f.statuses.at(-1).reason, 'disconnected');
  await f.time.advance(3000);
  assert.equal(f.connections.length, 2);
  f.context.settings.hubMode = 'local';
  f.context.hubModeGeneration++;
  f.context.stopStatsStream();
  await settle();
  const statusCount = f.statuses.length;
  await f.time.advance(100_000);
  assert.equal(f.connections.length, 2);
  assert.equal(f.statuses.length, statusCount);
  assert.equal(f.time.timers.size, 0);
});

test('frequent local pushes cannot postpone the background Hub read', async () => {
  const time = clock();
  let push;
  let reads = 0;
  const state = { streamConnected: true, settings: { hubMode: 'client' }, period: 'today' };
  const context = {
    state, window: { tokenMonitor: { onStatsPush: fn => { push = fn; } } },
    allTimeSessions: { invalidate() {}, attach: stats => stats }, sessionStatsForDisplay: stats => stats,
    observeLiveTokenRate() {}, observeDisplayLiveTokenRates() {}, applyCodexActiveAccountFromStats() {},
    fixedPeriodRangesApi: { isDerived: () => false }, statsRenderScheduler: { request() {} },
    warmFixedPeriodHistory() {}, maybeUpdateBarsIcon() {},
    setInterval(fn, ms) {
      const id = time.setTimeout(() => { fn(); }, ms);
      return id;
    },
    clearInterval: time.clearTimeout,
    refreshStats() { reads++; }
  };
  vm.runInNewContext(timerSource + '\n' + pushSource + '\nrestartTimer();', context);
  for (let i = 0; i < 60; i++) {
    await time.advance(5000);
    push({ event: 'stats', data: { reason: 'local', stats: {} } });
  }
  assert.equal(reads, 1, 'the five-minute fallback must run despite local updates every five seconds');
});

test('background reads change frequency on disconnect, reconnect and refresh settings changes', () => {
  const intervals = new Map();
  let nextId = 1;
  const state = { streamConnected: true, settings: { refreshMs: 15000 } };
  const context = vm.createContext({
    state, refreshStats() {}, clearInterval: id => intervals.delete(id),
    setInterval(_fn, ms) { const id = nextId++; intervals.set(id, ms); return id; }
  });
  vm.runInContext(timerSource, context);
  context.restartTimer();
  assert.deepEqual([...intervals.values()], [300000]);
  state.streamConnected = false;
  context.restartTimer();
  assert.deepEqual([...intervals.values()], [15000]);
  const offlineTimer = state.refreshTimer;
  context.restartTimer();
  assert.equal(state.refreshTimer, offlineTimer);
  state.settings.refreshMs = 30000;
  context.restartTimer();
  assert.deepEqual([...intervals.values()], [30000]);
  state.streamConnected = true;
  context.restartTimer();
  assert.deepEqual([...intervals.values()], [300000]);
});
