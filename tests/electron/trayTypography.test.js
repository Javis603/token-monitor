'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const typography = require('../../src/electron/renderer/trayTypography');

test('shared typography preserves tray font weights, width factors and space sizes', () => {
  assert.match(typography.font({}, 12, 500), /^500 12px -apple-system/);
  assert.match(typography.font({ fontStyle: 'menubar' }, 12, 500), /^700 12px/);
  assert.match(typography.font({ fontStyle: 'compactMono' }, 9, 500), /^600 9px ui-monospace/);
  assert.equal(typography.horizontalScale({ fontStyle: 'condensed' }), 0.86);
  assert.equal(typography.horizontalScale({ fontStyle: 'menubar' }), 0.92);
  assert.deepEqual([20, 44].map(height => typography.iconGap(height)), [2, 4]);
  assert.equal(typography.spaceScale({ fontStyle: 'compactMono' }), 0.55);
  assert.deepEqual(['narrow', 'regular', 'wide'].map(size => typography.spacerWidth({ size }, 20)), [2, 3, 5]);
  assert.deepEqual(['narrow', 'regular', 'wide'].map(size => typography.spacerWidth({ size, variant: 'dot' }, 44)), [8, 11, 15]);
});
