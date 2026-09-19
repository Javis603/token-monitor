'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resizeBounds } = require('../../src/electron/windowResize');

const start = { x: 100, y: 200, width: 340, height: 650 };
const limits = { minWidth: 240, minHeight: 140, maxWidth: 1200, maxHeight: 1400 };

test('resizes from the south-east corner', () => {
  assert.deepEqual(resizeBounds(start, 'se', { x: 60, y: 40 }, limits), {
    x: 100, y: 200, width: 400, height: 690
  });
});

test('keeps the opposite edge fixed when resizing north-west', () => {
  assert.deepEqual(resizeBounds(start, 'nw', { x: 20, y: 30 }, limits), {
    x: 120, y: 230, width: 320, height: 620
  });
});

test('clamps dimensions while preserving the opposite edge', () => {
  assert.deepEqual(resizeBounds(start, 'nw', { x: 500, y: 900 }, limits), {
    x: 200, y: 710, width: 240, height: 140
  });
});

test('rejects unknown edges and invalid pointer deltas', () => {
  assert.equal(resizeBounds(start, 'center', { x: 1, y: 1 }, limits), null);
  assert.equal(resizeBounds(start, 'e', { x: NaN, y: 1 }, limits), null);
});
