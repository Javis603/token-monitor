'use strict';
// Runs the real Home activity scroll listeners from app.js against a scroller double
// that behaves like Chromium: scroll offsets clamp to the overflow, and the scroll
// event for an offset change is dispatched on the next frame, after the new size
// is applied but before layout and ResizeObserver callbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const espree = require('espree');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest' });
function extract(name) {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name);
  return source.slice(node.start, node.end);
}

class ScrollerDouble extends EventTarget {
  constructor(clientWidth, scrollWidth) {
    super();
    this.clientWidth = clientWidth;
    this.scrollWidth = scrollWidth;
    this.left = 0;
    this.scrollPending = false;
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  get scrollLeft() { return this.left; }
  set scrollLeft(value) {
    const next = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, value));
    if (next === this.left) return;
    this.left = next;
    this.scrollPending = true;
  }
  querySelector() { return null; }
}

function fixture({ clientWidth = 300, scrollWidth = 640 } = {}) {
  const observers = [];
  const state = { homeActivityScrollLeft: null, homeActivityFollowEnd: true, homeActivityResizeObserver: null };
  const tooltip = { dataset: {}, style: {}, setAttribute() {} };
  const context = vm.createContext({
    state,
    homeOverviewApi: require('../../src/electron/renderer/homeOverview'),
    homeActivityProgrammaticScrollers: new WeakSet(),
    homeActivityTooltipEl: () => tooltip,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.callback = null; }
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    Element: class {}
  });
  vm.runInContext(['applyHomeActivityScroll', 'setupHomeActivityScroller', 'setupHomeActivityHover'].map(extract).join('\n'), context);
  const scroller = new ScrollerDouble(clientWidth, scrollWidth);
  context.setupHomeActivityScroller(scroller);
  context.setupHomeActivityHover(scroller);
  const dispatchScroll = () => {
    if (!scroller.scrollPending) return;
    scroller.scrollPending = false;
    scroller.dispatchEvent(new Event('scroll'));
  };
  // One rendered frame at a new panel width: the size changes first, queued scroll
  // events fire, then ResizeObserver delivers the settled layout.
  const frame = (width) => {
    scroller.clientWidth = width;
    scroller.scrollLeft = scroller.left; // re-clamp to the new overflow
    dispatchScroll();
    for (const observer of observers) observer.callback?.();
  };
  const resizeTo = (width, step = 10) => {
    while (scroller.clientWidth !== width) {
      const delta = width - scroller.clientWidth;
      frame(scroller.clientWidth + Math.sign(delta) * Math.min(step, Math.abs(delta)));
    }
    frame(width);
    frame(width);
  };
  const userScroll = (left) => { scroller.scrollLeft = left; dispatchScroll(); };
  const max = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  return { scroller, state, resizeTo, userScroll, max, settle: () => frame(scroller.clientWidth) };
}

test('Home activity heatmap returns to the newest week after widening past the content and narrowing again', () => {
  const f = fixture();
  f.settle();
  assert.equal(f.scroller.scrollLeft, f.max(), 'opens on the newest week');

  f.resizeTo(700);
  assert.equal(f.max(), 0, 'the whole year fits');

  f.resizeTo(300);
  assert.equal(f.state.homeActivityFollowEnd, true, 'restoring the right edge is not a user scroll');
  assert.equal(f.scroller.scrollLeft, f.max(), 'narrowing lands on the newest week again');
});

test('Home activity heatmap keeps a deliberate scroll back across resizes', () => {
  const f = fixture();
  f.settle();
  f.userScroll(100);
  assert.equal(f.state.homeActivityFollowEnd, false);

  f.resizeTo(500);
  f.resizeTo(300);
  assert.equal(f.scroller.scrollLeft, 100, 'scroll back position survives the resize');

  f.userScroll(f.max());
  assert.equal(f.state.homeActivityFollowEnd, true, 'scrolling back to the end follows the newest week again');
  f.resizeTo(700);
  f.resizeTo(300);
  assert.equal(f.scroller.scrollLeft, f.max());
});
