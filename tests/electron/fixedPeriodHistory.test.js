'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fixedPeriodHistoryMeta } = require('../../src/electron/fixedPeriodHistory');

test('fixed period metadata reports transport availability without claiming device completeness', () => {
  assert.deepEqual(fixedPeriodHistoryMeta({
    source: 'local',
  }), {
    source: 'local',
    historyTransportAvailable: true
  });
  assert.equal(fixedPeriodHistoryMeta({ source: 'embedded' }).historyTransportAvailable, true);
  assert.equal(fixedPeriodHistoryMeta({ source: 'remote' }).historyTransportAvailable, true);
});

test('fixed period metadata reports an unavailable transport when History is disabled', () => {
  assert.equal(fixedPeriodHistoryMeta({ source: 'empty' }).historyTransportAvailable, false);
});
