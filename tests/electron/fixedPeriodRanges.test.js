'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ranges = require('../../src/electron/renderer/fixedPeriodRanges');

function day(date, tokens, client = 'claude', model = 'opus') {
  return {
    date,
    tokens,
    cost: tokens / 100,
    perClient: { [client]: { tokens, cost: tokens / 100 } },
    perModel: { [model]: { tokens, cost: tokens / 100 } }
  };
}

function deviceSource({
  deviceId,
  date = '2026-08-12',
  endsAt = '2026-08-13T00:00:00.000Z',
  history = [],
  historyAvailable = true,
  platform = 'darwin-arm64',
  todayTokens = 0
}) {
  return {
    deviceId,
    platform,
    historyAvailable,
    history: historyAvailable ? { daily: history } : null,
    periodWindows: { today: { key: date, endsAt } },
    periods: {
      today: { totalTokens: todayTokens },
      month: { totalTokens: todayTokens },
      allTime: { totalTokens: todayTokens }
    }
  };
}

test('fixed period slots keep the existing three-button layout', () => {
  assert.equal(ranges.slotForSelection('today'), 'today');
  assert.equal(ranges.slotForSelection('last7'), 'month');
  assert.equal(ranges.slotForSelection('last30'), 'month');
  assert.equal(ranges.slotForSelection('allTime'), 'allTime');
  assert.equal(ranges.displayLabel('last7'), '7D');
});

test('device inventory signatures are stable and identity-aware', () => {
  assert.equal(
    ranges.deviceInventorySignature([{ deviceId: 'new-device' }, { deviceId: 'old-device' }]),
    ranges.deviceInventorySignature([{ deviceId: 'old-device' }, { deviceId: 'new-device' }])
  );
  assert.notEqual(
    ranges.deviceInventorySignature([{ deviceId: 'old-device' }]),
    ranges.deviceInventorySignature([{ deviceId: 'new-device' }])
  );
  assert.equal(
    ranges.deviceInventorySignature([{ deviceId: 'same' }, { deviceId: 'same' }, {}]),
    '["same"]'
  );
});

test('a failed History request retries with the same signature and settles after success', async () => {
  const signature = 'revision:2026-08-12:["mac"]';
  let attempts = 0;
  let retries = 0;
  const fetchHistory = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary History failure');
    return { deviceHistories: [{ deviceId: 'mac' }] };
  };

  let failed = false;
  let inventoryMatches = false;
  try {
    await fetchHistory();
  } catch (_) {
    failed = true;
  }
  assert.equal(ranges.shouldRetryFixedPeriodHistory({
    signature,
    currentSignature: signature,
    retries,
    maxRetries: 3,
    failed,
    inventoryMatches
  }), true);

  retries += 1;
  const history = await fetchHistory();
  failed = false;
  inventoryMatches = ranges.deviceInventorySignature(history.deviceHistories)
    === ranges.deviceInventorySignature([{ deviceId: 'mac' }]);
  assert.equal(ranges.shouldRetryFixedPeriodHistory({
    signature,
    currentSignature: signature,
    retries,
    maxRetries: 3,
    failed,
    inventoryMatches
  }), false);
  assert.equal(attempts, 2);
});

test('last 7 days is available immediately from V1 daily history', () => {
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [day('2026-08-06', 10), day('2026-08-11', 20)]
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 30);
  assert.equal(result.period.clients.claude, 30);
  assert.equal(result.period.models.opus, 30);
});

test('live today replaces a lagging V1 history row without double counting', () => {
  const result = ranges.fixedPeriodSnapshot('week', {
    historyAvailable: true,
    historyEnabled: true,
    locale: 'en-GB',
    todayKey: '2026-08-12',
    daily: [day('2026-08-10', 10), day('2026-08-12', 20)],
    todayPeriod: {
      totalTokens: 50,
      costUsd: 0.5,
      clients: { codex: 50 },
      clientCosts: { codex: 0.5 },
      models: { gpt: 50 },
      modelCosts: { gpt: 0.5 }
    }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 60);
  assert.deepEqual(result.period.clients, { claude: 10, codex: 50 });
});

test('per-device V1 histories retain device identity for fixed ranges', () => {
  const snapshots = ranges.fixedPeriodDeviceSnapshots('last7', [
    deviceSource({
      deviceId: 'mac',
      history: [day('2026-08-11', 40, 'codex', 'gpt')]
    }),
    deviceSource({
      deviceId: 'pc',
      history: [day('2026-08-11', 60, 'claude', 'opus')]
    })
  ], {
    historyEnabled: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.deepEqual(snapshots.map((entry) => ({
    deviceId: entry.deviceId,
    tokens: entry.period.totalTokens
  })), [
    { deviceId: 'mac', tokens: 40 },
    { deviceId: 'pc', tokens: 60 }
  ]);
  assert.equal(snapshots.reduce((sum, entry) => sum + entry.period.totalTokens, 0), 100);
});

test('mixed devices fail closed when a contributing device has no History', () => {
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [
    deviceSource({ deviceId: 'new', history: [day('2026-08-12', 100)], todayTokens: 100 }),
    deviceSource({ deviceId: 'old', historyAvailable: false, todayTokens: 50 })
  ], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'historyUnavailable');
  assert.equal(result.period, null);
});

test('a zero-native-usage device without History still fails closed', () => {
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [
    deviceSource({ deviceId: 'known', history: [day('2026-08-12', 100)], todayTokens: 100 }),
    deviceSource({ deviceId: 'unknown', historyAvailable: false, todayTokens: 0 })
  ], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'historyUnavailable');
});

test('live devices missing from a raced History response still fail closed', () => {
  const sources = ranges.joinDeviceHistorySources([
    deviceSource({ deviceId: 'known', history: [day('2026-08-12', 100)], todayTokens: 100 })
  ], [
    deviceSource({ deviceId: 'known', historyAvailable: false, todayTokens: 100 }),
    deviceSource({ deviceId: 'just-arrived', historyAvailable: false, todayTokens: 50 })
  ]);
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', sources, {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.deepEqual(sources.map((source) => ({
    deviceId: source.deviceId,
    historyAvailable: source.historyAvailable
  })), [
    { deviceId: 'just-arrived', historyAvailable: false },
    { deviceId: 'known', historyAvailable: true }
  ]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'historyUnavailable');
});

