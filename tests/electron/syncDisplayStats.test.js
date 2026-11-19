'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { aggregateDevices } = require('../../src/shared/usage');
const { pickRecentUsageProviderId } = require('../../src/shared/trayText');
const {
  attachLocalPresentationNativeViews,
  completeLocalSyncStats,
  composeLocalOnlySummary,
  composeLocalSyncStats,
  composeLocalSyncSummary
} = require('../../src/electron/syncDisplayStats');
const { createStatsStreamReceiver, prepareSseFanout } = require('../../src/shared/hubProtocol');
const { parseSseBlock } = require('../../src/electron/sseEventReader');

function device(deviceId, totalTokens, extra = {}) {
  return {
    deviceId,
    hostname: `${deviceId}.local`,
    updatedAt: '2026-07-16T00:00:00.000Z',
    receivedAt: '2026-07-16T00:00:00.000Z',
    today: { totalTokens, clients: { codex: totalTokens } },
    month: { totalTokens, clients: { codex: totalTokens } },
    allTime: { totalTokens, clients: { codex: totalTokens } },
    ...extra
  };
}

function limits(updatedAt, remainingPercent) {
  return {
    updatedAt,
    refreshMs: 5 * 60 * 1000,
    providers: [{
      provider: 'codex',
      accountKey: 'shared-account',
      status: 'ok',
      source: 'rpc',
      updatedAt,
      windows: [{ kind: 'session', label: 'Session', usedPercent: 100 - remainingPercent }]
    }]
  };
}

function usagePeriod(client, lastUsedAt, totalTokens = 1) {
  return {
    totalTokens,
    clients: { [client]: totalTokens },
    sessions: {
      [`${client}:${lastUsedAt}`]: { client, sessionId: `${client}:session`, lastUsedAt, totalTokens }
    }
  };
}

test('composeLocalSyncStats replaces the hub copy of the local device without double counting', () => {
  const hubStats = aggregateDevices([
    device('local', 100, { updatedAt: '2026-07-16T00:01:00.000Z' }),
    device('remote', 50)
  ], 0, Date.parse('2026-07-16T00:01:00.000Z'));
  const localHubDevice = hubStats.devices.find((entry) => entry.deviceId === 'local');
  const remoteHubDevice = hubStats.devices.find((entry) => entry.deviceId === 'remote');
  localHubDevice.displayName = 'This Mac';
  remoteHubDevice.displayName = 'Studio';
  remoteHubDevice.stale = true;
  remoteHubDevice.ageMs = 900000;
  hubStats.historyRevision = 'hub-revision';
  hubStats.deviceHistoryRevision = 'hub-device-revision';
  hubStats.limits = { providers: [{ provider: 'codex', sourceDeviceId: 'remote' }] };

  const result = composeLocalSyncStats(hubStats, device('local', 120, {
    updatedAt: '2026-07-16T00:02:00.000Z',
    receivedAt: '2026-07-16T00:02:00.000Z'
  }), { nowMs: Date.parse('2026-07-16T00:02:00.000Z') });

  assert.equal(result.periods.today.totalTokens, 170);
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').periods.today.totalTokens, 120);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').displayName, 'This Mac');
  // The live record owns receivedAt; the Hub's copy is kept as proof of upload.
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').receivedAt, '2026-07-16T00:02:00.000Z');
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').hubReceivedAt, '2026-07-16T00:00:00.000Z');
  assert.equal(Object.hasOwn(result.devices.find((entry) => entry.deviceId === 'remote'), 'hubReceivedAt'), false);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').displayName, 'Studio');
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').stale, true);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').ageMs, 900000);
  assert.equal(result.historyRevision, 'hub-revision');
  assert.match(result.deviceHistoryRevision, /^hub-device-revision:/);
  assert.deepEqual(result.limits, hubStats.limits);
  assert.equal(hubStats.periods.today.totalTokens, 150);
});

test('composeLocalSyncStats invalidates fixed ranges for fresher local History', () => {
  const hubStats = aggregateDevices([device('local', 100)], 0, Date.parse('2026-07-16T00:01:00.000Z'));
  hubStats.deviceHistoryRevision = 'hub-device-revision';
  const first = composeLocalSyncStats(hubStats, device('local', 100, {
    history: { daily: [{ date: '2026-07-15', tokens: 80 }], monthly: [], summary: {} }
  }));
  const second = composeLocalSyncStats(hubStats, device('local', 100, {
    history: { daily: [{ date: '2026-07-15', tokens: 90 }], monthly: [], summary: {} }
  }));

  assert.notEqual(first.deviceHistoryRevision, second.deviceHistoryRevision);
});

