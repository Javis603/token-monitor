'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  limitFillPercent,
  limitModeSuffix
} = require('../../src/electron/renderer/limits/displayMode');

test('left mode returns the remaining percent (unchanged behaviour)', () => {
  assert.equal(limitFillPercent(70, 30, false), 70);
});

test('used mode returns the consumed percent (100 - remaining)', () => {
  assert.equal(limitFillPercent(70, 30, true), 30);
  assert.equal(limitFillPercent(88, undefined, true), 12);
});

test('either mode derives from the other field when its primary is missing', () => {
  assert.equal(limitFillPercent(undefined, 40, false), 60);
  assert.equal(limitFillPercent(undefined, 40, true), 40);
});

test('used mode anchors on remainingPercent so every surface agrees', () => {
  // Normalized windows always set usedPercent === 100 - remainingPercent.
  // Deriving from remaining — the field the home card and tray bars also key
  // off — guarantees identical output everywhere even if a stray
  // non-complementary usedPercent were passed.
  assert.equal(limitFillPercent(70, 30, true), 30);
  assert.equal(limitFillPercent(70, 35, true), 30);
});

test('non-finite inputs fall back to 0 in both modes', () => {
  assert.equal(limitFillPercent(undefined, undefined, false), 0);
  assert.equal(limitFillPercent(undefined, undefined, true), 0);
});

test('suffix flips with the mode', () => {
  assert.equal(limitModeSuffix(false), 'left');
  assert.equal(limitModeSuffix(true), 'used');
});
