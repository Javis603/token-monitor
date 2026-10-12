'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateLimits } = require('../../src/shared/limits/core');
const { fetchWorkbuddyLimits, workbuddyAccountKey } = require('../../src/shared/providers/workbuddy/limits');
const { workbuddyCreditTotals } = require('../../src/electron/renderer/limits/providerPresentation');
const { aggregateLimits: aggregateWorkerLimits } = require('../../worker/src/shared/limits/core');

for (const [runtime, aggregate] of [['Node', aggregateLimits], ['Worker', aggregateWorkerLimits]]) {
  test(`${runtime}: unsigned fresh devices do not add accounts when every known credential is missing`, async () => {
    const now = Date.parse('2026-10-12T00:10:00Z');
    const at = new Date(now).toISOString();
    for (const realm of ['cn', 'ai']) {
      const known = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: [
        { realm, userId: 'encrypted-user', reason: 'encrypted' },
        { realm, userId: 'missing-user', reason: 'incomplete' }
      ] }, { env: {}, now: () => now });
      assert.deepEqual(known.map((row) => row.status), ['notConfigured', 'notConfigured']);
      for (const stale of [false, true]) for (const unsignedRealm of ['cn', 'ai']) {
        const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true,
          workbuddyRealm: unsignedRealm }, { env: {}, now: () => now });
        const devices = [
          { deviceId: 'known', stale, limits: { updatedAt: at, providers: known } },
          { deviceId: 'unsigned-fresh', limits: { updatedAt: at, providers: [placeholder] } }
        ];
        for (const observations of [devices, [...devices].reverse()]) {
          const summary = aggregate(observations, 60000, now);
          assert.equal(summary.providers.length, 2, `${realm} / ${unsignedRealm} / stale=${stale}`);
          for (const expected of known) {
            const retained = summary.providers.find((row) => row.accountKey === expected.accountKey);
            assert.ok(retained, 'every genuine identity remains');
            assert.equal(retained.status, expected.status);
            assert.equal(retained.actionRequired, expected.actionRequired);
            assert.equal(retained.stale, stale);
          }
          assert.equal(workbuddyCreditTotals(summary.providers), null);
        }
      }
    }
  });

  test(`${runtime}: placeholder-only devices retain the first-sign-in or encryption hint`, async () => {
    const now = Date.parse('2026-10-12T00:10:00Z');
    const at = new Date(now).toISOString();
    for (const realm of ['cn', 'ai']) for (const reason of ['', 'encrypted']) {
      const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true,
        workbuddyRealm: realm, workbuddyLocalSessionReason: reason }, { env: {}, now: () => now });
      const summary = aggregate([
        { deviceId: 'unsigned-old', stale: true, limits: { updatedAt: at, providers: [placeholder] } },
        { deviceId: 'unsigned-fresh', limits: { updatedAt: at, providers: [placeholder] } }
      ], 60000, now);
      assert.equal(summary.providers.length, 1);
      assert.equal(summary.providers[0].accountKey, placeholder.accountKey);
      assert.equal(summary.providers[0].status, 'notConfigured');
      assert.equal(summary.providers[0].actionRequired, placeholder.actionRequired);
      assert.equal(summary.providers[0].stale, false);
    }
  });
}

test('an unsigned desktop on another device does not join healthy WorkBuddy accounts', async () => {
  const now = Date.parse('2026-10-12T00:10:00Z');
  const at = new Date(now).toISOString();
  const rows = ['a', 'b'].map((user) => ({
    provider: 'workbuddy', accountKey: workbuddyAccountKey('', user), status: 'ok', region: 'cn', updatedAt: at,
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }]
  }));
  for (const reason of ['', 'encrypted']) {
    const placeholder = await fetchWorkbuddyLimits({
      workbuddyDesktopSessionEnabled: true, workbuddyLocalSessionReason: reason
    }, { env: {}, now: () => now });
    for (const status of ['notConfigured', 'unauthorized', 'unavailable']) {
      for (const realm of ['cn', 'ai']) for (const stale of [false, true]) {
        const sentinel = { ...placeholder, status, region: realm, accountKey: workbuddyAccountKey('', '', '', '', realm) };
        const summary = aggregateLimits([
          { deviceId: 'signed-in', limits: { updatedAt: at, providers: rows } },
          { deviceId: 'unsigned', stale, limits: { updatedAt: at, providers: [sentinel] } }
        ], 60000, now);
        assert.equal(summary.providers.length, 2, `${reason || 'absent'} / ${realm} / stale=${stale}`);
        const [total] = workbuddyCreditTotals(summary.providers);
        assert.equal(total.limit, 200);
        assert.equal(total.remaining, 160);
      }
    }
    const alone = aggregateLimits([{ deviceId: 'unsigned', limits: { updatedAt: at, providers: [placeholder] } }], 0, now);
    assert.equal(alone.providers.length, 1, 'the only observation still offers the sign-in action');
  }
});

test('unnamed known WorkBuddy accounts survive missing credentials beside healthy siblings', () => {
  const now = Date.parse('2026-10-12T00:10:00Z');
  const at = new Date(now).toISOString();
  for (const status of ['notConfigured', 'unauthorized', 'unavailable']) {
    for (const stale of [false, true]) {
      const knownKey = workbuddyAccountKey('', 'known-user', '', '', 'ai');
      const summary = aggregateLimits([
        { deviceId: 'healthy', limits: { updatedAt: at, providers: [{ provider: 'workbuddy',
          accountKey: workbuddyAccountKey('', 'healthy'), status: 'ok', updatedAt: at, windows: [] }] } },
        { deviceId: 'known', stale, limits: { updatedAt: at, providers: [{ provider: 'workbuddy',
          accountKey: knownKey, status, updatedAt: at, windows: [] }] } }
      ], 60000, now);
      assert.equal(summary.providers.length, 2);
      assert.equal(summary.providers.find((row) => row.accountKey === knownKey).status, status);
      assert.equal(workbuddyCreditTotals(summary.providers), null);
    }
  }
});

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
