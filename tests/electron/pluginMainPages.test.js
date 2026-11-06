'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { entries } = require('../../src/electron/renderer/pluginMainPages');
const { placementPatch, placementsFor, removePluginPlacements } = require('../../src/electron/plugins/placementSettings');
const { normalizeInitialRendererViewState } = require('../../src/electron/floatingBubble');
const { createSurfaceDemand } = require('../../src/electron/plugins/surfaceDemand');

test('main menu requires declared page capability, explicit placement and active plugin', () => {
  const view = (ref, surfaces, page) => ({ ref, title: ref, surfaces, placements: { page } });
  const plugins = [{ id: 'demo', status: 'active', views: [
    view('demo/tray', ['tray'], true), view('demo/side', ['edgeDock'], true), view('demo/notch', ['notch'], true),
    view('demo/optional', ['page'], false), view('demo/chosen', ['page', 'home'], true)] },
  { id: 'off', status: 'disabled', views: [view('off/page', ['page'], true)] }];
  assert.deepEqual(entries({ plugins }).map(page => page.id), ['plugin:demo/chosen']);
  plugins[0].status = 'needsApproval'; assert.deepEqual(entries({ plugins }), []);
});
test('main page placement defaults off and changes no other surface, with uninstall retention', () => {
  const settings = { homeModuleOrder: 'plugin:demo/view', notchPluginPages: ['demo/view'], pluginMainPages: ['other/view'] };
  assert.equal(placementsFor(settings, 'demo/view').page, false);
  const added = { ...settings, ...placementPatch(settings, { ref: 'demo/view', surface: 'page', placed: true }) };
  assert.equal(placementsFor(added, 'demo/view').page, true);
  assert.equal(placementsFor(added, 'demo/view').home, true);
  assert.equal(placementsFor(added, 'demo/view').notch, true);
  assert.deepEqual(placementPatch(added, { ref: 'demo/view', surface: 'page', placed: false }), { pluginMainPages: ['other/view'] });
  assert.deepEqual(removePluginPlacements(added, 'demo').pluginMainPages, ['other/view']);
  const full = { pluginMainPages: Array.from({ length: 32 }, (_, i) => `demo/v${i}`) };
  assert.throws(() => placementPatch(full, { ref: 'demo/extra', surface: 'page', placed: true }), /page-full/);
  assert.equal(placementPatch(full, { ref: 'demo/v1', surface: 'page', placed: true }).pluginMainPages.length, 32);
});
test('main page survives window rebuild state while invalid routes are rejected', () => {
  assert.equal(normalizeInitialRendererViewState({ breakdown: 'plugin:demo/view' }).breakdown, 'plugin:demo/view');
  for (const breakdown of ['plugin:../bad', 'plugin:demo/', 'plugin:demo/view<script>']) {
    assert.equal(normalizeInitialRendererViewState({ breakdown }).breakdown, 'home');
  }
});
test('main and detached windows union page demand without destroying each other', () => {
  const events = [], demand = createSurfaceDemand((surface, refs) => events.push([surface, refs.sort()]));
  demand.set('main', 'page', ['demo/one']); demand.set('window', 'page', ['demo/two']);
  assert.deepEqual(events.at(-1), ['page', ['demo/one', 'demo/two']]);
  demand.set('main', 'page', []); assert.deepEqual(events.at(-1), ['page', ['demo/two']]);
  demand.set('main', 'page', ['demo/one']); demand.remove('window');
  assert.deepEqual(events.at(-1), ['page', ['demo/one']]);
  demand.set('main', 'tray', ['demo/one']); demand.remove('main');
  assert.deepEqual(events.slice(-2), [['page', []], ['tray', []]]);
  demand.set('other', 'page', [{ toString: 0 }, 'bad', 'demo/one', 'demo/one']);
  assert.deepEqual(events.at(-1), ['page', ['demo/one']]);
});


test('standalone-window errors stay with their page, retry once and discard stale navigation results', async () => {
  const { create } = require('../../src/electron/renderer/pluginMainPages');
  const { Element } = require('../helpers/notchPanel');
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_, tag) => new Element(tag, document) };
  const container = document.createElement('main'), headingContainer = document.createElement('div'), actionsContainer = document.createElement('div');
  const mounts = [], unmounted = [];
  let pending, calls = 0;
  const pages = ['one', 'two'].map(id => ({ id: `plugin:demo/${id}`, ref: `demo/${id}`, title: id }));
  const ui = create({ document, container, headingContainer, actionsContainer, host: { mount(...args) { mounts.push(args); }, unmount(node) { unmounted.push(node); }, refreshDemand() {} }, t: key => key,
    formatError: error => `Localized: ${error.message}`,
    openWindow: () => { calls++; return new Promise((resolve, reject) => { pending = { resolve, reject }; }); } });
  ui.render(pages, pages[0].id);
  assert.equal(container.querySelector('h2'), null, 'body has no duplicate heading row');
  assert.equal(headingContainer.querySelector('h2').textContent, 'one');
  const button = actionsContainer.querySelector('button');
  assert.equal(mounts[0][3].headerActions, actionsContainer.querySelector('.plugin-header-actions'));
  assert.equal(button.querySelectorAll('svg').length, 1);
  button.fire('click'); button.fire('click'); assert.equal(calls, 1);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  pending.reject(Error('open failed')); await new Promise(setImmediate);
  const notice = container.querySelector('.plugin-action-error');
  assert.equal(notice?.textContent, 'Localized: open failed');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.equal(button.getAttribute('aria-describedby'), notice.id);
  assert.equal(button.disabled, false);
  ui.render(pages, pages[0].id); assert.equal(container.querySelectorAll('.plugin-action-error').length, 1);
  assert.equal(button.querySelectorAll('svg').length, 1, 'refresh retains icon');
  button.fire('click'); pending.resolve(); await new Promise(setImmediate);
  assert.equal(container.querySelector('.plugin-action-error'), null);
  button.fire('click'); ui.render(pages, pages[1].id); ui.render(pages, pages[0].id);
  pending.reject(Error('stale')); await new Promise(setImmediate);
  assert.equal(container.querySelector('.plugin-action-error'), null, 'navigation invalidates late failures even after returning');
  button.fire('click'); ui.render([], 'home'); pending.reject(Error('removed')); await new Promise(setImmediate);
  assert.equal(container.querySelector('.plugin-action-error'), null);
  assert.equal(unmounted.length, 2);assert.equal(actionsContainer.children.length, 0);
  assert.equal(headingContainer.children.length, 0, 'removed plugin releases heading');
  assert.equal(headingContainer.classList.contains('hidden'), true);
});
