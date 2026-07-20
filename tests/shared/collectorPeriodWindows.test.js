'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computePeriodWindows, collectUsageOnce } = require('../../src/shared/collector');

// endsAt is computed in the device's local time and serialized to UTC, so the
// hub can expire a stale today/month snapshot with a plain nowMs < endsAt check.
// Assertions read back the local components so they hold regardless of the test
// runner's timezone.
test('computePeriodWindows returns next local midnight and next month start', () => {
  const now = new Date(2026, 5, 27, 14, 30, 0); // local 2026-06-27 14:30
  const windows = computePeriodWindows(now);

  assert.equal(windows.today.key, '2026-06-27');
  assert.equal(windows.month.key, '2026-06');

  const todayEnd = new Date(windows.today.endsAt);
  assert.equal(todayEnd.getFullYear(), 2026);
  assert.equal(todayEnd.getMonth(), 5); // still June (boundary is June 28 00:00 local)
  assert.equal(todayEnd.getDate(), 28);
  assert.equal(todayEnd.getHours(), 0);
  assert.equal(todayEnd.getMinutes(), 0);

  const monthEnd = new Date(windows.month.endsAt);
  assert.equal(monthEnd.getMonth(), 6); // July
  assert.equal(monthEnd.getDate(), 1);
  assert.equal(monthEnd.getHours(), 0);
});

test('computePeriodWindows wraps the month boundary at year end', () => {
  const windows = computePeriodWindows(new Date(2026, 11, 31, 23, 0, 0)); // local 2026-12-31 23:00
  assert.equal(windows.today.key, '2026-12-31');
  assert.equal(windows.month.key, '2026-12');

  const todayEnd = new Date(windows.today.endsAt);
  assert.equal(todayEnd.getFullYear(), 2027);
  assert.equal(todayEnd.getMonth(), 0); // January
  assert.equal(todayEnd.getDate(), 1);

  const monthEnd = new Date(windows.month.endsAt);
  assert.equal(monthEnd.getFullYear(), 2027);
  assert.equal(monthEnd.getMonth(), 0);
  assert.equal(monthEnd.getDate(), 1);
});

// A single snapshot must carry a single timestamp: updatedAt and periodWindows
// have to come from the same instant, captured before the today scan, so a
// collection that straddles local midnight cannot stamp a today scan from day N
// with a window that ends on day N+1 (issue #37 follow-up).
test('collectUsageOnce stamps updatedAt and periodWindows from one injected clock', async () => {
  const now = new Date(2026, 0, 15, 12, 0, 0); // local 2026-01-15 12:00
  const summary = await collectUsageOnce({
    clients: '',
    deviceId: 'device-a',
    osInfo: { name: 'macOS', version: '26.0' },
    now,
    historyEnabled: false,
    limitsEnabled: false
  });
  assert.equal(summary.updatedAt, now.toISOString());
  assert.equal(summary.osName, 'macOS');
  assert.equal(summary.osVersion, '26.0');
  assert.deepEqual(summary.periodWindows, computePeriodWindows(now));
});