test('composeLocalSyncStats can render a local device before the first hub snapshot', () => {
  const result = composeLocalSyncStats(null, device('local', 25), { nowMs: Date.parse('2026-07-16T00:00:00.000Z') });

  assert.equal(result.periods.today.totalTokens, 25);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].deviceId, 'local');
  assert.equal(result.devices[0].hubReceivedAt, null);
});

test('composeLocalSyncStats restores local titles over a title-free hub device', () => {
  const hubLocal = device('local', 10, {
    today: usagePeriod('codex', '2026-07-16T10:00:00.000Z', 10)
  });
  const hubStats = aggregateDevices([hubLocal], 0, Date.parse('2026-07-16T10:01:00.000Z'));
  const local = device('local', 10, {
    today: usagePeriod('codex', '2026-07-16T10:00:00.000Z', 10)
  });
  const key = Object.keys(local.today.sessions)[0];
  local.today.sessions[key].title = 'Local-only conversation title';
  assert.ok(Object.values(hubStats.periods.today.sessions).every((session) => !String(session.title || '').trim()));

  const result = composeLocalSyncStats(hubStats, local, {
    nowMs: Date.parse('2026-07-16T10:01:00.000Z')
  });

  assert.equal(
    Object.values(result.periods.today.sessions).find((session) => session.title)?.title,
    'Local-only conversation title'
  );
});

test('sync presentation selects recent activity from the local device, not a newer remote session', () => {
  const nowMs = Date.parse('2026-07-16T10:02:00.000Z');
  const local = device('local', 10, {
    today: usagePeriod('openclaw', '2026-07-16T10:00:00.000Z', 10)
  });
  const remote = device('remote', 20, {
    today: usagePeriod('claude', '2026-07-16T10:01:00.000Z', 20)
  });

  const result = composeLocalSyncStats(aggregateDevices([local, remote], 0, nowMs), local, { nowMs });

  assert.equal(pickRecentUsageProviderId(result), 'openclaw');
  assert.equal(result.periods.today.clients.claude, 20);
  assert.equal(result.periods.today.clients.openclaw, 10);
});

test('local Reasonix activity wins independently of a newer remote generic session', () => {
  const nowMs = Date.parse('2026-07-16T10:04:00.000Z');
  const local = device('local', 10, {
    nativeSessions: {
      today: {
        reasonix: { client: 'reasonix', lastMessageAt: '2026-07-16T10:02:00.000Z' }
      },
      month: {},
      allTime: {}
    }
  });
  const remote = device('remote', 20, {
    today: usagePeriod('claude', '2026-07-16T10:03:00.000Z', 20)
  });

  const result = composeLocalSyncStats(aggregateDevices([local, remote], 0, nowMs), local, { nowMs });

  assert.equal(pickRecentUsageProviderId(result), 'reasonix');
});

test('remote activity cannot invent a recent provider when the local device has none', () => {
  const nowMs = Date.parse('2026-07-16T10:04:00.000Z');
  const local = device('local', 0);
  const remote = device('remote', 20, {
    today: usagePeriod('claude', '2026-07-16T10:03:00.000Z', 20)
  });

  const result = composeLocalSyncStats(aggregateDevices([local, remote], 0, nowMs), local, { nowMs });

  assert.equal(pickRecentUsageProviderId(result), null);
  assert.equal(Object.hasOwn(result, 'localRecentUsageActivity'), false);
});

test('Reasonix metadata updates cannot override newer local message activity', () => {
  const nowMs = Date.parse('2026-07-16T10:11:00.000Z');
  const local = device('local', 10, {
    today: usagePeriod('claude', '2026-07-16T10:00:00.000Z', 10),
    nativeSessions: {
      today: {
        reasonix: {
          client: 'reasonix',
          createdAt: '2026-07-16T09:00:00.000Z',
          lastMessageAt: '2026-07-16T09:00:00.000Z',
          lastUsedAt: '2026-07-16T10:10:00.000Z',
          updatedAt: '2026-07-16T10:10:00.000Z'
        }
      },
      month: {},
      allTime: {}
    }
  });

  const result = composeLocalSyncStats(null, local, { nowMs });

  assert.equal(pickRecentUsageProviderId(result), 'claude');
});

