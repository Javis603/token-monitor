'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { recordWorkbuddyUsage } = require('../../src/shared/providers/workbuddy/usageHistory');
const {
  WORKBUDDY_USAGE_MAX_PAGES,
  fetchWorkbuddyUsageSpend,
  parseRecordTime,
  summarizeUsageRecords,
  usageRequestBody
} = require('../../src/shared/providers/workbuddy/usageRecords');

// A fixed local afternoon keeps every bucket on the intended local day.
const at = (year, month, day, hour = 14) => new Date(year, month - 1, day, hour).getTime();

test('summarizeUsageRecords: every period is the sum of the rows inside it', () => {
  const now = at(2026, 10, 21, 16);
  const rows = [
    { requestTime: at(2026, 10, 21, 9), credit: 115.17 },
    { requestTime: at(2026, 10, 20, 9), credit: 4 },
    // Older than the rolling week but inside the calendar month.
    { requestTime: at(2026, 10, 3, 9), credit: 2 },
    // Previous month: only All time keeps it.
    { requestTime: at(2026, 9, 30, 9), credit: 1.25 }
  ];
  const spend = summarizeUsageRecords(rows, now);
  assert.equal(spend.todaySpend, 115.17);
  assert.equal(spend.weekSpend, 119.17);
  assert.equal(spend.monthSpend, 121.17);
  assert.equal(spend.allTimeSpend, 122.42);
  assert.equal(spend.count, 4);
  assert.equal(spend.todayCount, 1);
});

test('summarizeUsageRecords: rows without a usable timestamp or credit are skipped', () => {
  const now = at(2026, 10, 21);
  const spend = summarizeUsageRecords([
    { requestTime: now - 1_000, credit: 3 },
    { requestTime: 'not a date', credit: 9 },
    { requestTime: now - 2_000 },
    { credit: 5 },
    { requestTime: now - 3_000, credit: -4 },
    null
  ], now);
  assert.equal(spend.todaySpend, 3);
  assert.equal(spend.count, 1);
});

test('summarizeUsageRecords: numeric strings and second-precision epochs both land on the right day', () => {
  const now = at(2026, 10, 21);
  const spend = summarizeUsageRecords([
    { requestTime: String(now - 1_000), credit: '2.5' },
    { RequestTime: Math.floor((now - 2_000) / 1000), Credit: 1.5 },
    { createdAt: '2026-10-21 08:00:00', credit: 0.5 }
  ], now);
  assert.equal(spend.todaySpend, 4.5);
  assert.equal(spend.count, 3);
});

test('summarizeUsageRecords: an empty or absent ledger reads zero everywhere', () => {
  const now = at(2026, 10, 21);
  for (const rows of [[], undefined, null]) {
    const spend = summarizeUsageRecords(rows, now);
    assert.deepEqual(
      [spend.todaySpend, spend.weekSpend, spend.monthSpend, spend.allTimeSpend, spend.count],
      [0, 0, 0, 0, 0]
    );
  }
});

test('usageRequestBody: the window spans the maximum the API accepts', () => {
  const now = at(2026, 10, 21, 16);
  const body = usageRequestBody(now);
  // 31 days back, floored to local midnight: longer windows answer an empty
  // ledger, and a week-sized one collapses Month onto Week.
  assert.equal(body.startTime, '2026-09-20 00:00:00');
  assert.equal(body.endTime, '2026-10-21 16:00:00');
  assert.equal(body.pageNum, 1);
  assert.equal(body.pageSize, 100);
});

test('fetchWorkbuddyUsageSpend: Month keeps rows the week window dropped', async () => {
  const now = at(2026, 10, 21, 16);
  const spend = await fetchWorkbuddyUsageSpend(async () => ({
    data: {
      total: 2,
      data: [
        { requestTime: at(2026, 10, 20, 9), credit: 10 },
        { requestTime: at(2026, 10, 2, 9), credit: 25 }
      ]
    }
  }), now);
  assert.equal(spend.todaySpend, 0);
  assert.equal(spend.weekSpend, 10);
  assert.equal(spend.monthSpend, 35);
  assert.equal(spend.allTimeSpend, 35);
});

