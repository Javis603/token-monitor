'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateDevices } = require('../../src/shared/usage');
const { composeLocalSyncStats } = require('../../src/electron/syncDisplayStats');

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

test('composeLocalSyncStats replaces the hub copy of the local device without double counting', () => {
  const hubStats = aggregateDevices([
    device('local', 100),
    device('remote', 50)
  ], 0, Date.parse('2026-07-16T00:01:00.000Z'));
  const localHubDevice = hubStats.devices.find((entry) => entry.deviceId === 'local');
  const remoteHubDevice = hubStats.devices.find((entry) => entry.deviceId === 'remote');
  localHubDevice.displayName = 'This Mac';
  remoteHubDevice.displayName = 'Studio';
  remoteHubDevice.stale = true;
  remoteHubDevice.ageMs = 900000;
  hubStats.historyRevision = 'hub-revision';
  hubStats.limits = { providers: [{ provider: 'codex', sourceDeviceId: 'remote' }] };

  const result = composeLocalSyncStats(hubStats, device('local', 120, {
    updatedAt: '2026-07-16T00:02:00.000Z',
    receivedAt: '2026-07-16T00:02:00.000Z'
  }));

  assert.equal(result.periods.today.totalTokens, 170);
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').periods.today.totalTokens, 120);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'local').displayName, 'This Mac');
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').displayName, 'Studio');
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').stale, true);
  assert.equal(result.devices.find((entry) => entry.deviceId === 'remote').ageMs, 900000);
  assert.equal(result.historyRevision, 'hub-revision');
  assert.deepEqual(result.limits, hubStats.limits);
  assert.equal(hubStats.periods.today.totalTokens, 150);
});

test('composeLocalSyncStats can render a local device before the first hub snapshot', () => {
  const result = composeLocalSyncStats(null, device('local', 25));

  assert.equal(result.periods.today.totalTokens, 25);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].deviceId, 'local');
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
