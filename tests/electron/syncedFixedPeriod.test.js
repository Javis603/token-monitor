'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizePeriod } = require('../../src/shared/usage');
const { createFixedRangeReadCache, historyFallbackForDevices, resolveSyncedFixedPeriod } = require('../../src/electron/syncedFixedPeriod');

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

test('a stale device with History usage only outside Week does not hide exact Week details', async () => {
  const a = device('a');
  const b = device('b', '2026-11-24');
  b.periodWindows.today.endsAt = day + 'T00:00:00.000Z';
  b.periods.today.totalTokens = 0;
  const histories = [{
    ...b, historyAvailable: true, history: { daily: [{ date: '2026-11-22', tokens: 120 }] }
  }];
  const result = await resolveSyncedFixedPeriod('week', [a, b], { a: 'rev-a', b: 'rev-b' }, {
    ...options,
    read: id => id === 'a' ? period('a', 20) : null,
    history: devices => historyFallbackForDevices('week', devices, histories, options)
  });
  assert.equal(result.detailsAvailable, true);
  assert.equal(result.period.totalTokens, 20);
  assert.equal(result.period.sessions['claude:a'].totalTokens, 20);
  assert.equal(result.period.projects.shared.tokens, 20);
  assert.deepEqual(result.devices.map(row => [row.deviceId, row.period.totalTokens]), [['a', 20], ['b', 0]]);
});

test('a History-only device with cost but zero tokens still leaves Week details incomplete', async () => {
  const [a, b] = [device('a'), device('b')];
  b.periods.today.totalTokens = 0;
  const histories = [{
    ...b, historyAvailable: true, history: { daily: [{ date: '2026-11-24', tokens: 0, cost: 1 }] }
  }];
  const result = await resolveSyncedFixedPeriod('week', [a, b], { a: 'rev-a' }, {
    ...options,
    read: () => period('a', 20),
    history: devices => historyFallbackForDevices('week', devices, histories, options)
  });
  assert.equal(result.detailsAvailable, false);
  assert.equal(result.period.costUsd, 1);
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

test('overlapping refreshes share a slow remote read and reuse the result', async () => {
  const cache = createFixedRangeReadCache(1);
  let finish;
  let reads = 0;
  const load = () => {
    reads++;
    return new Promise(resolve => { finish = resolve; });
  };
  const first = cache.read('device-and-revision', load);
  const latest = cache.read('device-and-revision', load);
  assert.equal(first, latest);

  await Promise.resolve();
  finish({ totalTokens: 25 });
  assert.deepEqual(await latest, { totalTokens: 25 });
  assert.deepEqual(cache.read('device-and-revision', load), { totalTokens: 25 });
  assert.equal(reads, 1);

  let aborted;
  const stale = cache.read('old-source', signal => {
    aborted = signal;
    return new Promise(resolve => { finish = resolve; });
  });
  await Promise.resolve();
  const queued = cache.read('queued', () => assert.fail('a cleared queued read must not start'));
  cache.clear();
  assert.equal(await queued, null);
  assert.equal(aborted.aborted, true);
  finish({ totalTokens: 30 });
  assert.equal(await stale, null);
  assert.equal(await cache.read('old-source', () => null), null, 'a revoked read cannot repopulate the cache');
});


test('all 17 devices contribute exact ranges when only 16 reads can run at once', async () => {
  const cache = createFixedRangeReadCache();
  const period = normalizePeriod({ totalTokens: 10 });
  const devices = Array.from({ length: 17 }, (_, i) => ({
    deviceId: `device-${i}`,
    periodWindows: { timeZone: 'UTC', today: { key: day, endsAt: '2026-11-26T00:00:00.000Z' } }
  }));
  const revisions = Object.fromEntries(devices.map(device => [device.deviceId, 'rev']));
  const loads = [];
  const result = resolveSyncedFixedPeriod('last7', devices, revisions, {
    now: Date.parse(day + 'T12:00:00Z'),
    history: () => assert.fail('a queued read must not trigger History fallback'),
    read: id => cache.read(id, () => new Promise(resolve => loads.push(resolve)))
  });
  await new Promise(setImmediate);
  assert.equal(loads.length, 16);
  assert.equal(cache.read('device-16', () => assert.fail('queued reads must coalesce')),
    cache.read('device-16', () => assert.fail('queued reads must coalesce')));
  loads[0](period);
  await new Promise(setImmediate);
  assert.equal(loads.length, 17);
  for (const finish of loads.slice(1)) finish(period);
  const snapshot = await result;
  assert.equal(snapshot.period.totalTokens, 170);
  assert.equal(snapshot.devices.length, 17);
  assert.equal(snapshot.detailsAvailable, true);
});

test('paged Month sessions keep accepted totals and retained inline rows', async () => {
  const { resolveSyncedSessionPeriod } = require('../../src/electron/syncedFixedPeriod');
  const device = {
    deviceId: 'device',
    periodWindows: { today: { key: '2026-10-31' }, month: { endsAt: '2026-11-01T00:00:00.000Z' } },
    sessionDetailsOmitted: { month: 1 },
    periods: { month: { totalTokens: 30, sessions: { 'codex:retained': {
      client: 'codex', sessionId: 'retained', totalTokens: 20, title: 'Inline title'
    } } } }
  };
  const result = await resolveSyncedSessionPeriod('month', [device], { device: 'revision' }, {
    now: Date.parse('2026-10-31T12:00:00Z'),
    read: () => ({ totalTokens: 10, sessions: { 'claude:paged': {
      client: 'claude', sessionId: 'paged', totalTokens: 10
    }, 'codex:retained': { client: 'codex', sessionId: 'retained', totalTokens: 20 } } })
  });
  assert.equal(result.period.totalTokens, 30);
  assert.equal(result.period.sessions['codex:retained'].totalTokens, 20);
  assert.equal(result.period.sessions['codex:retained'].title, 'Inline title');
  assert.equal(result.period.sessions['claude:paged'].totalTokens, 10);
  assert.equal(result.detailsAvailable, true);
});
