'use strict';

// Contract: with no plugin active, whether the master switch is on or off, the
// plugin host costs what an app without plugins costs. Stats pushes, settings
// patches and backend switches do no plugin work; startup registration is the
// only accepted overhead. The real runtime, manager and built-in catalog run
// here against a disposable userData directory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const tokenRateApi = require('../../src/electron/renderer/tokenRatePresentation');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');

function host(t, { pluginsEnabled }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-idle-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const settings = { pluginsEnabled, pluginStates: {} };
  const publications = [];
  const work = { extras: 0, loads: 0, sends: 0, changes: 0, timers: 0 };
  const sender = { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => { work.sends++; }, once() {}, removeListener() {} };
  const handlers = new Map();
  const electron = {
    app: { getAppMetrics: () => [], getPath: () => userData },
    BrowserWindow: class { static fromWebContents() { return null; } },
    WebContentsView: function WebContentsView() { throw new Error('no child view while idle'); },
    powerMonitor: { on() {}, isOnBatteryPower: () => false },
    Notification: class {}, shell: {}, dialog: {},
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {}, removeHandler() {}, removeListener() {} },
    session: { fromPartition: () => { throw new Error('no session while idle'); } }
  };
  // Observe the real service without adding a production inspection API.
  const runtimePath = require.resolve('../../src/electron/plugins/runtime');
  const loaded = new Module(runtimePath, module);
  loaded.filename = runtimePath; loaded.paths = module.paths;
  const runtimeRequire = Module.createRequire(runtimePath);
  let businessData;
  loaded.require = id => id === './businessData' ? {
    createBusinessDataService(options) {
      businessData = runtimeRequire(id).createBusinessDataService(options);
      return businessData;
    }
  } : runtimeRequire(id);
  loaded._compile(fs.readFileSync(runtimePath, 'utf8'), runtimePath);
  const runtime = loaded.exports.createPluginRuntime({
    electron, userDataDir: userData, getSettings: () => settings,
    applySettingsPatch() {}, persistManagementSettings() {},
    persistPluginStates: states => { settings.pluginStates = states; },
    getLocale: () => 'en', getContext: () => ({ mode: 'local', hubMode: 'local', deviceId: 'd1' }),
    tokenRateApi, presentation, log() {}, env: {},
    isMainSender: event => event.sender === sender,
    businessAdapters: {
      sourceId: () => settings.source || 'local',
      extras: stats => { work.extras++; publications.push(stats); return { preferences: { sessionTitlesEnabled: settings.sessionTitlesEnabled !== false } }; },
      loadAllTime: () => { work.loads++; return null; },
      loadHistory: () => { work.loads++; return null; },
      loadSubscriptions: () => []
    }
  });
  runtime.start();
  // The main window reads the catalog once and then listens for changes.
  handlers.get('plugins:list')({ sender, senderFrame: sender.mainFrame });
  runtime.manager.onChanged(() => { work.changes++; });
  const stats = i => ({ periods: { today: { totalTokens: 1000 + i, costUsd: 1 }, month: { totalTokens: 9000 + i, costUsd: 9 } }, limits: { providers: [] }, updatedAt: i });
  return { runtime, settings, work, stats, publications, businessData };
}

for (const pluginsEnabled of [true, false]) {
  test(`no active plugin, master switch ${pluginsEnabled ? 'on' : 'off'}: pushes and settings patches do no plugin work`, async t => {
    const h = host(t, { pluginsEnabled });
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (...args) => { h.work.timers++; return realSetTimeout(...args); };
    try {
      for (let i = 0; i < 200; i++) {
        h.runtime.publishStats(h.stats(i));
        if (i % 20 === 0) { h.settings.unrelated = i; h.runtime.settingsChanged(); h.runtime.refreshBusinessData(); }
      }
    } finally { global.setTimeout = realSetTimeout; }
    assert.deepEqual(h.work, { extras: 0, loads: 0, sends: 0, changes: 0, timers: 0 });
    assert.deepEqual(h.runtime.manager.list().plugins.map(plugin => plugin.status), [pluginsEnabled ? 'disabled' : 'pluginsOff']);
    h.runtime.dispose();
  });
}

test('the master switch still announces itself, and the first active plugin receives the latest parked push', t => {
  const h = host(t, { pluginsEnabled: false });
  for (let i = 0; i < 5; i++) h.runtime.publishStats(h.stats(i));
  h.settings.pluginsEnabled = true; h.runtime.settingsChanged();
  assert.equal(h.work.changes, 1, 'availability changed, so the catalog refreshes once');
  assert.equal(h.work.extras, 0);
  h.runtime.manager.setEnabled('system-monitor', true);
  assert.equal(h.work.extras, 1, 'the parked push is published once on activation');
  h.runtime.publishStats(h.stats(6));
  assert.equal(h.work.extras, 2, 'active plugins receive every push');
  h.runtime.dispose();
});

