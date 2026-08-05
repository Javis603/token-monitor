'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hasSummaryPeriod } = require('../../src/shared/archivePeriods');

test('hasSummaryPeriod reads both supported summary shapes without materializing periods', () => {
  const flat = { today: {} };
  const nested = { periods: { month: {} } };

  assert.equal(hasSummaryPeriod(flat, 'today'), true);
  assert.equal(hasSummaryPeriod(flat, 'month'), false);
  assert.equal(hasSummaryPeriod(nested, 'month'), true);
  assert.equal(hasSummaryPeriod(nested, 'allTime'), false);
  assert.deepEqual(flat, { today: {} });
  assert.deepEqual(nested, { periods: { month: {} } });
});
