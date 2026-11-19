'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { trayBarFillWidth, trayBarsLayout } = require('../../src/electron/renderer/trayBars');

test('trayBarFillWidth leaves empty bars empty at zero percent', () => {
  assert.equal(trayBarFillWidth(0, 30), 0);
  assert.equal(trayBarFillWidth(-12, 30), 0);
});

test('trayBarFillWidth preserves visible positive values and clamps to the track', () => {
  assert.equal(trayBarFillWidth(0.4, 30), 1);
  assert.equal(trayBarFillWidth(50, 30), 15);
  assert.equal(trayBarFillWidth(120, 30), 30);
  assert.equal(trayBarFillWidth(Number.NaN, 30), null);
});

test('trayBarsLayout keeps the original compact menubar proportions', () => {
  assert.deepEqual(trayBarsLayout(36), {
    width: 74,
    height: 36,
    padX: 0,
    iconSize: 36,
    iconY: 0,
    barsX: 41,
    barsWidth: 33,
    barHeight: 9,
    barGap: 5,
    barsStartY: 7,
    radius: 4.5
  });
});

test('trayBarsLayout can fit the canvas to the compact bars only', () => {
  assert.deepEqual(trayBarsLayout(36, { contentOnly: true }), {
    width: 33,
    height: 36,
    padX: 0,
    iconSize: 0,
    iconY: 0,
    barsX: 0,
    barsWidth: 33,
    barHeight: 9,
    barGap: 5,
    barsStartY: 7,
    radius: 4.5
  });
});
