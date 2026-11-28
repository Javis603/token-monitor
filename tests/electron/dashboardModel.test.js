'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../../src/electron/renderer/dashboard/dashboardModel');
const usageCharts = require('../../src/electron/renderer/usageCharts');

test('buildFleetModel detects single-device vs multi-device fleet and computes active workspace & shares', () => {
  const single = model.buildFleetModel({
    stats: {
      localDeviceId: 'mac-1',
      devices: [{ deviceId: 'mac-1', displayName: 'MacBook Pro', platform: 'darwin', deviceKind: 'laptop', periods: { today: { totalTokens: 1200, costUsd: 0.4, clients: { claude: 1200 } } } }],
      periods: {
        today: {
          totalTokens: 1200,
          sessions: {
            'claude:s1': { client: 'claude', projectLabel: 'token-monitor', lastUsedAt: new Date().toISOString(), sourceDevice: { deviceId: 'mac-1' } }
          }
        }
      }
    },
    periodKey: 'today'
  });
  assert.equal(single.isFleetMode, false);
  assert.equal(single.machines.length, 1);
  assert.equal(single.machines[0].deviceKind, 'laptop');
  assert.equal(single.machines[0].activeWorkspace, 'token-monitor');
  assert.equal(single.machines[0].share, 1);

  const multi = model.buildFleetModel({
    stats: {
      localDeviceId: 'mac-1',
      devices: [
        { deviceId: 'mac-1', displayName: 'Mac Studio', platform: 'darwin', periods: { today: { totalTokens: 3000, costUsd: 1.5, clients: { codex: 3000 } } } },
        { deviceId: 'srv-1', displayName: 'Linux GPU', platform: 'linux', deviceKind: 'server', stale: false, periods: { today: { totalTokens: 1000, costUsd: 0.5, clients: { claude: 1000 } } } }
      ],
      periods: {
        today: {
          sessions: {
            'claude:remote': { client: 'claude', projectLabel: 'gpu-train', lastUsedAt: new Date().toISOString(), sourceDevice: { deviceId: 'srv-1' } }
          }
        }
      }
    },
    periodKey: 'today',
    liveRatesByDevice: { 'srv-1': 84.5 }
  });
  assert.equal(multi.isFleetMode, true);
  assert.equal(multi.machines.length, 2);
  const srv = multi.machines.find((m) => m.deviceId === 'srv-1');
  const mac = multi.machines.find((m) => m.deviceId === 'mac-1');
  assert.equal(srv.share, 0.25);
  assert.equal(mac.share, 0.75);
  assert.equal(srv.liveTokPerSec, 84.5);
  assert.equal(srv.activeSessionCount, 1);
  assert.equal(srv.activeWorkspace, 'gpu-train');
});

test('device cards prefer the latest active project and fall back to a named recent project', () => {
  const nowMs = Date.parse('2026-11-28T12:00:00Z');
  const session = (projectLabel, ageSeconds, activity = {}) => ({
    client: 'codex',
    projectLabel,
    lastUsedAt: new Date(nowMs - ageSeconds * 1000).toISOString(),
    sourceDevice: { deviceId: 'mac-1' },
    ...activity
  });
  const projectFor = (sessions, devices = [{ deviceId: 'mac-1' }]) => model.buildScopedOverview({
    nowMs,
    stats: {
      localDeviceId: 'mac-1',
      devices,
      periods: { today: { totalTokens: 100, sessions } }
    }
  }).topology.devices[0].cardProject;
  const running = session('Token Monitor', 10, { turnEnded: false });
  const waiting = session('Docs', 5, { waitingForInput: true });
  const ended = session('Website', 3, { turnEnded: true });
  const unnamed = session('', 1, { title: 'Session title' });

  assert.equal(projectFor({ running, ended }), 'Token Monitor');
  assert.equal(projectFor({ running, waiting, ended, unnamed }), 'Docs');
  assert.equal(projectFor({ ended, unnamed }), 'Website');
  assert.equal(projectFor({ unnamed }), '');
  assert.equal(projectFor({ running, ended }, []), 'Token Monitor');
  assert.equal(projectFor({
    'codex:parent': { ...ended, sessionId: 'parent' },
    'codex:child': { ...running, sessionId: 'child', parentSessionId: 'parent', parentClient: 'codex' }
  }), 'Token Monitor');
});

test('selectScopedHistory and buildScopedOverview isolate a selected machine without cross-machine leaks', () => {
  const history = {
    daily: [
      { date: '2026-11-24', tokens: 5000, cost: 2.0, perClient: { claude: { tokens: 3000, cost: 1.2 }, codex: { tokens: 2000, cost: 0.8 } } }
    ],
    deviceHistories: [
      {
        deviceId: 'mac-1',
        displayName: 'Mac',
        historyAvailable: true,
        history: { daily: [{ date: '2026-11-24', tokens: 3000, cost: 1.2, perClient: { claude: { tokens: 3000, cost: 1.2 } } }] }
      },
      {
        deviceId: 'pc-2',
        displayName: 'Workstation',
        historyAvailable: true,
        history: { daily: [{ date: '2026-11-24', tokens: 2000, cost: 0.8, perClient: { codex: { tokens: 2000, cost: 0.8 } } }] }
      }
    ]
  };
  const stats = {
    localDeviceId: 'mac-1',
    devices: [
      { deviceId: 'mac-1', displayName: 'Mac', periods: { today: { totalTokens: 3000, costUsd: 1.2, clients: { claude: 3000 } } } },
      { deviceId: 'pc-2', displayName: 'Workstation', periods: { today: { totalTokens: 2000, costUsd: 0.8, clients: { codex: 2000 } } } }
    ],
    periods: {
      today: {
        totalTokens: 5000,
        costUsd: 2.0,
        sessions: {
          'claude:a': { client: 'claude', projectLabel: 'repo-mac', totalTokens: 3000, sourceDevice: { deviceId: 'mac-1' } },
          'codex:b': { client: 'codex', projectLabel: 'repo-pc', totalTokens: 2000, sourceDevice: { deviceId: 'pc-2' } }
        }
      }
    }
  };

  const scoped = model.buildScopedOverview({ stats, history, periodKey: 'today', selectedDeviceId: 'pc-2' });
  assert.equal(scoped.hero.tokens, 2000);
  assert.equal(scoped.tools.map((t) => t.id).join(','), 'codex');
  assert.deepEqual(scoped.sessions.map((s) => s.key), ['codex:b']);
  assert.equal(scoped.sessions[0].deviceName, 'Workstation');
  assert.equal(scoped.sessions[0].isLocalDevice, false);
  assert.deepEqual(scoped.workspaces.map((w) => w.name), ['repo-pc']);
  assert.deepEqual(scoped.workspaces[0].devices, ['Workstation']);
  assert.equal(scoped.scopedHistory.daily.length, 1);
  assert.equal(scoped.scopedHistory.daily[0].tokens, 2000);
  const historyOnly = model.buildFleetModel({ history });
  assert.equal(historyOnly.machines.length, 2);
  assert.equal(historyOnly.fleetTotals.onlineCount, 0);
});

test('workspace attribution follows each member of a cross-project session group', () => {
  const first = { projectLabel: 'First', totalTokens: 120, sourceDevice: { deviceId: 'a', name: 'Mac' } };
  const second = { projectLabel: 'Second', totalTokens: 60, sourceDevice: { deviceId: 'b', name: 'PC' } };
  const rows = model.buildWorkspaceList({
    statsMode: 'sync',
    periodData: { sessions: { first, second } },
    sessions: [{ groupRows: [first, second] }]
  });
  assert.deepEqual(rows.map(row => [row.name, row.deviceIds, row.devices]), [
    ['First', ['a'], ['Mac']], ['Second', ['b'], ['PC']]
  ]);
});

test('selected workspace and Flow use the device rollup when session details are truncated', () => {
  const session = { client: 'codex', sessionId: 'one', projectLabel: 'Repo', totalTokens: 40, sourceDevice: { deviceId: 'a' } };
  const stats = {
    mode: 'sync', localDeviceId: 'a',
    periods: { today: { totalTokens: 120, sessions: { 'codex:one': session } } },
    devices: [
      { deviceId: 'a', periods: { today: { totalTokens: 100, projects: { repo: { label: 'Repo', tokens: 100 } } } } },
      { deviceId: 'b', periods: { today: { totalTokens: 20 } } }
    ]
  };
  const overview = model.buildScopedOverview({ stats, selectedDeviceId: 'a' });
  assert.equal(overview.workspaces[0].tokens, 100);
  assert.equal(overview.topology.devToHub[0].tokens, 100);
  assert.equal(overview.topology.hubToEnd[0].tokens, 40);
  const capped = model.buildTopologyGraph({
    ...overview,
    sessions: [...overview.sessions, { ...overview.sessions[0], key: 'two', totalTokens: 60 }]
  }, { maxEndpoints: 1 });
  assert.equal(capped.endpoints.length, 1);
  assert.equal(capped.devToHub[0].tokens, 100);
  assert.equal(capped.hubToEnd[0].tokens, 40);
});

test('Live Flow retains a confirmed device-to-workspace edge without session details', () => {
  const usage = { totalTokens: 100, clients: { codex: 100 }, models: { 'gpt-5': 100 } };
  const device = {
    deviceId: 'a',
    periods: { today: { ...usage, projects: { repo: { label: 'Repo', tokens: 100 } } } }
  };
  const stats = { mode: 'sync', periods: { today: usage }, devices: [device, { deviceId: 'b' }] };
  const { topology } = model.buildScopedOverview({ stats, selectedDeviceId: 'a' });
  assert.equal(topology.mode, 'sessions');
  assert.deepEqual(topology.hubs.map(hub => [hub.id, hub.tokens]), [['ws:repo', 100]]);
  assert.deepEqual(topology.devToHub.map(edge => [edge.from, edge.to, edge.tokens]), [['a', 'ws:repo', 100]]);
  assert.deepEqual(topology.endpoints, []);

  device.periods.today.projects = {};
  const fallback = model.buildScopedOverview({ stats, selectedDeviceId: 'a' }).topology;
  assert.deepEqual(fallback.hubs.map(hub => hub.id), ['tool:codex']);
  assert.deepEqual(fallback.endpoints.map(endpoint => endpoint.id), ['model:gpt-5']);
});

test('selected-device workspace totals use recovered sessions when the project rollup is incomplete', () => {
  const session = (id, projectLabel, totalTokens) => ({
    sessionId: id, client: 'codex', projectLabel, totalTokens, sourceDevice: { deviceId: 'a' }
  });
  const sessions = { 'codex:inline': session('inline', 'Inline', 40), 'codex:paged': session('paged', 'Paged', 60) };
  const projects = { inline: { label: 'Inline', tokens: 40 } };
  const period = { totalTokens: 100, projects };
  const stats = {
    mode: 'sync',
    periods: { month: { totalTokens: 100, sessions }, allTime: { totalTokens: 100, sessions } },
    devices: [
      {
        deviceId: 'a', periodProjectsOmitted: { month: 1 }, allTimeProjectsIncomplete: true,
        periods: { month: period, allTime: period }
      },
      { deviceId: 'b' }
    ]
  };
  for (const periodKey of ['month', 'allTime']) {
    const overview = model.buildScopedOverview({ stats, selectedDeviceId: 'a', periodKey, syncedPagesLoaded: true });
    assert.deepEqual(overview.workspaces.map(row => [row.name, row.tokens]), [['Paged', 60], ['Inline', 40]]);
  }
});

test('selected-device workspace rollups respect both stamped and legacy native period expiry', () => {
  const nowMs = Date.parse('2026-11-27T00:00:00Z');
  const period = { totalTokens: 100, projects: { repo: { label: 'Repo', tokens: 100 } } };
  const device = { deviceId: 'a', updatedAt: '2026-10-31T23:30:00Z', periods: { today: period, month: period } };
  const stats = { mode: 'sync', periods: { today: {}, month: {} }, devices: [device, { deviceId: 'b' }] };
  const workspaces = (periodKey) => model.buildScopedOverview({ stats, selectedDeviceId: 'a', periodKey, nowMs }).workspaces;
  for (const periodKey of ['today', 'month']) assert.deepEqual(workspaces(periodKey), []);

  device.periodWindows = {
    today: { endsAt: '2026-11-27T00:00:00Z' },
    month: { endsAt: '2026-12-01T00:00:00Z' }
  };
  device.updatedAt = '2026-11-27T00:00:00Z';
  assert.deepEqual(workspaces('today'), []);
  device.updatedAt = '2026-10-31T23:30:00Z';
  assert.deepEqual(workspaces('month').map(row => [row.name, row.tokens]), [['Repo', 100]]);
});

test('selected-device workspaces and Flow omit stale sessions when a displayed snapshot rolls over', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const boundary = Date.parse(endsAt);
  const updatedAt = new Date(boundary - 1000).toISOString();
  const period = {
    totalTokens: 100,
    clients: { codex: 100 },
    models: { 'gpt-5': 100 },
    clientModels: { codex: { 'gpt-5': 100 } },
    projects: { repo: { label: 'Repo', tokens: 100 } },
    sessions: { 'codex:one': {
      client: 'codex', sessionId: 'one', projectLabel: 'Repo', totalTokens: 100,
      lastUsedAt: updatedAt, turnEnded: true, sourceDevice: { deviceId: 'a' }
    } }
  };
  const periods = { today: period, month: period };
  const stats = {
    mode: 'sync', periods,
    devices: [
      { deviceId: 'a', updatedAt, periods, periodWindows: { today: { endsAt }, month: { endsAt } } },
      { deviceId: 'b' }
    ]
  };
  for (const periodKey of ['today', 'month']) {
    const options = { stats, selectedDeviceId: 'a', periodKey };
    const before = model.buildScopedOverview({ ...options, nowMs: boundary - 1 });
    assert.equal(before.workspaces[0]?.tokens, 100);
    assert.equal(before.topology.hubs[0]?.tokens, 100);
    const after = model.buildScopedOverview({ ...options, nowMs: boundary });
    assert.equal(after.hero.tokens, 0);
    assert.equal(after.activeMachine.tokens, 0);
    assert.equal(after.topology.devices[0]?.tokens, 0);
    assert.deepEqual(after.workspaces, []);
    assert.deepEqual(after.topology.hubs, []);
    assert.deepEqual(after.topology.endpoints, []);
    assert.deepEqual(after.topology.devToHub, []);
    assert.deepEqual(after.sessions, []);
  }
  period.sessions['codex:one'].turnEnded = false;
  const running = model.buildScopedOverview({ stats, selectedDeviceId: 'a', periodKey: 'today', nowMs: boundary });
  assert.equal(running.sessions[0]?.resumedFromPriorPeriod, true);
  assert.equal(running.sessions[0]?.totalTokens, 0);
  assert.equal(running.topology.hubs[0]?.tokens, 0);
});

