'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Element } = require('../helpers/notchPanel');
const { entries, render } = require('../../src/electron/renderer/notch/pageSettings');
const i18n = require('../../src/electron/renderer/i18n');
const pluginViews = require('../../src/electron/renderer/pluginViews');

const t = (key, params) => i18n.translate('en', key, params);
const flush = () => new Promise(setImmediate);

function documentStub() {
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.createElementNS = (_ns, tag) => new Element(tag, document);
  document.body = new Element('body', document);
  return document;
}

const catalog = {
  plugins: [
    { id: 'pulse', name: 'Token Pulse', status: 'active', views: [
      { ref: 'pulse/main', title: 'Token Pulse', icon: 'cpu', surfaces: ['notch'], placements: { notch: true } },
      { ref: 'pulse/mini', title: 'Mini', icon: 'memory', surfaces: ['notch', 'page'], placements: { notch: false } },
      { ref: 'pulse/elsewhere', title: 'Elsewhere', surfaces: ['page'], placements: {} }
    ] },
    { id: 'idle', name: 'Idle', status: 'error', views: [
      { ref: 'idle/main', title: 'Idle View', surfaces: ['notch'], placements: { notch: false } }
    ] }
  ]
};

test('entries pair a short label, a de-duplicated title and the tab icon', () => {
  const list = entries({}, catalog, t);
  assert.deepEqual(list.map(entry => entry.id),
    ['home', 'limits', 'sessions', 'breakdown', 'plugin:pulse/main', 'plugin:pulse/mini']);
  assert.deepEqual(list.slice(0, 4).map(entry => [entry.label, entry.icon.name]),
    [['Home', 'home'], ['Limits', 'limits'], ['Sessions', 'session'], ['Breakdown', 'model']]);
  const same = list.find(entry => entry.id === 'plugin:pulse/main');
  assert.equal(same.title, 'Token Pulse', 'a view named like its plugin is not doubled');
  assert.equal(same.label, 'Token Pulse');
  const mini = list.find(entry => entry.id === 'plugin:pulse/mini');
  assert.equal(mini.title, 'Token Pulse · Mini');
  assert.equal(mini.label, 'Mini');
  assert.deepEqual(mini.icon, { kind: 'plugin', name: 'memory' });
  assert.equal(mini.checked, false);
  assert.equal(same.checked, true);
});

test('page choices hide inactive plugins and a paused catalog without erasing saved choices', () => {
  const fixture = structuredClone(catalog);
  const settings = { notchBuiltinPages: ['home'], notchPageOrder: ['plugin:pulse/main', 'home'], notchPluginPages: ['pulse/main'] };
  const saved = JSON.stringify({ settings, fixture });
  assert.equal(entries(settings, fixture, t)[0].id, 'plugin:pulse/main');
  for (const status of ['disabled', 'pluginsOff', 'safeMode', 'crashed', 'needsApproval', 'invalid']) {
    fixture.plugins[0].status = status;
    assert.deepEqual(entries(settings, fixture, t).map(e => e.id), ['home', 'limits', 'sessions', 'breakdown']);
  }
  fixture.plugins[0].status = 'active';
  assert.equal(entries({ ...settings, pluginsEnabled: false }, fixture, t).length, 4);
  assert.equal(entries(settings, { ...fixture, enabled: false }, t).length, 4);
  const restored = entries(settings, fixture, t);
  assert.equal(restored[0].id, 'plugin:pulse/main'); assert.equal(restored[0].checked, true);
  assert.equal(JSON.stringify({ settings, fixture }), saved);
});

