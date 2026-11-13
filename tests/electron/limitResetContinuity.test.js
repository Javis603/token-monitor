'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const limitResetMotionApi = require('../../src/electron/renderer/limits/resetMotion');
const { createLimitResetAnimator } = require('../../src/electron/renderer/limits/resetAnimator');

// The refill driver itself — the surface is a stand-in for both real callers
// (the limits panel and the dock card), which bind the same animator.

function harness({ used = false } = {}) {
  let now = 0;
  let reduced = false;
  let nextHandle = 0;
  const frames = new Map();
  function node() {
    return {
      isConnected: true,
      dataset: {},
      animations: [],
      children: [],
      textContent: '',
      animate(keyframes, options) {
        const animation = { keyframes, options, startTime: null, playState: 'running', cancel() { this.playState = 'idle'; this.oncancel?.(); } };
        this.animations.push(animation);
        return animation;
      },
      getAnimations({ subtree = false } = {}) { return [...this.animations.filter(a => a.playState === 'running'), ...(subtree ? this.children.flatMap(child => child.getAnimations({ subtree: true })) : [])]; },
      append(child) { this.children.push(child); child.parentNode = this; },
      remove() { this.isConnected = false; this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    };
  }
  const panel = { rows: [], querySelectorAll() { return this.rows; } };
  const animator = createLimitResetAnimator({
    document: { createElement: node },
    motion: limitResetMotionApi,
    prefersReducedMotion: () => reduced,
    formatPercent: (value) => `${Math.round(value)}%`,
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextHandle, callback); return nextHandle; },
    cancelAnimationFrame(handle) { frames.delete(handle); }
  });
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
    const snapshot = animator.capture(panel);
    const items = replace(percentages, options);
    animator.animate(panel, snapshot);
    return items;
  }
  function retain(remaining, { used: showUsed = used } = {}) {
    const snapshot = animator.capture(panel);
    const item = panel.rows[0].items[1];
    item.dataset.limitRemainingPercent = String(remaining);
    item.dataset.limitDisplayPercent = String(showUsed ? 100 - remaining : remaining);
    item.value.dataset.limitMotionSuffix = showUsed ? 'used' : 'left';
    item.value.textContent = `${item.dataset.limitDisplayPercent}% ${item.value.dataset.limitMotionSuffix}`;
    animator.animate(panel, snapshot);
    return item;
  }
  replace([77, 0], { resetsAt: '2026-09-30' });
  return { animator, frame, panel, refresh, retain, reduce: () => { reduced = true; } };
}

test('non-reset readings cancel active and queued refills on retained quota nodes', () => {
  for (const started of [false, true]) {
    const h = harness();
    const item = h.refresh()[1];
    if (started) { h.frame(100); h.frame(700); }
    assert.equal(h.retain(20), item);
    h.frame(800); h.frame(2500);
    assert.equal(item.value.textContent, '20% left');
    assert.equal(item.fill.getAnimations({ subtree: true }).length, 0);
    h.retain(20); h.frame(2600);
    assert.equal(item.value.textContent, '20% left', 'an unchanged push cannot revive a superseded target');
  }
});

test('switching display mode cancels the retained quota refill and its old suffix', () => {
  const h = harness();
  const item = h.refresh()[1];
  h.frame(100); h.frame(700);
  h.retain(100, { used: true });
  h.frame(2500);
  assert.equal(item.value.textContent, '0% used');
  assert.equal(item.fill.getAnimations({ subtree: true }).length, 0);
});

test('unchanged retained quota nodes resume one effect on the original timeline', () => {
  const h = harness();
  const item = h.refresh()[1];
  h.frame(100); h.frame(1200);
  h.retain(100);
  assert.equal(item.value.textContent, '90% left');
  const effects = item.fill.getAnimations({ subtree: true });
  assert.equal(effects.length, 2, 'one fill and one completion glow');
  assert.ok(effects.every(effect => effect.startTime === 100));
  h.frame(1700);
  assert.equal(item.value.textContent, '100% left');
});

test('an unchanged push before the first frame starts only the current retained refill', () => {
  const h = harness();
  const item = h.refresh()[1];
  h.retain(100);
  h.frame(100);
  assert.equal(item.fill.getAnimations({ subtree: true }).length, 2);
  h.frame(1700);
  assert.equal(item.value.textContent, '100% left');
});

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
  // The detached generation's count-up was dropped on its first frame — a
  // settle must not be able to reach back and rewrite its text.
  h.animator.settle(h.panel);
  assert.equal(first[1].value.textContent, '90% left');
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
