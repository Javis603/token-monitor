'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isPeriodExpired, periodWindowStatus } = require('../../src/shared/periodWindow');

test('period window status uses the producer window boundary', () => {
  const windows = { today: { endsAt: '2026-08-11T16:00:00.000Z' } };
  assert.equal(periodWindowStatus(windows, 'today', '2026-08-11T15:59:59.000Z'), 'current');
  assert.equal(periodWindowStatus(windows, 'today', '2026-08-11T16:00:00.000Z'), 'expired');
  assert.equal(periodWindowStatus({}, 'today', '2026-08-11T16:00:00.000Z'), 'unknown');
});

test('aggregate expiry retains the legacy UTC fallback outside calendar ranges', () => {
  const record = { updatedAt: '2026-08-11T15:00:00.000Z' };
  assert.equal(isPeriodExpired(record, 'today', '2026-08-11T20:00:00.000Z'), false);
  assert.equal(isPeriodExpired(record, 'today', '2026-08-12T00:00:00.000Z'), true);
  assert.equal(isPeriodExpired(record, 'allTime', '2027-01-01T00:00:00.000Z'), false);
});

test('legacy expiry uses producer time when Hub receipt crosses UTC midnight', () => {
  const record = {
    updatedAt: '2026-08-11T23:59:00.000Z',
    receivedAt: '2026-08-12T00:01:00.000Z'
  };
  assert.equal(isPeriodExpired(record, 'today', '2026-08-12T00:02:00.000Z'), true);
});
