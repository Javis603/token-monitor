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
