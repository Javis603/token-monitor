'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { macVibrancyMaterial } = require('../../src/electron/macVibrancy');

test('uses system-managed vibrancy on Liquid Glass macOS releases', () => {
  assert.equal(macVibrancyMaterial('darwin', '25.0.0'), 'under-window');
  assert.equal(macVibrancyMaterial('darwin', '26.0.0'), 'under-window');
});

test('keeps the legacy HUD material on older macOS releases', () => {
  assert.equal(macVibrancyMaterial('darwin', '24.6.0'), 'hud');
  assert.equal(macVibrancyMaterial('darwin', 'unknown'), 'hud');
});

test('does not select a macOS material on other platforms', () => {
  assert.equal(macVibrancyMaterial('win32', '10.0.0'), null);
  assert.equal(macVibrancyMaterial('linux', '6.8.0'), null);
});
