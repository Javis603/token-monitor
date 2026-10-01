'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { create } = require('../../src/electron/renderer/overflowText');

function harness(distance = 7) {
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
      getBoundingClientRect: () => ({ width: 200 + distance }),
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
      },
      addEventListener(type, handler) { this[type] = handler; },
      hasAttribute: () => false,
      removeAttribute() {}
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
  const api = create({ document, window, prefersReducedMotion: () => false });
  function frame(at) {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(at));
  }
  function hover() {
    element.mouseenter();
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 240);
    timers.delete(id);
    timer.callback();
  }
  api.bind(element);
  frame(0);
  return { api, element, node, document, window, frame, hover, frames };
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
  const body = app.slice(app.indexOf('function updateRow('), app.indexOf('function applyHomeListMark('));
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
