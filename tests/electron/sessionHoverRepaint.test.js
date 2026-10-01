'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const overflowTextApi = require('../../src/electron/renderer/overflowText');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '../../src/electron/renderer', file), 'utf8');
}
function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf('\n}', start + 1) + 2;
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
}

test('Home holds a real overflowing title and only flushes deferred stats on leave', () => {
  const app = source('app.js');
  const classes = new Set();
  const title = {
    children: [{ textContent: 'Long session title' }], style: {}, scrollLeft: 0, clientWidth: 100,
    get childNodes() { return this.children; },
    get textContent() { return this.children.map(child => child.textContent).join(''); },
    append(...children) { this.children = children; },
    closest: selector => selector === '.session-mode, .home-session-row' ? {} : null,
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
    },
    addEventListener(type, handler) { this[type] = handler; }
  };
  const document = {
    querySelector: selector => selector.split(', ').some(part => part === '.home-session-row .is-hover-reading')
      && classes.has('is-hover-reading') ? title : null,
    querySelectorAll: () => [title],
    createElement: () => ({
      style: {}, children: [],
      get textContent() { return this.children.map(child => child.textContent).join(''); },
      append(...children) { this.children = children; },
      getBoundingClientRect: () => ({ width: 200 })
    })
  };
  const frames = [];
  const painted = [];
  const state = { breakdown: 'home', stats: { revision: 1 } };
  const context = {
    state, prefersReducedMotion: () => false, visibleStatsSurface: () => 'main',
    requestAnimationFrame: callback => frames.push(callback),
    document,
    window: {
      TokenMonitorOverflowText: overflowTextApi, addEventListener() {},
      requestAnimationFrame: callback => frames.push(callback),
      setTimeout: () => 1, clearTimeout() {}
    },
    els: { homePanel: {
      replaceChildren(module) { painted.push(module.revision); }, querySelector: () => null
    } },
    hideHomeActivityTooltip() {}, homeModuleIds: () => ['session'],
    renderHomeSessionModule: () => ({ revision: state.stats.revision }), scheduleHomeSessionRepaint() {}
  };
  const setup = app.slice(app.indexOf('const overflowText ='), app.indexOf('function bindHoverMarquee('));
  vm.runInNewContext(`let homeSessionRenderPending = false;\n${setup}\n${functionSource(app, 'sessionTooltipShouldHoldRender')}\n${functionSource(app, 'renderHome')}\nglobalThis.repaint = renderHome; globalThis.bind = overflowText.bind;`, context);
  context.bind(title);
  title.mouseenter();
  assert.equal(classes.has('is-hover-reading'), true, 'the real helper activates the selector used by Home');
  state.stats = { revision: 2 };
  context.repaint();
  state.stats = { revision: 3 };
  context.repaint();
  assert.deepEqual(painted, []);
  title.mouseleave();
  frames.splice(0).forEach(callback => callback());
  assert.deepEqual(painted, [3], 'leaving paints the most recent update, rather than losing deferred stats');
  title.mouseenter();
  title.mouseleave();
  frames.splice(0).forEach(callback => callback());
  assert.deepEqual(painted, [3], 'reading without deferred stats does not rebuild Home');
  title.clientWidth = 200;
  title.mouseenter();
  state.stats = { revision: 4 };
  context.repaint();
  title.mouseleave();
  frames.splice(0).forEach(callback => callback());
  assert.deepEqual(painted, [3, 4], 'a fitting title permits normal updates and no extra repaint on leave');
});

test('Edge Dock title hover permits pushes and clock repaints while tooltip holds still work', () => {
  const dock = source('edgeDock/dock.js');
  let tooltipHovered = false;
  const painted = [];
  const context = {
    state: { payload: null }, surface: 'bubble', limitTooltip: { active: false, pending: false },
    contentLayer: { querySelector: selector => {
      if (selector === '.fade-overflow:hover') return {};
      if (selector === '.limit-detail-tooltip-wrap:hover, .limit-detail-tooltip-wrap:focus-within') {
        return tooltipHovered ? {} : null;
      }
      return null;
    } },
    codexAccountControl: { deferRender: () => false },
    applyAppearance() {}, updateShape() {}, scheduleSelfRepaint() {},
    renderBubble: payload => painted.push(payload.cell.revision)
  };
  vm.runInNewContext(`${functionSource(dock, 'limitTooltipShouldHoldRender')}\n${functionSource(dock, 'deferBubbleRender')}\n${functionSource(dock, 'render')}\n${functionSource(dock, 'repaintSelf')}\nglobalThis.repaint = render; globalThis.tick = repaintSelf;`, context);
  context.repaint({ surface: 'bubble', cell: { revision: 1 } });
  context.repaint({ surface: 'bubble', cell: { revision: 2 } });
  context.tick();
  assert.deepEqual(painted, [1, 2, 2], 'hovering a title freezes neither pushes nor expiry/countdown ticks');
  assert.equal(context.limitTooltip.pending, false);
  context.repaint({ surface: 'bubble', cell: { revision: 3 } });
  assert.deepEqual(painted, [1, 2, 2, 3]);
  context.limitTooltip.active = true;
  tooltipHovered = true;
  context.repaint({ surface: 'bubble', cell: { revision: 4 } });
  context.tick();
  assert.equal(context.limitTooltip.pending, true);
  assert.deepEqual(painted, [1, 2, 2, 3], 'an actual open tooltip retains its existing repaint hold');
  tooltipHovered = false;
  context.tick();
  assert.deepEqual(painted, [1, 2, 2, 3, 4], 'the latest payload paints when the tooltip no longer holds it');
});
