'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const policy = require('../../src/electron/renderer/breakdownRenderPolicy');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function harness(count = 100) {
  let reduced = false;
  let offset = 0;
  let fillReads = 0;
  let captures = 0;
  const motions = new Map();
  const calls = [];
  const bars = [];
  const layouts = [];
  const rows = Array.from({ length: count }, (_, index) => {
    const value = { dataset: { motionValue: String(1000 + index) }, textContent: String(1000 + index),
      getBoundingClientRect: () => ({ top: index * 20 - offset, bottom: index * 20 + 15 - offset, left: 250, right: 290 }) };
    const fill = { scale: index % 2 ? 0.5 : 1,
      style: { getPropertyValue: () => String(fill.scale) },
      parentElement: { getBoundingClientRect: () => ({ width: 100 }) },
      getBoundingClientRect: () => ({ width: 100 * fill.scale }) };
    return { dataset: { key: `session:${index}`, motionValue: String(1000 + index) },
      getBoundingClientRect: value.getBoundingClientRect,
      animate(frames) {
        if (rows.length > 40) assert.fail('large lists must not animate row layout');
        layouts.push(frames);
      },
      querySelector(selector) {
        if (selector === '.row-value') return value;
        fillReads += 1;
        return selector === '.bar-fill' ? fill : null;
      }
    };
  });
  const context = {
    ...policy, Map, Set,
    state: { breakdown: 'session', settings: { tokenNumberAnimation: 'roll' } },
    els: { breakdown: { querySelectorAll: () => rows,
      getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 300 }) } },
    prefersReducedMotion: () => reduced,
    tokenNumberAnimationApi: { normalize: value => value === 'count' ? 'count' : 'roll', capture: () => { captures += 1; return null; } },
    rowNumberAnimations: motions,
    breakdownNumberMotionVisibleOnly: false,
    animateRowNumber(el, from, to, duration, snapshot, options) {
      calls.push({ el, from, to, options });
      motions.set(el, { target: to });
    },
    cancelRowNumberAnimation(el) { motions.delete(el); delete el.dataset.motionTarget; },
    formatNumber: value => String(value),
    animateBarBetween(fill, from, to) {
      if (rows.length > 40) assert.fail('large lists must not animate bars');
      bars.push({ fill, from, to });
    }
  };
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  vm.runInNewContext([
    section('function captureBreakdownMotion()', 'function animateRowNumber('),
    section('function settleOffscreenBreakdownNumbers()', '// A period switch'),
    section('function animateBreakdownFrom(', 'function periodBreakdownMotionDuration('),
    'this.api = { captureBreakdownMotion, animateBreakdownFrom, settleOffscreenBreakdownNumbers };'
  ].join('\n'), context);
  return { ...context.api, state: context.state, rows, calls, motions, bars, layouts,
    reduce(value) { reduced = value; }, scroll(value) { offset = value; },
    metrics: () => ({ fillReads, captures }) };
}

test('100-session period switches roll visible numbers without bar or row-layout work', () => {
  const h = harness();
  const snapshot = h.captureBreakdownMotion();
  assert.equal(snapshot.size, 100, 'old values must survive for every key');
  assert.deepEqual(h.metrics(), { fillReads: 0, captures: 5 });
  for (const row of h.rows) row.dataset.motionValue = String(Number(row.dataset.motionValue) + 10_000);
  h.animateBreakdownFrom(snapshot, { synchronized: true });
  assert.equal(h.calls.length, 5);
  assert.deepEqual(h.calls.map(call => [call.from, call.to]), Array.from({ length: 5 }, (_, i) => [1000 + i, 11000 + i]));
  assert.ok(h.calls.every(call => call.options.synchronized));
  assert.equal(h.metrics().fillReads, 0);
});

test('a previously offscreen session rolls from its own old value after reordering', () => {
  const h = harness();
  const snapshot = h.captureBreakdownMotion();
  h.scroll(1000);
  for (const row of h.rows) row.dataset.motionValue = String(Number(row.dataset.motionValue) + 123);
  h.animateBreakdownFrom(snapshot);
  assert.deepEqual(h.calls.map(call => [call.from, call.to]), Array.from({ length: 5 }, (_, i) => [1050 + i, 1173 + i]));
});

