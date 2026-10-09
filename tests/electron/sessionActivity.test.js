'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projection = require('../../src/shared/sessionActivityProjection');
const titles = require('../../src/electron/sessionTitleDisplay');
const publisher = require('../../src/electron/statsPublisher');
const syncDisplay = require('../../src/electron/syncDisplayStats');
const { mergedLocalAllTimeSessions } = require('../../src/shared/localSessions');

test('host and iCloud activity snapshots retain the captured local history for TOTAL pulls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const publishStart = source.indexOf('function publishLocalSessionActivity(');
  const publishEnd = source.indexOf('\n// Two options', publishStart);
  const pullStart = source.indexOf('function rendererAllTimeSessions(');
  const pullEnd = source.indexOf('\nlet codexPresentationPendingSince', pullStart);
  for (const mode of ['host', 'icloud']) {
    const session = { client: 'claude', sessionId: 'past', totalTokens: 500, title: 'Past' };
    const local = { deviceId: 'local', allTime: { sessions: { 'claude:past': session } } };
    const previous = { periods: { today: { sessions: {} }, month: { sessions: {} }, allTime: { sessions: {} } } };
    const snapshots = new WeakMap(); snapshots.set(previous, { localDevice: local });
    const patch = { observations: [{ client: 'claude', sessionId: 'past',
      liveActivity: { state: 'waiting', observedAt: new Date().toISOString() } }],
      nativeSessions: { today: {}, month: {}, allTime: {} } };
    const context = {
      settings: {}, latestStats: previous, localStats: previous, lastCollectedDevice: local, localDevice: local,
      isExternalAgentActive: () => false, ...syncDisplay, ...projection,
      snapshotLocalDevices: snapshots, rendererSnapshots: publisher.createRendererSnapshots({ source: () => mode }),
      presentationCache: publisher.createStatsPresentationCache(), allTimeSessionsCache: publisher.createStatsPresentationCache(),
      mergedLocalAllTimeSessions, projectModelAliasSessions: (_stats, sessions) => sessions,
      electronPresentationStats: stats => stats, updateEdgeDockCells: () => {}, sendPush: () => {},
      withoutSessionTitles: titles.withoutSessionTitles
    };
    vm.runInNewContext(source.slice(publishStart, publishEnd) + '\n' + source.slice(pullStart, pullEnd), context);
    context.publishLocalSessionActivity(patch);
    const pulled = context.rendererAllTimeSessions(context.latestStats);
    assert.equal(pulled['claude:past']?.totalTokens, 500, mode);
    assert.equal(pulled['claude:past']?.liveActivity?.state, 'waiting', mode);
    assert.equal(local.allTime.sessions['claude:past'].liveActivity, undefined, 'original accounting snapshot is immutable');
  }
});

test('a late TOTAL load reapplies title policy after restoring a previously visible native activity row', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const displayStart = source.indexOf('let localSessionActivity = null;');
  const displayEnd = source.indexOf('\nfunction setRendererSettings(', displayStart);
  const loadStart = source.indexOf('const allTimeSessions = allTimeSessionsApi.');
  const loadEnd = source.indexOf('\nfunction handleWindowVisibilityChange', loadStart);
  const snapshot = { id: 1, source: 'local' };
  const state = { stats: { snapshot, periods: { allTime: {} } }, settings: {} };
  let finish;
  const context = { state, allTimeSessionsApi: require('../../src/electron/renderer/allTimeSessions'),
    allTimeSessionsNeeded: () => true, statsRenderScheduler: { request: () => {} }, console,
    window: { TokenMonitorSessionActivityProjection: projection, TokenMonitorSessionTitleDisplay: titles,
      tokenMonitor: { getAllTimeSessions: () => new Promise(resolve => { finish = resolve; }) } } };
  vm.runInNewContext(source.slice(displayStart, displayEnd) + '\n' + source.slice(loadStart, loadEnd)
    + '\nglobalThis.loader = allTimeSessions;', context);
  context.incoming = { snapshot, patch: { observations: [],
    nativeSessions: { today: { zero: { client: 'claude', sessionId: 'zero', title: 'PRIVATE native title' } } } } };
  vm.runInNewContext('localSessionActivity = incoming;', context);
  context.loader.ensure();
  await Promise.resolve();
  state.settings.sessionTitlesEnabled = false;
  finish({ old: { client: 'claude', sessionId: 'old', title: 'PRIVATE history title', totalTokens: 500 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.stats.periods.allTime.sessions.old.title, undefined);
  assert.equal(state.stats.nativeSessions.today.zero.title, undefined);
  assert.equal(state.stats.periods.allTime.sessions.old.totalTokens, 500);
});

test('renderer activity survives late detail loads on the same accounting snapshot and respects title policy and source changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('let localSessionActivity = null;');
  const end = source.indexOf('\nfunction setRendererSettings(', start);
  const context = { state: { settings: { sessionTitlesEnabled: false } }, window: {
    TokenMonitorSessionActivityProjection: projection, TokenMonitorSessionTitleDisplay: titles
  } };
  vm.runInNewContext(source.slice(start, end), context);
  const native = { client: 'claude', sessionId: 'zero', title: 'PRIVATE', native: true };
  context.incoming = { snapshot: { id: 1, source: 'local' }, patch: { observations: [{ client: 'claude', sessionId: 'old',
    liveActivity: { state: 'waiting', observedAt: '2026-10-09T00:01:00Z' } }], nativeSessions: { today: { zero: native } } } };
  vm.runInNewContext('localSessionActivity = incoming;', context);
  const lateDetail = { snapshot: { id: 1, source: 'local' }, periods: { allTime: { sessions: {
    old: { client: 'claude', sessionId: 'old', title: 'PRIVATE', totalTokens: 500 }
  } } } };
  const shown = context.sessionStatsForDisplay(lateDetail);
  assert.equal(require('../../src/shared/sessionLive').sessionWithActivity(shown.periods.allTime, 'old').liveActivity.state, 'waiting');
  assert.equal(shown.periods.allTime.sessions.old.title, undefined);
  assert.equal(shown.nativeSessions.today.zero.title, undefined);
  assert.equal(lateDetail.periods.allTime.sessions.old.liveActivity, undefined);
  for (const snapshot of [{ id: 2, source: 'local' }, { id: 1, source: 'new-hub' }]) {
    const next = { ...lateDetail, snapshot };
    assert.equal(context.applyLocalSessionActivity(next), next);
  }
});
