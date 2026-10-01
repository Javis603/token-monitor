'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { create } = require('../../src/electron/renderer/overflowText');

function harness(distance = 7, options = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const frames = new Map();
  function node() {
    const classes = new Set();
    return {
      children: [], dataset: {}, style: {}, isConnected: true, clientWidth: 200, scrollLeft: 0,
      get childNodes() { return this.children; },
      get textContent() { return this.children.map(child => child.textContent).join(''); },
      set textContent(text) { this.children = [{ textContent: text }]; },
      append(...children) { this.children = children; },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect: () => ({ width: 200 + distance, left: 0, right: 200, top: 0, bottom: 20 }),
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
      },
      addEventListener(type, handler) { this[type] = handler; },
      hasAttribute(name) { return Object.hasOwn(this, name); },
      removeAttribute(name) { delete this[name]; }
    };
  }
  const element = node();
  element.textContent = 'Review Token Monitor PR 883';
  const window = {
    addEventListener() {}, performance: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id)
  };
  const document = { createElement: node, querySelectorAll: () => [element] };
  const api = create({ document, window, prefersReducedMotion: () => false, ...options });
  function frame(at) {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(at));
  }
  function hover(event) {
    element.mouseenter(event);
    assert.equal(timers.size, 1, 'hover schedules one delay timer');
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 240);
    timers.delete(id);
    timer.callback();
  }
  api.bind(element);
  frame(0);
  return { api, element, node, document, window, frame, hover, frames, timers };
}

test('small overflow moves smoothly in fractional pixels and finishes promptly', () => {
  const h = harness();
  h.hover();
  h.frame(16);
  const content = h.element.children[0];
  const offset = -Number(content.style.transform.match(/translate3d\(([^p]+)px/)[1]);
  assert.ok(offset > 0 && offset < 1, 'first frame moves less than one pixel without integer scroll steps');
  assert.equal(h.element.scrollLeft, 0, 'the viewport itself does not scroll');
  h.frame(240);
  assert.equal(content.style.transform, 'translate3d(-7px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), false);
  h.element.mouseleave();
  assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), true);
});