test('Windows contributors use retained History for fixed ranges', () => {
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [
    deviceSource({
      deviceId: 'windows-host',
      history: [day('2026-08-12', 50)],
      platform: 'win32-x64',
      todayTokens: 50
    })
  ], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 50);
  assert.deepEqual(result.devices.map((device) => device.deviceId), ['windows-host']);
});

test('each device uses its own current period-window day before aggregation', () => {
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [
    deviceSource({
      deviceId: 'taipei',
      date: '2026-08-12',
      endsAt: '2026-08-12T16:00:00.000Z',
      todayTokens: 40
    }),
    deviceSource({
      deviceId: 'new-york',
      date: '2026-08-11',
      endsAt: '2026-08-12T04:00:00.000Z',
      history: [day('2026-08-11', 60)],
      todayTokens: 60
    })
  ], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-11T16:30:00.000Z')
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 100);
  assert.deepEqual(result.devices.map((entry) => ({
    deviceId: entry.deviceId,
    totalTokens: entry.period.totalTokens,
    rangeEnd: entry.range.end
  })), [
    { deviceId: 'taipei', totalTokens: 40, rangeEnd: '2026-08-12' },
    { deviceId: 'new-york', totalTokens: 60, rangeEnd: '2026-08-11' }
  ]);
});

test('contributing devices without a current producer calendar fail closed', () => {
  const source = deviceSource({ deviceId: 'legacy', history: [day('2026-08-11', 50)], todayTokens: 50 });
  delete source.periodWindows;
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [source], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'historyUnavailable');
});

test('covered sparse days remain exact zero rows for Trends', () => {
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: []
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 0);
  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.daily.map((row) => row.date), [
    '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09',
    '2026-08-10', '2026-08-11', '2026-08-12'
  ]);
  assert.deepEqual(result.summary, {
    activeDays: 0,
    currentStreak: 0,
    activeTimeMs: 0,
    peakDayTokens: 0
  });
});

test('fixed periods fail closed without History and for unsupported detail views', () => {
  assert.equal(ranges.fixedPeriodSnapshot('last30', {
    historyAvailable: false,
    historyEnabled: true
  }).reason, 'historyUnavailable');
  assert.equal(ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: false,
    historyEnabled: false
  }).reason, 'historyDisabled');
  assert.equal(ranges.supportsBreakdown('last7', 'session'), false);
  assert.equal(ranges.supportsBreakdown('last7', 'project'), false);
  assert.equal(ranges.supportsBreakdown('last7', 'device', { deviceHistoriesAvailable: true }), true);
  assert.equal(ranges.supportsBreakdown('last7', 'device', { deviceHistoriesAvailable: false }), false);
  assert.equal(ranges.supportsBreakdown('last7', 'model'), true);
});

test('period menu keyboard navigation moves focus with standard menu keys', () => {
  const target = new EventTarget();
  const focused = [];
  target.addEventListener('keydown', (event) => {
    ranges.handlePeriodMenuNavigation(event, {
      currentIndex: 1,
      itemCount: 4,
      focusIndex: (index) => focused.push(index)
    });
  });

  const arrow = new Event('keydown', { cancelable: true });
  Object.defineProperty(arrow, 'key', { value: 'ArrowDown' });
  target.dispatchEvent(arrow);
  assert.equal(arrow.defaultPrevented, true);
  assert.deepEqual(focused, [2]);

  const end = new Event('keydown', { cancelable: true });
  Object.defineProperty(end, 'key', { value: 'End' });
  target.dispatchEvent(end);
  assert.equal(end.defaultPrevented, true);
  assert.deepEqual(focused, [2, 3]);

  const unrelated = new Event('keydown', { cancelable: true });
  Object.defineProperty(unrelated, 'key', { value: 'Enter' });
  target.dispatchEvent(unrelated);
  assert.equal(unrelated.defaultPrevented, false);
  assert.deepEqual(focused, [2, 3]);
});
