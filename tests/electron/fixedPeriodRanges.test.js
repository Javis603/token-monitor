'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
const { resolveRegionalLocale } = require('../../src/electron/renderer/i18n');
const { extractUsageFromTokscale, normalizePeriod } = require('../../src/shared/usage');

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
  timeZone = '',
  todayTokens = 0
}) {
  return {
    deviceId,
    platform,
    historyAvailable,
    history: historyAvailable ? { daily: history } : null,
    periodWindows: {
      ...(timeZone ? { timeZone } : {}),
      today: { key: date, endsAt }
    },
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

test('token component breakdown preserves known values and isolates the unknown remainder', () => {
  assert.deepEqual(ranges.tokenComponentBreakdown({
    totalTokens: 150,
    cacheReadTokens: 60,
    outputTokens: 20,
    unclassifiedTokens: 50
  }), {
    cacheRead: 60,
    cacheMiss: 20,
    output: 20,
    unclassified: 50,
    hitPct: 75,
    missPct: 25
  });
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

test('exhausted History failure only retries across an explicit recovery boundary', () => {
  const state = {
    hasStats: true,
    historyEnabled: true,
    apiAvailable: true,
    active: false,
    failed: true,
    requested: true,
    loadedSignature: 'same',
    currentSignature: 'same'
  };
  assert.equal(ranges.shouldWarmFixedPeriodHistory(state), false);
  assert.equal(ranges.shouldWarmFixedPeriodHistory({ ...state, retryFailed: true }), true);
  assert.equal(ranges.shouldWarmFixedPeriodHistory({ ...state, force: true }), true);
});

test('this week uses the full regional locale instead of the translation locale', () => {
  assert.deepEqual(ranges.rangeForSelection('week', {
    todayKey: '2026-08-12',
    locale: resolveRegionalLocale(['en-GB'])
  }), { start: '2026-08-10', end: '2026-08-12' });
  assert.deepEqual(ranges.rangeForSelection('week', {
    todayKey: '2026-08-12',
    locale: resolveRegionalLocale(['en-US'])
  }), { start: '2026-08-09', end: '2026-08-12' });
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

test('fixed ranges expose exact History token components only when every selected usage row proves them', () => {
  const exactDay = {
    date: '2026-08-11',
    tokens: 100,
    cost: 1,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 0,
    tokenComponentsAvailable: true,
    perClient: {
      claude: {
        tokens: 100, cost: 1,
        unclassifiedTokens: 0,
        cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20
      }
    },
    perModel: {
      opus: {
        tokens: 100, cost: 1,
        unclassifiedTokens: 0,
        cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 20
      }
    }
  };
  const exact = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [exactDay]
  });
  assert.equal(exact.period.capabilities.tokenComponents, true);
  assert.equal(exact.period.cacheReadTokens, 60);
  assert.equal(exact.period.cacheWriteTokens, 10);
  assert.equal(exact.period.outputTokens, 20);
  assert.equal(exact.period.clientCacheReads.claude, 60);
  assert.equal(exact.period.modelOutputs.opus, 20);

  const mixed = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [exactDay, day('2026-08-10', 50)]
  });
  assert.equal(mixed.period.totalTokens, 150);
  assert.equal(mixed.period.capabilities.tokenComponents, false);
  assert.equal(mixed.period.clientCacheReads.claude, 60);
  assert.equal(mixed.period.modelOutputs.opus, 20);
  assert.equal(mixed.period.unclassifiedTokens, 50);
  assert.equal(mixed.period.clientUnclassifiedTokens.claude, 50);
  assert.equal(mixed.period.modelUnclassifiedTokens.opus, 50);
});

test('live-only fixed ranges carry native token components through exact zero history days', () => {
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [],
    todayPeriod: {
      capabilities: { tokenComponents: true },
      totalTokens: 100,
      costUsd: 1,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      outputTokens: 20,
      clients: { codex: 100 },
      clientCosts: { codex: 1 },
      clientCacheReads: { codex: 60 },
      clientCacheWrites: { codex: 10 },
      clientOutputs: { codex: 20 },
      models: { gpt: 100 },
      modelCosts: { gpt: 1 },
      modelCacheReads: { gpt: 60 },
      modelCacheWrites: { gpt: 10 },
      modelOutputs: { gpt: 20 }
    }
  });
  assert.equal(result.period.capabilities.tokenComponents, true);
  assert.equal(result.period.cacheReadTokens, 60);
  assert.equal(result.period.clientCacheWrites.codex, 10);
  assert.equal(result.period.modelOutputs.gpt, 20);
});

