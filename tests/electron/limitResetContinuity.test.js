'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const limitResetMotionApi = require('../../src/electron/renderer/limits/resetMotion');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const source = app.slice(app.indexOf('function animateBarBetween('), app.indexOf('function captureTrendBarMotion('))
  + app.slice(app.indexOf('function captureLimitResetMotion('), app.indexOf('function renderLimits('));

function harness({ used = false } = {}) {
  let now = 0;
  let reduced = false;
  let nextHandle = 0;
  const frames = new Map();
  const numberAnimations = new Map();
  function node() {
    return {
      isConnected: true,
      dataset: {},
      animations: [],
      children: [],
      textContent: '',
      animate(keyframes, options) {
        const animation = { keyframes, options, startTime: null, playState: 'running', cancel() {} };
        this.animations.push(animation);
        return animation;
      },
      getAnimations() { return this.animations; },
      append(child) { this.children.push(child); },
      remove() { this.isConnected = false; }
    };
  }
  const panel = { rows: [], querySelectorAll() { return this.rows; } };
  const context = vm.createContext({
    limitResetMotionApi,
    limitResetMotions: new WeakMap(),
    rowBarAnimations: new Map(),
    limitResetNumberAnimations: numberAnimations,
    els: { limitsPanel: panel },
    performance: { now: () => now },
    prefersReducedMotion: () => reduced,
    formatPercent: (value) => `${Math.round(value)}%`,
    document: { createElement: node },
    requestAnimationFrame(callback) { frames.set(++nextHandle, callback); return nextHandle; },
    LIMIT_RESET_MOTION_EASING: 'cubic-bezier(0.333, 0.667, 0.667, 1)',
    LIMIT_RESET_GLOW_MS: 700,
    LIMIT_RESET_GLOW_LEAD_MS: 252
  });
  vm.runInContext(source, context);
  function replace(percentages, { account = 'account', resetsAt = '2026-10-01' } = {}) {
    for (const row of panel.rows) {
      for (const item of row.items) {
        item.isConnected = item.fill.isConnected = item.value.isConnected = false;
      }
    }
    const row = node();
    row.dataset.limitMotionKey = account;
    row.items = percentages.map((remaining, index) => {
      const item = node();
      item.dataset = {
        limitMotionKey: String(index),
        limitRemainingPercent: String(remaining),
        limitDisplayPercent: String(used ? 100 - remaining : remaining),
        limitResetAt: resetsAt
      };
      item.fill = node();
      item.value = node();
      item.value.dataset.limitMotionSuffix = used ? 'used' : 'left';
      item.querySelector = (selector) => selector === '.limit-meter-fill' ? item.fill : item.value;
      return item;
    });
    row.querySelectorAll = () => row.items;
    panel.rows = [row];
    return row.items;
  }
  function frame(time) {
    now = time;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  }
  function refresh(percentages = [100, 100], options) {
    const snapshot = context.captureLimitResetMotion();
    const items = replace(percentages, options);
    context.animateLimitResets(snapshot);
    return items;
  }
  replace([77, 0], { resetsAt: '2026-09-30' });
  return { context, frame, refresh, numberAnimations, reduce: () => { reduced = true; } };
}

test('a mid-refill stats refresh keeps the original bar, counter and glow timeline', () => {
  const h = harness();
  const first = h.refresh();
  h.frame(100);
  h.frame(1200);
  const replacements = h.refresh();
  // Replacement nodes must already be covered in the refresh task, before RAF.
  assert.equal(replacements[1].fill.animations.length, 1);
  assert.equal(replacements[1].fill.animations[0].startTime, 100);
  assert.equal(replacements[1].value.textContent, '90% left');
  h.frame(1216);

  for (const item of replacements) {
    assert.equal(item.fill.animations[0].startTime, 100);
    assert.equal(item.fill.animations[0].options.duration, 1600);
    assert.equal(item.fill.children[0].animations[0].startTime, 100);
    assert.equal(item.fill.children[0].animations[0].options.delay, 1348);
  }
  assert.equal(replacements[1].value.textContent, '91% left');
  assert.equal(h.numberAnimations.has(first[1].value), false);
  h.frame(1700);
  assert.equal(replacements[1].value.textContent, '100% left');
});

test('refreshes during the completion glow preserve it without replaying after it ends', () => {
  const h = harness();
  h.refresh();
  h.frame(100);
  h.frame(1850);
  const duringGlow = h.refresh();
  h.frame(1866);
  assert.equal(duringGlow[1].fill.children[0].animations[0].startTime, 100);
  assert.equal(duringGlow[1].value.textContent, '100% left');
  h.frame(2150);
  const afterGlow = h.refresh();
  h.frame(2166);
  assert.equal(afterGlow[1].fill.animations.length, 0);
  assert.equal(afterGlow[1].fill.children.length, 0);
});

test('replacement before the first paint keeps the batch synchronized', () => {
  const h = harness();
  const detached = h.refresh();
  const current = h.refresh();
  h.frame(100);
  assert.equal(detached[1].fill.animations.length, 0);
  assert.equal(current[0].fill.animations[0].startTime, 100);
  assert.equal(current[1].fill.animations[0].startTime, 100);
  assert.equal(current[0].fill.animations[0].options.duration, 1600);
});

test('active motion never carries over to another account, changed quota or reset cycle', () => {
  for (const [percentages, options] of [
    [[100, 100], { account: 'another-account' }],
    [[95, 95], {}],
    [[100, 100], { resetsAt: '2026-10-02' }]
  ]) {
    const h = harness();
    h.refresh();
    h.frame(100);
    h.frame(700);
    const current = h.refresh(percentages, options);
    h.frame(716);
    assert.equal(current[1].fill.animations.length, 0);
  }
});

test('used mode resumes its drain toward zero and reduced motion leaves replacements static', () => {
  const h = harness({ used: true });
  h.refresh();
  h.frame(100);
  h.frame(1200);
  const current = h.refresh();
  h.frame(1216);
  assert.equal(current[1].value.textContent, '9% used');
  assert.equal(current[1].fill.animations[0].keyframes[1].transform, 'scaleX(0)');
  h.reduce();
  const staticItems = h.refresh();
  h.frame(1232);
  assert.equal(staticItems[1].fill.animations.length, 0);
});
