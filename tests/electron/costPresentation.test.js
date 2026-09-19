'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { costAvailability, formatCostAvailability } = require('../../src/electron/renderer/costPresentation');

test('known zero remains a displayed known cost', () => {
  assert.equal(costAvailability(0, 0), 'known');
  assert.equal(formatCostAvailability(0, 0, (value) => `$${value}`, { unknown: 'Unknown', partial: 'Partial cost' }), '$0');
});

test('unpriced usage distinguishes partial subtotal from unavailable cost', () => {
  const labels = { unknown: 'Cost unavailable', partial: 'Partial cost' };
  assert.equal(formatCostAvailability(1.25, 10, (value) => `$${value.toFixed(2)}`, labels), '$1.25 · Partial cost');
  assert.equal(formatCostAvailability(0, 10, (value) => `$${value}`, labels), 'Cost unavailable');
});

test('callers can retain compact known and partial amount formatting', () => {
  const compact = (value) => value >= 1000 ? '$1.2K' : `$${value}`;
  const labels = { unknown: 'Cost unavailable', partial: 'Partial cost' };
  assert.equal(formatCostAvailability(1200, 0, compact, labels), '$1.2K');
  assert.equal(formatCostAvailability(1200, 10, compact, labels), '$1.2K · Partial cost');
});
