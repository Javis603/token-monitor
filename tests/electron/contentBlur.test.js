'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { Element } = require('../helpers/notchPanel');
const { create } = require('../../src/electron/renderer/contentBlur');

function fixture() {
  const frames = new Map(), listeners = new Map();
  let nextFrame = 0;
  const mutations = [], resizes = [], animations = [];
  const document = { hidden: false, getAnimations: () => animations };
  class Node extends Element {
    constructor(tag) {
      super(tag, document);
      this.box = { left: 0, top: 0, width: 400, height: 600 };
      this.style.removeProperty = name => { delete this.style[name]; };
    }
    get offsetHeight() { return this.box.height; }
    get offsetWidth() { return this.box?.width || 0; }
    set offsetWidth(_value) {}
    get isConnected() { return document.body.contains(this); }
    matches(selector) {
      return selector.split(',').some(part => {
        const name = part.trim();
        return name === ':popover-open' || name === ':modal' ? this.open : this.classList.contains(name.slice(1));
      });
    }
    getBoundingClientRect() { return { ...this.box, right: this.box.left + this.box.width, bottom: this.box.top + this.box.height }; }
  }
  document.body = new Node('body');
  document.documentElement = new Node('html');
  document.createElementNS = (_ns, tag) => new Node(tag);
  const listen = (event, callback) => listeners.set(event, callback);
  const unlisten = event => listeners.delete(event);
  document.addEventListener = listen; document.removeEventListener = unlisten;
  const window = {
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id), addEventListener: listen, removeEventListener: unlisten,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; mutations.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets.length = 0; }
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; resizes.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets.length = 0; }
    }
  };
  const root = new Node('main'); document.body.append(root);
  const controller = create({ document, window, root });
  const surface = (className = 'select-control-popup', box = { left: 20, top: 200, width: 120, height: 180 }) => {
    const node = new Node('div'); node.className = className; node.box = box; document.body.append(node); return node;
  };
  const toggle = (target, open) => {
    listeners.get('beforetoggle')({ target, newState: open ? 'open' : 'closed' });
    target.open = open;
  };
  const tick = () => {
    assert.equal(frames.size, 1);
    const [id, callback] = frames.entries().next().value; frames.delete(id); callback();
  };
  const definitions = document.body.children.find(node => node.classList.contains('content-blur-definitions'));
  const filterFor = source => {
    const id = source.style['--content-blur-filter']?.slice(5, -1);
    return definitions.children.find(node => node.getAttribute('id') === id);
  };
  return { root, document, frames, listeners, controller, definitions, surface, toggle, tick, filterFor,
    animations, mutations, resizes,
    changed: (target = root) => mutations.filter(observer => observer.targets.includes(document.body))
      .forEach(observer => observer.callback([{ target }])),
    appearanceChanged: () => mutations.filter(observer => observer.targets.includes(document.documentElement))
      .forEach(observer => observer.callback()) };
}

test('shared content blur tracks geometry, reuses stable filters, and stops when closed', () => {
  const f = fixture(), menu = f.surface();
  assert.equal(f.frames.size, 0);
  f.toggle(menu, true); f.tick();
  const filter = f.filterFor(f.root), blur = filter.children[0];
  assert.equal(f.root.classList.contains('content-blur-source'), true);
  assert.equal(menu.classList.contains('content-blur-source'), false, 'top menu stays sharp');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => blur.getAttribute(key)), ['2', '182', '156', '216']);
  const flood = filter.children.find(node => node.tagName === 'FEFLOOD');
  assert.equal(f.frames.size, 0, 'an idle open menu does not poll geometry');
  f.changed(); f.tick(); assert.ok(filter.children.includes(flood), 'unchanged geometry does not rebuild the filter');
  menu.box.top = 250; f.changed(menu); f.tick();
  assert.equal(filter.children.find(node => node.tagName === 'FEFLOOD').getAttribute('y'), '250');
  f.toggle(menu, false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.definitions.children.length, 0);
  assert.equal(f.root.classList.contains('content-blur-source'), false);
  assert.equal(f.root.style['--content-blur-filter'], undefined);
  f.controller.dispose();
});

