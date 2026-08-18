'use strict';

// Day-boundary regressions cannot be caught without pinning BOTH the zone and the
// instant: the CI matrix runs UTC, where the local and the UTC calendar day agree,
// and a non-UTC runner only diverges for part of the day. Every case below forces
// the divergence window explicitly, so it fails against the old implementation on
// every runner rather than depending on when it happens to run. The assertions are
// literal day keys, never a key derived from the helper under test — deriving both
// sides from the same function only proves f() === f().
//
// node --test gives this file its own process, and node:test's Date mock is
// restored per test, so neither the zone nor the clock leaks anywhere else.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { localDayKey, mergeHistories, normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { aggregateHistory } = require('../../src/shared/usage');

// 02:00 on the 17th at UTC+8, still the 16th in UTC: the local day sorts PAST a
// UTC-keyed window end and drops out of the daily tier.
const EAST_DIVERGES = '2026-08-16T18:00:00.000Z';
// 18:00 on the 16th at UTC-7, already the 17th in UTC: a UTC-keyed streak walk
// starts on a day that holds no data and reads zero.
const WEST_DIVERGES = '2026-08-17T01:00:00.000Z';

// Next local midnight for each producer, as the collector's computePeriodWindows
// would stamp it. Spelled out rather than derived so the expiry gate is tested
// against real UTC instants instead of whatever the helper would have produced.
const TOKYO_MIDNIGHT = '2026-08-17T15:00:00.000Z'; // 2026-08-18T00:00+09
const LA_MIDNIGHT = '2026-08-17T07:00:00.000Z'; // 2026-08-17T00:00-07

function inZone(t, timeZone, instant, run) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(instant) });
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function historyOf(days) {
  return {
    daily: days.map((d) => ({ date: d.date, tokens: d.tokens, cost: 1, perClient: {}, perModel: {} })),
    monthly: [{
      month: days[0].date.slice(0, 7),
      tokens: days.reduce((sum, d) => sum + d.tokens, 0),
      cost: days.length,
      perClient: {},
      perModel: {}
    }],
    summary: {}
  };
}

function graphOf(days) {
  return {
    contributions: days.map((d) => ({
      date: d.date,
      clients: [{
        client: 'claude',
        modelId: 'opus',
        providerId: 'p',
        tokens: { input: d.tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 1,
        messages: 1
      }]
    }))
  };
}

// Every record shape that reaches the merge carrying no day. They are not spellings of
// each other on the wire — an omitted field means this tick had no History update and
// an explicit null is the disabled/unavailable sentinel — but coerceHistory() flattens
// the rest to the same empty History, which is exactly why a `history` field being
// present cannot stand in for a device having contributed anything.
const NO_CONTRIBUTION = {
  omitted: {},
  disabled: { history: null },
  string: { history: 'oops' },
  array: { history: [] },
  number: { history: 7 },
  empty: { history: {} },
  unavailable: { history: {}, historyAvailable: false }
};

function deviceOf({ deviceId, todayKey, endsAt, days, history = 'present' }) {
  return {
    deviceId,
    receivedAt: '2026-08-16T18:00:00.000Z',
    ...(todayKey ? { periodWindows: { today: { key: todayKey, endsAt } } } : {}),
    ...(history === 'present' ? { history: historyOf(days) } : NO_CONTRIBUTION[history])
  };
}

test('mergeHistories keeps the producer current local day east of UTC', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const merged = mergeHistories([historyOf([
      { date: '2026-08-16', tokens: 5 },
      { date: '2026-08-17', tokens: 10 }
    ])]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
    assert.equal(merged.summary.activeDays, 2);
    assert.equal(merged.summary.currentStreak, 2);
    assert.equal(merged.summary.peakDayTokens, 10);
  });
});

test('mergeHistories does not zero the current streak west of UTC', (t) => {
  inZone(t, 'America/Los_Angeles', WEST_DIVERGES, () => {
    const merged = mergeHistories([historyOf([
      { date: '2026-08-15', tokens: 5 },
      { date: '2026-08-16', tokens: 10 }
    ])]);
    assert.equal(merged.summary.currentStreak, 2);
    assert.equal(merged.daily[merged.daily.length - 1].date, '2026-08-16');
  });
});

test('normalizeHistory caps the daily tier on the local day east of UTC', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const normalized = normalizeHistory(parseGraphResult(graphOf([
      { date: '2026-08-16', tokens: 5 },
      { date: '2026-08-17', tokens: 10 }
    ])));
    assert.deepEqual(normalized.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
    assert.equal(normalized.summary.currentStreak, 2);
  });
});