test('a fresh native activity row survives expiry of the local usage snapshot', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const observedAt = '2026-12-01T00:00:01Z';
  const activity = {
    client: 'codex', sessionId: 'new', totalTokens: 0, costUsd: 0, lastUsedAt: observedAt,
    liveActivity: { state: 'running', observedAt }
  };
  const periods = { today: { totalTokens: 50 }, month: { totalTokens: 50 } };
  const stats = {
    mode: 'sync', localDeviceId: 'a', periods,
    nativeSessions: { today: { 'codex:new': activity }, month: { 'codex:new': activity } },
    devices: [
      { deviceId: 'a', periods, periodWindows: { today: { endsAt }, month: { endsAt } } },
      { deviceId: 'b' }
    ]
  };
  for (const periodKey of ['today', 'month']) {
    const overview = model.buildScopedOverview({ stats, periodKey, selectedDeviceId: 'a', nowMs: Date.parse(observedAt) });
    const active = overview.sessions.find(row => row.sessionId === 'new');
    assert.equal(active?.activityState, 'running');
    assert.equal(active?.totalTokens, 0);
    assert.equal(overview.topology.endpoints[0]?.id, 'codex:new');
    assert.equal(overview.hero.tokens, 0);
  }
});

test('aggregate Today and Month wait for a fresh publication after a contributing device rolls over', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const boundary = Date.parse(endsAt);
  const capturedAt = new Date(boundary - 1000).toISOString();
  const period = {
    totalTokens: 100, clients: { codex: 100 }, models: { 'gpt-5': 100 },
    projects: { repo: { label: 'Old Repo', tokens: 100 } },
    sessions: { 'codex:old': {
      client: 'codex', sessionId: 'old', projectLabel: 'Old Repo', totalTokens: 100,
      turnEnded: true, lastUsedAt: capturedAt, sourceDevice: { deviceId: 'a' }
    } }
  };
  const a = { deviceId: 'a', periods: { today: period, month: period }, periodWindows: { today: { endsAt }, month: { endsAt } } };
  const fresh = { totalTokens: 25, clients: { claude: 25 } };
  const b = { deviceId: 'b', periods: { today: fresh, month: fresh }, updatedAt: endsAt,
    periodWindows: { today: { endsAt: '2026-12-01T08:00:00Z' }, month: { endsAt: '2026-12-02T08:00:00Z' } } };
  for (const devices of [[a], [a, b]]) {
    for (const periodKey of ['today', 'month']) {
      const aggregate = { ...period, totalTokens: devices.length > 1 ? 125 : 100 };
      const stats = { mode: 'sync', updatedAt: capturedAt, periods: { [periodKey]: aggregate }, devices };
      const before = model.buildScopedOverview({ stats, periodKey, nowMs: boundary - 1 });
      assert.equal(before.hero.tokens, aggregate.totalTokens);
      assert.equal(before.nextAccountingExpiryAt, boundary);
      const expired = model.buildScopedOverview({ stats, periodKey, nowMs: boundary });
      assert.equal(expired.accountingExpired, true);
      assert.equal(expired.hero.tokens, 0);
      assert.deepEqual(expired.sessions, []);
      assert.deepEqual(expired.workspaces, []);
      assert.deepEqual(expired.topology.hubs, []);
      if (devices.length > 1) {
        const selected = model.buildScopedOverview({ stats, periodKey, selectedDeviceId: 'b', nowMs: boundary });
        assert.equal(selected.hero.tokens, 25);
        assert.equal(selected.hero.accountingStatus, 'ready');
        const expiredDevice = model.buildScopedOverview({ stats, periodKey, selectedDeviceId: 'a', nowMs: boundary });
        assert.equal(expiredDevice.hero.accountingStatus, 'unavailable');
        assert.equal(expiredDevice.periodData, null);
      }
      const nextPeriod = devices.length > 1 ? fresh : { totalTokens: 0 };
      const next = model.buildScopedOverview({
        stats: { ...stats, updatedAt: endsAt, periods: { [periodKey]: nextPeriod } }, periodKey, nowMs: boundary
      });
      assert.equal(next.accountingExpired, false);
      assert.equal(next.hero.tokens, nextPeriod.totalTokens);
    }
  }
});

test('a native-only session disappears when its live activity expires after rollover', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const observedAt = '2026-11-30T23:59:40Z';
  const leaseEnd = Date.parse(observedAt) + 30_000;
  const session = {
    client: 'antigravity', sessionId: 'acp', native: true, totalTokens: 0, lastUsedAt: observedAt,
    liveActivity: { state: 'running', observedAt }
  };
  const periods = { today: { totalTokens: 50 }, month: { totalTokens: 50 } };
  const native = { 'antigravity:acp': session };
  const stats = {
    mode: 'sync', localDeviceId: 'a', periods, nativeSessions: { today: native, month: native },
    devices: [
      { deviceId: 'a', periods, periodWindows: { today: { endsAt }, month: { endsAt } } },
      { deviceId: 'b' }
    ]
  };
  for (const periodKey of ['today', 'month']) {
    const options = { stats, periodKey, selectedDeviceId: 'a' };
    const active = model.buildScopedOverview({ ...options, nowMs: leaseEnd - 1 });
    assert.equal(active.sessions[0]?.activityState, 'running');
    assert.equal(active.topology.endpoints[0]?.id, 'antigravity:acp');
    const expired = model.buildScopedOverview({ ...options, nowMs: leaseEnd });
    assert.deepEqual(expired.sessions, []);
    assert.deepEqual(expired.topology.endpoints, []);
  }
});

test('fleet keeps the verified aggregate when a zero-use device crosses its own boundary', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const nowMs = Date.parse(endsAt);
  for (const periodKey of ['today', 'month']) {
    const stats = {
      mode: 'sync', updatedAt: '2026-11-30T23:59:00Z', periods: { [periodKey]: { totalTokens: 100 } },
      devices: [
        { deviceId: 'mac', periods: { [periodKey]: { totalTokens: 0 } }, periodWindows: { [periodKey]: { endsAt } } },
        { deviceId: 'pc', periods: { [periodKey]: { totalTokens: 100 } },
          periodWindows: { [periodKey]: { endsAt: '2026-12-01T08:00:00Z' } } }
      ]
    };
    const all = model.buildScopedOverview({ stats, periodKey, nowMs });
    const mac = model.buildScopedOverview({ stats, periodKey, nowMs, selectedDeviceId: 'mac' });
    assert.equal(all.hero.accountingStatus, 'ready');
    assert.equal(all.hero.tokens, 100);
    assert.deepEqual(all.fleet.aggregateAccounting, { accountingStatus: 'ready', tokens: 100, hasShares: false });
    assert.deepEqual(mac.fleet.aggregateAccounting, all.fleet.aggregateAccounting);
    assert.equal(mac.hero.accountingStatus, 'unavailable');
    assert.equal(all.accountingWindows.get('mac').expired, true);
    assert.equal(all.accountingWindows.get('pc').expired, false);
    assert.ok(all.topology.devices.every(device => device.share === 0));
  }
});

test('zero-use local rollover expires native activity without withholding fleet accounting', () => {
  const endsAt = '2026-12-01T00:00:00Z';
  const observedAt = '2026-11-30T23:59:40Z';
  const leaseEnd = Date.parse(observedAt) + 30_000;
  const today = { totalTokens: 0 };
  const native = {
    client: 'antigravity', sessionId: 'acp', native: true, totalTokens: 0, lastUsedAt: observedAt,
    liveActivity: { state: 'running', observedAt }
  };
  const stats = {
    mode: 'sync', localDeviceId: 'a', periods: { today },
    nativeSessions: { today: { 'antigravity:acp': native } },
    devices: [{ deviceId: 'a', periods: { today }, periodWindows: { today: { endsAt } } }]
  };
  const options = { stats, periodKey: 'today' };
  const live = model.buildScopedOverview({ ...options, nowMs: leaseEnd - 1 });
  assert.equal(live.sessions[0]?.activityState, 'running');
  const expired = model.buildScopedOverview({ ...options, nowMs: leaseEnd });
  assert.equal(expired.hero.accountingStatus, 'ready');
  assert.equal(expired.hero.tokens, 0);
  assert.deepEqual(expired.sessions, []);
  assert.deepEqual(expired.topology.endpoints, []);
});

test('missing device History does not turn a known local aggregate into a device zero', () => {
  const nowMs = new Date(2026, 10, 27, 12).getTime();
  const stats = { mode: 'local', localDeviceId: 'a', devices: [{ deviceId: 'a' }] };
  const daily = [{ date: '2026-11-26', tokens: 100 }];
  const history = { daily, fixedPeriods: { historyTransportAvailable: true } };
  const options = { stats, history, nowMs, periodKey: 'yesterday' };
  const missing = model.buildScopedOverview(options);
  assert.equal(missing.hero.tokens, 100);
  assert.equal(missing.hero.accountingStatus, 'ready');
  assert.equal(missing.fleet.machines[0].accountingStatus, 'unavailable');
  assert.equal(missing.fleet.accountingComplete, false);
  assert.equal(missing.topology.devices[0].accountingStatus, 'unavailable');
  const ready = model.buildScopedOverview({
    ...options, history: { ...history, deviceHistories: [{ deviceId: 'a', historyAvailable: true, history: { daily } }] }
  });
  assert.equal(ready.fleet.machines[0].accountingStatus, 'ready');
  assert.equal(ready.fleet.machines[0].tokens, 100);
});

test('verified empty synced History keeps device zeroes available', () => {
  const devices = [{ deviceId: 'a' }, { deviceId: 'b' }];
  const view = model.buildScopedOverview({
    stats: { mode: 'sync', devices },
    history: {
      fixedPeriods: { historyTransportAvailable: true },
      deviceHistories: devices.map(device => ({ ...device, historyAvailable: true, history: { daily: [] } }))
    },
    selectedDeviceId: 'a',
    periodKey: 'yesterday'
  });
  assert.equal(view.fleet.accountingComplete, true);
  assert.equal(view.activeMachine.accountingStatus, 'ready');
  assert.equal(view.hero.accountingStatus, 'ready');
  assert.equal(view.hero.tokens, 0);
});

test('cold native periods withhold accounting until a source confirms a total', () => {
  for (const periodKey of ['today', 'month', 'allTime']) {
    const options = { periodKey };
    assert.equal(model.buildScopedOverview(options).hero.accountingStatus, 'unavailable');
    const known = model.buildScopedOverview({ ...options, stats: { periods: { [periodKey]: { totalTokens: 0 } } } });
    assert.equal(known.hero.accountingStatus, 'ready');
    assert.equal(known.hero.tokens, 0);
  }
  const retained = model.buildScopedOverview({
    periodKey: 'allTime',
    history: { daily: [{ date: '2026-11-26', tokens: 100 }] }
  });
  assert.equal(retained.hero.accountingStatus, 'partial');
  assert.equal(retained.hero.tokens, 100);
});

test('All Time fallback uses the uncapped History summary for aggregate and device totals', () => {
  const { normalizeHistory } = require('../../src/shared/history');
  const complete = normalizeHistory({ contributions: [
    { date: '2024-01-01', tokens: 90, cost: 9 },
    { date: '2026-11-26', tokens: 10, cost: 1 }
  ] }, { todayKey: '2026-11-27' });
  assert.equal(complete.daily.reduce((sum, day) => sum + day.tokens, 0), 10);
  const devices = [{ deviceId: 'mac' }, { deviceId: 'pc' }];
  const stats = { mode: 'sync', devices };
  const all = historyData => ({
    ...historyData,
    deviceHistories: [{ deviceId: 'mac', historyAvailable: true, history: historyData }]
  });
  for (const [history, tokens, status] of [
    [all(complete), 100, 'ready'],
    [all({ daily: [], summary: { totalTokens: 90, totalCost: 9, activeDaysComplete: false } }), 90, 'partial']
  ]) {
    for (const selectedDeviceId of ['all', 'mac']) {
      const view = model.buildScopedOverview({ stats, history, periodKey: 'allTime', selectedDeviceId });
      assert.equal(view.hero.tokens, tokens);
      assert.equal(view.hero.accountingStatus, status);
      assert.equal(view.fleet.aggregateAccounting.tokens, tokens);
      const mac = view.fleet.machines.find(machine => machine.deviceId === 'mac');
      assert.equal(mac.tokens, tokens);
      assert.equal(mac.accountingStatus, status);
    }
  }
  const local = model.buildScopedOverview({ periodKey: 'allTime', history: { daily: [{ date: '2026-11-26', tokens: 100 }] } });
  assert.equal(local.topology.devices[0].share, 0);
});

test('all-time History fallback preserves missing lifetime coverage', () => {
  const devices = [{ deviceId: 'mac' }, { deviceId: 'pc' }];
  for (const [daily, complete, expected, tokens] of [
    [[], false, 'unavailable', 0],
    [[{ date: '2026-11-26', tokens: 100 }], false, 'partial', 100],
    [[], true, 'ready', 0]
  ]) {
    const historyData = { daily, summary: { activeDaysComplete: complete } };
    const history = {
      ...historyData, fixedPeriods: { historyTransportAvailable: true },
      deviceHistories: devices.map(device => ({ ...device, historyAvailable: true, history: historyData }))
    };
    for (const selectedDeviceId of ['all', 'mac']) {
      const { hero } = model.buildScopedOverview({ stats: { devices }, history, periodKey: 'allTime', selectedDeviceId });
      assert.equal(hero.accountingStatus, expected);
      assert.equal(hero.tokens, tokens);
    }
  }
});

