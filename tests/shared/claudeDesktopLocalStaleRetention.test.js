'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateLimits, isUsefulLimitObservation } = require('../../src/shared/limits/core');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { composeLocalOnlySummary } = require('../../src/electron/syncDisplayStats');

const NOW = Date.parse('2026-10-19T15:30:00.000Z');
const DESKTOP_OK = {
  provider: 'claude',
  accountKey: 'sha256:a983ccabcdef0123456789',
  status: 'ok',
  source: 'local',
  sourceDetail: 'app',
  updatedAt: '2026-10-19T09:28:42.066Z',
  windows: [
    { kind: 'session', usedPercent: 97, windowMinutes: 300 },
    { kind: 'weekly', usedPercent: 59, windowMinutes: 10080 }
  ]
};

test('isUsefulLimitObservation treats empty failures as non-useful', () => {
  assert.equal(isUsefulLimitObservation(DESKTOP_OK), true);
  assert.equal(isUsefulLimitObservation({ provider: 'claude', status: 'notConfigured', windows: [] }), false);
  assert.equal(isUsefulLimitObservation({ provider: 'claude', status: 'unavailable', windows: [] }), false);
  assert.equal(isUsefulLimitObservation({
    provider: 'claude', status: 'unavailable', windows: [{ kind: 'session', usedPercent: 10 }]
  }), true);
});

test('aggregateLimits keeps a stale Desktop ok over a fresh empty failure', () => {
  const summary = aggregateLimits([{
    deviceId: 'mac-local',
    limits: {
      providers: [
        {
          provider: 'claude',
          status: 'notConfigured',
          windows: [],
          updatedAt: new Date(NOW - 60_000).toISOString()
        },
        { ...DESKTOP_OK }
      ],
      refreshMs: 300_000
    }
  }], 5 * 60 * 1000, NOW);

  const claude = summary.providers.filter((p) => p.provider === 'claude');
  assert.ok(claude.some((p) => p.status === 'ok' && p.windows?.length === 2),
    `expected ok Desktop row, got ${JSON.stringify(claude.map((p) => ({ s: p.status, w: p.windows?.length, stale: p.stale })))}`);
  const ok = claude.find((p) => p.status === 'ok');
  assert.equal(ok.stale, true);
  assert.equal(ok.source, 'local');
});

test('LimitsRuntime drops provider:* placeholder after account-keyed Desktop ok', async () => {
  const notConfigured = {
    provider: 'claude',
    status: 'notConfigured',
    windows: [],
    updatedAt: new Date(NOW - 60_000).toISOString()
  };
  const runtime = createLimitsRuntime(
    {
      limitsEnabled: true,
      limitProviders: 'claude',
      previousLimits: { providers: [notConfigured], refreshMs: 300_000 }
    },
    {
      now: () => NOW,
      autoStart: false,
      autoRetry: false,
      probeProvider: async () => [DESKTOP_OK]
    }
  );
  await runtime.refresh({ provider: 'claude' }, 'manual');
  const providers = runtime.getSnapshot().providers;
  assert.equal(providers.length, 1);
  assert.equal(providers[0].status, 'ok');
  assert.equal(providers[0].accountKey, DESKTOP_OK.accountKey);

  const device = {
    deviceId: 'mac-local',
    limits: runtime.getSnapshot(),
    periods: { today: {}, month: {}, allTime: {} }
  };
  const composed = composeLocalOnlySummary(device, (s) => s, { nowMs: NOW });
  const row = composed.limits.providers.find((p) => p.provider === 'claude');
  assert.ok(row, 'claude row present');
  assert.equal(row.status, 'ok');
  assert.equal(row.windows.length, 2);
  assert.equal(row.source, 'local');
  assert.equal(row.stale, true);
});

test('aggregateLimits keeps stale Desktop local ok over a fresh empty failure from another device', () => {
  // Live Mac Pro bug: Mac has Desktop sample (ok/local, ages stale); NAS reports
  // fresh claude notConfigured with no windows. Cross-device empty failure must
  // not eclipse the Desktop sample or leave Not signed in.
  const summary = aggregateLimits([
    {
      deviceId: 'mac-pro',
      limits: {
        providers: [{ ...DESKTOP_OK }],
        refreshMs: 300_000,
        updatedAt: DESKTOP_OK.updatedAt
      }
    },
    {
      deviceId: 'nas-201',
      limits: {
        providers: [{
          provider: 'claude',
          status: 'notConfigured',
          windows: [],
          updatedAt: new Date(NOW - 30_000).toISOString()
        }],
        refreshMs: 300_000,
        updatedAt: new Date(NOW - 30_000).toISOString()
      }
    }
  ], 600_000, NOW);

  const claude = summary.providers.filter((p) => p.provider === 'claude');
  assert.equal(claude.length, 1, `expected one claude row, got ${JSON.stringify(claude.map((p) => ({
    s: p.status, src: p.source, stale: p.stale, device: p.sourceDeviceId, w: p.windows?.length
  })))}`);
  assert.equal(claude[0].status, 'ok');
  assert.equal(claude[0].source, 'local');
  assert.equal(claude[0].accountKey, DESKTOP_OK.accountKey);
  assert.equal(claude[0].windows.length, 2);
  assert.equal(claude[0].stale, true);
});

test('a fresh same-device empty failure still eclipses stale keyed Codex quota', () => {
  const summary = aggregateLimits([{
    deviceId: 'mac-local',
    limits: {
      refreshMs: 300_000,
      providers: [
        {
          provider: 'codex', accountKey: 'sha256:codex-a', status: 'ok', source: 'rpc',
          updatedAt: '2026-10-19T09:00:00.000Z',
          windows: [{ kind: 'session', usedPercent: 40, windowMinutes: 300 }]
        },
        { provider: 'codex', status: 'notConfigured', windows: [], updatedAt: new Date(NOW - 30_000).toISOString() }
      ]
    }
  }], 600_000, NOW);
  const codex = summary.providers.filter((p) => p.provider === 'codex');
  assert.equal(codex.length, 1, JSON.stringify(codex.map((p) => [p.status, p.accountKey, p.stale])));
  assert.equal(codex[0].status, 'notConfigured');
});