test('normalizeHistory does not zero the current streak west of UTC', (t) => {
  inZone(t, 'America/Los_Angeles', WEST_DIVERGES, () => {
    const normalized = normalizeHistory(parseGraphResult(graphOf([
      { date: '2026-08-15', tokens: 5 },
      { date: '2026-08-16', tokens: 10 }
    ])));
    assert.equal(normalized.summary.currentStreak, 2);
  });
});

// A Cloudflare Worker isolate always reads UTC, so the Hub's own clock can never
// stand in for the producer's calendar day however it is formatted. These pin the
// Hub side in UTC on purpose: that is the deployment the wall clock cannot fix.
test('aggregateHistory keys the window on the producer day, not the Hub clock', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'tokyo',
      todayKey: '2026-08-17',
      endsAt: TOKYO_MIDNIGHT,
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
    assert.equal(merged.summary.activeDays, 2);
    assert.equal(merged.summary.currentStreak, 2);
  });
});

test('aggregateHistory takes the latest producer day across timezones', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    const merged = aggregateHistory([
      deviceOf({ deviceId: 'tokyo', todayKey: '2026-08-17', endsAt: TOKYO_MIDNIGHT, days: [{ date: '2026-08-17', tokens: 10 }] }),
      deviceOf({ deviceId: 'losangeles', todayKey: '2026-08-16', endsAt: LA_MIDNIGHT, days: [{ date: '2026-08-16', tokens: 5 }] })
    ]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
  });
});

// Only a device that puts contributions into the merge may move the end of it. A
// device reporting a window without a History would otherwise push the boundary past
// the day of every device that did contribute, and zero a streak nothing in the
// aggregate disagrees with. Every no-day shape is covered because they reach this
// function as one thing: 'disabled' is the explicit null a real deployment sends for
// historyEnabled: false, which a hasOwn() gate lets through, and the rest are what
// coerceHistory() returns for a payload that is not a History at all.
test('aggregateHistory ignores the day of a device that contributes no history', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    for (const history of Object.keys(NO_CONTRIBUTION)) {
      const merged = aggregateHistory([
        deviceOf({ deviceId: 'tokyo', todayKey: '2026-08-17', endsAt: TOKYO_MIDNIGHT, history }),
        deviceOf({
          deviceId: 'losangeles',
          todayKey: '2026-08-16',
          endsAt: LA_MIDNIGHT,
          days: [{ date: '2026-08-15', tokens: 5 }, { date: '2026-08-16', tokens: 10 }]
        })
      ]);
      assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-15', '2026-08-16'], `history: ${history}`);
      assert.equal(merged.summary.currentStreak, 2, `history: ${history}`);
    }
  });
});

// The key is untrusted wire input consumed as a lexical maximum, so an impossible
// day would outrank every real one forever — and '2026-99-99' additionally makes
// the window arithmetic build an invalid Date and throw out of the stats read.
test('aggregateHistory ignores an impossible or malformed producer day', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    for (const todayKey of ['2026-99-99', '9999-99-99', '2026-02-31', '2026-08-17junk', '']) {
      const merged = aggregateHistory([deviceOf({
        deviceId: 'bad',
        todayKey: todayKey || undefined,
        endsAt: TOKYO_MIDNIGHT,
        days: [{ date: '2026-08-15', tokens: 5 }, { date: '2026-08-16', tokens: 10 }]
      })]);
      assert.deepEqual(
        merged.daily.map((d) => d.date),
        ['2026-08-15', '2026-08-16'],
        `key ${JSON.stringify(todayKey)} must not move the boundary`
      );
      assert.equal(merged.summary.currentStreak, 2, `key ${JSON.stringify(todayKey)}`);
    }
  });
});

// A device whose own clock is wrong reports a day nothing can reconcile, and one
// lexical maximum is enough to drag the rolling window there — blanking the daily
// tier of every OTHER device, which is a blast radius the aggregate never had while
// it read its own clock. No zone puts a correct clock in 2099; that is skew.
test('aggregateHistory ignores a producer day that no timezone could explain', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const healthy = deviceOf({
      deviceId: 'healthy',
      todayKey: '2026-08-17',
      endsAt: TOKYO_MIDNIGHT,
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    });
    const skewed = deviceOf({
      deviceId: 'skewed',
      todayKey: '2099-01-01',
      endsAt: '2099-01-02T00:00:00.000Z',
      days: [{ date: '2099-01-01', tokens: 1 }]
    });
    const merged = aggregateHistory([healthy, skewed]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
    assert.equal(merged.summary.currentStreak, 2);
  });
});