test('computeTokenAnatomy fails closed on unclassifiedTokens and computes cacheHitRate accurately', () => {
  const exact = model.computeTokenAnatomy({
    totalTokens: 1000,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    outputTokens: 100,
    capabilities: { tokenComponents: true }
  });
  assert.equal(exact.cacheRead, 600);
  assert.equal(exact.cacheMiss, 200);
  assert.equal(exact.unclassified, 0);
  assert.equal(Math.round(exact.cacheHitRate * 100), 67);
  assert.deepEqual(exact.segments.map((s) => s.labelKey), [
    'dashboard.tooltip.inputCacheHit',
    'dashboard.anatomy.cacheWrite',
    'dashboard.tooltip.inputCacheMiss',
    'dashboard.tooltip.output'
  ]);

  const partial = model.computeTokenAnatomy({
    totalTokens: 1000,
    cacheReadTokens: 300,
    outputTokens: 100,
    unclassifiedTokens: 400,
    capabilities: { tokenComponents: false }
  });
  assert.equal(partial.unclassified, 400);
  assert.equal(partial.cacheMiss, 200);
  assert.equal(partial.segments.find((s) => s.key === 'unclassified').tokens, 400);

  const mixed = { totalTokens: 1000, cacheReadTokens: 300, outputTokens: 100, capabilities: { tokenComponents: false } };
  assert.equal(model.computeTokenAnatomy(mixed).unclassified, 600);
  assert.equal(model.computeTokenAnatomy({ ...mixed, unclassifiedTokens: 0 }).cacheMiss, 600);
});

test('buildQuotaAccounts keys credits formatting off metric === credits across any provider', () => {
  const quotas = model.buildQuotaAccounts({
    limits: {
      providers: [
        {
          provider: 'openrouter',
          accountKey: 'or-1',
          windows: [{ kind: 'billing', metric: 'credits', label: 'Credits', remaining: 42.5, currency: 'USD', remainingPercent: 85 }]
        },
        {
          provider: 'claude',
          accountKey: 'cl-1',
          resetCredits: { availableCount: 2 },
          planLabel: 'pro 100',
          windows: [{ kind: 'session', label: 'Session', remainingPercent: 60, windowMinutes: 300, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }]
        },
        {
          provider: 'antigravity',
          accountKey: 'ag-1',
          accountEmail: 'javis3@gmail.com',
          plan: 'pro',
          windows: [{ kind: 'session', label: 'Gemini', remainingPercent: 78 }]
        },
        {
          provider: 'antigravity',
          accountKey: 'ag-2',
          accountEmail: 'linus8@gmail.com',
          plan: 'ultra',
          windows: [{ kind: 'session', label: 'Gemini', remainingPercent: 45 }]
        }
      ]
    }
  }, { maskLimitAccountEmails: true }, Date.now());

  const or = quotas.find((q) => q.providerId === 'openrouter');
  const cl = quotas.find((q) => q.providerId === 'claude');
  const ags = quotas.filter((q) => q.providerId === 'antigravity');
  assert.ok(or);
  assert.equal(or.windows[0].isCredits, true);
  assert.equal(or.windows[0].creditsText, '$42.50');
  assert.ok(cl);
  assert.equal(cl.name, 'Claude');
  assert.equal(cl.plan, 'Pro 100');
  assert.equal(cl.resetCount, 2);
  assert.equal(cl.iconClass, 'home-list-mark row-icon row-icon-claude');
  assert.ok(cl.windows[0].pacePercent >= 29 && cl.windows[0].pacePercent <= 31);
  assert.equal(ags.length, 2);
  assert.equal(ags[0].name, 'l***8@gmail.com');
  assert.equal(ags[0].plan, 'Ultra');
  assert.equal(ags[1].name, 'j***3@gmail.com');
  assert.equal(ags[1].plan, 'Pro');
});

test('buildLiveVelocityModel projects Edge Dock speed/burn telemetry and scopes to selected machine', () => {
  const now = 1_760_000_000_000;
  const sample = {
    speed: 140,
    burn: 8400,
    deviceCount: 2,
    idle: false,
    devices: [
      { id: 'mac-1', name: 'Mac', models: [{ model: 'claude-sonnet-4-5', speed: 80, burn: 4800 }] },
      { id: 'pc-2', name: 'Workstation', models: [{ model: 'gpt-5', speed: 60, burn: 3600 }] }
    ]
  };
  const rateSamples = [
    { at: now - 4000, speed: 90, burn: 5400 },
    { at: now - 1000, speed: 140, burn: 8400 }
  ];

  const fleetVel = model.buildLiveVelocityModel({ sample, rateSamples, rateMode: 'speed', selectedDeviceId: 'all', now });
  assert.equal(fleetVel.hasSample, true);
  assert.equal(fleetVel.primaryValue, 140);
  assert.equal(fleetVel.secondaryValue, 8400);
  assert.equal(fleetVel.points.length, 2);
  assert.equal(fleetVel.models.length, 2);

  const scopedBurn = model.buildLiveVelocityModel({ sample, rateSamples, rateMode: 'burn', selectedDeviceId: 'pc-2', now });
  assert.equal(scopedBurn.hasSample, true);
  assert.equal(scopedBurn.primaryValue, 3600);
  assert.equal(scopedBurn.secondaryValue, 60);
  assert.deepEqual(scopedBurn.models.map((m) => m.id), ['gpt-5']);
});

test('isometricHeatmapSvg renders a CSP-safe 3D skyline sorted back-to-front with gradients and month labels', () => {
  const daily = usageCharts.computeHeatmapIntensities([
    { date: '2026-11-01', tokens: 1200, cost: 0.45 },
    { date: '2026-11-15', tokens: 24000, cost: 8.4 }
  ]);
  const heat = usageCharts.contribHeatmap(daily, { startDate: '2026-10-01', endDate: '2026-11-26', intensityKey: 'costIntensity' });
  const svg = model.isometricHeatmapSvg(heat, {
    monthLabel: (m) => m.label,
    metric: 'cost',
    uid: 'testIso'
  });

  assert.match(svg, /^<svg class="dash-heatmap dash-heatmap--iso"/);
  assert.match(svg, /class="iso-base-plate"/);
  assert.match(svg, /<linearGradient id="testIso-top-4"/);
  assert.match(svg, /class="iso-col lvl-4"[^>]*data-d="2026-11-15"/);
  assert.match(svg, /class="heat-month iso-month"[^>]*>2026-11<\/text>/);
  assert.doesNotMatch(svg, /\sstyle\s*=/i, '3D heatmap SVG must stay free of inline style attributes for CSP');
});

test('buildActivityInsights computes weekday rhythm, busiest day, and peak days with tool attribution', () => {
  const sampleDaily = [
    // 2026-11-23 is Monday, 2026-11-24 is Tuesday, 2026-11-25 is Wednesday
    { date: '2026-11-16', tokens: 1000, cost: 1.0, perClient: { codex: { tokens: 1000, cost: 1.0 } } },
    { date: '2026-11-23', tokens: 3000, cost: 3.0, perClient: {
      claude: { tokens: 1000, cost: 3.0 }, codex: { tokens: 2000, cost: 0 }
    } },
    { date: '2026-11-24', tokens: 5000, cost: 2.0, perClient: { antigravity: { tokens: 5000, cost: 2.0 } } },
    { date: '2026-11-25', tokens: 0, cost: 0 }
  ];

  const costInsights = model.buildActivityInsights(sampleDaily, { metric: 'cost', topLimit: 2 });
  assert.equal(costInsights.activeDays, 3);
  assert.equal(costInsights.busiestWeekday.dayOfWeek, 1); // Monday avg cost (1+3)/2 = 2.0 === Tuesday 2.0 (first max wins)
  assert.equal(costInsights.weekdays[1].avg, 2.0);
  assert.equal(costInsights.weekdays[2].avg, 2.0);
  assert.deepEqual(costInsights.peakDays.map((d) => d.date), ['2026-11-23', '2026-11-24']);
  assert.equal(costInsights.peakDays[0].topClient.id, 'claude');

  const tokenInsights = model.buildActivityInsights(sampleDaily, { metric: 'tokens', topLimit: 2 });
  assert.equal(tokenInsights.busiestWeekday.dayOfWeek, 2); // Tuesday avg tokens 5000 > Monday avg 2000
  assert.deepEqual(tokenInsights.peakDays.map((d) => d.date), ['2026-11-24', '2026-11-23']);
  assert.equal(tokenInsights.peakDays[0].topClient.id, 'antigravity');

  const emptyInsights = model.buildActivityInsights([], { metric: 'cost' });
  assert.equal(emptyInsights.activeDays, 0);
  assert.equal(emptyInsights.busiestWeekday, null);
  assert.deepEqual(emptyInsights.peakDays, []);
});

test('buildTopologyGraph links devices, workspaces, and sessions cleanly and falls back to tools -> models', () => {
  const nowIso = new Date().toISOString();
  const sessionOverview = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-1',
      devices: [
        { deviceId: 'mac-1', displayName: 'MacBook M5', platform: 'darwin', deviceKind: 'laptop', periods: { today: { totalTokens: 6000, costUsd: 2.4, clients: { codex: 6000 } } } },
        { deviceId: 'imac-1', displayName: 'iMac M1', platform: 'darwin', deviceKind: 'desktop', periods: { today: { totalTokens: 2000, costUsd: 0.8, clients: { claude: 2000 } } } }
      ],
      periods: {
        today: {
          totalTokens: 8000,
          costUsd: 3.2,
          sessions: {
            'codex:live': { client: 'codex', projectLabel: 'Token Monitor', totalTokens: 6000, costUsd: 2.4, updatedAt: nowIso, lastUsedAt: nowIso, status: 'running', sourceDevice: { deviceId: 'mac-1' } },
            'claude:unassigned': { client: 'claude', totalTokens: 2000, costUsd: 0.8, lastUsedAt: '2026-01-01T00:00:00.000Z', sourceDevice: { deviceId: 'imac-1' } }
          }
        }
      }
    },
    periodKey: 'today',
    liveRatesByDevice: { 'mac-1': 72 }
  });

  const graph = sessionOverview.topology;
  assert.equal(graph.mode, 'sessions');
  assert.equal(graph.devices.length, 2);
  assert.equal(graph.hubs.length, 1);
  assert.equal(graph.endpoints.length, 2);
  assert.equal(graph.endpoints.find((ep) => ep.id === 'claude:unassigned').hubId, '');
  const liveEdge = graph.hubToEnd.find((e) => e.to === 'codex:live');
  assert.equal(liveEdge.active, true);
  assert.equal(liveEdge.liveRate, 72);

  const toolOverview = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-1',
      devices: [
        { deviceId: 'mac-1', displayName: 'MacBook M5', periods: { allTime: { totalTokens: 9000, costUsd: 3.0, clients: { codex: 9000 } } } }
      ],
      periods: {
        allTime: {
          totalTokens: 9000,
          costUsd: 3.0,
          clients: { codex: 9000 },
          clientCosts: { codex: 3.0 },
          models: { 'gpt-6.2-sol': 9000 },
          modelCosts: { 'gpt-6.2-sol': 3.0 },
          clientModels: { codex: { 'gpt-6.2-sol': 9000 } }
        }
      }
    },
    periodKey: 'allTime'
  });

  assert.equal(toolOverview.topology.mode, 'tools');
  assert.equal(toolOverview.topology.hubs[0].toolId, 'codex');
  assert.equal(toolOverview.topology.endpoints[0].modelId, 'gpt-6.2-sol');
  assert.equal(toolOverview.topology.hubToEnd.length, 1);
  assert.equal(toolOverview.topology.hubToEnd[0].from, 'tool:codex');
  assert.equal(toolOverview.topology.hubToEnd[0].to, 'model:gpt-6.2-sol');
  assert.deepEqual(toolOverview.topology.totals, { devices: 1, hubs: 1, endpoints: 1 });
  assert.deepEqual(toolOverview.topology.overflow, { devices: 0, hubs: 0, endpoints: 0 });
});

test('buildTopologyGraph includes all 6+ devices and 9 sessions by default, and respects explicit caps without misattribution', () => {
  const devices = Array.from({ length: 6 }, (_, i) => ({
    deviceId: `dev-${i + 1}`,
    displayName: `Host ${i + 1}`,
    deviceKind: i % 2 === 0 ? 'laptop' : 'desktop',
    periods: { today: { totalTokens: (10 - i) * 1000, costUsd: (10 - i) * 0.5, clients: { codex: 1000 } } }
  }));
  const sessions = Array.from({ length: 9 }, (_, i) => ({
    key: `codex:s-${i + 1}`,
    title: `Session ${i + 1}`,
    client: 'codex',
    projectLabel: `Repo ${(i % 6) + 1}`,
    totalTokens: (20 - i) * 500,
    costUsd: 1.2,
    sourceDevice: { deviceId: i === 7 ? 'dev-6' : `dev-${(i % 4) + 1}` }
  })).reduce((acc, item) => {
    const { key, ...rest } = item;
    acc[key] = rest;
    return acc;
  }, {});

  const stats = {
    localDeviceId: 'dev-1',
    devices,
    periods: {
      today: {
        totalTokens: 45000,
        costUsd: 15,
        sessions
      }
    }
  };

  const full = model.buildScopedOverview({ stats, periodKey: 'today' }).topology;
  assert.deepEqual(full.counts, { devices: 6, hubs: 6, endpoints: 9, activeEdges: 0 });
  assert.deepEqual(full.totals, { devices: 6, hubs: 6, endpoints: 9 });
  assert.deepEqual(full.overflow, { devices: 0, hubs: 0, endpoints: 0 });
  assert.ok(full.devToHub.some((edge) => edge.from === 'dev-6'), 'scrollable default includes 6th device edges directly');

  const compact = model.buildScopedOverview({
    stats,
    periodKey: 'today',
    topology: { maxDevices: 4, maxHubs: 4, maxEndpoints: 5 }
  }).topology;
  assert.deepEqual(compact.counts, { devices: 4, hubs: 4, endpoints: 5, activeEdges: 0 });
  assert.deepEqual(compact.totals, { devices: 6, hubs: 6, endpoints: 9 });
  assert.deepEqual(compact.overflow, { devices: 2, hubs: 2, endpoints: 4 });
  assert.equal(
    compact.endpoints.some((ep) => ep.raw?.sourceDevice?.deviceId === 'dev-6' && ep.deviceId === 'dev-1'),
    false,
    'sessions from a hidden device must not misattribute onto devices[0]'
  );
});

