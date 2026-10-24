'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createPluginViewHost } = require('../../src/electron/renderer/pluginViews');

test('view demand clears while hidden without animation frames, but tray demand remains', async () => {
  let intersect;
  let visibility;
  const demands = new Map();
  const document = { visibilityState: 'visible', addEventListener: (_name, fn) => { visibility = fn; },
    createElement: () => ({ append() {}, classList: { add() {} } }),
    createElementNS: () => ({ append() {}, setAttribute() {} }) };
  const window = { requestAnimationFrame() { throw new Error('hidden windows cannot depend on animation frames'); },
    IntersectionObserver: class { constructor(fn) { intersect = fn; } observe() {} unobserve() {} } };
  const host = createPluginViewHost({ document, window, t: x => x, onDemand: (surface, refs) => demands.set(surface, refs) });
  const container = { isConnected: true, classList: { add() {} }, dataset: {}, style: { removeProperty() {}, setProperty() {} }, getClientRects: () => [{}], replaceChildren() {} };
  const flush = () => new Promise(resolve => setTimeout(resolve, 10));
  host.mount(container, 'pulse/chart', 'home');
  host.setExplicitDemand('tray', ['pulse/chart']);
  await flush();
  assert.deepEqual(demands.get('home'), ['pulse/chart']);
  intersect([{ target: container, isIntersecting: false }]);
  await flush();
  assert.deepEqual(demands.get('home'), []);
  intersect([{ target: container, isIntersecting: true }]);
  await flush();
  document.visibilityState = 'hidden';
  visibility();
  await flush();
  assert.deepEqual(demands.get('home'), []);
  assert.deepEqual(demands.get('tray'), ['pulse/chart']);
});