// The far end of the envelope against a UTC aggregator: one calendar day apart, and
// a real deployment that must keep its vote.
test('aggregateHistory still accepts the furthest real timezone ahead', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'kiritimati',
      todayKey: '2026-08-17',
      endsAt: '2026-08-17T10:00:00.000Z', // 2026-08-18T00:00+14
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
  });
});

// Both ends of the envelope at once, which is where measuring the producer against
// the READER's calendar day breaks: UTC-12 and UTC+14 are 26 hours apart, so at this
// instant two correct clocks name days two apart and the reader would score its own
// end of the range as skew. Rejecting the only producer here does not merely lose a
// day — the fallback window ends before every row it holds, so the daily tier empties
// and the streak reads 0 while the monthly tier still counts the same tokens.
test('aggregateHistory accepts a producer at the opposite end of the zone range', (t) => {
  // 2026-01-01T10:30Z: 2025-12-31 22:30 at UTC-12, 2026-01-02 00:30 at UTC+14.
  inZone(t, 'Etc/GMT+12', '2026-01-01T10:30:00.000Z', () => {
    assert.equal(localDayKey(), '2025-12-31'); // the reader really is two days behind
    const merged = aggregateHistory([deviceOf({
      deviceId: 'kiritimati',
      todayKey: '2026-01-02',
      endsAt: '2026-01-02T10:00:00.000Z', // 2026-01-03T00:00+14
      days: [{ date: '2026-01-01', tokens: 5 }, { date: '2026-01-02', tokens: 10 }]
    })]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-01-01', '2026-01-02']);
    assert.equal(merged.summary.currentStreak, 2);
  });
});

// The envelope is 26 hours wide, so how many calendar days it covers depends on where
// in the UTC day it is read: at 00:30 UTC it reaches only 2026-08-15 (UTC-12) through
// 2026-08-16 (UTC+14), and no correct clock anywhere is on the 17th yet. A device one
// day fast is not exotic enough to look wrong — it is well formed, adjacent, and
// passes the expiry gate because its endsAt is a day ahead too — so nothing else here
// stops it from taking the boundary. When it happens to be idle on its own "today" it
// contributes no row there either, and the streak of every device that is on time
// reads 0. Anchoring ±1 day on the UTC date would admit exactly this producer.
test('aggregateHistory rejects a producer day no zone has reached yet', (t) => {
  inZone(t, 'UTC', '2026-08-16T00:30:00.000Z', () => {
    const onTime = deviceOf({
      deviceId: 'on-time',
      todayKey: '2026-08-16',
      endsAt: '2026-08-17T00:00:00.000Z',
      days: [
        { date: '2026-08-14', tokens: 5 },
        { date: '2026-08-15', tokens: 5 },
        { date: '2026-08-16', tokens: 10 }
      ]
    });
    const fast = deviceOf({
      deviceId: 'fast',
      todayKey: '2026-08-17',
      endsAt: '2026-08-18T00:00:00.000Z',
      days: [{ date: '2026-08-16', tokens: 1 }]
    });
    const merged = aggregateHistory([onTime, fast]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-14', '2026-08-15', '2026-08-16']);
    assert.equal(merged.summary.currentStreak, 3);
  });
});

// A closed window is not silence: it says the device has rolled over to at least the
// day after the one it reported. Dropping the key instead of advancing it lets the
// clock fallback re-select the day the window just declared finished — here a laptop
// at UTC+14 asleep one minute past its own midnight, read by a UTC Worker that is
// still on the 17th. The device's own widget would key on the 18th and show 0; before
// this the Hub kept serving the 17th's live streak for the next fourteen hours.
test('aggregateHistory advances past a producer day its window has closed', (t) => {
  inZone(t, 'UTC', '2026-08-17T10:01:00.000Z', () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'kiritimati',
      todayKey: '2026-08-17',
      endsAt: '2026-08-17T10:00:00.000Z', // 2026-08-18T00:00+14, one minute ago
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })]);
    assert.equal(merged.daily[merged.daily.length - 1].date, '2026-08-17');
    assert.equal(merged.summary.currentStreak, 0);
    assert.equal(merged.summary.activeDays, 2);
  });
});