test('the local cold-start presentation restores native views from the anchor seed', () => {
  const nativeSessions = { today: { session: { client: 'reasonix', totalTokens: 25 } }, month: {}, allTime: {} };
  const nativeProjects = { today: { project: { label: 'Project', tokens: 25 } }, month: {}, allTime: {} };
  const seededLocalDevice = device('local', 25, { nativeSessions, nativeProjects });
  const stats = aggregateDevices([seededLocalDevice], 0, Date.parse('2026-07-16T00:00:00.000Z'));

  assert.equal(Object.hasOwn(stats, 'nativeSessions'), false);
  attachLocalPresentationNativeViews(stats, {
    lastCollectedDevice: null,
    seededLocalDevice,
    mode: 'local'
  });

  assert.deepEqual(stats.nativeSessions, nativeSessions);
  assert.deepEqual(stats.nativeProjects, nativeProjects);

  const collectedSessions = { today: { live: { client: 'reasonix', totalTokens: 30 } }, month: {}, allTime: {} };
  attachLocalPresentationNativeViews(stats, {
    lastCollectedDevice: device('local', 30, { nativeSessions: collectedSessions }),
    seededLocalDevice,
    mode: 'local'
  });
  assert.deepEqual(stats.nativeSessions, collectedSessions);
  assert.equal(Object.hasOwn(stats, 'nativeProjects'), false);
});

test('the cold-start native-view fallback is local-mode only', () => {
  const seededLocalDevice = device('local', 25, {
    nativeSessions: { today: {}, month: {}, allTime: {} },
    nativeProjects: { today: {}, month: {}, allTime: {} }
  });
  const stats = aggregateDevices([seededLocalDevice], 0, Date.parse('2026-07-16T00:00:00.000Z'));

  attachLocalPresentationNativeViews(stats, {
    lastCollectedDevice: null,
    seededLocalDevice,
    mode: 'sync'
  });

  assert.equal(Object.hasOwn(stats, 'nativeSessions'), false);
  assert.equal(Object.hasOwn(stats, 'nativeProjects'), false);
});

test('composeLocalSyncStats exposes current aggregate omission diagnostics', () => {
  const result = composeLocalSyncStats(null, device('local', 25, {
    sessionDetailsOmitted: { month: 7 },
    periodProjectsOmitted: { month: 4 }
  }), { nowMs: Date.parse('2026-07-16T00:00:00.000Z') });

  assert.deepEqual(result.sessionDetailsOmitted, { month: 7 });
  assert.deepEqual(result.periodProjectsOmitted, { month: 4 });
});

test('composeLocalSyncStats clears obsolete Hub omission diagnostics', () => {
  const nowMs = Date.parse('2026-07-16T00:01:00.000Z');
  const hubStats = aggregateDevices([
    device('local', 25, {
      sessionDetailsOmitted: { month: 7 },
      periodProjectsOmitted: { month: 4 }
    })
  ], 0, nowMs);

  const result = composeLocalSyncStats(hubStats, device('local', 30, {
    updatedAt: '2026-07-16T00:01:00.000Z',
    receivedAt: '2026-07-16T00:01:00.000Z'
  }), { nowMs });

  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sessionDetailsOmitted'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'periodProjectsOmitted'), false);
});

test('composeLocalSyncStats uses the Hub threshold to refresh local limits without reviving stale remote data', () => {
  const nowMs = Date.parse('2026-07-16T00:20:00.000Z');
  const hubStats = aggregateDevices([
    device('local', 100, { limits: limits('2026-07-16T00:00:00.000Z', 80) }),
    device('remote', 50, { limits: limits('2026-07-16T00:05:00.000Z', 70) })
  ], 10 * 60 * 1000, nowMs);
  hubStats.staleAfterMs = 10 * 60 * 1000;

  const result = composeLocalSyncStats(hubStats, device('local', 120, {
    updatedAt: '2026-07-16T00:20:00.000Z',
    receivedAt: '2026-07-16T00:20:00.000Z',
    limits: limits('2026-07-16T00:20:00.000Z', 60)
  }), { nowMs });

  const local = result.devices.find((entry) => entry.deviceId === 'local');
  const remote = result.devices.find((entry) => entry.deviceId === 'remote');
  assert.equal(local.stale, false);
  assert.equal(remote.stale, true);
  assert.equal(result.limits.providers.length, 1);
  assert.equal(result.limits.providers[0].sourceDeviceId, 'local');
  assert.equal(result.limits.providers[0].windows[0].remainingPercent, 60);
  assert.equal(result.limits.providers[0].stale, false);
});

