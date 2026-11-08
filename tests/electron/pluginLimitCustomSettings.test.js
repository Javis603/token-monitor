'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { create } = require('../../src/electron/renderer/limits/pluginSettings');
const { Element } = require('../helpers/notchPanel');
const base = { tmApi: 1, id: 'quota-fixture', name: 'Quota', version: '1.0.0', backend: 'backend.cjs', ui: 'ui.mjs', files: ['backend.cjs', 'ui.mjs'], views: [{ id: 'form', surfaces: ['settings'] }], limits: [{ id: 'credits', name: 'Credits', settingsView: 'form' }] };
test('module settings view must belong to this manifest and declare the settings surface', () => {
  assert.equal(normalizeManifest(base).ok, true);
  for (const settingsView of ['missing', 'other-plugin/form', true, 12]) assert.equal(normalizeManifest({ ...base, limits: [{ ...base.limits[0], settingsView }] }).ok, false);
  assert.equal(normalizeManifest({ ...base, views: [{ id: 'form', surfaces: ['home'] }] }).ok, false);
  assert.equal(normalizeManifest({ ...base, ui: undefined }).ok, false);
});
function fixture() {
  const document = { createElement: tag => { const node = new Element(tag); node.isConnected = true; return node; } };
  let modules = [{ id: 'plugin:quota-fixture:credits', moduleId: 'credits', settingsView: 'form' }], visible = false;
  const calls = [], disposed = [];
  const host = { mount: (...args) => calls.push(args), unmount: node => disposed.push(node), refreshDemand() {} };
  const controller = create({ document, host, getModules: () => modules, getView: module => module.settingsView ? { ref: `quota-fixture/${module.settingsView}` } : null, isVisible: () => visible });
  return { controller, calls, disposed, module: modules[0], show: value => { visible = value; }, modules: value => { modules = value; } };
}
test('custom controls mount lazily and retain the same node/draft across native rebuild and collapse', () => {
  const f = fixture(), node = f.controller.node(f.module); node.draft = 'unsaved';
  f.controller.reconcile(); assert.equal(f.calls.length, 0);
  f.show(true); f.controller.reconcile();
  assert.equal(f.calls[0][1], 'quota-fixture/form'); assert.equal(f.calls[0][2], 'settings');
  assert.equal(f.calls[0][3].moduleRef, f.module.id); assert.equal(f.calls[0][3].moduleId, 'credits');
  assert.equal(f.calls[0][3].surfaceVariant, 'limits-settings');
  assert.equal(f.controller.node(f.module), node);
  f.show(false); assert.equal(f.calls[0][3].isVisible(), false, 'host rechecks visibility on data pushes without remounting'); f.controller.reconcile(); assert.equal(f.calls.at(-1)[3].visible, false);
  assert.equal(node.draft, 'unsaved'); assert.equal(f.disposed.length, 0);
  f.controller.dispose(); assert.deepEqual(f.disposed, [node]);
});
test('removing one module disposes only its mount; removal does not depend on author startup', () => {
  const f = fixture(), first = f.controller.node(f.module);
  const other = { id: 'plugin:another:quota', moduleId: 'quota', settingsView: 'second' };
  const second = f.controller.node(other);
  f.modules([other]); f.controller.reconcile();
  assert.deepEqual(f.disposed, [first]); assert.equal(f.controller.node(other), second);
  f.modules([]); f.controller.reconcile(); assert.deepEqual(f.disposed, [first, second]);
});
