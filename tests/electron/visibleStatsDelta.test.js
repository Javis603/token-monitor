'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRendererSnapshots } = require('../../src/electron/statsPublisher');
const { applyStatsDelta, buildStatsDelta, fingerprintStats } = require('../../src/shared/statsDelta');

const root = path.join(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');

test('main sends visible session changes as a delta from a compact fingerprint', () => {
  assert.match(main, /require\('\.\.\/shared\/statsDelta'\)/);
  assert.match(main, /let lastRendererStatsFingerprint = null/);
  assert.match(main, /buildStatsDelta\(lastRendererStatsFingerprint, copy\)/);
  assert.match(main, /data: \{ \.\.\.data, statsDelta: built\.delta \}/);
  assert.match(main, /lastRendererStatsFingerprint = rendererFingerprint/);
  assert.match(main, /const fingerprint = fingerprintStats\(copy\)/);
  assert.match(main, /lastRendererStatsFingerprint = fingerprint/);
  assert.match(main, /event\.sender === mainWindow\.webContents/);
  assert.match(main, /if \(win === mainWindow\) lastRendererStatsFingerprint = null/);
});

test('the renderer loads the delta decoder before its stats handler', () => {
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/statsDelta\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
});

function excerpt(source, from, to) {
  const start = source.indexOf(from);
  return source.slice(start, source.indexOf(to, start + from.length));
}

function recoveryFixture() {
  const sent = [];
  const makeStats = total => ({ periods: { today: { sessions: { 'claude:s1': { total } } } } });
  const snapshots = createRendererSnapshots({ source: () => mainScope.hubModeGeneration });
  const sender = {
    send(channel, payload) {
      assert.equal(channel, 'stats:push');
      sent.push(payload);
    }
  };
  let getStats;
  const mainScope = {
    hubModeGeneration: 1,
    currentHubStatsIdentity: () => 'client|test-hub',
    mainWindow: { isDestroyed: () => false, webContents: sender },
    mode: 'sync',
    rendererSnapshots: snapshots,
    rendererStats: value => value,
    electronPresentationStats: value => value,
    fingerprintStats,
    ipcMain: { handle: (_name, handler) => { getStats = handler; } },
    fetchStats: () => assert.fail('recovery must not read the offline Hub')
  };
  vm.runInNewContext(
    excerpt(main, 'function sendStatsPresentationToRenderer(', 'function refreshLimitStatsPresentation(')
      + excerpt(main, "ipcMain.handle('stats:get',", "ipcMain.handle('devices:delete',"),
    mainScope
  );

  const publish = (total, full = false) => {
    mainScope.latestStats = makeStats(total);
    mainScope.latestStatsSource = { generation: mainScope.hubModeGeneration, identity: mainScope.currentHubStatsIdentity() };
    const stats = snapshots.stamp(mainScope.latestStats, mainScope.latestStats);
    const built = buildStatsDelta(mainScope.lastRendererStatsFingerprint, stats);
    mainScope.lastRendererStatsFingerprint = built.fingerprint;
    sender.send('stats:push', {
      event: 'stats',
      data: { reason: 'local', ...(built.delta && !full ? { statsDelta: built.delta } : { stats }) }
    });
    return stats;
  };

  let receive;
  const replies = [];
  const noop = () => {};
  const rendererScope = {
    window: {
      TokenMonitorStatsDelta: { applyStatsDelta },
      tokenMonitor: {
        onStatsPush: handler => { receive = handler; },
        getStats: options => new Promise((resolve, reject) => {
          const result = getStats({ sender }, options);
          replies.push(() => result.then(resolve, reject));
        })
      }
    },
    state: { period: 'today', streamConnected: false, streamFailure: { reason: 'offline' } },
    allTimeSessions: { invalidate: noop, attach: value => value },
    sessionStatsForDisplay: value => value,
    observeLiveTokenRate: noop,
    observeDisplayLiveTokenRates: noop,
    applyCodexActiveAccountFromStats: noop,
    fixedPeriodRangesApi: { isDerived: () => false },
    warmFixedPeriodHistory: noop,
    statsRenderScheduler: { request: noop },
    maybeUpdateBarsIcon: noop,
    restartTimer: noop
  };
  vm.runInNewContext(
    excerpt(renderer, 'async function refreshStats(options = {})', 'async function refreshStatusViewManually()')
      + excerpt(renderer, 'window.tokenMonitor.onStatsPush?.((payload) => {', 'function pickWorstProvider('),
    rendererScope
  );

  const deliverNext = () => receive(sent.shift());
  const deliver = () => { while (sent.length > 0) deliverNext(); };
  publish(1);
  deliver();
  publish(2);
  sent.shift(); // Drop one delta to desynchronize the renderer.

  return {
    mainScope, rendererScope, snapshots, sent, replies, deliver, deliverNext, publish,
    recover: (eventSender = sender) => getStats({ sender: eventSender }, { deltaResync: true }),
    total: () => rendererScope.state.stats.periods.today.sessions['claude:s1'].total,
    evict() {
      for (const total of [5, 6, 7]) {
        const stats = makeStats(total);
        snapshots.stamp(stats, stats);
      }
    },
    async finishReply() {
      await replies.shift()();
      await new Promise(setImmediate);
    }
  };
}

test('an offline resync delivers the latest snapshot even if the cached base was evicted', async () => {
  const f = recoveryFixture();
  const latest = f.publish(3);
  f.evict();
  assert.equal(f.snapshots.get(latest.snapshot.id), null);
  f.deliver();
  await f.finishReply();
  assert.equal(f.total(), 3);
  assert.equal(f.rendererScope.state.streamConnected, false);
  assert.equal(f.rendererScope.state.streamFailure.reason, 'offline');
  assert.ok(f.snapshots.get(f.rendererScope.state.stats.snapshot.id));
});

test('a delta sent during resync applies and an older IPC reply cannot roll stats back', async () => {
  const f = recoveryFixture();
  f.publish(3);
  f.deliver();
  assert.equal(f.replies.length, 1);
  f.publish(4);
  assert.ok(f.sent.at(-1).data.statsDelta);
  f.deliver();
  await f.finishReply();
  assert.equal(f.total(), 4);
  assert.equal(f.replies.length, 0);
});

test('a newer full push survives a delayed resync reply', async () => {
  const f = recoveryFixture();
  f.publish(3);
  f.deliver();
  f.publish(4, true);
  f.deliver();
  assert.equal(f.total(), 4);
  await f.finishReply();
  assert.equal(f.total(), 4);
});

test('an old acknowledgement does not clear a newer recovery request', async () => {
  const f = recoveryFixture();
  f.publish(3);
  f.deliver();
  assert.equal(f.total(), 3);

  f.publish(4);
  f.sent.shift();
  f.publish(5);
  f.deliverNext();
  assert.equal(f.replies.length, 2);
  const newerRequest = f.rendererScope.state.statsDeltaResyncPending;
  assert.ok(newerRequest);
  await f.finishReply();
  assert.equal(f.rendererScope.state.statsDeltaResyncPending, newerRequest);

  f.deliver();
  await f.finishReply();
  assert.equal(f.total(), 5);
  assert.equal(f.rendererScope.state.statsDeltaResyncPending, null);
});

test('a resync cannot publish data from a different sender or Hub source', async () => {
  const f = recoveryFixture();
  await f.recover({});
  assert.equal(f.sent.length, 0);
  f.mainScope.hubModeGeneration += 1;
  await f.recover();
  assert.equal(f.sent.length, 0);
  f.mainScope.hubModeGeneration -= 1;
  f.mainScope.currentHubStatsIdentity = () => 'client|different-hub';
  await f.recover();
  assert.equal(f.sent.length, 0);
});

test('a missed alias presentation does not match the next delta base', () => {
  const snapshots = createRendererSnapshots({ source: () => 1 });
  const stats = { periods: {} };
  const projection = model => ({ periods: { today: { sessions: { 'claude:s1': { model } } } } });
  const before = projection('original');
  const after = projection('alias');
  const old = snapshots.stamp(stats, before, before);
  const missed = snapshots.stamp(stats, after, after);
  const next = snapshots.stamp({ periods: {} }, after, after);
  const { delta } = buildStatsDelta(fingerprintStats(missed), next);
  assert.equal(applyStatsDelta(old, delta), null);
  assert.equal(applyStatsDelta(missed, delta).periods.today.sessions['claude:s1'].model, 'alias');
});