test('composeLocalSyncStats honors a custom Hub staleness threshold', () => {
  const nowMs = Date.parse('2026-07-16T00:20:00.000Z');
  const hubStats = aggregateDevices([
    device('local', 100),
    device('remote', 50, {
      updatedAt: '2026-07-16T00:05:00.000Z',
      receivedAt: '2026-07-16T00:05:00.000Z'
    })
  ], 20 * 60 * 1000, nowMs);
  hubStats.staleAfterMs = 20 * 60 * 1000;

  const result = composeLocalSyncStats(hubStats, device('local', 120, {
    updatedAt: '2026-07-16T00:20:00.000Z',
    receivedAt: '2026-07-16T00:20:00.000Z'
  }), { nowMs });

  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').stale, false);
});

test('composeLocalSyncStats honors an explicit zero Hub staleness threshold', () => {
  const nowMs = Date.parse('2026-07-16T00:20:00.000Z');
  const hubStats = aggregateDevices([
    device('local', 100, { limits: limits('2026-07-16T00:00:00.000Z', 80) })
  ], 0, nowMs);
  hubStats.staleAfterMs = 0;

  const result = composeLocalSyncStats(hubStats, device('local', 120, {
    updatedAt: '2026-07-16T00:20:00.000Z',
    receivedAt: '2026-07-16T00:20:00.000Z',
    limits: limits('2026-07-16T00:20:00.000Z', 60)
  }), { nowMs });

  assert.equal(result.limits.providers[0].windows[0].remainingPercent, 60);
});

test('composeLocalSyncStats preserves an incompatible legacy snapshot instead of dropping remote usage', () => {
  const hubStats = { periods: { today: { totalTokens: 50 } } };

  assert.equal(composeLocalSyncStats(hubStats, device('local', 25)), hubStats);
});

test('composeLocalSyncStats recomposes an unchanged local record exactly like a fresh one', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const shared = (totalTokens) => usagePeriod('codex', '2026-07-16T10:00:00.000Z', totalTokens);
  const local = device('local', 10, { today: shared(10), month: shared(10), allTime: shared(10) });
  const untouched = structuredClone(local);

  // The remote device reports the same session key, so every recompose merges
  // into it; a reused normalization must come out of that exactly as it went in.
  for (const remoteTokens of [5, 7, 11]) {
    const hubStats = aggregateDevices([
      device('remote', remoteTokens, { today: shared(remoteTokens), month: shared(remoteTokens), allTime: shared(remoteTokens) })
    ], 0, nowMs);
    const reused = composeLocalSyncStats(hubStats, local, { nowMs });
    const fresh = composeLocalSyncStats(hubStats, structuredClone(local), { nowMs });
    assert.deepEqual(reused.periods, fresh.periods);
    assert.deepEqual(reused.devices, fresh.devices);
    assert.equal(Object.values(reused.periods.today.sessions)[0].totalTokens, 10 + remoteTokens);
  }
  assert.deepEqual(local, untouched);
});

test('a publish composes without all-time session detail and completes to the full composition', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const period = (client, totalTokens) => usagePeriod(client, '2026-07-16T10:00:00.000Z', totalTokens);
  const local = device('local', 10, { today: period('codex', 10), month: period('codex', 10), allTime: period('codex', 10) });
  // An agent older than #118 still uploads its all-time sessions.
  const hubStats = aggregateDevices([
    device('legacy', 5, { today: period('claude', 5), month: period('claude', 5), allTime: period('claude', 5) })
  ], 0, nowMs);
  const untouched = structuredClone(local);

  const summary = composeLocalSyncSummary(hubStats, local, { nowMs });
  const full = composeLocalSyncStats(hubStats, local, { nowMs });
  assert.deepEqual(summary.periods.allTime.sessions, {});
  assert.deepEqual({ ...summary.periods.allTime, sessions: null }, { ...full.periods.allTime, sessions: null });
  assert.deepEqual(summary.periods.today, full.periods.today);
  assert.deepEqual(summary.periods.month, full.periods.month);

  const complete = completeLocalSyncStats(summary);
  assert.deepEqual(complete.periods, full.periods);
  assert.equal(Object.keys(complete.periods.allTime.sessions).length, 2, 'both devices, legacy upload included');
  assert.equal(completeLocalSyncStats(summary), complete, 'completed once per snapshot');
  assert.deepEqual(local, untouched);
});

