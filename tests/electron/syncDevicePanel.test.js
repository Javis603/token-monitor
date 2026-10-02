'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clientConnectionState, deviceCounts, deviceRows } = require('../../src/electron/renderer/syncDevicePanel');

function device(deviceId, extra = {}) {
  return {
    deviceId,
    hostname: `${deviceId}.local`,
    platform: 'darwin',
    agentVersion: '0.65.0',
    agentRuntime: 'electron-widget',
    receivedAt: '2026-10-02T00:00:00.000Z',
    stale: false,
    ...extra
  };
}

test('this device leads, then online devices by latest sync, then offline ones', () => {
  const rows = deviceRows([
    device('old-offline', { stale: true, receivedAt: '2026-09-01T00:00:00.000Z' }),
    device('recent', { receivedAt: '2026-10-02T00:05:00.000Z' }),
    device('older', { receivedAt: '2026-10-02T00:01:00.000Z' }),
    device('me', { receivedAt: '2026-10-01T00:00:00.000Z' })
  ], { localDeviceId: 'me' });

  assert.deepEqual(rows.map((row) => row.key), ['me', 'recent', 'older', 'old-offline']);
  assert.equal(rows[0].isLocal, true);
  assert.deepEqual(deviceCounts(rows), { total: 4, online: 3 });
});

test('only stale remote devices can be removed', () => {
  const rows = deviceRows([
    device('me', { stale: true }),
    device('gone', { stale: true }),
    device('live')
  ], { localDeviceId: 'me' });
  const removable = Object.fromEntries(rows.map((row) => [row.key, row.canRemove]));

  assert.deepEqual(removable, { me: false, live: false, gone: true });
});

test("this device's sync time is the Hub's receipt when the live record carries one", () => {
  const [uploaded] = deviceRows([device('me', {
    receivedAt: '2026-10-02T00:09:00.000Z',
    hubReceivedAt: '2026-10-02T00:00:00.000Z'
  })], { localDeviceId: 'me' });
  const [pending] = deviceRows([device('me', { hubReceivedAt: null })], { localDeviceId: 'me' });
  const [hostOwned] = deviceRows([device('me')], { localDeviceId: 'me' });

  assert.equal(uploaded.syncedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(pending.syncedAt, '');
  assert.equal(hostOwned.syncedAt, '2026-10-02T00:00:00.000Z');
});

test('client connection state separates a missing URL from a failed connection', () => {
  assert.equal(clientConnectionState({ mode: 'local', streamConnected: false }), 'notConfigured');
  assert.equal(clientConnectionState({ mode: 'sync', streamConnected: true }), 'connected');
  assert.equal(clientConnectionState({ mode: 'sync', streamConnected: false, failureReason: 'Wrong secret' }), 'disconnected');
  assert.equal(clientConnectionState({ mode: 'sync', streamConnected: false, failureReason: '' }), 'connecting');
});
