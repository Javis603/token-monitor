'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  devicesWithLocalHistory,
  parseDeviceHistories,
  resolveCompleteHistory,
  resolveCompleteHistoryWithDevices
} = require('../../src/electron/historySource');
const { fixedPeriodSnapshotFromDevices } = require('../../src/electron/renderer/fixedPeriodRanges');
const { normalizeDeviceRecord } = require('../../src/shared/usage');

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

test('keeps device identity when resolving fixed-range histories', async () => {
  const devices = [
    {
      deviceId: 'mac',
      hostname: 'MacBook',
      platform: 'darwin-arm64',
      periodWindows: { today: { key: '2026-08-11', endsAt: '2026-08-12T00:00:00.000Z' } },
      today: { totalTokens: 40 },
      date: '2026-08-11',
      tokens: 40,
      historyAvailable: true,
      history: { daily: [{ date: '2026-08-11', tokens: 40 }], monthly: [], summary: {} }
    },
    {
      deviceId: 'pc',
      hostname: 'Windows',
      platform: 'win32-x64',
      periodWindows: { today: { key: '2026-08-11', endsAt: '2026-08-12T00:00:00.000Z' } },
      today: { totalTokens: 60 },
      date: '2026-08-11',
      tokens: 60,
      historyAvailable: true,
      history: { daily: [{ date: '2026-08-11', tokens: 60 }], monthly: [], summary: {} }
    }
  ];
  let request;
  const result = await resolveCompleteHistoryWithDevices({
    hubUrl: 'https://hub.example/',
    secret: 'test-secret',
    aggregateHistory: aggregate,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return { devices }; } };
    }
  });

  assert.equal(request.url, 'https://hub.example/api/devices');
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
  assert.equal(result.history.summary.totalTokens, 100);
  assert.deepEqual(result.deviceHistories.map((entry) => ({
    deviceId: entry.deviceId,
    hostname: entry.hostname,
    tokens: entry.history.daily[0].tokens,
    todayTokens: entry.periods.today.totalTokens,
    todayKey: entry.periodWindows.today.key
  })), [
    { deviceId: 'mac', hostname: 'MacBook', tokens: 40, todayTokens: 40, todayKey: '2026-08-11' },
    { deviceId: 'pc', hostname: 'Windows', tokens: 60, todayTokens: 60, todayKey: '2026-08-11' }
  ]);
});

test('remote fixed-range history overlays a fresher local device record', async () => {
  const hubDevice = {
    deviceId: 'mac',
    periodWindows: { today: { key: '2026-08-12', endsAt: '2026-08-13T00:00:00.000Z' } },
    today: { totalTokens: 5 },
    historyAvailable: true,
    history: { daily: [{ date: '2026-08-11', tokens: 100 }], monthly: [], summary: {} }
  };
  const localDevice = {
    deviceId: 'mac',
    periodWindows: { today: { key: '2026-08-12', endsAt: '2026-08-13T00:00:00.000Z' } },
    today: { totalTokens: 5 },
    historyAvailable: true,
    history: { daily: [{ date: '2026-08-11', tokens: 200 }], monthly: [], summary: {} }
  };
  const result = await resolveCompleteHistoryWithDevices({
    hubUrl: 'https://hub.example',
    localDevice,
    aggregateHistory: (devices) => devices[0].history,
    fetchImpl: async () => ({ ok: true, async json() { return { devices: [hubDevice] }; } })
  });
  assert.equal(result.history.daily[0].tokens, 200);
  assert.equal(result.deviceHistories[0].history.daily[0].tokens, 200);
});

test('local snapshot without History preserves the Hub last-good History', () => {
  const hubHistory = { daily: [{ date: '2026-08-11', tokens: 80 }] };
  assert.deepEqual(devicesWithLocalHistory([
    { deviceId: 'mac', historyAvailable: true, history: hubHistory, today: { totalTokens: 4 } }
  ], {
    deviceId: 'mac',
    historyAvailable: true,
    today: { totalTokens: 5 }
  }), [{
    deviceId: 'mac',
    historyAvailable: true,
    history: hubHistory,
    today: { totalTokens: 5 }
  }]);
});

