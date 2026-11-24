'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const resetMotion = require('../../src/electron/renderer/limits/resetMotion');
const { createHomeLimitMotion, planMeterMotion, FILL_MS } = require('../../src/electron/renderer/limits/homeMotion');

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

function motionScope({ value = null, track = null } = {}) {
  const item = {
    dataset: { limitMotionKey: 'row', limitRemainingPercent: track?.dataset.limitFill ?? '', limitResetAt: '' },
    querySelector: (selector) => (selector === '.home-limit-track' ? track : selector === '[data-limit-motion-value]' ? value : null)
  };
  return { ownerDocument: { timeline: { currentTime: 1000 } }, querySelectorAll: () => [item] };
}

function countMotion(begun) {
  return createHomeLimitMotion({
    motion: resetMotion,
    numberMode: () => 'count',
    formatPercent: (value) => `${Math.round(value)}%`,
    numbers: {
      duration: 0,
      currentCountValue: (el) => el.counting,
      beginCount: (el, from, to) => { begun.push([from, to]); return () => {}; }
    }
  });
}

test('Home hands a count still in flight over to a reading it already rounds to', () => {
  const begun = [];
  const value = { dataset: { limitMotionText: '61%', limitMotionValue: '61' }, counting: 60.6 };
  countMotion(begun).animate(motionScope({ value }), new Map([['row', { text: '80%', percent: 60.6 }]]));
  assert.deepEqual(begun, [[60.6, 61]], 'left running, the old count would finish on its own target');
  // With no count in flight, a reading that rounds the same stays put.
  const idle = [];
  countMotion(idle).animate(motionScope({ value: { ...value, counting: undefined } }), new Map([['row', { text: '61%', percent: 61 }]]));
  assert.deepEqual(idle, []);
});

test('Home stops a meter animation whose target moved without motion of its own', () => {
  const track = (fill) => {
    const animation = { cancelled: false, cancel() { this.cancelled = true; } };
    return { animation, dataset: { limitFill: fill }, getAnimations: () => [animation], querySelector: () => null };
  };
  const motion = countMotion([]);
  // An entry growth toward 80% is cut short by a refresh to 0% while it still reads 0.
  const moved = track('0');
  motion.animate(motionScope({ track: moved }), new Map([['row', { fill: '80', displayFill: 0, motion: null }]]));
  assert.equal(moved.animation.cancelled, true, 'the meter must not keep growing toward the old target');
  // An unchanged target leaves a running animation alone.
  const same = track('80');
  motion.animate(motionScope({ track: same }), new Map([['row', { fill: '80', displayFill: 80, motion: null }]]));
  assert.equal(same.animation.cancelled, false);
});

test('Home never replays a meter motion whose target a refresh already replaced', () => {
  const node = () => ({ animate: () => ({}) });
  const parts = { '.home-limit-ghost': node(), '.home-limit-fill': node(), '.home-limit-tip': node() };
  const track = {
    dataset: { limitFill: '40' }, isConnected: false, running: [],
    getAnimations() { return this.running; },
    animate() { const animation = { cancel() {} }; this.running.push(animation); return animation; },
    querySelector: (selector) => parts[selector] || null
  };
  const scope = motionScope({ track });
  const motion = countMotion([]);
  // A drain from 80% toward 40% starts and is recorded for replay.
  motion.animate(scope, new Map([['row', { fill: '80', displayFill: 80, motion: null }]]));
  assert.equal(motion.capture(scope).get('row').motion.kind, 'drain');
  // A refresh lands on 60%, right where the meter stands: no motion of its own.
  track.dataset.limitFill = '60';
  motion.animate(scope, new Map([['row', { fill: '40', displayFill: 60, motion: motion.capture(scope).get('row').motion }]]));
  assert.equal(motion.capture(scope).get('row').motion, undefined, 'a later refresh would replay the superseded drain');
});