// Counts reads of the token totals of each local all-time session. Normalizing a
// session reads them; the tray's recent-activity scan, which runs per publish
// over the raw record, reads only its client and timestamps.
function countingSessions(sessions) {
  const reads = { count: 0 };
  const counted = {};
  for (const [key, session] of Object.entries(sessions)) {
    counted[key] = new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'totalTokens') reads.count += 1;
        return Reflect.get(target, property, receiver);
      }
    });
  }
  return { sessions: counted, reads };
}

test('a summary never normalizes the local all-time sessions', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const period = (totalTokens) => usagePeriod('codex', '2026-07-16T10:00:00.000Z', totalTokens);
  const allTime = period(10);
  const { sessions, reads } = countingSessions(allTime.sessions);
  const local = device('local', 10, { today: period(10), month: period(10), allTime: { ...allTime, sessions } });

  const summary = composeLocalSyncSummary(aggregateDevices([device('remote', 5)], 0, nowMs), local, { nowMs });
  const localOnly = composeLocalOnlySummary(local, (stats) => stats, { nowMs });
  assert.equal(reads.count, 0);

  assert.equal(Object.keys(completeLocalSyncStats(summary).periods.allTime.sessions).length, 1);
  assert.equal(Object.keys(completeLocalSyncStats(localOnly).periods.allTime.sessions).length, 1);
  assert.ok(reads.count > 0, 'the completions normalize them');
});

test('a completion normalizes only the all-time period on top of its summary', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const period = (totalTokens) => usagePeriod('codex', '2026-07-16T10:00:00.000Z', totalTokens);
  const today = period(10);
  const { sessions, reads } = countingSessions(today.sessions);
  const local = device('local', 10, { today: { ...today, sessions }, month: period(10), allTime: period(10) });

  const summary = composeLocalOnlySummary(local, (stats) => stats, { nowMs });
  const afterSummary = reads.count;
  assert.ok(afterSummary > 0);
  completeLocalSyncStats(summary);
  assert.equal(reads.count, afterSummary, 'today is not normalized again');
});

test('a completion matches normalizing the whole record', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const period = (client, totalTokens) => ({
    ...usagePeriod(client, '2026-07-16T10:00:00.000Z', totalTokens),
    projects: { 'repo-a': { totalTokens, clients: { [client]: totalTokens } } }
  });
  const records = {
    'top-level periods': device('local', 10, { today: period('codex', 10), month: period('codex', 10), allTime: period('claude', 10) }),
    'wire periods': { deviceId: 'local', receivedAt: '2026-07-16T10:00:00.000Z', periods: { today: period('codex', 10), month: period('codex', 10), allTime: period('claude', 10) } },
    'projects disabled': device('local', 10, { projectsEnabled: false, today: period('codex', 10), month: period('codex', 10), allTime: period('claude', 10) }),
    'both shapes, top level first': device('local', 10, { allTime: period('claude', 10), periods: { allTime: period('codex', 99) } }),
    'no all-time period': device('local', 10, { allTime: undefined })
  };
  for (const [name, local] of Object.entries(records)) {
    const summary = composeLocalOnlySummary(local, (stats) => stats, { nowMs });
    assert.deepEqual(completeLocalSyncStats(summary).periods, aggregateDevices([local], 0, nowMs).periods, name);
  }
});

