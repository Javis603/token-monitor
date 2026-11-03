'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Element } = require('../helpers/notchPanel');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const frames = [];
  let popoverShows = 0, pluginUpdates = 0;
  class Node extends Element {
    querySelectorAll(selector) {
      if (selector[0] === '#') return this.children.flatMap(node => [...(node.id === selector.slice(1) ? [node] : []), ...node.querySelectorAll(selector)]);
      return super.querySelectorAll(selector);
    }
    matches(selector) { return selector === ':popover-open' && this.open; }
    showPopover() { this.open = true; popoverShows++; }
    hidePopover() { this.open = false; }
    scrollIntoView() { this.parent.scrollTop = 0; }
  }
  const document = { createElement: tag => new Node(tag, document), activeElement: null };
  const switcher = document.createElement('div');
  const state = { breakdown: 'home', viewSwitcherOpen: true, viewSwitcherHasOpened: true, floatingBubble: { collapsed: false } };
  const options = { order: ['home', 'limits', 'plugin:example/page'], locale: 'en', icon: 'globe' };
  const context = {
    state, document, els: { viewSwitcher: switcher }, viewSwitcherRenderKey: '',
    visibleBreakdownOrder: () => options.order,
    viewLabelById: id => `${options.locale}:${id}`,
    nextBreakdown: id => options.order[(options.order.indexOf(id) + 1) % options.order.length],
    pluginPageOptions: () => [{ id: 'plugin:example/page', icon: options.icon, identityIcon: '' }],
    viewSwitcherIcon: () => document.createElement('span'),
    t: (key, params) => `${options.locale}:${key}:${params?.view || ''}`,
    visibleStatsSurface: () => 'main', isSettingsPanelOpen: () => false, isRendererWindowHidden: () => false,
    pluginContent: { render: () => { pluginUpdates++; } }, openViewFromTray() {},
    requestAnimationFrame: callback => { frames.push(callback); },
    clearViewSwitcherHoverClose() {}, clearViewSwitcherLongPress() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function updateViewSwitcherOpenState('), source.indexOf('function homeModuleShell(')), context);
  const render = () => { context.renderViewSwitcher(); while (frames.length) frames.shift()(); };
  return { context, render, switcher, state, options, counts: () => ({ popoverShows, pluginUpdates }) };
}

test('unchanged navigation survives repeated usage renders without replaying the menu or losing reading position', () => {
  const f = fixture();
  f.render();
  const menu = f.switcher.querySelector('#viewSwitcherMenu');
  const hovered = menu.children[1];
  hovered.focus();
  menu.scrollTop = 84;
  const before = f.counts();
  for (let i = 0; i < 5; i++) f.render();
  assert.equal(f.switcher.querySelector('#viewSwitcherMenu'), menu, 'retain the open popover');
  assert.equal(menu.children[1], hovered, 'retain the hovered/focused row');
  assert.equal(f.context.document.activeElement, hovered);
  assert.equal(menu.scrollTop, 84, 'usage updates must not scroll back to the active page');
  assert.equal(f.counts().popoverShows, before.popoverShows, 'do not re-enter the top layer');
  assert.equal(f.counts().pluginUpdates, before.pluginUpdates + 5, 'navigation plugin content still updates');
  f.state.viewSwitcherOpen = false;
  f.context.updateViewSwitcherOpenState();
  assert.equal(menu.open, false);
  f.state.viewSwitcherOpen = true;
  f.context.updateViewSwitcherOpenState({ focusMenu: true });
  assert.equal(menu.open, true);
});

test('navigation changes still refresh labels, order, active page and plugin icons', () => {
  const f = fixture();
  f.render();
  let previous = f.switcher.querySelector('#viewSwitcherMenu');
  for (const change of [() => { f.options.locale = 'zh'; }, () => { f.options.order.reverse(); },
    () => { f.state.breakdown = 'limits'; }, () => { f.options.icon = 'token'; }]) {
    change(); f.render();
    const menu = f.switcher.querySelector('#viewSwitcherMenu');
    assert.notEqual(menu, previous);
    assert.deepEqual(menu.children.map(row => row.dataset.view), f.options.order);
    assert.equal(menu.querySelector('.is-current').dataset.view, f.state.breakdown);
    previous = menu;
  }
});