test('dashboard session resolution honors sessionWithActivity overlays and projects resumed active sessions into today with zero accounting', () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // 1. Live activity overlay overrides raw transcript recency
  const overlayOverview = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-1',
      devices: [
        { deviceId: 'mac-1', displayName: 'Mac', periods: { today: { totalTokens: 2000, costUsd: 1.0, clients: { codex: 2000 } } } }
      ],
      periods: {
        today: {
          totalTokens: 2000,
          costUsd: 1.0,
          sessions: {
            'codex:overridden-idle': {
              client: 'codex',
              projectLabel: 'proj-idle',
              totalTokens: 1200,
              lastUsedAt: nowIso,
              sourceDevice: { deviceId: 'mac-1' }
            },
            'codex:overridden-waiting': {
              client: 'codex',
              projectLabel: 'proj-wait',
              totalTokens: 800,
              lastUsedAt: new Date(now - 60 * 60 * 1000).toISOString(),
              sourceDevice: { deviceId: 'mac-1' }
            }
          },
          sessionActivity: {
            'codex:overridden-idle': { state: 'idle', observedAt: nowIso },
            'codex:overridden-waiting': { state: 'waiting', observedAt: nowIso }
          }
        }
      }
    },
    periodKey: 'today',
    nowMs: now
  });

  const idleSession = overlayOverview.sessions.find((s) => s.key === 'codex:overridden-idle');
  const waitSession = overlayOverview.sessions.find((s) => s.key === 'codex:overridden-waiting');
  assert.equal(idleSession.activityState, 'idle');
  assert.equal(idleSession.isActive, false);
  assert.equal(waitSession.activityState, 'waiting');
  assert.equal(waitSession.isActive, true);
  assert.equal(overlayOverview.fleet.fleetTotals.activeSessions, 1);

  // 2. Cross-day resumed Antigravity turn appears as active with zero tokens in today only
  const baseStats = {
    localDeviceId: 'mac-1',
    devices: [
      {
        deviceId: 'mac-1',
        displayName: 'Mac',
        periods: {
          today: { totalTokens: 1000, costUsd: 0.4, clients: { codex: 1000 } },
          yesterday: { totalTokens: 2000, costUsd: 0.8, clients: { antigravity: 2000 } }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 1000,
        costUsd: 0.4,
        sessions: {
          'codex:today-1': {
            client: 'codex',
            projectLabel: 'today-repo',
            totalTokens: 1000,
            costUsd: 0.4,
            lastUsedAt: nowIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'mac-1' }
          }
        }
      },
      yesterday: {
        totalTokens: 2000,
        costUsd: 0.8,
        sessions: {}
      },
      month: {
        totalTokens: 60000,
        costUsd: 15,
        sessions: {
          'antigravity:resumed-running': {
            client: 'antigravity',
            title: 'Resumed AG Task',
            projectLabel: 'Token Monitor',
            latestModel: 'gemini-3-pro',
            totalTokens: 50000,
            costUsd: 12.5,
            unpricedTokens: 4000,
            lastUsedAt: nowIso,
            turnEnded: false,
            sourceDevice: { deviceId: 'mac-1' }
          },
          'antigravity:resumed-finished': {
            client: 'antigravity',
            title: 'Finished AG Task',
            totalTokens: 9000,
            costUsd: 2.1,
            lastUsedAt: nowIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'mac-1' }
          }
        }
      }
    }
  };

  const todayOverview = model.buildScopedOverview({ stats: baseStats, periodKey: 'today', nowMs: now });
  const resumedRow = todayOverview.sessions.find((s) => s.key === 'antigravity:resumed-running');
  assert.ok(resumedRow, 'resumed running Antigravity session projects into today');
  assert.equal(resumedRow.activityState, 'running');
  assert.equal(resumedRow.totalTokens, 0);
  assert.equal(resumedRow.costUsd, 0);
  assert.equal(resumedRow.unpricedTokens, 0);
  assert.equal(resumedRow.resumedFromPriorPeriod, true);
  assert.equal(todayOverview.hero.tokens, 1000, 'prior-day tokens do not leak into today hero');
  assert.equal(todayOverview.sessions.some((s) => s.key === 'antigravity:resumed-finished'), false);
  assert.equal(todayOverview.fleet.fleetTotals.activeSessions, 1);
  assert.equal(todayOverview.topology.hubToEnd.find((e) => e.to === 'antigravity:resumed-running')?.active, true);

  // Yesterday must not inherit today/resumed live projections
  const yesterdayOverview = model.buildScopedOverview({ stats: baseStats, periodKey: 'yesterday', nowMs: now });
  assert.equal(yesterdayOverview.sessions.some((s) => s.key === 'antigravity:resumed-running'), false);

  // Once today records new usage for the same key, today wins without duplication
  const statsWithTodayUsage = {
    ...baseStats,
    periods: {
      ...baseStats.periods,
      today: {
        ...baseStats.periods.today,
        totalTokens: 1300,
        sessions: {
          ...baseStats.periods.today.sessions,
          'antigravity:resumed-running': {
            client: 'antigravity',
            title: 'Resumed AG Task',
            projectLabel: 'Token Monitor',
            totalTokens: 300,
            costUsd: 0.12,
            lastUsedAt: nowIso,
            turnEnded: false,
            sourceDevice: { deviceId: 'mac-1' }
          }
        }
      }
    }
  };
  const settledOverview = model.buildScopedOverview({ stats: statsWithTodayUsage, periodKey: 'today', nowMs: now });
  const matches = settledOverview.sessions.filter((s) => s.key === 'antigravity:resumed-running');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].totalTokens, 300);
  assert.equal(matches[0].resumedFromPriorPeriod, false);
});

test('buildQuotaAccounts respects canonical limitProviderHiddenItems keys from limitUsageItemId', () => {
  const usageItems = require('../../src/shared/limits/usageItems');
  const sessionWin = { kind: 'session', label: 'Session', remainingPercent: 80 };
  const weeklyWin = { kind: 'weekly', label: 'Weekly', remainingPercent: 55 };
  const creditsWin = { kind: 'billing', label: 'Credits', metric: 'credits', remaining: 12.5, currency: 'USD' };

  const stats = {
    limits: {
      providers: [
        {
          provider: 'codex',
          accountKey: 'cx-1',
          windows: [sessionWin, weeklyWin, creditsWin]
        }
      ]
    }
  };
  const settings = {
    limitProviderHiddenItems: {
      codex: [
        usageItems.limitUsageItemId(sessionWin, 'codex'),
        'credits'
      ]
    }
  };

  const accounts = model.buildQuotaAccounts(stats, settings, Date.now());
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0].windows.map((w) => w.kind), ['weekly']);
});

test('missing period never substitutes sessions from today or month', () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const statsMissingYesterday = {
    localDeviceId: 'mac-1',
    devices: [{ deviceId: 'mac-1', displayName: 'MacBook', periods: { today: { totalTokens: 500 }, month: { totalTokens: 5000 } } }],
    periods: {
      today: {
        totalTokens: 500,
        sessions: { 'codex:t1': { client: 'codex', title: 'Today Session', totalTokens: 500, lastUsedAt: nowIso, sourceDevice: { deviceId: 'mac-1' } } }
      },
      month: {
        totalTokens: 5000,
        sessions: { 'codex:m1': { client: 'codex', title: 'Month Session', totalTokens: 5000, lastUsedAt: '2026-11-01T10:00:00.000Z', sourceDevice: { deviceId: 'mac-1' } } }
      }
    }
  };

  const ydayOverview = model.buildScopedOverview({ stats: statsMissingYesterday, periodKey: 'yesterday', nowMs: now });
  assert.equal(ydayOverview.sessions.length, 0);
  assert.equal(ydayOverview.fleet.machines[0].sessionCount, 0);

  // When today itself is missing while month has historical sessions, month sessions must not leak into today.
  const statsMissingToday = {
    localDeviceId: 'mac-1',
    devices: [{ deviceId: 'mac-1', displayName: 'MacBook', periods: { month: { totalTokens: 5000 } } }],
    periods: {
      month: {
        totalTokens: 5000,
        sessions: { 'codex:m1': { client: 'codex', title: 'Old Month Session', totalTokens: 5000, lastUsedAt: '2026-11-01T10:00:00.000Z', sourceDevice: { deviceId: 'mac-1' } } }
      }
    }
  };
  const todayOverview = model.buildScopedOverview({ stats: statsMissingToday, periodKey: 'today', nowMs: now });
  assert.equal(todayOverview.sessions.some((s) => s.key === 'codex:m1'), false);
});

test('buildLiveVelocityModel isolates sparkline history per selected device without leaking fleet aggregate points', () => {
  const now = 1_760_000_000_000;
  const sample = {
    speed: 140,
    burn: 8400,
    deviceCount: 2,
    idle: false,
    devices: [
      { id: 'mac-1', name: 'Mac', models: [{ model: 'claude-sonnet-4-5', speed: 80, burn: 4800 }] },
      { id: 'pc-2', name: 'Workstation', models: [{ model: 'gpt-5', speed: 60, burn: 3600 }] }
    ]
  };
  const fleetSamples = [
    { at: now - 4000, speed: 90, burn: 5400 },
    { at: now - 1000, speed: 140, burn: 8400 }
  ];

  // Unattributed fleet sample array must not be drawn when viewing a single machine.
  const noDeviceSeries = model.buildLiveVelocityModel({ sample, rateSamples: fleetSamples, rateMode: 'speed', selectedDeviceId: 'pc-2', now });
  assert.deepEqual(noDeviceSeries.points, []);

  // Device-scoped series should render its own sparkline.
  const withDeviceSeries = model.buildLiveVelocityModel({
    sample,
    rateSamples: fleetSamples,
    rateSamplesByDevice: {
      'pc-2': [
        { at: now - 5000, speed: 30, burn: 1800 },
        { at: now - 2000, speed: 60, burn: 3600 }
      ]
    },
    rateMode: 'speed',
    selectedDeviceId: 'pc-2',
    now
  });
  assert.equal(withDeviceSeries.points.length, 2);
  assert.ok(withDeviceSeries.points[0].y > withDeviceSeries.points[1].y);

  // Per-sample `.devices` metadata also projects cleanly per selected machine.
  const embeddedSamples = [
    { at: now - 5000, speed: 90, burn: 5400, devices: [{ id: 'mac-1', models: [{ speed: 90, burn: 5400 }] }] },
    { at: now - 2000, speed: 140, burn: 8400, devices: [{ id: 'mac-1', models: [{ speed: 80, burn: 4800 }] }, { id: 'pc-2', models: [{ speed: 60, burn: 3600 }] }] }
  ];
  const projectedSeries = model.buildLiveVelocityModel({ sample, rateSamples: embeddedSamples, rateMode: 'speed', selectedDeviceId: 'pc-2', now });
  assert.equal(projectedSeries.points.length, 1);
});

test('computeSessionDetailAnatomy aggregates exchanges[].tokens from session:getDetail payloads', () => {
  const anatomy = model.computeSessionDetailAnatomy({
    found: true,
    totals: { totalTokens: 1000, costUsd: 0.4, exchangeCount: 2, turnCount: 2 },
    exchanges: [
      { tokens: { input: 100, cacheRead: 400, cacheWrite: 50, output: 150, total: 700 } },
      { tokens: { input: 50, cacheRead: 200, cacheWrite: 0, output: 50, total: 300 } }
    ]
  });
  assert.equal(anatomy.totalTokens, 1000);
  assert.equal(anatomy.cacheRead, 600);
  assert.equal(anatomy.cacheWrite, 50);
  assert.equal(anatomy.cacheMiss, 150);
  assert.equal(anatomy.output, 200);
  assert.equal(anatomy.unclassified, 0);
  assert.equal(anatomy.cacheHitRate, 600 / 800);

  const fallback = model.computeSessionDetailAnatomy({
    found: true,
    totals: { totalTokens: 450, costUsd: 0, exchangeCount: 0, turnCount: 0 },
    exchanges: []
  });
  assert.equal(fallback.totalTokens, 450);
  assert.equal(fallback.unclassified, 450);
  assert.equal(fallback.segments[0].key, 'unclassified');
});

test('buildTopologyGraph tools mode does not fabricate device or model links for unattributed entries', () => {
  const overview = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-1',
      devices: [
        { deviceId: 'mac-1', displayName: 'Mac', periods: { allTime: { totalTokens: 5000, costUsd: 1.5, clients: { codex: 5000 } } } },
        { deviceId: 'pc-2', displayName: 'Linux Box', periods: { allTime: { totalTokens: 1000, costUsd: 0.3 } } }
      ],
      periods: {
        allTime: {
          totalTokens: 6000,
          costUsd: 1.8,
          clients: { codex: 5000, claude: 1000 },
          clientModels: { codex: { 'gpt-6.2-sol': 5000 } },
          models: { 'gpt-6.2-sol': 5000, 'claude-sonnet-4-5': 1000 }
        }
      }
    },
    periodKey: 'allTime'
  });

  const graph = overview.topology;
  assert.equal(graph.mode, 'tools');
  assert.equal(graph.devToHub.some((e) => e.from === 'pc-2'), false, 'real device with no client attribution must not inherit fleet tools');
  assert.equal(graph.hubToEnd.some((e) => e.to === 'model:claude-sonnet-4-5'), false, 'unmapped models must not be attributed to hubs[0]');
});