test('local month rows preserve rounding and stay independent of the cached device rows', () => {
  const at = '2026-07-16T10:00:00.000Z';
  const period = usagePeriod('codex', at, 10);
  const row = Object.values(period.sessions)[0];
  row.costUsd = 0.123456789;
  row.models = { 'gpt-5': 10 };
  row.modelCosts = { 'gpt-5': row.costUsd };
  row.promptCache = { observedAt: at, ttlSeconds: 300 };
  period.sessions.activity = {
    ...row,
    sessionId: 'activity',
    liveActivity: { state: 'running', observedAt: at }
  };
  const record = device('local', 10, { month: period });
  const nowMs = Date.parse(at);
  const expected = aggregateDevices([record], 0, nowMs).periods.month;
  const first = composeLocalOnlySummary(record, stats => stats, { nowMs });

  assert.deepEqual(first.periods.month, expected);
  const firstRow = Object.values(first.periods.month.sessions).find(session => session.sessionId === row.sessionId);
  firstRow.models['gpt-5'] = 99;
  firstRow.modelCosts['gpt-5'] = 99;
  firstRow.promptCache.ttlSeconds = 99;
  assert.deepEqual(composeLocalOnlySummary(record, stats => stats, { nowMs }).periods.month, expected);
});

test('Hub month rows preserve overlap accounting and stay independent of cached device rows', () => {
  const at = '2026-07-16T10:00:00.000Z';
  const later = '2026-07-16T10:01:00.000Z';
  const nowMs = Date.parse(later);
  const remoteMonth = usagePeriod('codex', at, 10);
  const remoteRow = Object.values(remoteMonth.sessions)[0];
  Object.assign(remoteRow, { archived: true, costUsd: 0.123456789, models: { 'gpt-5': 10 } });
  remoteMonth.sessions.unique = {
    ...remoteRow, sessionId: 'remote-only',
    promptCache: { observedAt: at, ttlSeconds: 300 }
  };
  const localMonth = usagePeriod('codex', later, 15);
  Object.assign(Object.values(localMonth.sessions)[0], {
    costUsd: 0.123456789, models: { 'gpt-5': 15 }, liveActivity: { state: 'running', observedAt: later }
  });
  const remote = device('remote', 10, { month: remoteMonth });
  const local = device('local', 15, { month: localMonth });
  const hub = { devices: [remote], staleAfterMs: 0 };
  const expected = aggregateDevices([remote, local], 0, nowMs).periods.month;
  const first = composeLocalSyncSummary(hub, local, { nowMs });

  assert.deepEqual(first.periods.month, expected);
  const shared = Object.values(first.periods.month.sessions).find(session => session.sessionId === remoteRow.sessionId);
  assert.equal(shared.totalTokens, 25);
  assert.equal(shared.archived, undefined);
  const unique = Object.values(first.periods.month.sessions).find(session => session.sessionId === 'remote-only');
  unique.models['gpt-5'] = 99;
  unique.promptCache.ttlSeconds = 99;
  assert.deepEqual(composeLocalSyncSummary(hub, local, { nowMs }).periods.month, expected);
});

test('local mode publishes a summary that completes to the full aggregate', () => {
  const nowMs = Date.parse('2026-07-16T10:05:00.000Z');
  const period = (client, totalTokens) => usagePeriod(client, '2026-07-16T10:00:00.000Z', totalTokens);
  const local = device('local', 10, { today: period('codex', 10), month: period('codex', 10), allTime: period('claude', 10) });
  const untouched = structuredClone(local);
  const finished = [];
  const finish = (stats) => {
    finished.push(stats);
    stats.historyRevision = 'local-revision';
    return stats;
  };

  const summary = composeLocalOnlySummary(local, finish, { nowMs });
  const full = aggregateDevices([local], 0, nowMs);
  assert.deepEqual(finished, [summary]);
  assert.deepEqual(summary.periods.allTime.sessions, {});
  assert.deepEqual({ ...summary.periods.allTime, sessions: null }, { ...full.periods.allTime, sessions: null });
  assert.deepEqual(summary.periods.today, full.periods.today);
  assert.deepEqual(summary.periods.month, full.periods.month);
  const withoutPeriods = (devices) => devices.map(({ periods, ...rest }) => rest);
  assert.deepEqual(withoutPeriods(summary.devices), withoutPeriods(full.devices));
  assert.deepEqual(summary.devices[0].periods.allTime.sessions, {}, 'as in a Hub summary');

  const complete = completeLocalSyncStats(summary);
  assert.deepEqual(complete.periods, full.periods);
  assert.equal(complete.historyRevision, 'local-revision', 'the completion is finished like the summary');
  assert.equal(completeLocalSyncStats(summary), complete, 'completed once per snapshot');
  assert.equal(finished.length, 2);
  assert.deepEqual(local, untouched);
});