test('scrolling settles offscreen rolls and a new update keeps active work bounded', () => {
  const h = harness();
  const start = h.captureBreakdownMotion();
  for (const row of h.rows) row.dataset.motionValue = String(Number(row.dataset.motionValue) + 1);
  h.animateBreakdownFrom(start);
  assert.equal(h.motions.size, 5);
  h.scroll(1000);
  h.settleOffscreenBreakdownNumbers();
  assert.equal(h.motions.size, 0);
  const next = h.captureBreakdownMotion();
  for (const row of h.rows) row.dataset.motionValue = String(Number(row.dataset.motionValue) + 1);
  h.animateBreakdownFrom(next);
  assert.equal(h.motions.size, 5);
  h.scroll(1500);
  const last = h.captureBreakdownMotion();
  for (const row of h.rows) row.dataset.motionValue = String(Number(row.dataset.motionValue) + 1);
  h.animateBreakdownFrom(last);
  assert.equal(h.motions.size, 5, 'old offscreen motions must be settled before adding new ones');
});

test('unavailable token data stays a label and reduced motion skips capture entirely', () => {
  const h = harness();
  const row = h.rows[0];
  row.dataset.tokenDataUnavailable = 'true';
  row.querySelector('.row-value').textContent = 'Unavailable';
  const snapshot = h.captureBreakdownMotion();
  for (const current of h.rows) current.dataset.motionValue = String(Number(current.dataset.motionValue) + 1);
  h.animateBreakdownFrom(snapshot);
  assert.equal(h.calls.length, 4);
  assert.equal(row.querySelector('.row-value').textContent, 'Unavailable');
  h.reduce(true);
  assert.equal(h.captureBreakdownMotion(), null);
  h.animateBreakdownFrom(new Map());
  assert.equal(h.calls.length, 4);
});

test('compact roll lists skip offscreen and unchanged readings while preserving active targets', () => {
  const h = harness(40);
  const snapshot = h.captureBreakdownMotion();
  assert.equal(h.metrics().captures, 5);
  for (const index of [1, 8]) h.rows[index].dataset.motionValue = String(20_000 + index);
  h.animateBreakdownFrom(snapshot);
  assert.deepEqual(h.calls.map(call => call.to), [20_001]);
  h.animateBreakdownFrom(h.captureBreakdownMotion());
  assert.equal(h.calls.length, 2, 'an existing target is handed to the number animator without being lost');
  h.scroll(1000);
  h.settleOffscreenBreakdownNumbers();
  assert.equal(h.motions.size, 0);
});

test('compact count lists keep their existing offscreen capture and animation policy', () => {
  const h = harness(40);
  h.state.settings.tokenNumberAnimation = 'count';
  const snapshot = h.captureBreakdownMotion();
  assert.equal(h.metrics().captures, 40);
  h.rows[8].dataset.motionValue = '20008';
  h.animateBreakdownFrom(snapshot);
  assert.equal(h.calls.length, 40);
  assert.equal(h.calls[8].to, 20_008);
});

for (const mode of ['roll', 'count']) {
  test(`41-to-40 ${mode} session lists skip uncaptured layout and bars but keep changed number motion`, () => {
    const h = harness(41);
    h.state.settings.tokenNumberAnimation = mode;
    const snapshot = h.captureBreakdownMotion();
    assert.equal(snapshot.get('session:0').top, undefined);
    assert.equal(h.metrics().fillReads, 0);
    h.rows.pop();
    h.animateBreakdownFrom(snapshot, { synchronized: true });
    assert.equal(h.bars.length, 0, 'unchanged bars must not restart from an invented zero');
    assert.equal(h.layouts.length, 0, 'uncaptured positions must not trigger FLIP');
    h.calls.length = 0;
    h.motions.clear();
    h.rows[0].dataset.motionValue = '2000';
    h.animateBreakdownFrom(snapshot, { synchronized: true });
    assert.ok(h.calls.some(call => call.from === 1000 && call.to === 2000 && call.options.synchronized));
    assert.equal(h.bars.length, 0);
    assert.equal(h.layouts.length, 0);
  });
}

test('captured zero-width bars still animate to a nonzero scale in compact lists', () => {
  const h = harness(40);
  const fill = h.rows[0].querySelector('.bar-fill');
  fill.scale = 0;
  const snapshot = h.captureBreakdownMotion();
  assert.equal(snapshot.get('session:0').barScale, 0);
  fill.scale = 0.5;
  h.animateBreakdownFrom(snapshot);
  assert.ok(h.bars.some(bar => bar.fill === fill && bar.from === 0 && bar.to === 0.5));
});
