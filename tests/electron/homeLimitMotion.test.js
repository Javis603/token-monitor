'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const resetMotion = require('../../src/electron/renderer/limits/resetMotion');
const { planMeterMotion, FILL_MS } = require('../../src/electron/renderer/limits/homeMotion');

const row = (remainingPercent, fill = remainingPercent, extra = {}) => ({
  remainingPercent: String(remainingPercent), fill: String(fill), ...extra
});

test('Home meters drain used quota behind a ghost and grow without one', () => {
  assert.deepEqual(planMeterMotion(row(60), row(52), resetMotion),
    { kind: 'drain', from: 60, to: 52, ghostFrom: 60, duration: FILL_MS });
  // Used mode grows the fill as quota is spent.
  assert.deepEqual(planMeterMotion(row(60, 40), row(52, 48), resetMotion),
    { kind: 'fill', from: 40, to: 48, duration: FILL_MS });
});

test('Home meters restart a mid-flight change from what is on screen', () => {
  const motion = planMeterMotion(row(60, 52, { displayFill: 55, displayGhost: 60 }), row(48), resetMotion);
  assert.equal(motion.from, 55);
  assert.equal(motion.ghostFrom, 60, 'the ghost keeps its place instead of jumping to the fill');
});

test('Home meters refill a real reset at the shared reset pace, never as a drain', () => {
  const previous = row(12, 12, { resetsAt: '2026-10-06T00:00:00Z' });
  const reset = planMeterMotion(previous, row(100, 100, { resetsAt: '2026-10-13T00:00:00Z' }), resetMotion);
  assert.deepEqual(reset, { kind: 'reset', from: 12, to: 100, duration: resetMotion.durationMs(12, 100) });
  // In used mode the fill empties on a reset, still as a refill.
  assert.equal(planMeterMotion(row(12, 88), row(100, 0), resetMotion).kind, 'reset');
  // A refill whose cycle boundary did not advance is a correction, not a reset.
  assert.equal(planMeterMotion(previous, row(100, 100, { resetsAt: '2026-10-06T00:00:00Z' }), resetMotion).kind, 'fill');
});

test('Home meters stay still when nothing changed or the row is unmeasured', () => {
  assert.equal(planMeterMotion(row(60), row(60), resetMotion), null);
  assert.equal(planMeterMotion(row(60, 60, { displayFill: 60.02 }), row(60.04), resetMotion), null);
  assert.equal(planMeterMotion(null, row(60), resetMotion), null);
  assert.equal(planMeterMotion(row(60), { remainingPercent: '60', fill: undefined }, resetMotion), null);
});