test('parseRecordTime: distinguishes seconds from milliseconds and rejects junk', () => {
  assert.equal(parseRecordTime(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseRecordTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseRecordTime(''), null);
  assert.equal(parseRecordTime('nonsense'), null);
  assert.equal(parseRecordTime(undefined), null);
});

test('fetchWorkbuddyUsageSpend: reads every page and reports no truncation', async () => {
  const now = at(2026, 10, 21);
  const pages = [];
  const spend = await fetchWorkbuddyUsageSpend(async (body) => {
    pages.push(body.pageNum);
    if (body.pageNum === 1) {
      return { data: { total: 150, data: Array.from({ length: 100 }, () => ({ requestTime: now - 1_000, credit: 1 })) } };
    }
    return { data: { total: 150, data: Array.from({ length: 50 }, () => ({ requestTime: now - 2_000, credit: 1 })) } };
  }, now);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(spend.todaySpend, 150);
  assert.equal(spend.truncated, false);
});

test('fetchWorkbuddyUsageSpend: a short page ends the scan', async () => {
  const now = at(2026, 10, 21);
  const spend = await fetchWorkbuddyUsageSpend(async () => ({ data: { data: [{ requestTime: now, credit: 2 }] } }), now);
  assert.equal(spend.todaySpend, 2);
  assert.equal(spend.truncated, false);
});

test('fetchWorkbuddyUsageSpend: hitting the page bound reports truncation instead of a silent total', async () => {
  const now = at(2026, 10, 21);
  let calls = 0;
  const spend = await fetchWorkbuddyUsageSpend(async () => {
    calls += 1;
    return { data: { data: Array.from({ length: 100 }, () => ({ requestTime: now - 1_000, credit: 0.5 })) } };
  }, now);
  assert.equal(calls, WORKBUDDY_USAGE_MAX_PAGES);
  assert.equal(spend.truncated, true);
  assert.equal(spend.allTimeSpend, WORKBUDDY_USAGE_MAX_PAGES * 50);
});

test('recordWorkbuddyUsage: publishes Today/Week/Month and no All-time figure', async () => {
  const now = at(2026, 10, 21);
  const tracked = await recordWorkbuddyUsage(async () => ({
    data: { data: [{ requestTime: now - 1_000, credit: 115.17 }] }
  }), now);
  assert.equal(tracked.todaySpend, 115.17);
  assert.equal(tracked.weekSpend, 115.17);
  assert.equal(tracked.monthSpend, 115.17);
  // The API caps a window at 31 days, so a lifetime figure cannot be stated;
  // the field is absent rather than mislabelled, which drops the row entirely.
  assert.equal('allTimeSpend' in tracked, false);
  assert.equal(tracked.monthSinceTracking, false);
  assert.equal(tracked.spendTruncated, undefined);
});

test('recordWorkbuddyUsage: a truncated scan flags the figure', async () => {
  const now = at(2026, 10, 21);
  const tracked = await recordWorkbuddyUsage(async () => ({
    data: { data: Array.from({ length: 100 }, () => ({ requestTime: now - 1_000, credit: 1 })) }
  }), now);
  assert.equal(tracked.spendTruncated, true);
});

test('recordWorkbuddyUsage: an unreadable ledger yields null so the balance still publishes', async () => {
  const now = at(2026, 10, 21);
  assert.equal(await recordWorkbuddyUsage(async () => { throw new Error('HTTP 503'); }, now), null);
  assert.equal(await recordWorkbuddyUsage(async () => { throw Object.assign(new Error('x'), { httpStatus: 401 }); }, now), null);
  assert.equal(await recordWorkbuddyUsage(null, now), null);
  assert.equal(await recordWorkbuddyUsage(async () => ({ data: {} }), Number.NaN), null);
});