test('aggregate-only live fallback remains exact in total but unclassified in components', () => {
  const todayPeriod = normalizePeriod(extractUsageFromTokscale({
    totalTokens: 100,
    totalCost: 1
  }));
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [],
    todayPeriod
  });

  assert.equal(todayPeriod.capabilities.tokenComponents, false);
  assert.equal(result.period.totalTokens, 100);
  assert.equal(result.period.capabilities.tokenComponents, false);
  assert.equal(result.period.unclassifiedTokens, 100);
  assert.equal(result.period.cacheReadTokens, 0);
});

test('partial live provenance preserves known components and classifies only the remainder', () => {
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [],
    todayPeriod: {
      capabilities: { tokenComponents: false },
      totalTokens: 100,
      costUsd: 1,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      outputTokens: 20,
      clients: { codex: 100 },
      clientCosts: { codex: 1 },
      clientCacheReads: { codex: 60 },
      clientCacheWrites: { codex: 10 },
      clientOutputs: { codex: 20 },
      models: { gpt: 100 },
      modelCosts: { gpt: 1 },
      modelCacheReads: { gpt: 60 },
      modelCacheWrites: { gpt: 10 },
      modelOutputs: { gpt: 20 }
    }
  });

  assert.equal(result.period.capabilities.tokenComponents, false);
  assert.equal(result.period.cacheReadTokens, 60);
  assert.equal(result.period.cacheWriteTokens, 10);
  assert.equal(result.period.outputTokens, 20);
  assert.equal(result.period.unclassifiedTokens, 10);
  assert.equal(result.period.clientUnclassifiedTokens.codex, 10);
  assert.equal(result.period.modelUnclassifiedTokens.gpt, 10);
});

test('mixed live provenance keeps exact cache miss separate from explicit Unclassified usage', () => {
  const result = ranges.fixedPeriodSnapshot('last7', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [],
    todayPeriod: {
      capabilities: { tokenComponents: false },
      totalTokens: 200,
      costUsd: 2,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      outputTokens: 20,
      unclassifiedTokens: 100,
      clients: { codex: 100, claude: 100 },
      clientCosts: { codex: 1, claude: 1 },
      clientCacheReads: { codex: 60 },
      clientCacheWrites: { codex: 10 },
      clientOutputs: { codex: 20 },
      clientUnclassifiedTokens: { claude: 100 },
      models: { gpt: 100, opus: 100 },
      modelCosts: { gpt: 1, opus: 1 },
      modelCacheReads: { gpt: 60 },
      modelCacheWrites: { gpt: 10 },
      modelOutputs: { gpt: 20 },
      modelUnclassifiedTokens: { opus: 100 }
    }
  });

  assert.equal(result.period.totalTokens, 200);
  assert.equal(result.period.unclassifiedTokens, 100);
  assert.equal(result.period.clientUnclassifiedTokens.codex, 0);
  assert.equal(result.period.clientUnclassifiedTokens.claude, 100);
  assert.equal(result.period.modelUnclassifiedTokens.gpt, 0);
  assert.equal(result.period.modelUnclassifiedTokens.opus, 100);
  assert.equal(
    result.period.clients.codex
      - result.period.clientCacheReads.codex
      - result.period.clientCacheWrites.codex
      - result.period.clientOutputs.codex
      - result.period.clientUnclassifiedTokens.codex,
    10
  );
});

test('historical cost-only usage participates in a fixed range', () => {
  const source = deviceSource({ deviceId: 'cost-only' });
  source.history.daily = [{
    date: '2026-08-11',
    tokens: 0,
    cost: 2.5,
    perClient: { codex: { tokens: 0, cost: 2.5 } },
    perModel: { gpt: { tokens: 0, cost: 2.5 } }
  }];
  source.periods.allTime.costUsd = 2.5;

  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [source], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 0);
  assert.equal(result.period.costUsd, 2.5);
  assert.equal(result.period.clientCosts.codex, 2.5);
  assert.equal(result.period.modelCosts.gpt, 2.5);
  assert.deepEqual(result.devices.map((device) => device.deviceId), ['cost-only']);
});