test('stats that were never summarised are already complete', () => {
  const hubStats = { periods: { today: { totalTokens: 50 } } };
  assert.equal(composeLocalSyncSummary(hubStats, device('local', 25)), hubStats, 'a legacy snapshot passes through');
  assert.equal(completeLocalSyncStats(hubStats), hubStats);
  const full = composeLocalSyncStats(null, device('local', 25));
  assert.equal(completeLocalSyncStats(full), full);
  assert.equal(completeLocalSyncStats(null), null);
});

test('main publishes summaries and exports their completions', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.doesNotMatch(main, /composeLocalSyncStats\(/, 'every composition main publishes is a summary');
  assert.equal((main.match(/composeLocalSyncSummary\(/g) || []).length, 3, 'the publish, stats:get and its fresh-stream reuse');
  assert.equal((main.match(/composeLocalOnlySummary\(/g) || []).length, 1, 'the local collector publish');
  assert.doesNotMatch(main, /aggregateDevices\(\[localDevice\], 0\)/, 'local mode publishes a summary too');
  assert.match(main, /writeExportTo\(settings\.exportDir, completeLocalSyncStats\(payload\.data\.stats\)\.periods/);
  assert.match(main, /writeExportTo\(result\.filePaths\[0\], completeLocalSyncStats\(stats\)\.periods\)/);
  assert.equal((main.match(/writeExportTo\(/g) || []).length, 3, 'the definition and the two exports above');
});

test('Hub events that re-send a device keep its unchanged periods normalized', () => {
  const at = (seconds) => new Date(Date.parse('2026-07-16T00:00:00.000Z') + seconds * 1000).toISOString();
  const record = (deviceId, totalTokens, receivedAt) => device(deviceId, totalTokens, {
    receivedAt, updatedAt: receivedAt,
    month: usagePeriod('codex', receivedAt, totalTokens)
  });
  const remote = record('remote', 50, at(0));
  const first = aggregateDevices([record('local', 10, at(1)), remote], 0, Date.parse(at(2)));
  let sessionWalks = 0;
  const remoteMonth = first.devices[1].periods.month;
  remoteMonth.sessions = new Proxy(remoteMonth.sessions, {
    ownKeys(target) { sessionWalks += 1; return Reflect.ownKeys(target); }
  });
  const stream = createStatsStreamReceiver();
  const receive = (frame) => {
    const { event, data } = parseSseBlock(frame.replace(/\n+$/, ''));
    return stream.receive(event, data);
  };
  // main.js keeps the delta base private by copying each device per event.
  const display = (stats) => ({ ...stats, devices: stats.devices.map((entry) => ({ ...entry })) });
  const firstFrames = prepareSseFanout({ reason: 'ingest', stats: first, hasDeltaClients: true, revision: 1 });
  let cache = display(stream.receive('stats', { stats: first, revision: 1 }));
  composeLocalSyncSummary(cache, record('local', 10, at(1)), { nowMs: Date.parse(at(2)) });
  assert.ok(sessionWalks > 0);

  // This machine's upload comes back as a delta; the Hub re-sends the other
  // device too, for its ageMs.
  const second = aggregateDevices([record('local', 20, at(5)), remote], 0, Date.parse(at(6)));
  const secondFrames = prepareSseFanout({ reason: 'ingest', stats: second, hasDeltaClients: true,
    previousStats: first, revision: 2, lastContentKey: firstFrames.contentKey });
  assert.match(secondFrames.delta, /\/devices\/1\/ageMs/);
  const previousRemote = cache.devices[1];
  cache = display(receive(secondFrames.delta));
  assert.notEqual(cache.devices[1], previousRemote);
  sessionWalks = 0;
  const afterDelta = composeLocalSyncSummary(cache, record('local', 20, at(5)), { nowMs: Date.parse(at(6)) });
  assert.equal(sessionWalks, 0, 'the delta left the remote period, so its normalization is reused');
  assert.equal(afterDelta.periods.month.totalTokens, 70);

  // An unchanged snapshot arrives as a freshness event, which re-stamps devices.
  const third = aggregateDevices([record('local', 20, at(5)), remote], 0, Date.parse(at(9)));
  const thirdFrames = prepareSseFanout({ reason: 'ingest', stats: third, hasDeltaClients: true,
    previousStats: second, revision: 3, lastContentKey: secondFrames.contentKey });
  assert.match(thirdFrames.delta, /^event: freshness/);
  cache = display(receive(thirdFrames.delta));
  composeLocalSyncSummary(cache, record('local', 20, at(5)), { nowMs: Date.parse(at(9)) });
  assert.equal(sessionWalks, 0, 'a freshness event keeps the remote period too');

  // New remote usage replaces its period, which is normalized again.
  const fourth = aggregateDevices([record('local', 20, at(5)), record('remote', 80, at(10))], 0, Date.parse(at(11)));
  const fourthFrames = prepareSseFanout({ reason: 'ingest', stats: fourth, hasDeltaClients: true,
    previousStats: third, revision: 4, lastContentKey: thirdFrames.contentKey });
  cache = display(receive(fourthFrames.delta));
  const afterRemoteUsage = composeLocalSyncSummary(cache, record('local', 20, at(5)), { nowMs: Date.parse(at(11)) });
  assert.equal(afterRemoteUsage.periods.month.totalTokens, 100);
});

test('a cached Hub period follows the clock that judges a peer activity observation', () => {
  const realNow = Date.now;
  let clock = Date.parse('2026-07-16T00:00:10.000Z');
  Date.now = () => clock;
  try {
    const period = usagePeriod('codex', '2026-07-16T00:00:00.000Z', 50);
    const key = Object.keys(period.sessions)[0];
    // The peer's clock runs a few seconds ahead of this machine's.
    period.sessions[key].liveActivity = { state: 'running', observedAt: '2026-07-16T00:00:13.000Z' };
    const hubStats = { devices: [device('remote', 50, { month: period })] };
    // Both the aggregate and the remote device's own period carry the session.
    const activity = () => {
      const composed = composeLocalSyncSummary(hubStats, device('local', 10), { nowMs: clock });
      const [aggregate, remote] = [composed, composed.devices.find((entry) => entry.deviceId === 'remote')]
        .map((source) => Object.values(source.periods.month.sessions));
      assert.equal(aggregate.length, 1);
      assert.deepEqual(remote.map((session) => session.liveActivity || null), [aggregate[0].liveActivity || null]);
      return aggregate[0].liveActivity || null;
    };

    assert.equal(activity(), null, 'a future observation is not evidence yet');
    clock = Date.parse('2026-07-16T00:00:14.000Z');
    assert.deepEqual(activity(), { state: 'running', observedAt: '2026-07-16T00:00:13.000Z' });
    // A clock corrected backwards puts the observation in the future again.
    clock = Date.parse('2026-07-16T00:00:11.000Z');
    assert.equal(activity(), null);

    // The clock moves while a fill reads it. Each period is normalized at one
    // sample, so the cache matches a fresh normalization at that time.
    const remotePeriodActivity = (stats, nowMs) => Object.values(composeLocalSyncSummary(stats, device('local', 10), { nowMs })
      .devices.find((entry) => entry.deviceId === 'remote').periods.month.sessions)[0].liveActivity || null;
    const fillWhileClockMoves = (sampled, during) => {
      const stats = { devices: [device('remote', 50, { today: undefined, allTime: undefined, month: structuredClone(period) })] };
      let reads = 0;
      Date.now = () => (reads++ === 0 ? Date.parse(sampled) : Date.parse(during));
      composeLocalSyncSummary(stats, device('local', 10), { nowMs: Date.parse(sampled) });
      return stats;
    };
    const setBack = fillWhileClockMoves('2026-07-16T00:00:14.000Z', '2026-07-16T00:00:11.000Z');
    Date.now = () => Date.parse('2026-07-16T00:00:15.000Z');
    assert.deepEqual(remotePeriodActivity(setBack, Date.now()), { state: 'running', observedAt: '2026-07-16T00:00:13.000Z' });
    const movedOn = fillWhileClockMoves('2026-07-16T00:00:12.999Z', '2026-07-16T00:00:13.000Z');
    Date.now = () => Date.parse('2026-07-16T00:00:12.999Z');
    assert.equal(remotePeriodActivity(movedOn, Date.now()), null);
  } finally {
    Date.now = realNow;
  }
});
