'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHex, hexToHsv, hsvToHex } = require('../../src/electron/renderer/appearanceColorPicker');

test('only complete six-digit HEX values can be stored by the picker', () => {
  assert.equal(parseHex(' #73BDF5 '), '#73bdf5');
  assert.equal(parseHex('49A3B0'), '#49a3b0');
  for (const value of ['#', '#fff', '#ffabcd0', '#ffabcz', 'red', '##73bdf5']) {
    assert.equal(parseHex(value), null, value);
  }
});

test('the color plane round-trips the palette across hue sectors and achromatic colors', () => {
  for (const color of ['#000000', '#ffffff', '#929292', '#ff0000', '#ffff00', '#00ff00',
    '#00ffff', '#0000ff', '#ff00ff', '#49a3b0', '#b7ead4', '#a366ff']) {
    assert.equal(hsvToHex(hexToHsv(color)), color);
  }
  assert.equal(hsvToHex({ hue: 0, saturation: 1, value: 0 }), '#000000');
  assert.equal(hsvToHex({ hue: 359, saturation: 0, value: 1 }), '#ffffff');
});