test('unchanged text preserves pending, active and completed hover motion', () => {
  const h = harness(100);
  const content = h.element.children[0];
  h.element.mouseenter();
  assert.equal(h.timers.size, 1, 'reading starts with a scheduled hover delay');
  const delayId = [...h.timers.keys()][0];
  h.api.setText(h.element, h.element.textContent);
  assert.equal(h.timers.size, 1, 'an unchanged title retains exactly one delay timer');
  assert.equal([...h.timers.keys()][0], delayId, 'an update during the hover delay keeps the original timer');
  h.element.mouseleave();
  h.hover();
  h.frame(500);
  const before = content.style.transform;
  h.api.setText(h.element, h.element.textContent);
  assert.equal(h.element.children[0], content);
  assert.equal(content.style.transform, before);
  h.frame(1000);
  assert.notEqual(content.style.transform, before, 'the same animation continues through a data refresh');
  h.frame(2200);
  h.api.setText(h.element, h.element.textContent);
  h.frame(2300);
  assert.equal(content.style.transform, 'translate3d(-100px, 0, 0)');
  h.api.setText(h.element, 'A renamed session');
  assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.textContent, 'A renamed session');
  assert.equal(h.element.hasAttribute('title'), false);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('leaving before the delay cancels motion, and reduced motion keeps the full tooltip', () => {
  let reduced = false;
  let releases = 0;
  const h = harness(100, { prefersReducedMotion: () => reduced, onLeave: () => { releases++; } });
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  h.frame(1000);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(releases, 1);
  reduced = true;
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  assert.equal(releases, 1, 'reduced-motion hover exits do not notify a reading release');
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
  assert.equal(h.element.title, h.element.textContent);
});

test('fitting titles do not notify a reading release on ordinary hover exits', () => {
  let releases = 0;
  const h = harness(0, { onLeave: () => { releases++; } });
  h.element.mouseenter();
  h.element.mouseleave();
  assert.equal(h.timers.size, 0);
  assert.equal(releases, 0);
});

for (const phase of ['pending', 'active', 'completed']) {
  test(`card replacement preserves ${phase} reading motion through commitCard`, () => {
    let releases = 0;
    const h = harness(100, { onLeave: () => { releases++; } });
    h.element.dataset.overflowKey = 'codex:session-1';
    const pointer = { clientX: 50, clientY: 10 };
    if (phase === 'pending') h.element.mouseenter(pointer);
    else {
      h.hover(pointer);
      h.frame(phase === 'active' ? 500 : 2200);
    }
    const before = h.element.children[0].style.transform;
    const delayId = [...h.timers.keys()][0];
    const replacement = h.node();
    replacement.textContent = h.element.textContent;
    replacement.dataset.overflowKey = h.element.dataset.overflowKey;
    replacement.isConnected = false;
    h.api.bind(replacement);
    // A detached replacement has no text geometry until commitCard mounts it.
    const content = replacement.children[0];
    content.getBoundingClientRect = () => ({ width: replacement.isConnected ? 300 : 0 });
    const previousList = { scrollTop: 37 };
    const nextList = { scrollTop: 0 };
    function card(title, list) {
      return {
        dataset: { cellId: 'sessions', breakdownMode: 'session' },
        querySelector: () => list,
        querySelectorAll: selector => selector === '.fade-overflow'
          || (selector === '.fade-overflow.is-hover-reading' && title.classList.contains('is-hover-reading'))
          ? [title] : []
      };
    }
    const previous = card(h.element, previousList);
    const next = card(replacement, nextList);
    const contentLayer = {
      firstElementChild: previous,
      querySelector: () => previous,
      replaceChildren(value) {
        assert.equal(value, next);
        this.firstElementChild = value;
        h.element.isConnected = false;
        replacement.isConnected = true;
        h.document.querySelectorAll = () => [replacement];
      }
    };
    const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
    const start = dock.indexOf('function commitCard(');
    const end = dock.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, 'commitCard source boundaries exist');
    const context = {
      contentLayer, overflowText: h.api, CARD_SCROLL_SELECTOR: '.scroll',
      cardResetAnimator: { capture: () => null, animate() {} }
    };
    vm.runInNewContext(`${dock.slice(start, end)}\nglobalThis.commit = commitCard;`, context);
    context.commit(next, 'sessions');
    assert.equal(nextList.scrollTop, 37, 'reading handoff preserves card scroll position');
    assert.equal(content.style.transform, before);
    assert.equal(replacement.classList.contains('is-hover-reading'), true);
    h.element.mouseleave();
    replacement.mouseenter(pointer);
    assert.equal(releases, 0, 'old-node leave does not interrupt the replacement');
    if (phase === 'pending') {
      assert.equal(h.timers.size, 1);
      assert.equal([...h.timers.keys()][0], delayId, 'the original delay continues');
      const timer = h.timers.get(delayId);
      h.timers.delete(delayId);
      timer.callback();
      h.frame(500);
      assert.notEqual(content.style.transform, before);
    } else {
      assert.equal(h.timers.size, 0, 'mouseenter on a replacement does not restart reading');
      h.frame(1000);
      if (phase === 'active') assert.notEqual(content.style.transform, before);
      else assert.equal(content.style.transform, before, 'completed reading remains at the end');
    }
    replacement.mouseleave();
    assert.equal(releases, 1);
    assert.equal(content.style.transform, 'translate3d(0px, 0, 0)');
  });
}

test('reading handoff ignores renamed, different and moved session titles', () => {
  for (const change of ['title', 'key', 'position', 'missing']) {
    const h = harness(100);
    h.element.dataset.overflowKey = 'codex:session-1';
    if (change === 'position') h.hover({ clientX: 50, clientY: 10 });
    else h.hover();
    h.frame(500);
    const replacement = h.node();
    replacement.textContent = change === 'title' ? 'Renamed session' : h.element.textContent;
    replacement.dataset.overflowKey = change === 'key' ? 'codex:session-2' : h.element.dataset.overflowKey;
    h.api.bind(replacement);
    replacement.getBoundingClientRect = () => ({ left: 0, right: 200, top: 40, bottom: 60, width: 200 });
    h.api.preserveReading({ querySelectorAll: () => [h.element] }, {
      querySelectorAll: () => change === 'missing' ? [] : [replacement]
    });
    assert.equal(replacement.classList.contains('is-hover-reading'), false);
    assert.equal(replacement.children[0].style.transform, 'translate3d(0px, 0, 0)');
    assert.equal(h.element.classList.contains('is-hover-reading'), false, 'failed handoff stops the old motion immediately');
    h.element.isConnected = false;
    h.frame(1000);
    assert.equal(h.element.classList.contains('is-hover-reading'), false);
  }
});