test('a push parked before a backend switch is never published under the new backend', t => {
  const h = host(t, { pluginsEnabled: true });
  h.runtime.publishStats(h.stats(1));
  h.settings.source = 'hub'; h.runtime.refreshBusinessData();
  h.runtime.manager.setEnabled('system-monitor', true);
  assert.equal(h.work.extras, 0, 'stale backend data waits for the next push');
  h.runtime.publishStats(h.stats(2));
  assert.equal(h.work.extras, 1);
  h.runtime.dispose();
});


test('source changes while inactive invalidate published snapshots before reactivation', async t => {
  const h = host(t, { pluginsEnabled: true });
  h.runtime.manager.setEnabled('system-monitor', true);
  h.runtime.publishStats(h.stats(99));
  h.runtime.manager.setEnabled('system-monitor', false);
  h.settings.source = 'hub'; h.runtime.refreshBusinessData();
  h.runtime.manager.setEnabled('system-monitor', true);
  const value = await h.businessData.query({ version: 1, resource: 'usage', period: 'today' }, { pluginId: 'review', active: true, permissions: ['tm.data.usage'], revision: 1 });
  assert.notEqual(value.availability, 'available', 'old source data must not remain queryable');
  h.runtime.dispose();
});

test('a fresh push from the new source survives an inactive refresh', t => {
  const h = host(t, { pluginsEnabled: true });
  h.runtime.publishStats(h.stats(1));
  h.settings.source = 'hub';
  const fresh = h.stats(2); h.runtime.publishStats(fresh);
  h.runtime.refreshBusinessData();
  h.runtime.manager.setEnabled('system-monitor', true);
  assert.equal(h.work.extras, 1);
  assert.equal(h.publications[0], fresh);
  h.runtime.dispose();
});


test('privacy changes while disabled apply before a plugin can query after reactivation', async t => {
  const h = host(t, { pluginsEnabled: true });
  const stats = h.stats(1);
  stats.periods.today.sessions = { a: { sessionId: 'a', client: 'codex', title: 'private title', totalTokens: 1 } };
  h.runtime.manager.setEnabled('system-monitor', true); h.runtime.publishStats(stats);
  h.runtime.manager.setEnabled('system-monitor', false);
  h.settings.sessionTitlesEnabled = false; h.runtime.settingsChanged();
  h.runtime.manager.setEnabled('system-monitor', true);
  const result = await h.businessData.query({ version: 1, resource: 'sessions', period: 'today' }, { pluginId: 'review', active: true, permissions: ['tm.data.sessions', 'tm.data.identities'], revision: 2 });
  assert.equal(result.rows[0].title, null);
  h.runtime.dispose();
});

test('inactive source round trips expire retained cursors', async t => {
  const h = host(t, { pluginsEnabled: true }), stats = h.stats(1);
  stats.periods.today.sessions = Object.fromEntries(['a', 'b'].map(sessionId => [sessionId, { sessionId, client: 'codex', totalTokens: 1 }]));
  h.runtime.manager.setEnabled('system-monitor', true); h.runtime.publishStats(stats);
  const auth = { pluginId: 'review', active: true, permissions: ['tm.data.sessions'], revision: 1 };
  const query = { version: 1, resource: 'sessions', period: 'today', page: { limit: 1 } };
  const first = await h.businessData.query(query, auth);
  assert.ok(first.pageInfo.nextCursor);
  h.runtime.manager.setEnabled('system-monitor', false);
  h.settings.source = 'hub'; h.runtime.refreshBusinessData();
  h.settings.source = 'local'; h.runtime.refreshBusinessData();
  h.runtime.manager.setEnabled('system-monitor', true);
  const next = await h.businessData.query({ ...query, page: { limit: 1, cursor: first.pageInfo.nextCursor } }, auth);
  assert.equal(next.availability, 'snapshotExpired');
  h.runtime.dispose();
});

test('mutation parks the latest push and drains once at completion', t => {
  const h = host(t, { pluginsEnabled: true });
  h.runtime.manager.setEnabled('system-monitor', true);
  h.runtime.manager.beginMutation();
  h.runtime.publishStats(h.stats(1)); const latest = h.stats(2); h.runtime.publishStats(latest);
  assert.equal(h.work.extras, 0);
  h.runtime.manager.endMutation();
  assert.deepEqual(h.publications, [latest]);
  h.runtime.dispose();
});
