'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '../../src/electron/renderer', file), 'utf8');
}
function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf('\n}', start + 1) + 2;
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
}

test('Home holds its hovered title and flushes the latest stats on leave', () => {
  const app = source('app.js');
  let hovered = true;
  let callbacks;
  const frames = [];
  const painted = [];
  const state = { breakdown: 'home', stats: { revision: 1 } };
  const context = {
    state, prefersReducedMotion: () => false, visibleStatsSurface: () => 'main',
    requestAnimationFrame: callback => frames.push(callback),
    document: { querySelector: () => hovered ? {} : null, createElement: () => ({ append() {}, addEventListener() {} }) },
    window: { TokenMonitorOverflowText: { create: options => { callbacks = options; } } },
    els: { homePanel: { replaceChildren() { painted.push(state.stats.revision); } } },
    hideHomeActivityTooltip() {}, homeModuleIds: () => [], t: key => key, openHomeSettings() {}
  };
  const setup = app.slice(app.indexOf('const overflowText ='), app.indexOf('function bindHoverMarquee('));
  vm.runInNewContext(`${setup}\n${functionSource(app, 'sessionTooltipShouldHoldRender')}\n${functionSource(app, 'renderHome')}\nglobalThis.repaint = renderHome;`, context);
  state.stats = { revision: 2 };
  context.repaint();
  state.stats = { revision: 3 };
  context.repaint();
  assert.deepEqual(painted, []);
  hovered = false;
  callbacks.onLeave();
  frames.shift()();
  assert.deepEqual(painted, [3], 'leaving paints the most recent update, rather than losing deferred stats');
});

test('Edge Dock holds its hovered title and flushes the latest payload on leave', () => {
  const dock = source('edgeDock/dock.js');
  let hovered = true;
  let callbacks;
  const frames = [];
  const painted = [];
  const context = {
    state: { payload: null }, surface: 'bubble', limitTooltip: { active: false, pending: false },
    document: {}, window: { TokenMonitorOverflowText: { create: options => { callbacks = options; } } },
    prefersReducedMotion: () => false, requestAnimationFrame: callback => frames.push(callback),
    contentLayer: { querySelector: () => hovered ? {} : null },
    codexAccountControl: { deferRender: () => false },
    applyAppearance() {}, updateShape() {}, scheduleSelfRepaint() {},
    renderBubble: payload => painted.push(payload.cell.revision)
  };
  const setup = dock.slice(dock.indexOf('const overflowText ='), dock.indexOf('const SESSION_STATE_GLYPHS'));
  vm.runInNewContext(`${setup}\n${functionSource(dock, 'limitTooltipShouldHoldRender')}\n${functionSource(dock, 'deferBubbleRender')}\n${functionSource(dock, 'render')}\nglobalThis.repaint = render;`, context);
  context.repaint({ surface: 'bubble', cell: { revision: 1 } });
  context.repaint({ surface: 'bubble', cell: { revision: 2 } });
  assert.deepEqual(painted, []);
  assert.equal(context.limitTooltip.pending, true);
  hovered = false;
  callbacks.onLeave();
  frames.shift()();
  assert.deepEqual(painted, [2]);
  assert.equal(context.limitTooltip.pending, false);
  context.repaint({ surface: 'bubble', cell: { revision: 3 } });
  assert.deepEqual(painted, [2, 3], 'normal repaint resumes after leaving');
});
