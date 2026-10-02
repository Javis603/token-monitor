'use strict';

// The edge dock plays the same quota refill the Limits page does, on both of
// its surfaces: the card's rows through the shared animator itself (see
// commitCard), and the rail's rings through dock.js's own driver, which asks
// resetMotion.js the same question before painting anything. These tests pin
// the driver, the cell projection it reads, and the wiring between them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const limitResetMotionApi = require('../../src/electron/renderer/limits/resetMotion');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');

const root = path.join(__dirname, '../..');
const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
const dockHtml = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/index.html'), 'utf8');
const dockCss = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.css'), 'utf8');
const presentation = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/presentation.js'), 'utf8');

function provider(id, overrides = {}) {
  return {
    provider: id,
    status: 'ok',
    stale: false,
    windows: [
      { kind: 'session', label: '', remainingPercent: 40, resetsAt: '2026-09-17T12:00:00.000Z' },
      { kind: 'weekly', label: 'Weekly', remainingPercent: 70 }
    ],
    ...overrides
  };
}

function providerStats(providers) {
  return {
    periods: { today: { sessions: {} }, month: { sessions: {} } },
    limits: { providers }
  };
}

test('the cell projection carries the headline identity the ring motion keys on', () => {
  const record = provider('claude');
  const [cell] = buildEdgeDockCells(providerStats([record]), { items: [{ type: 'limit', provider: 'claude' }] });
  assert.equal(cell.resetsAt, '2026-09-17T12:00:00.000Z');
  assert.equal(cell.headlineAccount, limitResetMotionApi.providerKey(record));
  assert.equal(
    cell.headlineWindowKey,
    limitResetMotionApi.windowKey('', { kind: 'session', label: '' })
  );
  // A second account's record keys differently — that is what keeps a headline
  // swap from reading as a refill.
  const other = provider('claude', { accountEmail: 'other@example.com' });
  assert.notEqual(limitResetMotionApi.providerKey(other), cell.headlineAccount);
});

// The rail driver is dock.js's own functions, sliced whole so the test runs
// the same code the page runs rather than a restatement of it.
function ringHarness() {
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
        const animation = { keyframes, options, startTime: null, playState: 'running', cancel() {} };
        this.animations.push(animation);
        return animation;
      },
      getAnimations() { return this.animations; },
      append(child) { this.children.push(child); },
      remove() { this.isConnected = false; }
    };
  }
  const rail = {
    cells: [],
    querySelectorAll(selector) {
      if (selector === '.edge-dock-cell[data-ring-motion-key]') {
        return this.cells.filter((cell) => cell.dataset.ringMotionKey !== undefined);
      }
      return [];
    }
  };
  const context = vm.createContext({
    railNode: rail,
    limitResetMotionApi,
    limitResetAnimatorApi: { EASING: 'cubic-bezier(0.333, 0.667, 0.667, 1)', GLOW_MS: 700, GLOW_LEAD_MS: 252 },
    RING_CIRCUMFERENCE: 2 * Math.PI * 19,
    prefersReducedMotion: () => reduced,
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextHandle, callback); return nextHandle; },
    cancelAnimationFrame(handle) { frames.delete(handle); },
    document: { createElement: node },
    root: { getAnimations: () => [] },
    contentLayer: {},
    cardResetAnimator: { settle() {} },
    Math
  });
  const slice = dock.slice(
    dock.indexOf('const ringResetMotions = new WeakMap();'),
    dock.indexOf('const cardResetAnimator = ')
  );
  vm.runInContext(slice, context);

  function cell(remaining, { key = 'provider', resetsAt = '2026-10-01', display } = {}) {
    const cellNode = node();
    const shown = display === undefined ? remaining : display;
    cellNode.dataset = {
      ringMotionKey: key,
      ringRemaining: remaining === null ? '' : String(remaining),
      ringDisplay: shown === null ? '' : String(shown),
      ringResetAt: resetsAt || ''
    };
    cellNode.circle = node();
    cellNode.ring = node();
    cellNode.value = node();
    cellNode.value.textContent = shown === null ? '--' : `${Math.round(shown)}%`;
    cellNode.querySelector = (selector) => (
      selector === '.edge-dock-ring-fill' ? cellNode.circle
        : selector === '.edge-dock-ring' ? cellNode.ring
          : cellNode.value
    );
    return cellNode;
  }
  function refresh(cells) {
    const snapshot = context.captureRingResetMotion();
    for (const old of rail.cells) {
      old.isConnected = old.circle.isConnected = old.ring.isConnected = old.value.isConnected = false;
    }
    rail.cells = cells;
    context.animateRingResets(snapshot);
    return cells;
  }
  function frame(time) {
    now = time;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  }
  return { cell, refresh, frame, context, reduce: () => { reduced = true; } };
}