test('chips toggle through click, restore state on failure and keep focus', async () => {
  const document = documentStub();
  const container = new Element('div', document);
  document.body.append(container);
  let fail = false;
  const options = {
    document, container, settings: {}, catalog, t,
    save: async patch => { if (fail) throw new Error('disk'); Object.assign(options.settings, patch); },
    place: async (ref, placed) => {
      for (const plugin of catalog.plugins) {
        const view = (plugin.views || []).find(candidate => candidate.ref === ref);
        if (view) view.placements.notch = placed;
      }
    },
    pluginIcon: name => pluginViews.iconNode(document, name, null, 14),

  };
  render(options);
  const chip = id => container.querySelectorAll('button').find(node => node.dataset.page === id);
  assert.equal(container.querySelectorAll('button').length, 6);
  assert.equal(chip('home').children[0].className, 'view-switcher-icon view-icon-home');
  assert.equal(chip('home').children[1].textContent, 'Home');
  assert.equal(chip('home').attributes['aria-pressed'], 'true');
  assert.equal(chip('plugin:pulse/main').title, undefined, 'label and title agree, so no tooltip');
  assert.equal(chip('plugin:pulse/mini').title, undefined, 'full view name is accessible without a native tooltip');
  assert.equal(chip('plugin:pulse/mini').attributes['aria-label'], 'Token Pulse · Mini');
  assert.ok(chip('plugin:pulse/mini').querySelector('.pv-icon'), 'plugin chips paint the plugin icon');
  assert.equal(chip('plugin:idle/main'), undefined, 'inactive plugins have no page chip');

  chip('limits').focus();
  chip('limits').fire('click', {});
  await flush(); await flush();
  assert.deepEqual(options.settings.notchBuiltinPages, ['home', 'sessions', 'breakdown']);
  assert.equal(chip('limits').attributes['aria-pressed'], 'false');

  chip('plugin:pulse/mini').fire('click', {});
  await flush(); await flush();
  assert.equal(catalog.plugins[0].views[1].placements.notch, true);
  assert.equal(chip('plugin:pulse/mini').attributes['aria-pressed'], 'true');

  fail = true;
  chip('sessions').focus();
  chip('sessions').fire('click', {});
  await flush(); await flush();
  assert.match(container.querySelector('.plugin-action-error')?.textContent, /disk/);
  assert.equal(chip('sessions').attributes['aria-pressed'], 'true', 'a failed save rolls the chip back');
  assert.equal(document.activeElement?.dataset.page, 'sessions', 'focus lands back on the toggled chip');
  const notice = container.querySelector('.plugin-action-error');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.equal(chip('sessions').getAttribute('aria-describedby'), notice.id);
  render(options); assert.ok(container.querySelector('.plugin-action-error'), 'refresh retains failure');
  fail = false; chip('sessions').fire('click'); await flush();
  assert.equal(container.querySelector('.plugin-action-error'), null, 'successful retry clears failure');
});

test('a focused chip survives re-renders while the container is saving', async () => {
  const document = documentStub();
  const container = new Element('div', document);
  document.body.append(container);
  const options = {
    document, container, settings: {}, catalog, t,
    save: async () => {}, place: async () => {}, onError: () => {}
  };
  render(options);
  const home = container.querySelectorAll('button').find(node => node.dataset.page === 'home');
  home.focus();
  render(options);
  assert.equal(document.activeElement?.dataset.page, 'home', 're-rendering restores focus by page key');
  container.dataset.saving = 'true';
  const before = container.querySelectorAll('button').length;
  render(options);
  assert.equal(container.querySelectorAll('button').length, before, 'a save in flight does not rebuild mid-gesture');
});


test('mixed page order retains hidden entries and keyboard sorting preserves visibility', async () => {
  const document = documentStub(), container = new Element('div', document); document.body.append(container);
  let fail = false;
  const settings = { notchPageOrder: ['plugin:pulse/main', 'home', 'limits'], notchBuiltinPages: ['home'] };
  const options = { document, container, settings, catalog: structuredClone(catalog), t,
    save: async patch => { if (fail) throw Error('disk'); Object.assign(settings, patch); }, place: async () => {} };
  const ids = () => container.querySelectorAll('button').map(node => node.dataset.page);
  const chip = id => container.querySelectorAll('button').find(node => node.dataset.page === id);
  render(options);
  assert.deepEqual(ids().slice(0, 3), ['plugin:pulse/main', 'home', 'limits']);
  chip('plugin:pulse/main').focus();
  chip('plugin:pulse/main').fire('keydown', { altKey: true, key: 'End', preventDefault() {} });
  await flush(); await flush();
  assert.equal(ids().at(-1), 'plugin:pulse/main');
  assert.equal(document.activeElement?.dataset.page, 'plugin:pulse/main');
  assert.deepEqual(settings.notchBuiltinPages, ['home'], 'reordering does not toggle visibility');
  const previous = [...settings.notchPageOrder]; fail = true;
  chip('home').focus(); chip('home').fire('keydown', { altKey: true, key: 'ArrowRight', preventDefault() {} });
  await flush(); await flush();
  assert.deepEqual(settings.notchPageOrder, previous); assert.deepEqual(ids(), previous); assert.match(container.querySelector('.plugin-action-error')?.textContent, /disk/);
  assert.equal(document.activeElement?.dataset.page, 'home');
});

