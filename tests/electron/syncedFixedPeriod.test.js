'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizePeriod } = require('../../src/shared/usage');
const { historyFallbackForDevices, resolveSyncedFixedPeriod } = require('../../src/electron/syncedFixedPeriod');

const day = '2026-11-25';
const windows = {
  yesterday: { start: '2026-11-24', end: '2026-11-24' },
  week: { start: '2026-11-23', end: day },
  last7: { start: '2026-11-19', end: day },
  last30: { start: '2026-10-27', end: day }
};
const options = { now: Date.parse(day + 'T10:00:00Z'), locale: 'en-GB' };

function device(name, today = day) {
  const updatedAt = day + 'T09:00:00.000Z';
  return {
    deviceId: name, displayName: name, updatedAt,
    periodWindows: { today: { key: today, endsAt: day + 'T23:59:00.000Z' }, timeZone: 'UTC' },
    periods: { today: { totalTokens: 10 }, allTime: { totalTokens: 120 } }
  };
}

function period(name, tokens) {
  return normalizePeriod({
    totalTokens: tokens,
    clients: { claude: tokens },
    sessions: { ['claude:' + name]: {
      client: 'claude', sessionId: name, totalTokens: tokens,
      projectId: 'project', projectLabel: 'Shared'
    } }
  });
}

test('all four synchronized windows use the same totals for device rows, sessions and projects', async () => {
  for (const [i, [selection, window]] of Object.entries(Object.entries(windows))) {
    const result = await resolveSyncedFixedPeriod(selection, [device('a'), device('b')], { a: 'rev-a', b: 'rev-b' }, {
      ...options,
      read(id, name, range, revision) {
        assert.equal(name, selection);
        assert.equal(revision, 'rev-' + id);
        assert.deepEqual(range, window);
        return period(id, (id === 'a' ? 20 : 50) + Number(i));
      },
      history() { assert.fail('exact coverage needs no History'); }
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.period.totalTokens, 70 + 2 * Number(i));
    assert.equal(result.detailsAvailable, true);
    assert.deepEqual(result.devices.map(row => row.period.totalTokens), [20 + Number(i), 50 + Number(i)]);
    assert.deepEqual(Object.values(result.period.sessions).map(row => row.sourceDevice.deviceId), ['a', 'b']);
    assert.equal(result.period.projects.shared.tokens, result.period.totalTokens);
  }
});

test('a legacy device contributes its own History once and makes detailed views unavailable', async () => {
  const [a, b] = [device('a'), device('b')];
  const result = await resolveSyncedFixedPeriod('yesterday', [a, b], { a: 'rev-a' }, {
    ...options,
    read: () => period('a', 20),
    history(devices) {
      assert.deepEqual(devices, [b]);
      return historyFallbackForDevices('yesterday', devices, [{
        ...b, historyAvailable: true, history: { daily: [{ date: '2026-11-24', tokens: 12 }] }
      }], options);
    }
  });
  assert.equal(result.detailsAvailable, false);
  assert.equal(result.period.totalTokens, 32);
  assert.deepEqual(result.devices.map(row => row.period.totalTokens), [20, 12]);
});

test('each device resolves its own calendar and a shared session ID cannot open a local transcript', async () => {
  const result = await resolveSyncedFixedPeriod('yesterday', [device('a'), device('b', '2026-11-24')], { a: 'a', b: 'b' }, {
    ...options,
    read(id, _name, range) {
      const expected = id === 'a' ? '2026-11-24' : '2026-11-23';
      assert.deepEqual(range, { start: expected, end: expected });
      return period('shared', 10);
    }
  });
  assert.deepEqual(result.range, { start: '2026-11-23', end: '2026-11-24' });
  assert.equal(result.period.totalTokens, 20);
  assert.deepEqual(result.period.sessions['claude:shared'].sourceDevice, { ambiguous: true });
});

test('the captured local scan contributes immediately, even when its upload is throttled', async () => {
  const a = device('a');
  const b = device('b');
  const localDevice = {
    ...a, nativeRangeWindows: windows, nativeRanges: { week: period('a', 35) }
  };
  const result = await resolveSyncedFixedPeriod('week', [a, b], { a: 'old', b: 'remote' }, {
    ...options, locale: 'en-US', weekStartsOn: 1, localDevice,
    read(id, _name, range) {
      assert.equal(id, 'b');
      assert.deepEqual(range, windows.week);
      return period('b', 50);
    },
    history() { assert.fail('matching scan data covers both devices'); }
  });
  assert.equal(result.period.totalTokens, 85);
  assert.deepEqual(result.devices.map(row => row.period.totalTokens), [35, 50]);
  assert.equal(result.period.sessions['claude:a'].sourceDevice.deviceId, 'a');
});

test('an idle legacy device with empty History leaves the exact range and details available', async () => {
  const a = device('a');
  const b = { ...device('b'), periods: {} };
  const result = await resolveSyncedFixedPeriod('yesterday', [a, b], { a: 'rev' }, {
    ...options,
    read: () => period('a', 20),
    history: devices => historyFallbackForDevices('yesterday', devices, [{
      ...b, historyAvailable: true, history: { daily: [] }
    }], options)
  });
  assert.equal(result.period.totalTokens, 20);
  assert.equal(result.detailsAvailable, true);
  assert.deepEqual(result.devices.map(row => row.deviceId), ['a']);
});

test('mismatched History cannot make a missing device contribution look like zero', () => {
  const b = { ...device('b'), historyAvailable: true };
  const fetched = { ...b, updatedAt: day + 'T08:00:00.000Z',
    history: { daily: [{ date: windows.yesterday.start, tokens: 9 }] } };
  assert.equal(historyFallbackForDevices('yesterday', [b], [fetched], options), null);

  const owned = { ...b, history: { daily: [{ date: windows.yesterday.start, tokens: 12 }] } };
  const result = historyFallbackForDevices('yesterday', [owned], [fetched], options);
  assert.equal(result[0].period.totalTokens, 12);
});