test('live cost-only attribution uses cost-map keys without token-map entries', () => {
  const source = deviceSource({ deviceId: 'live-cost-only' });
  source.periods.today = {
    totalTokens: 0,
    costUsd: 3.25,
    clients: {},
    clientCosts: { codex: 3.25 },
    models: {},
    modelCosts: { gpt: 3.25 }
  };
  source.periods.month = source.periods.today;
  source.periods.allTime = source.periods.today;

  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [source], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T12:00:00.000Z')
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 0);
  assert.equal(result.period.costUsd, 3.25);
  assert.equal(result.period.clients.codex, 0);
  assert.equal(result.period.clientCosts.codex, 3.25);
  assert.equal(result.period.models.gpt, 0);
  assert.equal(result.period.modelCosts.gpt, 3.25);
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

test('offline devices keep their last live snapshot on its producer day', () => {
  const result = ranges.fixedPeriodSnapshotFromDevices('last7', [
    deviceSource({
      deviceId: 'new-york-offline',
      date: '2026-08-11',
      endsAt: '2026-08-12T04:00:00.000Z',
      timeZone: 'America/New_York',
      history: [day('2026-08-11', 80)],
      todayTokens: 100
    })
  ], {
    historyEnabled: true,
    historyAvailable: true,
    now: Date.parse('2026-08-12T16:30:00.000Z')
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.period.totalTokens, 100);
  assert.equal(result.range.end, '2026-08-12');
  assert.equal(result.daily.find((row) => row.date === '2026-08-11').tokens, 100);
  assert.equal(result.daily.find((row) => row.date === '2026-08-12').tokens, 0);
});

test('ready snapshots are reused only for the same fixed selection', () => {
  const snapshot = ranges.fixedPeriodSnapshot('week', {
    historyAvailable: true,
    historyEnabled: true,
    todayKey: '2026-08-12',
    daily: [day('2026-08-12', 10)]
  });

  assert.equal(ranges.readySnapshotForSelection(snapshot, 'week'), snapshot);
  assert.equal(ranges.readySnapshotForSelection(snapshot, 'last30'), null);
});

test('device rows come from the same ready presentation snapshot as the headline', () => {
  const snapshot = {
    status: 'ready',
    selection: 'last7',
    devices: [{
      deviceId: 'mac',
      period: { totalTokens: 70 },
      periods: { today: { totalTokens: 10 } }
    }]
  };

  const [device] = ranges.devicesForReadySnapshot(snapshot, 'last7');
  assert.equal(device.deviceId, 'mac');
  assert.equal(device.periods.today.totalTokens, 10);
  assert.equal(device.periods.last7.totalTokens, 70);
  assert.deepEqual(ranges.devicesForReadySnapshot(snapshot, 'last30'), []);
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

test('latest request coordinator catches up revisions and upgrades a background waiter', async () => {
  let signature = 'revision-a';
  const requests = [];
  const deferred = [];
  const settled = [];
  const coordinator = ranges.createLatestRequestCoordinator({
    signature: () => signature,
    load: ({ signature: requestedSignature }) => {
      requests.push(requestedSignature);
      return new Promise((resolve) => deferred.push(resolve));
    },
    onSettled: (result) => settled.push(result)
  });

  const background = coordinator.request({ renderOnComplete: false });
  signature = 'revision-b';
  const foreground = coordinator.request({ renderOnComplete: true });
  assert.equal(foreground, background);

  deferred.shift()(true);
  await Promise.resolve();
  assert.deepEqual(requests, ['revision-a', 'revision-b']);
  assert.deepEqual(settled, []);

  deferred.shift()(true);
  assert.equal(await foreground, true);
  await Promise.resolve();
  assert.deepEqual(settled, [{ render: true }]);
  assert.equal(coordinator.active(), false);
});