test('buildQuotaAccounts normalizes CSV limitProviders and respects limitsEnabled: false', () => {
  const stats = {
    limits: {
      providers: [
        { provider: 'claude', accountKey: 'cl-1', windows: [{ kind: 'session', label: 'Session', remainingPercent: 80 }] },
        { provider: 'codex', accountKey: 'cx-1', windows: [{ kind: 'session', label: 'Session', remainingPercent: 45 }] }
      ]
    }
  };

  const onlyCodex = model.buildQuotaAccounts(stats, { limitProviders: 'codex' }, Date.now());
  assert.deepEqual(onlyCodex.map((a) => a.providerId), ['codex']);

  const noneSelected = model.buildQuotaAccounts(stats, { limitProviders: '' }, Date.now());
  assert.deepEqual(noneSelected, []);

  const masterOff = model.buildQuotaAccounts(stats, { limitsEnabled: false, limitProviders: 'claude,codex' }, Date.now());
  assert.deepEqual(masterOff, []);

  const settings = { limitProviders: 'claude,codex', homeLimitProviderOrder: 'claude,codex' };
  const quotaOrder = (dashboardQuotaProviderOrder) => model.buildQuotaAccounts(stats, {
    ...settings, dashboardQuotaProviderOrder
  }).map(account => account.providerId);
  assert.deepEqual(quotaOrder(undefined), ['codex', 'claude']);
  assert.deepEqual(quotaOrder('claude,codex'), ['claude', 'codex']);
  assert.deepEqual(quotaOrder(''), ['codex', 'claude']);
});

test('buildQuotaAccounts preserves MiMo expired plan metadata without fabricating zero percent', () => {
  const accounts = model.buildQuotaAccounts({
    limits: {
      providers: [
        {
          provider: 'mimo',
          accountKey: 'mimo-1',
          balance: { planStatus: 'expired' },
          windows: [{ kind: 'billing', label: 'Credits', metric: 'credits', remaining: 5.25, currency: 'USD' }]
        }
      ]
    }
  }, {}, Date.now());

  assert.equal(accounts.length, 1);
  const expiredWin = accounts[0].windows[0];
  assert.equal(expiredWin.planStatus, 'expired');
  assert.equal(expiredWin.showMeter, false);
  assert.equal(expiredWin.remainingPercent, null);
});

test('buildLiveVelocityModel computes exact per-device totals from real tracker samples including unattributed devices', () => {
  const { createLiveTokenRateGroupTracker } = require('../../src/electron/renderer/tokenRatePresentation');
  let now = 1_760_000_000_000;
  const baseDev1 = {
    timedOutputTokens: 0,
    timedTokens: 0,
    timedDurationMs: 0,
    modelThroughput: {
      'm-1': { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 },
      'm-2': { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 }
    }
  };
  const nextDev1 = {
    timedOutputTokens: 150,
    timedTokens: 600,
    timedDurationMs: 1000,
    modelThroughput: {
      'm-1': { timedOutputTokens: 150, timedTokens: 600, timedDurationMs: 1000 },
      'm-2': { timedOutputTokens: 150, timedTokens: 600, timedDurationMs: 1000 }
    }
  };
  const baseDev2 = { timedOutputTokens: 0, timedTokens: 0, timedDurationMs: 0 };
  const nextDev2 = { timedOutputTokens: 100, timedTokens: 400, timedDurationMs: 1000 };

  const fleetTracker = createLiveTokenRateGroupTracker({ now: () => now, activeMs: 12_000 });
  const dev1Tracker = createLiveTokenRateGroupTracker({ now: () => now, activeMs: 12_000 });
  const dev2Tracker = createLiveTokenRateGroupTracker({ now: () => now, activeMs: 12_000 });

  fleetTracker.observe([{ id: 'dev-1', name: 'Dev 1', period: baseDev1 }, { id: 'dev-2', name: 'Dev 2', period: baseDev2 }]);
  dev1Tracker.observe([{ id: 'dev-1', name: 'Dev 1', period: baseDev1 }]);
  dev2Tracker.observe([{ id: 'dev-2', name: 'Dev 2', period: baseDev2 }]);

  now += 1000;
  const fleetSample = fleetTracker.observe([{ id: 'dev-1', name: 'Dev 1', period: nextDev1 }, { id: 'dev-2', name: 'Dev 2', period: nextDev2 }]).sample;
  const dev1Sample = dev1Tracker.observe([{ id: 'dev-1', name: 'Dev 1', period: nextDev1 }]).sample;
  const dev2Sample = dev2Tracker.observe([{ id: 'dev-2', name: 'Dev 2', period: nextDev2 }]).sample;

  const deviceRateSamples = { 'dev-1': dev1Sample, 'dev-2': dev2Sample };
  const rateSamplesByDevice = {
    'dev-1': [{ at: dev1Sample.sampledAt, speed: dev1Sample.speed, burn: dev1Sample.burn }],
    'dev-2': [{ at: dev2Sample.sampledAt, speed: dev2Sample.speed, burn: dev2Sample.burn }]
  };

  const fleetVel = model.buildLiveVelocityModel({ sample: fleetSample, deviceRateSamples, rateSamplesByDevice, selectedDeviceId: 'all', now });
  assert.equal(fleetVel.primaryValue, 250);

  const dev1Vel = model.buildLiveVelocityModel({ sample: fleetSample, deviceRateSamples, rateSamplesByDevice, selectedDeviceId: 'dev-1', now });
  assert.equal(dev1Vel.hasSample, true);
  assert.equal(dev1Vel.primaryValue, 150);

  const dev2Vel = model.buildLiveVelocityModel({ sample: fleetSample, deviceRateSamples, rateSamplesByDevice, selectedDeviceId: 'dev-2', now });
  assert.equal(dev2Vel.hasSample, true);
  assert.equal(dev2Vel.primaryValue, 100);
  assert.equal(dev2Vel.points.length, 1);
});

test('buildScopedOverview dailyLedger leaves deltaPercent null across missing calendar days', () => {
  const overview = model.buildScopedOverview({
    history: {
      daily: [
        { date: '2026-11-10', tokens: 1000, cost: 1 },
        { date: '2026-11-25', tokens: 2000, cost: 2 },
        { date: '2026-11-26', tokens: 3000, cost: 3 }
      ]
    },
    periodKey: 'allTime'
  });

  const nov26 = overview.dailyLedger.find((r) => r.date === '2026-11-26');
  const nov25 = overview.dailyLedger.find((r) => r.date === '2026-11-25');
  const nov10 = overview.dailyLedger.find((r) => r.date === '2026-11-10');
  assert.equal(nov26.deltaPercent, 50);
  assert.equal(nov25.deltaPercent, null, 'Nov 25 compared to non-adjacent Nov 10 must not report a daily delta');
  assert.equal(nov10.deltaPercent, null);
});

test('synced topology and session scoping leave ambiguous and unproven sessions unassigned and never fabricate a local machine', () => {
  const { projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
  const nowIso = new Date().toISOString();
  const rawStats = {
    localDeviceId: 'mac-local',
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 3000,
            costUsd: 1.5,
            clients: { codex: 3000 },
            sessions: {
              'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 500 },
              'codex:local-only': { client: 'codex', sessionId: 'local-only', totalTokens: 2500 }
            }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: {
          today: {
            totalTokens: 500,
            costUsd: 0.2,
            clients: { codex: 500 },
            sessions: {
              'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 500 }
            }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 3900,
        costUsd: 1.9,
        clients: { codex: 3900 },
        sessions: {
          'codex:shared': { client: 'codex', sessionId: 'shared', projectLabel: 'SharedRepo', totalTokens: 1000, costUsd: 0.5, lastUsedAt: nowIso },
          'codex:explicit-ambig': { client: 'codex', sessionId: 'explicit-ambig', projectLabel: 'AmbigRepo', totalTokens: 400, costUsd: 0.2, lastUsedAt: nowIso, sourceDevice: { ambiguous: true } },
          'codex:local-only': { client: 'codex', sessionId: 'local-only', projectLabel: 'LocalRepo', totalTokens: 2500, costUsd: 1.2, lastUsedAt: nowIso }
        }
      }
    }
  };

  const projected = projectSessionDeviceStats(rawStats, 'mac-local');
  assert.equal(projected.periods.today.sessions['codex:shared'].sourceDevice, undefined);
  assert.equal(projected.periods.today.sessions['codex:local-only'].sourceDevice?.deviceId, 'mac-local');

  const syncedSettings = { hubMode: 'client', hubUrl: 'https://hub.example', deviceId: 'mac-local' };
  const allOverview = model.buildScopedOverview({ stats: projected, periodKey: 'today', settings: syncedSettings });
  assert.equal(allOverview.topology.mode, 'sessions');
  const sharedEp = allOverview.topology.endpoints.find((e) => e.id === 'codex:shared');
  const ambigEp = allOverview.topology.endpoints.find((e) => e.id === 'codex:explicit-ambig');
  const localEp = allOverview.topology.endpoints.find((e) => e.id === 'codex:local-only');
  assert.equal(sharedEp?.deviceId, '', 'shared synced session without positive owner must remain unassigned');
  assert.equal(ambigEp?.deviceId, '', 'explicitly ambiguous session must remain unassigned');
  assert.equal(localEp?.deviceId, 'mac-local');
  assert.equal(allOverview.topology.devToHub.some((e) => e.to === 'ws:sharedrepo' || e.to === 'ws:ambigrepo'), false);
  assert.equal(allOverview.topology.devToHub.some((e) => e.from === 'mac-local' && e.to === 'ws:localrepo'), true);

  const localOverview = model.buildScopedOverview({
    stats: projected,
    periodKey: 'today',
    selectedDeviceId: 'mac-local',
    settings: syncedSettings
  });
  assert.deepEqual(localOverview.sessions.map((s) => s.key), ['codex:local-only']);

  const syncedNoDevices = model.buildScopedOverview({
    stats: { localDeviceId: 'mac-local', devices: [], periods: { today: { totalTokens: 500, sessions: {} } } },
    periodKey: 'today',
    settings: syncedSettings
  });
  assert.deepEqual(syncedNoDevices.topology.devices, [], 'synced view with no devices must not fabricate a local node');
});

test('fleet and topology agree on shared running sessions, remote-only local badges, and local mode with saved hubUrl', () => {
  const { projectSessionDeviceStats } = require('../../src/electron/sessionDeviceSources');
  const nowIso = new Date().toISOString();

  // 1. Shared running session leaves mac-local fleet summary free of unowned active agent/workspace
  const sharedRunningRaw = {
    localDeviceId: 'mac-local',
    devices: [
      {
        deviceId: 'mac-local',
        displayName: 'MacBook',
        platform: 'darwin',
        periods: {
          today: {
            totalTokens: 1000,
            costUsd: 0.5,
            clients: { codex: 1000 },
            sessions: { 'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 500 } }
          }
        }
      },
      {
        deviceId: 'linux-remote',
        displayName: 'Linux Box',
        platform: 'linux',
        periods: {
          today: {
            totalTokens: 500,
            costUsd: 0.25,
            clients: { codex: 500 },
            sessions: { 'codex:shared': { client: 'codex', sessionId: 'shared', totalTokens: 500 } }
          }
        }
      }
    ],
    periods: {
      today: {
        totalTokens: 1500,
        costUsd: 0.75,
        clients: { codex: 1500 },
        sessions: {
          'codex:shared': {
            client: 'codex',
            sessionId: 'shared',
            projectLabel: 'SharedWorkspace',
            totalTokens: 1000,
            status: 'running',
            lastUsedAt: nowIso
          }
        }
      }
    }
  };
  const sharedProjected = projectSessionDeviceStats(sharedRunningRaw, 'mac-local');
  const sharedOverview = model.buildScopedOverview({
    stats: sharedProjected,
    periodKey: 'today',
    settings: { hubMode: 'client', hubUrl: 'https://hub.example', deviceId: 'mac-local' },
    nowMs: Date.parse(nowIso)
  });
  const macMachine = sharedOverview.fleet.machines.find((m) => m.deviceId === 'mac-local');
  assert.equal(macMachine.activeSessionCount, 0, 'fleet mac summary must not count shared unowned running session');
  assert.equal(macMachine.sessionCount, 0);
  assert.equal(macMachine.activeWorkspace, '');
  assert.equal(sharedOverview.topology.endpoints.find((e) => e.id === 'codex:shared')?.deviceId, '');

  // 2. Single remote machine + local native session never marks remote machine local or routes native session through it
  const remoteWithNative = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-local',
      devices: [
        { deviceId: 'linux-remote', displayName: 'Linux Box', platform: 'linux', periods: { today: { totalTokens: 400, clients: { codex: 400 } } } }
      ],
      nativeSessions: {
        today: {
          'reasonix:n1': {
            client: 'reasonix',
            sessionId: 'n1',
            projectLabel: 'LocalNative',
            totalTokens: 300,
            lastUsedAt: nowIso
          }
        }
      },
      periods: {
        today: { totalTokens: 700, costUsd: 0.3, sessions: {} }
      }
    },
    periodKey: 'today',
    settings: { hubMode: 'client', hubUrl: 'https://hub.example', deviceId: 'mac-local' },
    statsMode: 'sync'
  });
  const remoteMachine = remoteWithNative.fleet.machines.find((m) => m.deviceId === 'linux-remote');
  assert.equal(remoteMachine.isLocal, false, 'single remote machine must not be labeled local');
  assert.equal(remoteWithNative.topology.devices.find((d) => d.id === 'linux-remote')?.isLocal, false);
  assert.equal(
    remoteWithNative.topology.devToHub.some((e) => e.from === 'linux-remote' && e.to === 'ws:localnative'),
    false,
    'local native session must not connect through remote machine'
  );

  // 3. Switched to Local Only while retaining saved hubUrl still attributes local last7 session cleanly
  const { rangeForSelection } = require('../../src/electron/renderer/fixedPeriodRanges');
  const now = Date.parse(nowIso);
  const localLast7Window = rangeForSelection('last7', { now });
  const localWithSavedUrl = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-local',
      nativeRangeWindows: { last7: localLast7Window },
      devices: [
        { deviceId: 'mac-local', displayName: 'MacBook', platform: 'darwin', periods: { last7: { totalTokens: 500, clients: { codex: 500 } } } }
      ],
      periods: {
        last7: {
          totalTokens: 500,
          costUsd: 0.2,
          sessions: {
            'codex:l7': { client: 'codex', sessionId: 'l7', projectLabel: 'Local7Repo', totalTokens: 500, lastUsedAt: nowIso }
          }
        }
      }
    },
    periodKey: 'last7',
    nowMs: now,
    settings: { hubMode: 'local', hubUrl: 'https://hub.example', deviceId: 'mac-local' },
    statsMode: 'local'
  });
  assert.equal(localWithSavedUrl.isSynced, false);
  assert.equal(localWithSavedUrl.sessions[0]?.isLocalDevice, true);
  assert.equal(localWithSavedUrl.topology.endpoints[0]?.deviceId, 'mac-local');
});