for (const phase of ['pending', 'active', 'completed']) {
  for (const width of [180, 240, 320]) {
    test(`${phase} reading reaches the new endpoint after replacement width changes to ${width}px`, () => {
      const h = harness(100);
      const pointer = { clientX: 50, clientY: 10 };
      h.element.dataset.overflowKey = 'codex:session-1';
      if (phase === 'pending') h.element.mouseenter(pointer);
      else {
        h.hover(pointer);
        h.frame(phase === 'active' ? 500 : 2200);
      }
      const before = h.element.children[0].style.transform;
      const replacement = h.node();
      replacement.clientWidth = width;
      replacement.dataset.overflowKey = h.element.dataset.overflowKey;
      replacement.textContent = h.element.textContent;
      h.api.bind(replacement);
      h.api.preserveReading({ querySelectorAll: () => [h.element] }, { querySelectorAll: () => [replacement] });
      h.element.isConnected = false;
      h.document.querySelectorAll = () => [replacement];
      if (width === 180) assert.equal(replacement.children[0].style.transform, before, 'narrowing continues from the existing offset');
      if (phase === 'pending') {
        const [id, timer] = [...h.timers][0];
        h.timers.delete(id);
        timer.callback();
      }
      h.frame(10_000);
      assert.equal(replacement.children[0].style.transform, `translate3d(${-Math.max(0, 300 - width)}px, 0, 0)`);
      assert.equal(replacement.classList.contains('has-overflow-fade'), false, 'the complete tail is visible at the new endpoint');
      assert.equal(h.frames.size, 0, 'the animation finishes without a perpetual repaint');
    });
  }
}

test('native text tooltips follow reduced motion for binding, updates and preference changes', () => {
  let reduced = false;
  const h = harness(100, { prefersReducedMotion: () => reduced });
  assert.equal(h.element.hasAttribute('title'), false);
  h.api.setText(h.element, 'Renamed title');
  assert.equal(h.element.hasAttribute('title'), false);
  reduced = true;
  h.api.refresh();
  h.frame(0);
  assert.equal(h.element.title, 'Renamed title');
  h.api.setText(h.element, 'Another title');
  assert.equal(h.element.title, 'Another title');
  const reducedTitle = h.node();
  reducedTitle.textContent = 'Bound with reduced motion';
  h.api.bind(reducedTitle);
  assert.equal(reducedTitle.title, reducedTitle.textContent);
  reduced = false;
  h.api.setText(h.element, h.element.textContent);
  h.frame(0);
  assert.equal(h.element.hasAttribute('title'), false, 'unchanged text also observes the latest preference');
  const fitting = harness(0);
  assert.equal(fitting.element.hasAttribute('title'), false, 'fitting text has no tooltip in normal mode');
});

test('failed handoff cancels a pending delay immediately', () => {
  const h = harness(100);
  h.element.dataset.overflowKey = 'codex:session-1';
  h.element.mouseenter();
  assert.equal(h.timers.size, 1);
  h.api.preserveReading({ querySelectorAll: () => [h.element] }, { querySelectorAll: () => [] });
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('resizing clamps the offset and detaching a hovered title stops its animation', () => {
  const h = harness(100);
  h.hover();
  h.frame(1000);
  h.element.clientWidth = 280;
  h.api.update(h.element);
  assert.equal(h.element.children[0].style.transform, 'translate3d(-20px, 0, 0)');
  h.element.clientWidth = 320;
  h.api.update(h.element);
  assert.equal(h.element.children[0].style.transform, 'translate3d(0px, 0, 0)');
  assert.equal(h.element.classList.contains('has-overflow-fade'), false);
  h.element.isConnected = false;
  h.frame(1100);
  assert.equal(h.frames.size, 0);
  assert.equal(h.element.classList.contains('is-hover-reading'), false);
});

test('a token and cost update through updateRow keeps the hovered title moving', () => {
  const h = harness(100);
  const selectors = new Map();
  const row = h.node();
  selectors.set('.row-title', h.element);
  row.querySelector = selector => {
    if (!selectors.has(selector)) selectors.set(selector, h.node());
    return selectors.get(selector);
  };
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function updateRow(');
  const end = app.indexOf('function applyHomeListMark(');
  assert.ok(start >= 0 && end > start, 'updateRow source boundaries exist in the expected order');
  const body = app.slice(start, end);
  const context = {
    state: { breakdown: 'session' }, rowWidth: () => 50,
    iconKindFor: () => ({ kind: 'dot' }),
    setHoverMarqueeText: h.api.setText, formatNumber: String, formatCost: String,
    updateRowContext() {}, updateRowLive() {}, applyBarScale() {},
    sessionRowsApi: { applyBreakdownRowSemantics() {} }, t: key => key
  };
  vm.runInNewContext(`${body}\nglobalThis.update = updateRow;`, context);
  const data = { name: h.element.textContent, detail: 'session-id', kind: 'session', client: 'codex', value: 100, cost: 1 };
  context.update(row, data);
  h.frame(0);
  h.hover();
  h.frame(500);
  const content = h.element.children[0];
  const before = content.style.transform;
  context.update(row, { ...data, value: 200, cost: 2 });
  assert.equal(row.querySelector('.row-value').textContent, '200');
  assert.equal(row.querySelector('.row-cost').textContent, '2');
  assert.equal(content.style.transform, before);
  h.frame(1000);
  assert.notEqual(content.style.transform, before);
});
