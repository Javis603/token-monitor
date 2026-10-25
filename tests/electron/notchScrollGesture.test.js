'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { swipeDestination } = require('../../src/electron/renderer/notch/scrollGesture');

test('main pages advance one neighbor and stop at both endpoints', () => {
  for (const [page, direction, target] of [[0, -1, 0], [0, 1, 1], [1, -1, 0], [2, 1, 3], [3, 1, 3], [3, -1, 2]]) {
    assert.deepEqual(swipeDestination(page, 4, null, direction), { lane: 'outer', origin: page, target });
  }
});

test('accounts take precedence until the requested edge is already reached', () => {
  const strip = { pageWidth: 120, pageCount: 3, origin: 1 };
  assert.deepEqual(swipeDestination(1, 4, strip, 1), { lane: 'strip', origin: 1, target: 2 });
  assert.deepEqual(swipeDestination(1, 4, strip, -1), { lane: 'strip', origin: 1, target: 0 });
  assert.equal(swipeDestination(1, 4, { ...strip, origin: 2 }, 1).lane, 'outer');
  assert.equal(swipeDestination(1, 4, { ...strip, origin: 0 }, -1).lane, 'outer');
});
