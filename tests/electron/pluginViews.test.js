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

for (const surface of ['home', 'page', 'notch', 'edgeDock']) {
  test(`${surface} control failures render clean localized inline errors and clear on success`, async () => {
    const { Element } = require('../helpers/notchPanel');
    const document = { visibilityState: 'visible', addEventListener() {} };
    document.createElement = tag => {
      const node = new Element(tag, document);
      node.style.removeProperty = key => delete node.style[key];
      Object.defineProperties(node, {
        firstElementChild: { get: () => node.children[0] || null },
        isConnected: { get: () => document.body?.contains(node) || false }
      });
      node.getClientRects = () => [{}]; return node;
    };
    document.createElementNS = (_ns, tag) => document.createElement(tag);
    document.body = document.createElement('body');
    const mount = document.createElement('div'); document.body.append(mount);
    let failure = true;
    const host = createPluginViewHost({ document, window: {},
      t: (key, values) => key === 'settings.plugins.actionFailed' ? `Action failed: ${values.error}` : key,
      onInteraction: async () => { if (failure) throw Error("Error invoking remote method 'plugins:interact': Error: plugin view changed; try again"); }
    });
    host.update({ surface, views: { 'test/view': { status: 'ok', revision: 1, tree: { type: 'button', label: 'Go', action: 'go' } } } });
    host.mount(mount, 'test/view', surface);
    mount.querySelector('button').fire('click', { stopPropagation() {} }); await new Promise(setImmediate);
    const alert = mount.querySelector('.pv-action-error');
    assert.equal(alert?.textContent, 'Action failed: plugin view changed; try again');
    assert.equal(alert.getAttribute('role'), 'alert');
    failure = false; mount.querySelector('button').fire('click', { stopPropagation() {} }); await new Promise(setImmediate);
    assert.equal(mount.querySelector('.pv-action-error'), null);
  });
}

test('detached page metadata errors use the same clean message', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const nodes = new Map();
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } };
  const views = require('../../src/electron/renderer/pluginViews');
  const window = {
    tokenMonitorPluginPage: { onMeta() {}, onViews() {}, metadata: async () => { throw Error("Error invoking remote method 'plugins:page:metadata': Error: page unavailable"); } },
    TokenMonitorI18n: { translate: (_locale, _key, values) => `Action failed: ${values.error}` },
    TokenMonitorPluginViews: { ...views, createPluginViewHost: () => ({}) },
    matchMedia: () => ({ addEventListener() {} })
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/renderer/plugins/page.js'), 'utf8'), { document, window });
  await new Promise(setImmediate);
  assert.equal(nodes.get('pageError').textContent, 'Action failed: page unavailable');
  assert.equal(nodes.get('pageError').hidden, false);
});
