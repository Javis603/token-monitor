'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocument } = require('./accountOwnerDom.fixture.cjs');
const { create } = require('../../src/electron/renderer/limits/legacyAccountList');
const { translate } = require('../../src/electron/renderer/i18n');

function harness(editorConfig = {}) {
  const document = createDocument(), container = document.createElement('div'); document.root.append(container);
  const form = document.createElement('div'); form.id = 'ownedForm'; form.classList.add('hidden');
  const input = document.createElement('input'); input.value = 'draft'; form.append(input); document.root.append(form);
  const replacement = document.createElement('div'); replacement.id = 'ownedReplacement'; replacement.classList.add('hidden'); document.root.append(replacement);
  let busy = false, cancellations = 0;
  const list = create({ document, container, provider: 'fixture', label: 'Fixture', t: (key, params) => translate('en', key, params), bridge: {},
    getContext: () => ({ settings: {} }), preserveScroll: fn => fn(), changed() {}, refresh() {}, busy: () => busy,
    editor: { nodes: ['ownedForm'], visibility: 'ownedForm', cancel() { cancellations++; form.classList.add('hidden'); }, ...editorConfig },
    add() { form.classList.remove('hidden'); }, edit() { (editorConfig.replaceVisibility ? replacement : form).classList.remove('hidden'); } });
  list.update([{ id: 'account', accountKey: 'key' }], []);
  return { document, container, input, form, replacement, list, cancellations: () => cancellations, setBusy: value => { busy = value; list.updateReadings([]); } };
}

test('owned editor stays inside compact card with a live draft across updates and fold/reopen', () => {
  const h = harness(), shell = h.container.querySelector('.legacy-slot-editor'), reveal = h.container.querySelector('.legacy-editor-reveal');
  assert.equal(shell.closest('.slot-list'), h.container.querySelector('.slot-list'));
  assert.equal(reveal.inert, true);
  h.container.querySelector('.slot-add').click();
  assert.equal(reveal.inert, false);
  assert.equal(h.input.value, 'draft');
  assert.equal(h.document.activeElement, h.input);
  h.input.value = 'writing'; h.input.selectionStart = 3;
  h.list.updateReadings([]);
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.input.selectionStart, 3);
  const cancel = shell.children.at(-1).children[0]; cancel.click();
  assert.equal(reveal.inert, true);
  assert.equal(h.cancellations(), 1);
  assert.equal(h.input.value, 'writing');
  h.container.querySelector('.slot-add').click();
  assert.equal(h.input.value, 'writing');
  assert.match(shell.children[0].textContent, /Fixture/);
});

test('busy editor cannot cancel a provider mutation; composing Escape leaves the draft alone', () => {
  const h = harness(), shell = h.container.querySelector('.legacy-slot-editor'), reveal = h.container.querySelector('.legacy-editor-reveal');
  h.container.querySelector('.slot-add').click(); h.setBusy(true);
  const cancel = shell.children.at(-1).children[0];
  assert.equal(cancel.disabled, true); cancel.click();
  assert.equal(h.cancellations(), 0);
  h.setBusy(false);
  reveal.listeners.keydown({ key: 'Escape', isComposing: true });
  assert.equal(h.cancellations(), 0);
  reveal.key('Escape');
  assert.equal(h.cancellations(), 1);
  assert.equal(h.input.value, 'draft');
  assert.equal(h.document.activeElement, h.container.querySelector('.slot-add'));
});

test('replacement uses its owned visibility and returns focus after cancellation', () => {
  const h = harness({ replaceVisibility: 'ownedReplacement' });
  const replace = [...h.container.walk()].find(node => node.dataset.slotAction?.startsWith('replace'));
  replace.click();
  const shell = h.container.querySelector('.legacy-slot-editor'), reveal = h.container.querySelector('.legacy-editor-reveal');
  assert.equal(reveal.inert, false);
  assert.equal(shell.classList.contains('is-replacing'), true);
  assert.equal(h.form.classList.contains('hidden'), true);
  assert.equal(h.replacement.classList.contains('hidden'), false);
  shell.children.at(-1).children[0].click();
  assert.equal(reveal.inert, true);
  assert.equal(h.replacement.classList.contains('hidden'), true);
});
test('native cancellation remains available while login is busy and completion folds the shell', () => {
  let loginOpen = true, cancelled = 0;
  const h = harness({ allowBusyCancel: true, isOpen: () => loginOpen, cancel() { cancelled++; loginOpen = false; } });
  h.setBusy(true);
  const shell = h.container.querySelector('.legacy-slot-editor'), reveal = h.container.querySelector('.legacy-editor-reveal');
  const cancel = shell.children.at(-1).children[0];
  assert.equal(cancel.disabled, false); cancel.click();
  assert.equal(cancelled, 1);
  h.list.updateReadings([]);
  assert.equal(reveal.inert, true);
});

test('native editor visibility follows the owner after login completion', () => {
  let loginOpen = true;
  const h = harness({ isOpen: () => loginOpen, allowBusyCancel: true });
  const reveal = h.container.querySelector('.legacy-editor-reveal');
  assert.equal(reveal.inert, false);
  h.setBusy(true);
  assert.equal(reveal.inert, false);
  loginOpen = false;
  h.setBusy(false);
  assert.equal(reveal.inert, true);
  assert.equal(h.container.querySelector('.slot-add').classList.contains('hidden'), false);
});
