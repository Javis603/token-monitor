'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildOfficialSeries } = require('../../src/shared/providers/workbuddy/historySeries');
const { localDayKey } = require('../../src/shared/providers/workbuddy/balanceAnchors');

const now = new Date(2026, 10, 10, 15).getTime();
const day = offset => localDayKey(now - offset * 86_400_000);

test('anchored days are exact and gaps are filled from official daily spend', () => {
  const anchors = { [day(3)]: { remaining: 1000 }, [day(0)]: { remaining: 700 } };
  const dailySpend = { [day(2)]: 100, [day(1)]: 120, [day(0)]: 80 };
  const series = buildOfficialSeries({ anchors, dailySpend, currentRemaining: 700, now });
  assert.equal(series.points.length, 14);
  const byDay = Object.fromEntries(series.points.map(point => [point.day, point]));
  assert.equal(byDay[day(3)].kind, 'exact');
  assert.equal(byDay[day(3)].balance, 1000);
  assert.equal(byDay[day(0)].kind, 'exact');
  assert.equal(byDay[day(0)].balance, 700);
  // 700 + 80 (today) + 120 (yesterday) = 900 at the end of day -2.
  assert.equal(byDay[day(2)].kind, 'inferred');
  assert.equal(byDay[day(2)].balance, 900);
  assert.equal(byDay[day(1)].balance, 780);
  assert.equal(series.unattributed, 0);
  assert.equal(series.inferredDays, 12);
});

test('a grant or expiry inside a gap is reported, not silently smoothed away', () => {
  const anchors = { [day(3)]: { remaining: 1000 }, [day(0)]: { remaining: 1500 } };
  const dailySpend = { [day(2)]: 100, [day(1)]: 100, [day(0)]: 100 };
  const series = buildOfficialSeries({ anchors, dailySpend, currentRemaining: 1500, now });
  const byDay = Object.fromEntries(series.points.map(point => [point.day, point]));
  assert.equal(byDay[day(2)].uncertain, true);
  assert.equal(byDay[day(1)].uncertain, true);
  // 1000 - 1500 - 300 = -800 => a grant of 800 is unattributed.
  assert.equal(series.unattributed, 800);
});

test('without historical anchors every earlier day is inferred from the live balance', () => {
  const dailySpend = { [day(1)]: 50, [day(0)]: 25 };
  const series = buildOfficialSeries({ anchors: {}, dailySpend, currentRemaining: 500, now });
  const byDay = Object.fromEntries(series.points.map(point => [point.day, point]));
  assert.equal(byDay[day(0)].kind, 'exact');
  assert.equal(byDay[day(1)].balance, 525);
  assert.equal(byDay[day(2)].balance, 575);
  assert.equal(series.unattributed, 0);
  assert.equal(series.inferredDays, 13);
});

test('all points carry absolute Credits, local-day keys and usable timestamps', () => {
  const series = buildOfficialSeries({ anchors: {}, dailySpend: {}, currentRemaining: 6265.81, now });
  for (const point of series.points) {
    assert.match(point.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof point.balance, 'number');
    assert.ok(point.balance >= 0);
    assert.ok(Number.isFinite(point.at));
  }
  assert.equal(series.points.at(-1).balance, 6265.81);
});

test('unusable inputs yield null rather than a fabricated curve', () => {
  assert.equal(buildOfficialSeries({ currentRemaining: null, now }), null);
  assert.equal(buildOfficialSeries({ currentRemaining: 10, now: Number.NaN }), null);
  assert.equal(buildOfficialSeries({ currentRemaining: -1, now }), null);
  assert.equal(buildOfficialSeries(), null);
});