test('a real reset sweeps the arc, counts the figure up and lands the flare', () => {
  const h = ringHarness();
  h.refresh([h.cell(5, { resetsAt: '2026-09-30T12:00:00.000Z' })]);
  const after = h.refresh([h.cell(100, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  h.frame(100);
  const [arc] = after[0].circle.animations;
  // 95 points of refill pace at the meters' own duration rule: 900 + 95 * 7.
  assert.equal(arc.options.duration, 1565);
  assert.equal(arc.options.easing, 'cubic-bezier(0.333, 0.667, 0.667, 1)');
  assert.equal(arc.keyframes[1].strokeDashoffset, '0px');
  // The flare is timed to land with the sweep, the meter glow's own lead.
  assert.equal(after[0].ring.children[0].animations[0].options.delay, 1313);
  assert.equal(after[0].value.textContent, '5%');
  h.frame(1665);
  assert.equal(after[0].value.textContent, '100%');
});

test('a stats push mid-refill carries the arc, count and flare onto replacement cells', () => {
  const h = ringHarness();
  h.refresh([h.cell(5, { resetsAt: '2026-09-30T12:00:00.000Z' })]);
  h.refresh([h.cell(100, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  h.frame(100);
  h.frame(800);
  const current = h.refresh([h.cell(100, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  // Resumed coverage lands in the refresh task, not on the next frame.
  assert.equal(current[0].circle.animations.length, 1);
  assert.equal(current[0].circle.animations[0].startTime, 100);
  assert.equal(current[0].ring.children[0].animations[0].startTime, 100);
  h.frame(816);
  // (816-100)/1565 ≈ 0.457 → eased ≈ 0.706 → 5 + 95 * 0.706 ≈ 72.
  assert.equal(current[0].value.textContent, '72%');
});

test('a headline that moved to another account or window is never animated as a refill', () => {
  for (const key of ['provider\0other-account\0session', 'provider\0account\0weekly']) {
    const h = ringHarness();
    h.refresh([h.cell(5, { key: 'provider\0account\0session', resetsAt: '2026-09-30T12:00:00.000Z' })]);
    const after = h.refresh([h.cell(100, { key, resetsAt: '2026-10-01T12:00:00.000Z' })]);
    h.frame(100);
    assert.equal(after[0].circle.animations.length, 0);
    assert.equal(after[0].ring.children.length, 0);
  }
});

test('a refill without an advancing reset boundary stays static', () => {
  const h = ringHarness();
  h.refresh([h.cell(5, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  const after = h.refresh([h.cell(100, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  h.frame(100);
  assert.equal(after[0].circle.animations.length, 0);
  // No boundary either snapshot reports is the meter's own allowance — the
  // transition is trusted when nothing can disprove it.
  const unknown = ringHarness();
  unknown.refresh([unknown.cell(5, { resetsAt: '' })]);
  const filled = unknown.refresh([unknown.cell(100, { resetsAt: '' })]);
  unknown.frame(100);
  assert.equal(filled[0].circle.animations.length, 1);
});

test('reduced motion leaves replacement rings static', () => {
  const h = ringHarness();
  h.refresh([h.cell(5, { resetsAt: '2026-09-30T12:00:00.000Z' })]);
  h.reduce();
  const after = h.refresh([h.cell(100, { resetsAt: '2026-10-01T12:00:00.000Z' })]);
  h.frame(100);
  assert.equal(after[0].circle.animations.length, 0);
  assert.equal(after[0].ring.children.length, 0);
  assert.equal(after[0].value.textContent, '100%');
});

test('the renderer wires the ring driver and the shared card animator', () => {
  // The cell wears the motion's comparison fields, keyed on the headline's
  // account and window identities the projection now carries.
  assert.match(dock, /node\.dataset\.ringMotionKey = `\$\{cell\.id\}\\0\$\{cell\.headlineAccount \|\| ''\}\\0\$\{cell\.headlineWindowKey \|\| ''\}`;/);
  assert.match(dock, /node\.dataset\.ringResetAt = cell\.resetsAt \|\| '';/);
  assert.match(dock, /const ringSnapshot = captureRingResetMotion\(\);\s*railNode\.replaceChildren\(\.\.\.nodes\);\s*animateRingResets\(ringSnapshot\);/);
  assert.match(dock, /strokeDashoffset: `\$\{fromOffset\}px`/);
  // The card is the page's animator scoped to the card layer, bound in
  // commitCard around the same replaceChildren the refresh performs.
  assert.match(dock, /cardResetAnimator = limitResetAnimatorApi\.createLimitResetAnimator\(\{[\s\S]*?motion: limitResetMotionApi/);
  assert.match(dock, /const resetSnapshot = cardResetAnimator\.capture\(contentLayer\);\s*contentLayer\.replaceChildren\(card\);[\s\S]*?cardResetAnimator\.animate\(card, resetSnapshot\);/);
  // Reduced motion settles both halves rather than stranding a count-up.
  assert.match(dock, /if \(reduceMotion\) settleDockMotions\(\);/);
  assert.match(dock, /cardResetAnimator\.settle\(contentLayer\);/);
  // The cell projection really supplies the keys the dataset names.
  assert.match(presentation, /headlineAccount: headline \? limitResetMotion\.providerKey\(headline\.record\) : ''/);
  assert.match(presentation, /limitResetMotion\.windowKey\(headlineWindow\.label \|\| '', headlineWindow\)/);
  // The flare is its own rule beside the running halo's.
  assert.match(dockCss, /\.edge-dock-ring-complete\s*\{[^}]*position:\s*absolute;[^}]*opacity:\s*0;/s);
  // Both scripts load ahead of the renderer itself.
  const motionAt = dockHtml.indexOf('<script src="../limits/resetMotion.js"></script>');
  const animatorAt = dockHtml.indexOf('<script src="../limits/resetAnimator.js"></script>');
  const rendererAt = dockHtml.indexOf('<script src="dock.js"></script>');
  assert.ok(motionAt > -1 && motionAt < animatorAt && animatorAt < rendererAt);
});
