'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resizedWindowBounds } = require('../../src/electron/windowResize');
const bounds = { x: 100, y: 200, width: 400, height: 600 };
const limits = { minWidth: 240, minHeight: 140, maxWidth: 1200, maxHeight: 1400 };

test('northwest resizing anchors the opposite corner even when minimum limits are reached', () => {
  const next = resizedWindowBounds(bounds, 'nw', { x: 500, y: 500 }, limits);
  assert.deepEqual(next, { x: 260, y: 660, width: 240, height: 140 });
  assert.equal(next.x + next.width, bounds.x + bounds.width);
  assert.equal(next.y + next.height, bounds.y + bounds.height);
});

test('edges resize only their own dimension and corners enforce maximum limits', () => {
  assert.deepEqual(resizedWindowBounds(bounds, 'e', { x: 80, y: 100 }, limits), { ...bounds, width: 480 });
  assert.deepEqual(resizedWindowBounds(bounds, 'se', { x: 2000, y: 2000 }, limits), { ...bounds, width: 1200, height: 1400 });
  assert.equal(resizedWindowBounds(bounds, 'invalid', { x: 0, y: 0 }, limits), null);
});