test('simultaneous surfaces share a union mask and nested popovers filter the lower dialog once', () => {
  const f = fixture();
  const dialog = f.surface('sync-content-dialog', { left: 60, top: 100, width: 280, height: 350 });
  const menu = f.surface('select-control-popup', { left: 100, top: 200, width: 160, height: 180 });
  f.toggle(dialog, true); f.toggle(menu, true); f.tick();
  assert.equal(f.definitions.children.length, 2);
  const rootFilter = f.filterFor(f.root), dialogFilter = f.filterFor(dialog);
  assert.equal(rootFilter.children.filter(node => node.tagName === 'FEGAUSSIANBLUR').length, 1);
  assert.equal(rootFilter.children.filter(node => node.tagName === 'FEFLOOD').length, 2);
  const region = dialogFilter.children.find(node => node.tagName === 'FEFLOOD');
  assert.equal(region.getAttribute('x'), '40'); assert.equal(region.getAttribute('y'), '100');
  assert.equal(menu.classList.contains('content-blur-source'), false);
  f.toggle(menu, false); f.tick();
  assert.equal(f.definitions.children.length, 1);
  assert.equal(dialog.classList.contains('content-blur-source'), false);
  f.toggle(dialog, false); assert.equal(f.frames.size, 0);
  f.controller.dispose();
});

test('detached/cancelled surfaces, accessibility, visibility and disposal release filters and frames', () => {
  const f = fixture(), menu = f.surface();
  f.toggle(menu, true); menu.open = false; f.tick();
  assert.equal(f.frames.size, 0, 'cancelled open never starts a persistent loop');
  f.toggle(menu, true); f.tick();
  f.document.documentElement.classList.add('native-reduced-transparency'); f.appearanceChanged(); f.tick();
  assert.equal(f.definitions.children.length, 0); assert.equal(f.frames.size, 0);
  f.document.documentElement.classList.remove('native-reduced-transparency'); f.appearanceChanged(); f.tick();
  assert.equal(f.definitions.children.length, 1);
  f.document.hidden = true; f.listeners.get('visibilitychange')(); f.tick();
  assert.equal(f.frames.size, 0); assert.equal(f.definitions.children.length, 0);
  f.document.hidden = false; f.listeners.get('visibilitychange')(); f.tick();
  menu.remove(); f.changed(); f.tick(); assert.equal(f.frames.size, 0);
  f.controller.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.definitions.parent, null);
});

test('geometry events coalesce and observers only run while surfaces need blur', () => {
  const f = fixture(), menu = f.surface();
  f.toggle(menu, true); f.tick();
  f.changed(f.definitions);
  assert.equal(f.frames.size, 0, 'filter writes do not trigger their own update');
  for (const event of ['scroll', 'resize', 'input', 'change', 'load']) f.listeners.get(event)();
  f.resizes[0].callback();
  assert.equal(f.frames.size, 1);
  menu.box.width = 150; f.tick();
  assert.equal(f.filterFor(f.root).children.find(node => node.tagName === 'FEFLOOD').getAttribute('width'), '150');
  assert.equal(f.frames.size, 0);
  f.toggle(menu, false);
  assert.ok(f.resizes.every(observer => observer.targets.length === 0));
  assert.ok(f.mutations.every(observer => !observer.targets.includes(f.document.body)));
  f.listeners.get('scroll')();
  assert.equal(f.frames.size, 0, 'closed surfaces do not wake on layout events');
  f.controller.dispose();
});

test('opening and layout animations track every frame, then stop without tracking unrelated spinners', () => {
  const f = fixture(), menu = f.surface();
  const animation = { playState: 'running', effect: { target: menu, getComputedTiming: () => ({ endTime: 190 }) } };
  f.animations.push(animation);
  f.toggle(menu, true); f.tick();
  menu.box.top = 220; f.tick();
  assert.equal(f.filterFor(f.root).children.find(node => node.tagName === 'FEFLOOD').getAttribute('y'), '220');
  animation.playState = 'finished'; f.tick();
  assert.equal(f.frames.size, 0);
  const spinner = f.surface('spinner'); f.root.append(spinner);
  f.animations.push({ playState: 'running', effect: { target: spinner, getComputedTiming: () => ({ endTime: Infinity }) } });
  f.listeners.get('animationstart')(); f.tick();
  assert.equal(f.frames.size, 0, 'an unrelated infinite spinner cannot keep the loop alive');
  animation.effect.target = spinner; animation.playState = 'running';
  f.listeners.get('transitionrun')(); f.tick();
  assert.equal(f.frames.size, 1, 'finite layout animations may move CSS anchors');
  animation.playState = 'finished'; f.tick();
  assert.equal(f.frames.size, 0);
  f.controller.dispose();
});