test('buildSessionList folds subagents, background reviews, and Grok Bot runs while preserving Fleet and Topology parity', () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const earlierIso = new Date(now - 60_000).toISOString();

  const stats = {
    localDeviceId: 'mac-1',
    devices: [
      { deviceId: 'mac-1', displayName: 'MacBook', platform: 'darwin', periods: { today: { totalTokens: 6000, costUsd: 3.0, clients: { antigravity: 4500, codex: 1000, cursor: 500 } } } },
      { deviceId: 'linux-2', displayName: 'Linux Box', platform: 'linux', periods: { today: { totalTokens: 400, costUsd: 0.2, clients: { codex: 400 } } } }
    ],
    periods: {
      today: {
        totalTokens: 6400,
        costUsd: 3.2,
        sessions: {
          'antigravity:parent-1': {
            client: 'antigravity',
            sessionId: 'parent-1',
            title: 'Parent Orchestrator',
            projectLabel: 'Token Monitor',
            latestModel: 'gemini-3-pro',
            models: { 'gemini-3-pro': 2000 },
            totalTokens: 2000,
            costUsd: 1.0,
            lastUsedAt: earlierIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
          },
          'antigravity:child-1': {
            client: 'antigravity',
            sessionId: 'child-1',
            title: 'Worker Alpha',
            projectLabel: 'Token Monitor',
            parentClient: 'antigravity',
            parentSessionId: 'parent-1',
            latestModel: 'gemini-3-flash',
            models: { 'gemini-3-flash': 1500 },
            totalTokens: 1500,
            costUsd: 0.75,
            lastUsedAt: nowIso,
            turnEnded: false,
            sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
          },
          'antigravity:child-2': {
            client: 'antigravity',
            sessionId: 'child-2',
            title: 'Worker Beta',
            projectLabel: 'Token Monitor',
            parentClient: 'antigravity',
            parentSessionId: 'parent-1',
            latestModel: 'claude-sonnet-4-5',
            models: { 'claude-sonnet-4-5': 1000 },
            totalTokens: 1000,
            costUsd: 0.5,
            lastUsedAt: earlierIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
          },
          'codex:rev-1': {
            client: 'codex',
            sessionId: 'rev-1',
            sessionKind: 'background-review',
            projectLabel: 'RepoA',
            latestModel: 'gpt-6.2-sol',
            totalTokens: 1000,
            costUsd: 0.5,
            lastUsedAt: nowIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
          },
          'codex:rev-2': {
            client: 'codex',
            sessionId: 'rev-2',
            sessionKind: 'background-review',
            projectLabel: 'RepoB',
            latestModel: 'gpt-6.2-sol',
            totalTokens: 400,
            costUsd: 0.2,
            lastUsedAt: earlierIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'linux-2', name: 'Linux Box' }
          },
          'cursor:grok-1': {
            client: 'cursor',
            sessionId: 'grok-1',
            latestModel: 'grok-bot-1',
            models: { 'grok-bot-1': 500 },
            totalTokens: 500,
            costUsd: 0.25,
            lastUsedAt: earlierIso,
            sourceDevice: { deviceId: 'mac-1', name: 'MacBook' }
          },
          'reasonix:synth-1': {
            client: 'reasonix',
            sessionId: 'reasonix-stats:hidden',
            totalTokens: 9999,
            lastUsedAt: nowIso
          }
        }
      }
    }
  };

  const overview = model.buildScopedOverview({
    stats,
    periodKey: 'today',
    nowMs: now,
    sessionLabels: {
      subagent: 'Subagent',
      subagentCount: (c) => `${c} subagents`,
      backgroundReviews: 'Codex Auto Review',
      backgroundReviewCount: (c) => `${c} background runs`,
      grokBot: 'Grok Bot',
      grokBotCount: (c) => `${c} activity records`
    }
  });

  // Only 3 top-level rows: parent subagent group, Codex Auto Review, Grok Bot (Reasonix synthetic row excluded)
  assert.equal(overview.sessions.length, 3);
  const parentGroup = overview.sessions.find((s) => s.subagentGroup);
  assert.ok(parentGroup, 'parent + 2 children should fold into one subagent group');
  assert.equal(parentGroup.title, 'Parent Orchestrator');
  assert.equal(parentGroup.totalTokens, 4500);
  assert.equal(parentGroup.costUsd, 2.25);
  assert.equal(parentGroup.subagentCount, 2);
  assert.equal(parentGroup.modelLabel, 'gemini-3-pro +2');
  assert.equal(parentGroup.isActive, true, 'running child propagates running state onto parent group');
  assert.equal(parentGroup.groupRows.length, 3);
  assert.equal(parentGroup.sourceDevice?.deviceId, 'mac-1');

  const reviewGroup = overview.sessions.find((s) => s.groupKind === 'background-review');
  assert.ok(reviewGroup);
  assert.equal(reviewGroup.title, 'Codex Auto Review');
  assert.equal(reviewGroup.totalTokens, 1400);
  assert.equal(reviewGroup.groupCount, 2);
  assert.equal(reviewGroup.projectLabel, '', 'multi-workspace synthetic group leaves projectLabel empty');
  assert.equal(reviewGroup.sourceDevice, null, 'multi-device synthetic group leaves sourceDevice null');

  const grokGroup = overview.sessions.find((s) => s.groupKind === 'grok-bot');
  assert.ok(grokGroup);
  assert.equal(grokGroup.title, 'Grok Bot');
  assert.equal(grokGroup.groupCount, 1);
  assert.equal(grokGroup.sourceDevice?.deviceId, 'mac-1', 'single-owner synthetic group preserves owner device');

  const mac = overview.fleet.machines.find((m) => m.deviceId === 'mac-1');
  assert.equal(mac.activeSessionCount, 1, 'fleet active count reflects folded parent group rather than individual children');
  assert.equal(mac.sessionCount, 3, 'mac owns parent group + its review group + grok group');

  const ep = overview.topology.endpoints.find((e) => e.id === parentGroup.key);
  assert.ok(ep);
  assert.equal(ep.subagentCount, 2);
  assert.equal(ep.modelLabel, 'gemini-3-pro +2');
});

test('buildScopedOverview keeps mixed-device subagent group unowned and splits Live Flow edges by member device', () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const stats = {
    localDeviceId: 'dev-mac',
    devices: [
      { deviceId: 'dev-mac', displayName: 'Mac', platform: 'darwin', periods: { today: { totalTokens: 100, costUsd: 0.1, clients: { codex: 100 } } } },
      { deviceId: 'dev-pc', displayName: 'PC', platform: 'win32', periods: { today: { totalTokens: 900, costUsd: 0.9, clients: { codex: 900 } } } }
    ],
    periods: {
      today: {
        totalTokens: 1000,
        costUsd: 1.0,
        sessions: {
          'codex:p1': {
            client: 'codex',
            sessionId: 'p1',
            title: 'Mixed Parent',
            projectLabel: 'Token Monitor',
            latestModel: 'gpt-6.2-sol',
            models: { 'gpt-6.2-sol': 100 },
            totalTokens: 100,
            costUsd: 0.1,
            lastUsedAt: nowIso,
            turnEnded: true,
            sourceDevice: { deviceId: 'dev-mac', name: 'Mac' }
          },
          'codex:c1': {
            client: 'codex',
            sessionId: 'c1',
            title: 'Mixed Child',
            projectLabel: 'Token Monitor',
            parentClient: 'codex',
            parentSessionId: 'p1',
            latestModel: 'gpt-6.2-sol',
            models: { 'gpt-6.2-sol': 900 },
            totalTokens: 900,
            costUsd: 0.9,
            lastUsedAt: nowIso,
            turnEnded: false,
            sourceDevice: { deviceId: 'dev-pc', name: 'PC' }
          }
        }
      }
    }
  };

  const overview = model.buildScopedOverview({ stats, periodKey: 'today', nowMs: now });
  const mixedGroup = overview.sessions.find((s) => s.subagentGroup);
  assert.ok(mixedGroup);
  assert.equal(mixedGroup.totalTokens, 1000);
  assert.equal(mixedGroup.sourceDevice, null, 'mixed-device subagent group must not claim single owner');
  assert.equal(mixedGroup.deviceName, '');

  const ep = overview.topology.endpoints.find((e) => e.id === mixedGroup.key);
  assert.ok(ep);
  assert.equal(ep.deviceId, '');
  assert.deepEqual(ep.memberDeviceIds.sort(), ['dev-mac', 'dev-pc']);

  const macEdge = overview.topology.devToHub.find((e) => e.from === 'dev-mac' && e.to === 'ws:token monitor');
  const pcEdge = overview.topology.devToHub.find((e) => e.from === 'dev-pc' && e.to === 'ws:token monitor');
  assert.equal(macEdge?.tokens, 100, 'Mac-to-workspace edge should attribute only Mac member tokens');
  assert.equal(pcEdge?.tokens, 900, 'PC-to-workspace edge should attribute only PC member tokens');

  assert.deepEqual(overview.workspaces[0]?.devices?.slice().sort(), ['Mac', 'PC']);

  stats.periods.today.sessions['codex:c1'].projectLabel = 'Second';
  const split = model.buildScopedOverview({ stats, periodKey: 'today', nowMs: now });
  const expected = [['ws:second', 900, true], ['ws:token monitor', 100, false]];
  assert.deepEqual(split.topology.devToHub.map(e => [e.to, e.tokens, e.active]).sort(), expected);
  assert.deepEqual(split.topology.hubToEnd.map(e => [e.from, e.tokens, e.active]).sort(), expected);
  assert.deepEqual(split.topology.hubToEnd.map(e => [e.from, e.deviceIds]).sort(), [
    ['ws:second', ['dev-pc']], ['ws:token monitor', ['dev-mac']]
  ]);
  assert.deepEqual(split.workspaces.map(w => [w.name, w.activeSessionCount]).sort(), [
    ['Second', 1], ['Token Monitor', 0]
  ]);
  assert.deepEqual(split.topology.hubs.map(w => [w.id, w.activeSessionCount]).sort(), [
    ['ws:second', 1], ['ws:token monitor', 0]
  ]);
});

test('buildScopedOverview ignores stale selectedDeviceId when fleet shrinks to one surviving device', () => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    localDeviceId: 'dev-a',
    devices: [
      { deviceId: 'dev-a', displayName: 'Mac', platform: 'darwin', periods: { today: { totalTokens: 300, costUsd: 0.3 } } }
    ],
    periods: {
      today: { totalTokens: 300, costUsd: 0.3, sessions: {} }
    }
  };
  const history = {
    daily: [{ date: today, tokens: 900, cost: 0.9 }],
    deviceHistories: [
      { deviceId: 'dev-a', history: { daily: [{ date: today, tokens: 300, cost: 0.3 }] } }
    ]
  };

  const overview = model.buildScopedOverview({
    stats,
    history,
    periodKey: 'today',
    selectedDeviceId: 'dev-a'
  });
  assert.equal(overview.fleet.isFleetMode, false);
  assert.equal(overview.activeMachine, null, 'single-device fleet must not produce a machine-scoped activeMachine');
  assert.equal(overview.dailyLedger[0]?.tokens, 900, 'daily ledger must use aggregate tokens matching All Devices Trends');
});

test('buildTopologyGraph does not attribute duplicate-named Desktop workspace edges to an unowning device', () => {
  const nowIso = new Date().toISOString();
  const stats = {
    localDeviceId: 'dev-1',
    devices: [
      { deviceId: 'dev-1', displayName: 'Desktop', platform: 'win32', periods: { today: { totalTokens: 0, costUsd: 0 } } },
      { deviceId: 'dev-2', displayName: 'Desktop', platform: 'linux', periods: { today: { totalTokens: 100, costUsd: 0.1, clients: { codex: 100 } } } }
    ],
    periods: {
      today: {
        totalTokens: 100,
        costUsd: 0.1,
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            title: 'Remote Desktop Task',
            projectLabel: 'Repo',
            latestModel: 'gpt-6.2-sol',
            totalTokens: 100,
            costUsd: 0.1,
            lastUsedAt: nowIso,
            sourceDevice: { deviceId: 'dev-2', name: 'Desktop' }
          }
        }
      }
    }
  };

  const overview = model.buildScopedOverview({ stats, periodKey: 'today', settings: { hubMode: 'client' } });
  assert.equal(overview.topology.devToHub.length, 1);
  assert.equal(overview.topology.devToHub[0].from, 'dev-2');
  assert.equal(overview.topology.devToHub[0].tokens, 100);

  // Even when endpoints are omitted (workspace fallback path), duplicate display names must not manufacture a dev-1 edge
  const fallbackTopo = model.buildTopologyGraph({
    ...overview,
    sessions: [{ ...overview.sessions[0], key: 'first', projectLabel: 'Other', totalTokens: 200 }, ...overview.sessions]
  }, { maxEndpoints: 1 });
  assert.deepEqual(fallbackTopo.endpoints.map(endpoint => endpoint.id), ['first']);
  const repo = fallbackTopo.hubs.find(hub => hub.name === 'Repo');
  const repoEdges = fallbackTopo.devToHub.filter(edge => edge.to === repo.id);
  assert.deepEqual(repoEdges.map(edge => [edge.from, edge.tokens]), [['dev-2', 100]]);
});


test('a hidden zero-token session retains its edge without borrowing unrelated live activity', () => {
  const overview = {
    fleet: { machines: [{ deviceId: 'a', tokens: 40 }, { deviceId: 'b', tokens: 0, liveTokPerSec: 10 }] },
    sessions: [
      { key: 'a', projectLabel: 'Repo', sourceDevice: { deviceId: 'a' }, totalTokens: 40, isActive: true },
      { key: 'b', projectLabel: 'Repo', sourceDevice: { deviceId: 'b' }, totalTokens: 0 }
    ],
    workspaces: [{ name: 'Repo', tokens: 40, activeSessionCount: 1,
      deviceIds: ['a', 'b'], deviceTokens: { a: 40, b: 0 }, activeDeviceIds: ['a'] }],
    hero: { tokens: 40 }
  };
  const graph = model.buildTopologyGraph(overview, { maxEndpoints: 1 });
  assert.deepEqual(graph.endpoints.map(endpoint => endpoint.id), ['a']);
  assert.equal(graph.devToHub.find(edge => edge.from === 'a')?.tokens, 40);
  const hidden = graph.devToHub.find(edge => edge.from === 'b');
  assert.equal(hidden?.tokens, 0);
  assert.equal(hidden.active, false);
  assert.equal(hidden.liveRate, 0);
});

