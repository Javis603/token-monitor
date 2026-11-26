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

test('buildActivityInsights computes weekday rhythm, busiest day, and peak days with tool attribution', () => {
  const sampleDaily = [
    // 2026-11-23 is Monday, 2026-11-24 is Tuesday, 2026-11-25 is Wednesday
    { date: '2026-11-16', tokens: 1000, cost: 1.0, perClient: { codex: { tokens: 1000, cost: 1.0 } } },
    { date: '2026-11-23', tokens: 3000, cost: 3.0, perClient: { claude: { tokens: 3000, cost: 3.0 } } },
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
  assert.equal(anatomy.cacheHitRate, 600 / 750);

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
  const localWithSavedUrl = model.buildScopedOverview({
    stats: {
      localDeviceId: 'mac-local',
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


test('a confirmed zero-token device retains a zero Live Flow edge when its session is outside the visible endpoints', () => {
  const overview = {
    fleet: { machines: [{ deviceId: 'a', tokens: 40 }, { deviceId: 'b', tokens: 0 }] },
    sessions: [{ key: 'a', projectLabel: 'Repo', deviceId: 'a', totalTokens: 40 }],
    workspaces: [{ name: 'Repo', tokens: 40, deviceIds: ['a', 'b'], deviceTokens: { a: 40, b: 0 } }],
    hero: { tokens: 40 }
  };
  const graph = model.buildTopologyGraph(overview, { maxEndpoints: 1 });
  assert.equal(graph.devToHub.find(edge => edge.from === 'a')?.tokens, 40);
  assert.equal(graph.devToHub.find(edge => edge.from === 'b')?.tokens, 0);
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

test('legacy and current client model attribution merge without dropping either count', () => {
  const today = { totalTokens: 30, clients: { antigravity: 10, 'antigravity-cli': 20 },
    clientModels: { antigravity: { gemini: 10 }, 'antigravity-cli': { gemini: 20 } } };
  const view = model.buildScopedOverview({ stats: { periods: { today } }, periodKey: 'today' });
  assert.deepEqual(view.tools[0].models.map(({ id, tokens }) => [id, tokens]), [['gemini', 30]]);
});

test('a workspace named __general stays separate from unassigned sessions', () => {
  const graph = model.buildTopologyGraph({
    hero: { tokens: 30 },
    sessions: [{ key: 'named', projectLabel: '__general', totalTokens: 10 },
      { key: 'unassigned', projectLabel: '', totalTokens: 20 }]
  });
  assert.deepEqual(graph.hubs.map(hub => [hub.id, hub.tokens]).sort(), [['unassigned', 20], ['ws:__general', 10]]);
});
