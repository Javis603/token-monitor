'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateLimits } = require('../../src/shared/limits/core');

test('WorkBuddy keeps known accounts separate through missing credentials and sync', () => {
  const at = '2026-10-12T00:00:00.000Z';
  const row = (key, status) => ({
    provider: 'workbuddy', accountKey: key, accountName: 'Same nickname',
    status, source: 'oauth', updatedAt: at, windows: []
  });
  const devices = [
    { deviceId: 'one', limits: { updatedAt: at, providers: [row('a', 'notConfigured'), row('b', 'notConfigured')] } },
    { deviceId: 'two', limits: { updatedAt: at, providers: [row('a', 'ok')] } }
  ];
  const summary = aggregateLimits(devices, 0, Date.parse(at));
  assert.equal(summary.providers.length, 2);
  assert.deepEqual(summary.providers.map((p) => [p.accountKey, p.status]).sort(), [['a', 'ok'], ['b', 'notConfigured']]);
});

test('fresh WorkBuddy siblings retain an independent stale account and prevent a partial total', () => {
  const now = Date.parse('2026-10-12T00:10:00Z');
  const row = (accountKey, updatedAt) => ({ provider: 'workbuddy', accountKey, status: 'ok', region: 'cn', updatedAt,
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }] });
  const fresh = new Date(now).toISOString(), old = new Date(now - 3600000).toISOString();
  const summary = aggregateLimits([
    { deviceId: 'fresh', limits: { updatedAt: fresh, providers: [row('a', fresh), row('b', fresh)] } },
    { deviceId: 'old', limits: { updatedAt: old, providers: [row('a', old), row('c', old)] } }
  ], 60000, now);
  assert.equal(summary.providers.length, 3);
  assert.equal(summary.providers.find((p) => p.accountKey === 'a').stale, false);
  assert.equal(summary.providers.find((p) => p.accountKey === 'c').stale, true);
  const { workbuddyCreditTotals } = require('../../src/electron/renderer/limits/providerPresentation');
  assert.equal(workbuddyCreditTotals(summary.providers), null);
});