test('synced Week History fallback uses the published Monday calendar in an en-US dashboard', () => {
  const device = {
    deviceId: 'mac',
    periodWindows: { today: { key: '2026-11-23', endsAt: '2026-11-24T00:00:00Z' } },
    periods: { today: { totalTokens: 60 } }
  };
  const daily = [{ date: '2026-11-22', tokens: 40 }, { date: '2026-11-23', tokens: 60 }];
  const view = model.buildScopedOverview({
    stats: { mode: 'sync', devices: [device], periods: { today: { totalTokens: 60 } } },
    history: { daily, fixedPeriods: { historyTransportAvailable: true },
      deviceHistories: [{ deviceId: device.deviceId, historyAvailable: true, history: { daily } }] },
    periodKey: 'week', statsMode: 'sync', settings: { locale: 'en-US', syncWeekStartsOn: 1 },
    nowMs: Date.parse('2026-11-23T12:00:00Z')
  });
  assert.equal(view.hero.tokens, 60);
  assert.equal(view.fleet.machines[0].tokens, 60);
  assert.equal(view.sessionsIncomplete, true);
});


test('a synced fixed page keeps uncovered device History without counting covered devices twice', () => {
  const periodWindows = { today: { key: '2026-11-24', endsAt: '2026-11-25T00:00:00Z' } };
  const mac = { deviceId: 'mac', periodWindows, periods: { today: { totalTokens: 1 } } };
  const stats = { mode: 'sync', devices: [mac], periods: { today: { totalTokens: 1 } } };
  const history = {
    fixedPeriods: { historyTransportAvailable: true },
    deviceHistories: [['mac', 100000], ['pc', 200000]].map(([deviceId, tokens]) => ({
      deviceId, periodWindows, historyAvailable: true,
      history: { daily: [{ date: '2026-11-23', tokens, cost: 2, messages: 3, activeTimeMs: 1000, perClient: { codex: { tokens, cost: 2 } } }] }
    }))
  };
  const view = (snapshot, selectedDeviceId = 'all') => model.buildScopedOverview({
    stats: snapshot, selectedDeviceId, history, periodKey: 'yesterday', nowMs: Date.parse('2026-11-24T12:00:00Z')
  });
  assert.equal(view(stats).hero.tokens, 300000);

  const exact = {
    totalTokens: 110000, costUsd: 3, clients: { codex: 110000 },
    projects: { repo: { label: 'Mac Repo', tokens: 110000 } },
    sessions: { 'codex:mac': { client: 'codex', sessionId: 'mac', totalTokens: 110000,
      projectLabel: 'Mac Repo', sourceDevice: { deviceId: 'mac' } } }
  };
  const paged = {
    ...stats, periods: { ...stats.periods, yesterday: exact },
    devices: [{ ...mac, periods: { ...mac.periods, yesterday: exact } }],
    syncedFixedPeriodDeviceWindows: { yesterday: { mac: { start: '2026-11-23', end: '2026-11-23' } } }
  };
  const overview = view(paged);
  assert.equal(overview.hero.tokens, 310000);
  assert.equal(overview.hero.cost, 5);
  assert.equal(overview.tools.find(row => row.id === 'codex').tokens, 310000);
  assert.equal(overview.sessionsIncomplete, true);
  assert.equal(overview.hero.messages, 6);
  assert.equal(overview.hero.activeTimeMs, 2000);
  assert.deepEqual(overview.sessions, []);
  assert.deepEqual(overview.workspaces, []);
  assert.equal(overview.fleet.machines.reduce((sum, row) => sum + row.tokens, 0), 310000);
  assert.equal(view(paged, 'pc').hero.tokens, 200000);
  const macView = view(paged, 'mac');
  assert.equal(macView.hero.tokens, 110000);
  assert.equal(macView.hero.messages, 3);
  assert.equal(macView.hero.activeTimeMs, 1000);
  assert.equal(macView.sessionsIncomplete, false);
  assert.equal(macView.sessions.length, 1);
  assert.deepEqual(macView.workspaces.map(row => row.name), ['Mac Repo']);

  history.deviceHistories.push({ deviceId: 'undated', historyAvailable: true,
    history: { daily: [{ date: '2026-11-23', tokens: 40000, cost: 1 }] } });
  assert.equal(view(paged).hero.tokens, 310000);
  assert.equal(view(paged, 'pc').hero.tokens, 200000);
  const unverifiedView = view(paged);
  assert.equal(unverifiedView.hero.accountingStatus, 'partial');
  assert.equal(view(paged, 'undated').hero.accountingStatus, 'unavailable');
  assert.equal(view(paged, 'pc').hero.accountingStatus, 'ready');
  assert.equal(view(paged, 'mac').hero.accountingStatus, 'ready');
  assert.equal(unverifiedView.sessionsIncomplete, true);
  assert.deepEqual(unverifiedView.sessions, []);
  assert.deepEqual(unverifiedView.workspaces, []);
  history.deviceHistories.pop();
  assert.deepEqual(exact.clients, { codex: 110000 });

  const fullPage = {
    ...paged,
    periods: { ...paged.periods, yesterday: { totalTokens: 330000 } },
    devices: [...paged.devices, { deviceId: 'pc', periods: { yesterday: { totalTokens: 220000 } } }],
    syncedFixedPeriodDeviceWindows: { yesterday: {
      ...paged.syncedFixedPeriodDeviceWindows.yesterday,
      pc: { start: '2026-11-23', end: '2026-11-23' }
    } }
  };
  assert.equal(view(fullPage).hero.tokens, 330000);
  assert.equal(view(fullPage).sessionsIncomplete, false);
  assert.equal(view(fullPage).hero.accountingStatus, 'ready');
  assert.equal(view(fullPage).hero.messages, 6);
  assert.equal(view(fullPage).hero.activeTimeMs, 2000);
});

test('activity-only uncovered History uses the device calendar or marks activity unavailable', () => {
  const stats = {
    mode: 'sync',
    devices: [{ deviceId: 'utc', periods: { yesterday: { totalTokens: 100 } } }],
    periods: { yesterday: { totalTokens: 100 } },
    syncedFixedPeriodDeviceWindows: { yesterday: { utc: { start: '2026-11-23', end: '2026-11-23' } } }
  };
  const tokyo = {
    deviceId: 'tokyo', historyAvailable: true,
    periodWindows: { timeZone: 'Asia/Tokyo', today: { key: '2026-11-25', endsAt: '2026-11-25T15:00:00Z' } },
    history: { daily: [
      { date: '2026-11-23', tokens: 0, messages: 2, activeTimeMs: 1000 },
      { date: '2026-11-24', tokens: 0, messages: 7, activeTimeMs: 4000 }
    ] }
  };
  const history = { fixedPeriods: { historyTransportAvailable: true }, deviceHistories: [
    { deviceId: 'utc', historyAvailable: true, history: { daily: [
      { date: '2026-11-23', tokens: 100, messages: 3, activeTimeMs: 1000 }
    ] } }, tokyo
  ] };
  const activity = (selectedDeviceId, snapshot = stats) => {
    const { hero } = model.buildScopedOverview({ stats: snapshot, history, periodKey: 'yesterday', selectedDeviceId,
      nowMs: Date.parse('2026-11-24T18:00:00Z') });
    return [hero.messages, hero.activeTimeMs];
  };
  assert.deepEqual(activity('tokyo'), [7, 4000]);
  assert.deepEqual(activity('all'), [10, 5000]);
  const cold = { mode: 'sync', devices: [], periods: {} };
  history.deviceHistories[0].periodWindows = { today: { key: '2026-11-24', endsAt: '2026-11-25T00:00:00Z' } };
  assert.deepEqual(activity('tokyo', cold), [7, 4000]);
  assert.deepEqual(activity('all', cold), [10, 5000]);

  delete tokyo.periodWindows;
  assert.deepEqual(activity('tokyo', cold), [null, null]);
  assert.deepEqual(activity('all', cold), [null, null]);
  assert.deepEqual(activity('utc', cold), [3, 1000]);
  assert.deepEqual(activity('tokyo'), [null, null]);
  assert.deepEqual(activity('all'), [null, null]);
  assert.deepEqual(activity('utc'), [3, 1000]);
});

test('fixed-period accounting distinguishes unavailable History from a verified zero', () => {
  const options = { stats: { mode: 'sync', devices: [] }, periodKey: 'yesterday' };
  assert.equal(model.buildScopedOverview(options).hero.accountingStatus, 'unavailable');
  const { hero } = model.buildScopedOverview({ ...options,
    history: { fixedPeriods: { historyTransportAvailable: true }, deviceHistories: [] }
  });
  assert.equal(hero.accountingStatus, 'ready');
  assert.equal(hero.tokens, 0);
});

test('a synced fixed period renders without totals while device History is pending or unavailable', () => {
  const stats = {
    mode: 'sync',
    devices: [{ deviceId: 'mac', periods: { today: { totalTokens: 60 } } }],
    periods: { today: { totalTokens: 60 } }
  };
  for (const history of [null, {
    daily: [{ date: '2026-11-23', tokens: 60 }],
    summary: { totalTokens: 60 },
    deviceHistories: [{ deviceId: 'mac', historyAvailable: false }]
  }]) {
    const view = model.buildScopedOverview({ stats, history, periodKey: 'week', statsMode: 'sync' });
    assert.equal(view.hero.tokens, 0);
    assert.equal(view.fleet.machines[0].tokens, 0);
    assert.equal(view.sessionsIncomplete, true);
    assert.deepEqual(view.tools, []);
  }
});


test('Today without Stats never substitutes unrestricted History totals', () => {
  const daily = [{ date: '2026-11-22', tokens: 900, perClient: { codex: { tokens: 900 } } }];
  const history = { daily, summary: { totalTokens: 900 } };
  const today = model.buildScopedOverview({ history, periodKey: 'today' });
  assert.equal(today.hero.tokens, 0);
  assert.deepEqual(today.tools, []);
  assert.equal(model.buildScopedOverview({ history, periodKey: 'allTime' }).hero.tokens, 900);
});

test('summary activity uses the selected calendar range and keeps missing metrics distinct from zero', () => {
  const history = {
    daily: [
      { date: '2026-10-30', activeTimeMs: 60000, messages: 2 },
      { date: '2026-11-01', activeTimeMs: 120000, messages: 4 },
      { date: '2026-11-23', activeTimeMs: 240000, messages: 8 },
      { date: '2026-11-24', activeTimeMs: 0, messages: 0 },
      { date: '2026-11-25', activeTimeMs: 480000, messages: 16 }
    ],
    summary: { activeTimeMs: 3600000, messages: 80 }
  };
  const options = {
    history,
    nowMs: new Date(2026, 10, 24, 12).getTime(),
    settings: { calendarLocale: 'en-GB' }
  };
  const activity = (periodKey, override) => {
    const { activeTimeMs, messages } = model.buildScopedOverview({ ...options, periodKey, ...override }).hero;
    return [activeTimeMs, messages];
  };
  assert.deepEqual(activity('today'), [0, 0]);
  assert.deepEqual(activity('yesterday'), [240000, 8]);
  assert.deepEqual(activity('week'), [240000, 8]);
  assert.deepEqual(activity('last7'), [240000, 8]);
  assert.deepEqual(activity('last30'), [420000, 14]);
  assert.deepEqual(activity('month'), [360000, 12]);
  assert.deepEqual(activity('allTime'), [3600000, 80]);
  assert.deepEqual(activity('today', { history: null }), [null, null]);
  const pendingToday = {
    stats: { periods: { today: { totalTokens: 900 } } },
    history: { ...history, daily: history.daily.filter(row => row.date !== '2026-11-24') }
  };
  assert.deepEqual(activity('week', pendingToday), [null, null]);
  assert.deepEqual(activity('month', pendingToday), [null, null]);
  assert.deepEqual(activity('yesterday', pendingToday), [240000, 8]);
  const pendingCostOnly = { ...pendingToday, stats: { periods: { today: { totalTokens: 0, costUsd: 1 } } } };
  assert.deepEqual(activity('week', pendingCostOnly), [null, null]);
  assert.deepEqual(activity('month', pendingCostOnly), [null, null]);
  assert.deepEqual(activity('today', { settings: { historyEnabled: false } }), [null, null]);
  assert.deepEqual(activity('today', {
    history: { daily: [{ date: '2026-11-24', messages: 2 }] }
  }), [null, 2]);
});

