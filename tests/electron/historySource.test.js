'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseDeviceHistories,
  resolveCompleteHistory,
  resolveDeviceHistories
} = require('../../src/electron/historySource');
const { deviceHistoriesCoverUsage } = require('../../src/electron/renderer/homeOverview');
const { deriveRangeSnapshot } = require('../../src/electron/renderer/periodRanges');

const aggregate = (devices) => ({
  daily: devices.map((device) => ({ date: device.date, tokens: device.tokens })),
  monthly: [],
  summary: { totalTokens: devices.reduce((sum, device) => sum + device.tokens, 0) }
});

test('returns the same empty history shape when history is disabled', async () => {
  assert.deepEqual(await resolveCompleteHistory({ historyEnabled: false, aggregateHistory: aggregate }), {
    daily: [], monthly: [], summary: { totalTokens: 0 }
  });
});

test('resolves local and embedded host histories without a network request', async () => {
  const local = await resolveCompleteHistory({
    mode: 'local',
    aggregateHistory: aggregate,
    localDevice: { date: '2026-07-17', tokens: 42 }
  });
  assert.deepEqual(local.daily, [{ date: '2026-07-17', tokens: 42 }]);

  const host = await resolveCompleteHistory({
    mode: 'host',
    hubMode: 'host',
    embeddedHub: { hub: { getHistory: () => ({ daily: [{ date: '2026-07-16', tokens: 7 }] }) } },
    aggregateHistory: aggregate
  });
  assert.deepEqual(host.daily, [{ date: '2026-07-16', tokens: 7 }]);
});

test('fetches and parses the complete client history endpoint', async () => {
  let request;
  const history = { daily: [{ date: '2026-07-15', tokens: 9 }], monthly: [], summary: {} };
  const result = await resolveCompleteHistory({
    hubUrl: 'https://hub.example/',
    secret: 'test-secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return history; } };
    }
  });
  assert.deepEqual(result, history);
  assert.equal(request.url, 'https://hub.example/api/history');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
});

test('projects per-device histories and preserves explicit availability', () => {
  assert.deepEqual(parseDeviceHistories({
    devices: [
      { deviceId: 'mac', history: { daily: [{ date: '2026-08-11', tokens: 9 }] } },
      { id: 'win', history: { monthly: [{ month: '2026-08', tokens: 5 }] } },
      { deviceId: 'disabled', historyAvailable: false, history: null, allTime: { totalTokens: 50 } },
      { deviceId: 'legacy', allTime: { totalTokens: 0 } }
    ]
  }), {
    mac: { available: true, daily: [{ date: '2026-08-11', tokens: 9 }], monthly: [], summary: {} },
    win: { available: true, daily: [], monthly: [{ month: '2026-08', tokens: 5 }], summary: {} },
    disabled: { available: false, daily: [], monthly: [], summary: {} },
    legacy: { available: false, daily: [], monthly: [], summary: {} }
  });
});

test('legacy empty history with lifetime usage is unavailable instead of an exact zero', () => {
  const histories = parseDeviceHistories({ devices: [{
    deviceId: 'legacy-normalized-null',
    periods: { allTime: { totalTokens: 500 } },
    history: { daily: [], monthly: [], summary: {} }
  }] });

  assert.equal(histories['legacy-normalized-null'].available, false);
});

test('a history-disabled participating device blocks a partial last-7-days total', () => {
  const devices = [
    {
      deviceId: 'mac',
      periods: { today: { totalTokens: 100 }, allTime: { totalTokens: 700 } },
      historyAvailable: true,
      history: { daily: [{ date: '2026-08-11', tokens: 100 }] }
    },
    {
      deviceId: 'linux',
      periods: { today: { totalTokens: 50 }, allTime: { totalTokens: 500 } },
      historyAvailable: false,
      history: null
    }
  ];
  const histories = parseDeviceHistories(devices);
  const status = deviceHistoriesCoverUsage(devices, histories) ? 'ready' : 'unavailable';
  const snapshot = deriveRangeSnapshot([], { status, selection: 'last7', todayKey: '2026-08-11' });

  assert.equal(status, 'unavailable');
  assert.equal(snapshot.period, null);
  assert.deepEqual(snapshot.daily, []);
});

test('resolves local and embedded device histories without a network request', async () => {
  const local = await resolveDeviceHistories({
    mode: 'local',
    localDevice: { deviceId: 'local', history: { daily: [{ date: '2026-08-11', tokens: 4 }] } }
  });
  assert.equal(local.local.daily[0].tokens, 4);

  const embedded = await resolveDeviceHistories({
    mode: 'host',
    hubMode: 'host',
    embeddedHub: {
      hub: {
        getDevices: () => [{ deviceId: 'remote', history: { daily: [{ date: '2026-08-10', tokens: 7 }] } }]
      }
    }
  });
  assert.equal(embedded.remote.daily[0].tokens, 7);
});

test('fetches authenticated raw device histories from the existing hub endpoint', async () => {
  let request;
  const result = await resolveDeviceHistories({
    hubUrl: 'https://hub.example/',
    secret: 'test-secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { devices: [{ deviceId: 'mac', history: { daily: [{ date: '2026-08-11', tokens: 12 }] } }] };
        }
      };
    }
  });
  assert.equal(result.mac.daily[0].tokens, 12);
  assert.equal(request.url, 'https://hub.example/api/devices');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
});