// The reader's clock never re-enters the choice, not even as one term of a maximum.
// A Hub east of a live producer is the case that first broke: taking the later of the
// two would key the fleet on a day the only device with data has not reached, which is
// the original bug wearing the producer-derived design as a disguise.
test('aggregateHistory keeps a live producer day behind the reader clock', (t) => {
  // 2026-08-17T13:00Z: 2026-08-18 03:00 at UTC+14, still 2026-08-17 01:00 at UTC-12.
  inZone(t, 'Pacific/Kiritimati', '2026-08-17T13:00:00.000Z', () => {
    assert.equal(localDayKey(), '2026-08-18'); // the reader really is a day ahead
    const merged = aggregateHistory([deviceOf({
      deviceId: 'baker',
      todayKey: '2026-08-17',
      endsAt: '2026-08-18T12:00:00.000Z', // 2026-08-18T00:00-12, still open
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })]);
    assert.equal(merged.summary.currentStreak, 2);
  });
});

// A device offline since last year still reports last year's day. Honouring it
// would pin the rolling window there and keep serving a streak that ended with it.
test('aggregateHistory does not freeze the window on a closed producer day', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'dormant',
      todayKey: '2024-01-01',
      endsAt: '2024-01-02T00:00:00.000Z',
      days: [{ date: '2024-01-01', tokens: 10 }]
    })]);
    assert.deepEqual(merged.daily, []);
    assert.equal(merged.summary.currentStreak, 0);
    // The contributions themselves are durable: only the daily tier is a window.
    assert.equal(merged.summary.totalTokens, 10);
  });
});

// The explicit key is deliberately neither the producer's day nor the Hub clock's,
// so this cannot pass by coinciding with whichever one the code actually read.
test('aggregateHistory lets an explicit todayKey override the producers', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'tokyo',
      todayKey: '2026-08-17',
      endsAt: TOKYO_MIDNIGHT,
      days: [
        { date: '2026-08-15', tokens: 3 },
        { date: '2026-08-16', tokens: 5 },
        { date: '2026-08-17', tokens: 10 }
      ]
    })], { todayKey: '2026-08-15' });
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-15']);
  });
});

test('aggregateHistory falls back to the local clock for records without a window', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const merged = aggregateHistory([deviceOf({
      deviceId: 'legacy',
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })]);
    assert.deepEqual(merged.daily.map((d) => d.date), ['2026-08-16', '2026-08-17']);
  });
});

// The Worker serves the same reads from a vendored copy, and it is the deployment
// whose runtime clock can never be right. Drift is already a CI failure; this pins
// the behaviour itself rather than the bytes.
test('the vendored Worker aggregate derives the same boundary', (t) => {
  inZone(t, 'UTC', EAST_DIVERGES, () => {
    const workerUsage = require('../../worker/src/shared/usage');
    const devices = [deviceOf({
      deviceId: 'tokyo',
      todayKey: '2026-08-17',
      endsAt: TOKYO_MIDNIGHT,
      days: [{ date: '2026-08-16', tokens: 5 }, { date: '2026-08-17', tokens: 10 }]
    })];
    assert.deepEqual(workerUsage.aggregateHistory(devices), aggregateHistory(devices));
    assert.deepEqual(
      workerUsage.aggregateHistory(devices).daily.map((d) => d.date),
      ['2026-08-16', '2026-08-17']
    );
  });
});

// The shared twin of the renderer guard in tests/electron/activityDateKey.test.js.
// Key arithmetic on an already-correct key stays UTC-anchored on purpose (that is
// what dayKeyAddDays does); what must never come back is reading the WALL CLOCK in
// UTC and calling the result a calendar day.
test('shared history modules derive today from the local day key, not toISOString', () => {
  const sharedDir = path.join(__dirname, '../../src/shared');
  for (const file of ['history.js', 'usage.js', 'collector.js']) {
    const source = fs.readFileSync(path.join(sharedDir, file), 'utf8');
    assert.ok(
      !/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(source),
      `${file} must derive today from localDayKey(), not new Date().toISOString()`
    );
  }
});

// Asserted on the day they name rather than on function identity, so wrapping either
// side stays legal and only actually disagreeing about the calendar day fails.
test('the collector stamp and the history boundary name the same day', (t) => {
  inZone(t, 'Asia/Shanghai', EAST_DIVERGES, () => {
    const { localTodayKey } = require('../../src/shared/collector');
    assert.equal(localTodayKey(), '2026-08-17');
    assert.equal(localTodayKey(), localDayKey());
  });
});
