'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { rendererStats } = require('../../src/electron/statsPublisher');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

test('paused UI avoids projection and registration while background consumers still receive exact stats', () => {
  const calls = [];
  const full = { historyRevision: 'new', periods: { today: { totalTokens: 12 }, allTime: { sessions: { exact: { totalTokens: 12 } } } } };
  const context = {
    latestStats: { historyRevision: 'old' }, statsHistoryRevision: stats => stats?.historyRevision,
    settings: { lightweightMode: true, exportAutoEnabled: true, exportDir: '/fixture' },
    mainWindow: { isDestroyed: () => false, isVisible: () => true, webContents: { send: (...args) => calls.push(['ui', ...args]) } },
    mainRendererNeedsStats: () => false, statsPushRevision: 0, statsPushSource: null, hubModeGeneration: 2,
    currentHubStatsIdentity: () => 'fixture', injectLocalDeviceStatus: stats => stats,
    edgeDockManualStats: null, getSyncContentRuntime: () => ({ notifyStats: stats => calls.push(['sync', stats]) }),
    electronPresentationStats: stats => stats, migrateCodexAdditionalLimits() {},
    rendererStats: () => assert.fail('paused UI must not clone the renderer payload'),
    rendererSnapshots: { stamp: () => assert.fail('paused UI must not retain unseen snapshot inputs') },
    scheduleMacWidgetSnapshot: stats => calls.push(['widget', stats]),
    updateEdgeDockCells: stats => calls.push(['dock', stats]), syncCodexPresentationActiveAccount() {},
    updateTrayDisplay: () => calls.push(['tray']), lastExportAt: 0, exportIntervalMs: () => 1,
    completeLocalSyncStats: stats => stats, writeExportTo: (_dir, periods) => { calls.push(['export', periods]); return Promise.resolve(); },
    dashboardWindow: { isDestroyed: () => false, webContents: { send: channel => calls.push(['dashboard', channel]) } },
    maybeAdoptSharedSubscriptionRevision: stats => calls.push(['subscriptions', stats])
  };
  const start = source.indexOf('function sendPush(');
  vm.runInNewContext(source.slice(start, source.indexOf('\nfunction statsHistoryRevision', start)), context);
  context.sendPush({ event: 'stats', data: { stats: full, reason: 'usage' } });
  assert.equal(context.latestStats, full);
  assert.equal(calls.some(([name]) => name === 'ui'), false);
  for (const consumer of ['sync', 'widget', 'dock', 'subscriptions']) assert.equal(calls.find(([name]) => name === consumer)[1], full);
  assert.equal(calls.find(([name]) => name === 'export')[1], full.periods);
  assert.ok(calls.some(([name]) => name === 'dashboard'));
  context.mainRendererNeedsStats = () => true;
  context.rendererStats = rendererStats;
  context.rendererSnapshots.stamp = (_stats, display) => ({ ...display, snapshot: { id: 10 } });
  context.sendPush({ event: 'stats', data: { stats: full, reason: 'usage' } });
  const pushed = calls.find(([name]) => name === 'ui')[2].data.stats;
  assert.equal(pushed.snapshot.id, 10);
  assert.equal(pushed.periods.allTime.sessions, undefined);
});

test('a read completing after renderer crash cannot register a stale process generation snapshot', async () => {
  let handler, finish, registrations = 0;
  const sender = { isDestroyed: () => false };
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    settings: { lightweightMode: true }, trayRendererGeneration: new WeakMap(), mainWindow: { isDestroyed: () => false, webContents: sender },
    statsPushRevision: 1, statsPushSource: { generation: 1, identity: 'fixture' }, hubModeGeneration: 1,
    currentHubStatsIdentity: () => 'fixture', latestStats: { periods: {} },
    fetchStats: () => new Promise(resolve => { finish = resolve; }), sendPush() {},
    maybeAdoptSharedSubscriptionRevision() {}, rendererStats, electronPresentationStats: stats => stats,
    rendererSnapshots: { stamp: () => { registrations += 1; } }
  };
  const start = source.indexOf("  ipcMain.handle('stats:get'");
  vm.runInNewContext(source.slice(start, source.indexOf("  ipcMain.handle('devices:delete'", start)), context);
  const pending = handler({ sender });
  context.trayRendererGeneration.set(sender, 1); // same WebContents, replaced renderer process
  finish(context.latestStats);
  assert.equal(await pending, null);
  assert.equal(registrations, 0);
});

test('enabling lightweight mode during a valid read does not impersonate a renderer replacement', async () => {
  let handler, finish;
  const sender = { isDestroyed: () => false }, stats = { periods: {} };
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    settings: { lightweightMode: false }, trayRendererGeneration: new WeakMap(),
    mainWindow: { isDestroyed: () => false, webContents: sender },
    statsPushRevision: 1, statsPushSource: { generation: 1, identity: 'fixture' }, hubModeGeneration: 1,
    currentHubStatsIdentity: () => 'fixture', latestStats: stats,
    fetchStats: () => new Promise(resolve => { finish = resolve; }), sendPush() {},
    maybeAdoptSharedSubscriptionRevision() {}, rendererStats, electronPresentationStats: value => value,
    rendererSnapshots: { stamp: () => ({ accepted: true }) }
  };
  const start = source.indexOf("  ipcMain.handle('stats:get'");
  vm.runInNewContext(source.slice(start, source.indexOf("  ipcMain.handle('devices:delete'", start)), context);
  context.trayRendererGeneration.set(sender, 3); // a previous crash must not make an ordinary mode toggle look like another crash
  const pending = handler({ sender }); context.settings.lightweightMode = true; finish(stats);
  assert.equal((await pending).accepted, true);
});
