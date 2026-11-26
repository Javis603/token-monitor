'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../../src/electron/renderer/dashboardModel');
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
  assert.equal(Math.round(exact.cacheHitRate * 100), 75);
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
    unclassifiedTokens: 400
  });
  assert.equal(partial.unclassified, 400);
  assert.equal(partial.cacheMiss, 200);
  assert.equal(partial.segments.find((s) => s.key === 'unclassified').tokens, 400);
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
  assert.equal(graph.hubs.length, 2);
  assert.equal(graph.endpoints.length, 2);
  assert.ok(graph.hubs.some((h) => h.isGeneral === true));
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