test('local capability does not endorse ambiguous legacy Hub History', () => {
  const records = devicesWithLocalHistory([{
    deviceId: 'mac',
    history: { daily: [], monthly: [], summary: {} },
    today: { totalTokens: 4 }
  }], {
    deviceId: 'mac',
    historyAvailable: true,
    today: { totalTokens: 5 }
  });

  assert.equal(Object.hasOwn(records[0], 'history'), false);
  const [device] = parseDeviceHistories(records);
  assert.equal(device.historyAvailable, false);
  assert.equal(device.history, null);
});

test('older widget snapshot cannot replace newer headless-agent Hub History', () => {
  const hubHistory = { daily: [{ date: '2026-08-11', tokens: 300 }] };
  const localHistory = { daily: [{ date: '2026-08-11', tokens: 200 }] };
  assert.deepEqual(devicesWithLocalHistory([{
    deviceId: 'mac',
    updatedAt: '2026-08-12T13:05:00.000Z',
    agentRuntime: 'headless-agent',
    history: hubHistory
  }], {
    deviceId: 'mac',
    updatedAt: '2026-08-12T13:00:00.000Z',
    agentRuntime: 'electron-widget',
    history: localHistory
  }), [{
    deviceId: 'mac',
    updatedAt: '2026-08-12T13:05:00.000Z',
    agentRuntime: 'headless-agent',
    history: hubHistory
  }]);
});

test('marks a device without retained History unavailable instead of inventing zero', () => {
  assert.deepEqual(parseDeviceHistories([{ deviceId: 'mac' }]), [{
    deviceId: 'mac',
    displayName: '',
    hostname: '',
    platform: '',
    updatedAt: '',
    agentVersion: '',
    agentRuntime: '',
    periodWindows: null,
    periods: { today: null, month: null, allTime: null },
    historyAvailable: false,
    history: null
  }]);
});

test('keeps explicit disabled History unavailable after device normalization', () => {
  const record = normalizeDeviceRecord({
    deviceId: 'mac',
    historyAvailable: false,
    history: null,
    today: { totalTokens: 100 }
  });
  const [device] = parseDeviceHistories([record]);

  assert.equal(device.historyAvailable, false);
  assert.equal(device.history, null);
  assert.equal(device.periods.today.totalTokens, 100);
});

test('does not trust legacy empty History without the producer capability', () => {
  const [legacy] = parseDeviceHistories([{
    deviceId: 'legacy',
    periodWindows: { today: { key: '2026-08-12', endsAt: '2026-08-13T00:00:00.000Z' } },
    today: { totalTokens: 100 },
    month: { totalTokens: 100 },
    allTime: { totalTokens: 100 },
    history: { daily: [], monthly: [], summary: {} }
  }]);
  const [current] = parseDeviceHistories([{
    deviceId: 'current',
    historyAvailable: true,
    history: { daily: [], monthly: [], summary: {} }
  }]);

  assert.equal(legacy.historyAvailable, false);
  assert.equal(legacy.history, null);
  assert.equal(fixedPeriodSnapshotFromDevices('last7', [legacy], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  }).status, 'unavailable');
  assert.equal(current.historyAvailable, true);
  assert.deepEqual(current.history, { daily: [], monthly: [], summary: {} });
});

test('resolves embedded device histories without a loopback request', async () => {
  const devices = [{
    deviceId: 'host',
    date: '2026-08-12',
    tokens: 12,
    historyAvailable: true,
    history: { daily: [{ date: '2026-08-12', tokens: 12 }] }
  }];
  const result = await resolveCompleteHistoryWithDevices({
    mode: 'host',
    hubMode: 'host',
    embeddedHub: { hub: { getDevices: () => devices } },
    aggregateHistory: aggregate,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  assert.equal(result.history.summary.totalTokens, 12);
  assert.equal(result.deviceHistories[0].deviceId, 'host');
});