test('synced summary activity applies device calendars and never fills missing device history with fleet totals', () => {
  const window = (key, endsAt) => ({ today: { key, endsAt } });
  const devices = [
    { deviceId: 'east', periodWindows: window('2026-11-24', '2026-11-24T16:00:00Z'), periods: { today: { totalTokens: 300 } } },
    { deviceId: 'west', periodWindows: window('2026-11-23', '2026-11-24T08:00:00Z'), periods: { today: { totalTokens: 200 } } }
  ];
  const history = {
    daily: [{ date: '2026-11-24', activeTimeMs: 600000, messages: 999 }],
    deviceHistories: [
      { deviceId: 'east', historyAvailable: true, history: { daily: [
        { date: '2026-11-23', tokens: 50, activeTimeMs: 60000, messages: 1 },
        { date: '2026-11-24', tokens: 300, activeTimeMs: 180000, messages: 3 }
      ] } },
      { deviceId: 'west', historyAvailable: true, history: { daily: [
        { date: '2026-11-23', tokens: 200, activeTimeMs: 120000, messages: 2 }
      ] } }
    ],
    fixedPeriods: { historyTransportAvailable: true }
  };
  const stats = { mode: 'sync', devices, periods: { today: { totalTokens: 500 } } };
  const options = {
    stats, history, nowMs: Date.parse('2026-11-24T02:00:00Z'),
    settings: { locale: 'en-US', syncWeekStartsOn: 1 }
  };
  const activity = (periodKey, selectedDeviceId, override) => {
    const { activeTimeMs, messages } = model.buildScopedOverview({
      ...options, periodKey, selectedDeviceId, ...override
    }).hero;
    return [activeTimeMs, messages];
  };
  assert.deepEqual(activity('today', 'all'), [300000, 5]);
  assert.deepEqual(activity('today', 'west'), [120000, 2]);
  assert.deepEqual(activity('week', 'all'), [360000, 6]);
  assert.deepEqual(activity('week', 'east'), [240000, 4]);
  const lagging = {
    ...history,
    deviceHistories: [
      { ...history.deviceHistories[0], history: { daily: history.deviceHistories[0].history.daily.slice(0, 1) } },
      history.deviceHistories[1]
    ]
  };
  assert.deepEqual(activity('week', 'all', { history: lagging }), [null, null]);
  assert.deepEqual(activity('week', 'west', { history: lagging }), [120000, 2]);
  const costOnly = { ...stats, devices: [
    { ...devices[0], periods: { today: { totalTokens: 0, costUsd: 1 } } },
    devices[1]
  ] };
  assert.deepEqual(activity('week', 'all', { stats: costOnly, history: lagging }), [null, null]);
  assert.deepEqual(activity('week', 'east', { stats: costOnly, history: lagging }), [null, null]);

  const partial = { ...history, deviceHistories: history.deviceHistories.slice(0, 1) };
  assert.deepEqual(activity('today', 'east', { history: partial }), [180000, 3]);
  assert.deepEqual(activity('today', 'west', { history: partial }), [null, null]);
  assert.deepEqual(activity('today', 'all', { history: partial }), [null, null]);
  assert.deepEqual(activity('week', 'all', { history: partial }), [null, null]);
});

test('legacy and current client model attribution merge without dropping either count', () => {
  const today = { totalTokens: 30, clients: { antigravity: 10, 'antigravity-cli': 20 },
    clientModels: { antigravity: { gemini: 10 }, 'antigravity-cli': { gemini: 20 } } };
  const view = model.buildScopedOverview({ stats: { periods: { today } }, periodKey: 'today' });
  assert.deepEqual(view.tools[0].models.map(({ id, tokens }) => [id, tokens]), [['gemini', 30]]);
});

test('Live Flow keeps unassigned sessions in order without a synthetic workspace or links', () => {
  const graph = model.buildTopologyGraph({
    fleet: { machines: [{ deviceId: 'mac', isLocal: true }] },
    sessions: [
      { key: 'review', backgroundReview: true, totalTokens: 20 },
      { key: 'named', projectLabel: '__general', totalTokens: 10 },
      { key: 'grok', grokBot: true, totalTokens: 30 }
    ]
  });
  assert.deepEqual(graph.endpoints.map(endpoint => endpoint.id), ['review', 'named', 'grok']);
  assert.deepEqual(graph.hubs.map(hub => [hub.id, hub.tokens]), [['ws:__general', 10]]);
  assert.deepEqual(graph.devToHub.map(edge => edge.to), ['ws:__general']);
  assert.deepEqual(graph.hubToEnd.map(edge => edge.to), ['named']);
});


test('local fixed ranges reject carried periods after rollover and use the current calendar history', () => {
  const nowMs = new Date(2026, 10, 23, 12).getTime(); // Monday
  const stale = {
    totalTokens: 900, clients: { codex: 900 },
    sessions: { 'codex:stale': {
      client: 'codex', sessionId: 'stale', projectLabel: 'Stale workspace',
      lastUsedAt: new Date(nowMs).toISOString(), totalTokens: 900
    } }
  };
  const stats = {
    mode: 'local', localDeviceId: 'local',
    nativeRangeWindows: { week: { start: '2026-11-16', end: '2026-11-22' } },
    devices: [{ deviceId: 'local', periods: { week: stale } }],
    periods: { week: stale }
  };
  const daily = [{ date: '2026-11-22', tokens: 100 }, { date: '2026-11-23', tokens: 40 }];
  const view = model.buildScopedOverview({
    stats, periodKey: 'week', nowMs, settings: { locale: 'en-US', calendarLocale: 'en-GB' },
    history: {
      daily,
      fixedPeriods: { historyTransportAvailable: true },
      deviceHistories: [{ deviceId: 'local', historyAvailable: true, history: { daily } }]
    }
  });
  assert.equal(view.hero.tokens, 40);
  assert.equal(view.fleet.machines[0].tokens, 40);
  assert.equal(view.fleet.machines[0].sessionCount, 0);
  assert.deepEqual(view.sessions, []);
  assert.deepEqual(view.workspaces, []);
  assert.equal(view.sessionsIncomplete, true);

  stats.nativeRangeWindows.week = { start: '2026-11-23', end: '2026-11-23' };
  const fresh = model.buildScopedOverview({
    stats, periodKey: 'week', nowMs, settings: { locale: 'en-US', calendarLocale: 'en-GB' }
  });
  assert.equal(fresh.hero.tokens, 900);
  assert.equal(fresh.fleet.machines[0].tokens, 900);
  assert.equal(fresh.sessions[0].sessionId, 'stale');
  assert.equal(fresh.sessionsIncomplete, false);
});

test('local fixed fallback needs History coverage and retains only confirmed Today accounting when unavailable', () => {
  const nowMs = new Date(2026, 10, 27, 12).getTime();
  const today = { totalTokens: 100, costUsd: 2 };
  const stats = {
    mode: 'local', localDeviceId: 'local',
    periods: { today },
    devices: [{ deviceId: 'local', periods: { today } }]
  };
  const view = (periodKey, overrides = {}) => model.buildScopedOverview({ stats, periodKey, nowMs, ...overrides });
  assert.equal(view('yesterday').hero.accountingStatus, 'unavailable');

  const failedHistory = { fixedPeriods: { historyTransportAvailable: false }, daily: [] };
  const partial = view('last7', { history: failedHistory });
  assert.equal(partial.hero.accountingStatus, 'partial');
  assert.equal(partial.hero.tokens, 100);
  assert.equal(partial.hero.cost, 2);
  assert.equal(partial.fleet.machines[0].tokens, 100);
  assert.deepEqual(partial.sessions, []);
  assert.equal(view('yesterday', { settings: { historyEnabled: false } }).hero.accountingStatus, 'unavailable');

  const verified = view('yesterday', { history: { fixedPeriods: { historyTransportAvailable: true }, daily: [] } });
  assert.equal(verified.hero.accountingStatus, 'ready');
  assert.equal(verified.hero.tokens, 0);

  const stale = { ...stats, periodWindows: { today: { key: '2026-11-26' } } };
  assert.equal(view('last7', { stats: stale }).hero.accountingStatus, 'unavailable');
});

test('Flow accents use active tools in each device and workspace even when endpoints are offscreen', () => {
  const session = (key, client, deviceId, isActive = true) => ({
    key, client, isActive, sourceDevice: { deviceId }, projectLabel: 'Repo'
  });
  const graph = model.buildTopologyGraph({
    isSynced: true,
    fleet: { machines: [{ deviceId: 'mac' }, { deviceId: 'pc' }, { deviceId: 'idle' }] },
    sessions: [
      { ...session('group', 'codex', 'mac'), groupRows: [
        session('codex', 'codex', 'mac'),
        session('claude', 'claude', 'mac')
      ] },
      session('gemini', 'gemini', 'pc'),
      { ...session('other-repo', 'cursor', 'pc'), projectLabel: 'Other' },
      session('history', 'gemini', 'mac', false),
      session('inactive-tool', 'opencode', 'mac', false),
      { ...session('ambiguous', 'claude', 'pc'), sourceDevice: { ambiguous: true } }
    ]
  }, { maxEndpoints: 1 });
  const devices = Object.fromEntries(graph.devices.map(device => [device.id, device.activeToolColors]));
  assert.deepEqual(graph.endpoints.map(endpoint => endpoint.id), ['group']);
  assert.equal(devices.mac.length, 2);
  assert.equal(devices.pc.length, 2);
  assert.notEqual(devices.mac[0], devices.mac[1]);
  assert.ok(!devices.mac.includes(devices.pc[0]));
  assert.deepEqual(devices.idle, []);
  const hubs = Object.fromEntries(graph.hubs.map(hub => [hub.id, hub.activeToolColors]));
  const { claude, codex, cursor, gemini } = usageCharts.clientColors;
  assert.deepEqual(hubs['ws:repo'], [claude, codex, gemini].sort());
  assert.deepEqual(hubs['ws:other'], [cursor]);
});

test('buildTopologyGraph defaults to sync flowMode and assigns deterministic per-component flowPhase offsets in stagger mode', () => {
  const mkSession = (key, client, deviceId, projectLabel, totalTokens) => ({
    key,
    client,
    isActive: true,
    totalTokens,
    sourceDevice: { deviceId },
    projectLabel
  });

  const syncGraph = model.buildTopologyGraph({
    isSynced: true,
    fleet: {
      machines: [
        { deviceId: 'alpha', name: 'Alpha', tokens: 100, share: 0.1 },
        { deviceId: 'beta', name: 'Beta', tokens: 900, share: 0.9 }
      ]
    },
    sessions: [
      mkSession('s-a', 'codex', 'alpha', 'RepoA', 100),
      mkSession('s-b', 'claude', 'beta', 'RepoB', 900)
    ]
  });
  assert.equal(syncGraph.flowMode, 'sync');
  for (const col of ['devices', 'hubs', 'endpoints', 'devToHub', 'hubToEnd']) {
    for (const item of syncGraph[col]) assert.equal(item.flowPhase ?? 0, 0);
  }

  // Two completely disjoint paths should keep intra-path nodes/edges phase-locked
  // and stagger across components regardless of volatile token totals.
  const lowFirst = model.buildTopologyGraph({
    isSynced: true,
    fleet: {
      machines: [
        { deviceId: 'alpha', name: 'Alpha', tokens: 100, share: 0.1 },
        { deviceId: 'beta', name: 'Beta', tokens: 900, share: 0.9 }
      ]
    },
    sessions: [
      mkSession('s-a', 'codex', 'alpha', 'RepoA', 100),
      mkSession('s-b', 'claude', 'beta', 'RepoB', 900)
    ]
  }, { flowMode: 'stagger' });
  const highFirst = model.buildTopologyGraph({
    isSynced: true,
    fleet: {
      machines: [
        { deviceId: 'alpha', name: 'Alpha', tokens: 900, share: 0.9 },
        { deviceId: 'beta', name: 'Beta', tokens: 100, share: 0.1 }
      ]
    },
    sessions: [
      mkSession('s-a', 'codex', 'alpha', 'RepoA', 900),
      mkSession('s-b', 'claude', 'beta', 'RepoB', 100)
    ]
  }, { flowMode: 'stagger' });

  assert.equal(lowFirst.flowMode, 'stagger');
  const phaseById = (graph, col) => Object.fromEntries(graph[col].map((item) => [item.id, item.flowPhase]));
  const { alpha, beta } = phaseById(lowFirst, 'devices');
  assert.notEqual(alpha, beta);
  assert.equal(phaseById(lowFirst, 'hubs')['ws:repoa'], alpha);
  assert.equal(phaseById(lowFirst, 'endpoints')['s-a'], alpha);
  assert.equal(phaseById(lowFirst, 'devices').beta, beta);
  assert.equal(phaseById(lowFirst, 'hubs')['ws:repob'], beta);
  assert.equal(phaseById(lowFirst, 'endpoints')['s-b'], beta);
  assert.deepEqual(phaseById(lowFirst, 'devToHub'), {
    'd2h:alpha->ws:repoa': alpha,
    'd2h:beta->ws:repob': beta
  });
  assert.deepEqual(phaseById(lowFirst, 'hubToEnd'), {
    'h2e:ws:repoa->s-a': alpha,
    'h2e:ws:repob->s-b': beta
  });
  assert.deepEqual(phaseById(lowFirst, 'devices'), phaseById(highFirst, 'devices'));

  // Two devices feeding the same shared workspace form one connected component (all use Alpha’s phase).
  const shared = model.buildTopologyGraph({
    isSynced: true,
    fleet: {
      machines: [
        { deviceId: 'alpha', name: 'Alpha', tokens: 500, share: 0.5 },
        { deviceId: 'beta', name: 'Beta', tokens: 500, share: 0.5 }
      ]
    },
    sessions: [
      mkSession('s-a', 'codex', 'alpha', 'SharedRepo', 500),
      mkSession('s-b', 'claude', 'beta', 'SharedRepo', 500)
    ]
  }, { flowMode: 'stagger' });
  assert.equal(phaseById(shared, 'devices').alpha, alpha);
  assert.equal(phaseById(shared, 'devices').beta, alpha);
  assert.equal(phaseById(shared, 'hubs')['ws:sharedrepo'], alpha);

  const betaOnly = model.buildTopologyGraph({
    isSynced: true,
    fleet: { machines: [{ deviceId: 'beta', name: 'Beta', tokens: 900, share: 1 }] },
    sessions: [mkSession('s-b', 'claude', 'beta', 'RepoB', 900)]
  }, { flowMode: 'stagger' });
  assert.equal(phaseById(betaOnly, 'devices').beta, beta);
  assert.equal(phaseById(betaOnly, 'devToHub')['d2h:beta->ws:repob'], beta);
  assert.equal(phaseById(betaOnly, 'hubToEnd')['h2e:ws:repob->s-b'], beta);

  // buildScopedOverview defaults to sync and propagates stagger when dashboardFlowMode === 'stagger'.
  const overviewStats = {
    devices: [
      { deviceId: 'alpha', deviceName: 'Alpha' },
      { deviceId: 'beta', deviceName: 'Beta' }
    ],
    periods: { today: { totalTokens: 1000, sessions: {} } }
  };
  const defaultOverview = model.buildScopedOverview({ stats: overviewStats, statsMode: 'sync' });
  assert.equal(defaultOverview.topology.flowMode, 'sync');
  const staggerOverview = model.buildScopedOverview({
    stats: overviewStats,
    statsMode: 'sync',
    settings: { dashboardFlowMode: 'stagger' }
  });
  assert.equal(staggerOverview.topology.flowMode, 'stagger');
});