test('reset order preserves visibility and recovers from failed saves without duplicate submissions', async () => {
  const document = documentStub(), container = new Element('div', document), resetButton = new Element('button', document);
  document.body.append(resetButton, container);
  const settings = { notchPageOrder: ['plugin:pulse/main', 'limits', 'home'], notchBuiltinPages: ['home'] };
  const fixtureCatalog = structuredClone(catalog), beforePlacements = JSON.stringify(fixtureCatalog);
  let pending; const patches = [];
  const options = { document, container, resetButton, settings, catalog: fixtureCatalog, t,
    save: patch => { patches.push(patch); return new Promise((resolve, reject) => { pending = { resolve: () => { Object.assign(settings, patch); resolve(); }, reject }; }); },
    place: () => assert.fail('reset must not change plugin placements') };
  render(options); render(options);
  assert.equal(resetButton.disabled, false);
  assert.equal(resetButton.hidden, false, 'custom order exposes the text reset action');
  resetButton.focus(); resetButton.fire('click'); resetButton.fire('click');
  document.activeElement = document.body; // Native disabled buttons lose focus.
  assert.equal(patches.length, 1, 'one reset stays in flight across repeated clicks and renders');
  assert.equal(resetButton.disabled, true);
  pending.reject(Error('disk')); await flush(); await flush();
  assert.match(container.querySelector('.plugin-action-error')?.textContent, /disk/); assert.equal(resetButton.disabled, false);
  assert.equal(container.querySelectorAll('button')[0].dataset.page, 'plugin:pulse/main');
  assert.equal(resetButton.getAttribute('aria-describedby'), container.querySelector('.plugin-action-error').id);
  assert.equal(document.activeElement, resetButton);
  assert.ok(container.querySelectorAll('button').every(chip => !chip.getAttribute('aria-describedby')));
  resetButton.fire('click');
  assert.ok(!resetButton.getAttribute('aria-describedby'), 'retry clears reset error association');
  document.activeElement = document.body;
  pending.resolve(); await flush(); await flush();
  assert.equal(container.querySelector('.plugin-action-error'), null);
  assert.deepEqual(patches.at(-1), { notchPageOrder: [] });
  assert.equal(document.activeElement?.dataset.page, 'home', 'successful reset focuses first page because Reset disappears');
  assert.deepEqual(container.querySelectorAll('button').slice(0, 4).map(n => n.dataset.page), ['home', 'limits', 'sessions', 'breakdown']);
  assert.deepEqual(settings.notchBuiltinPages, ['home']);
  assert.equal(JSON.stringify(fixtureCatalog), beforePlacements);
  assert.equal(resetButton.disabled, true, 'default order has nothing to reset');
  assert.equal(resetButton.hidden, true, 'default order hides reset like the existing Dock/Notch composer');
});

test('failed reset does not steal focus after the user leaves the controls', async () => {
  const document = documentStub(), container = new Element('div', document), resetButton = new Element('button', document), other = new Element('button', document);
  document.body.append(resetButton, container, other);
  let rejectSave;
  const options = { document, container, resetButton, settings: { notchPageOrder: ['limits', 'home'] }, catalog, t,
    save: () => new Promise((_resolve, reject) => { rejectSave = reject; }), place: async () => {} };
  render(options); resetButton.focus(); resetButton.fire('click'); other.focus();
  rejectSave(Error('disk')); await flush();
  assert.equal(document.activeElement, other);
  assert.equal(resetButton.getAttribute('aria-describedby'), container.querySelector('.plugin-action-error').id);
});
