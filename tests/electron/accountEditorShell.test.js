'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocument } = require('./accountOwnerDom.fixture.cjs');
const { create } = require('../../src/electron/renderer/limits/legacyAccountList');
const { translate } = require('../../src/electron/renderer/i18n');

function harness(editorConfig = {}, document = createDocument()) {
  const container = document.createElement('div'); document.root.append(container);
  const form = document.createElement('div'); form.id = 'ownedForm'; form.classList.add('hidden');
  const submitActions = document.createElement('div'); submitActions.className = 'settings-actions';
  const submit = document.createElement('button'); submit.id = 'ownedSubmit'; submitActions.append(submit);
  const input = document.createElement('input'); input.value = 'draft'; form.append(input, submitActions); document.root.append(form);
  const replacement = document.createElement('div'); replacement.id = 'ownedReplacement'; replacement.classList.add('hidden'); document.root.append(replacement);
  let busy = false, cancellations = 0, additions = 0;
  const list = create({ document, container, provider: 'fixture', label: 'Fixture', t: (key, params) => translate('en', key, params), bridge: {},
    getContext: () => ({ settings: {} }), preserveScroll: fn => fn(), changed() {}, refresh() {}, busy: () => busy,
    editor: { nodes: ['ownedForm'], visibility: 'ownedForm', cancel() { cancellations++; form.classList.add('hidden'); }, ...editorConfig },
    add() { additions++; form.classList.remove('hidden'); }, edit() { (editorConfig.replaceVisibility ? replacement : form).classList.remove('hidden'); } });
  list.update([{ id: 'account', accountKey: 'key' }], []);
  return { document, container, input, form, submit, submitActions, replacement, list, cancellations: () => cancellations, additions: () => additions, setBusy: value => { busy = value; list.updateReadings([]); } };
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

for (const replacing of [false, true]) {
  test(`shared cancel joins the declared submit row during ${replacing ? 'edit' : 'add'} without rebuilding owner controls`, () => {
    const h = harness({ submit: 'ownedSubmit' });
    if (replacing) [...h.container.walk()].find(node => node.dataset.slotAction?.startsWith('replace')).click();
    else h.container.querySelector('.slot-add').click();
    const cancel = h.submitActions.children[1];
    assert.equal(cancel.textContent, 'Cancel');
    assert.equal(h.submitActions.children[0], h.submit);
    h.input.focus(); h.input.selectionStart = 2; h.list.updateReadings([]);
    assert.equal(h.submitActions.children[1], cancel);
    assert.equal(h.document.activeElement, h.input);
    assert.equal(h.input.selectionStart, 2);
    h.setBusy(true); assert.equal(cancel.disabled, true);
    h.setBusy(false); cancel.click();
    assert.equal(h.cancellations(), 1);
  });
}
test('a separate replacement protocol gets its own cancel footer rather than the hidden add submit row', () => {
  const h = harness({ submit: 'ownedSubmit', replaceVisibility: 'ownedReplacement' });
  [...h.container.walk()].find(node => node.dataset.slotAction?.startsWith('replace')).click();
  assert.equal(h.submitActions.children.length, 1);
  const footer = h.container.querySelector('.legacy-slot-editor').children.at(-1);
  assert.equal(footer.classList.contains('hidden'), false);
  footer.children[0].click();
  assert.equal(h.replacement.classList.contains('hidden'), true);
});

test('provider account lists precede guidance with live controls and keyboard order preserved', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function prioritizeLimitProviderAccounts(');
  const end = source.indexOf('\nfunction limitProviderQuery()', start);
  for (const wrapped of [false, true]) {
    const document = createDocument();
    const group = document.createElement('div'), details = document.createElement('div');
    details.className = 'cursor-settings-details'; group.append(details); document.root.append(group);
    const body = wrapped ? document.createElement('div') : details;
    if (wrapped) { body.className = 'cursor-settings-details-inner'; details.append(body); }
    const guidance = document.createElement('p'), section = document.createElement('div'), panel = document.createElement('div');
    const draft = document.createElement('input'); draft.value = 'live draft'; draft.selectionStart = 4;
    panel.className = 'slot-panel'; section.append(panel); panel.append(draft); body.append(guidance, section);
    Object.defineProperty(body, 'firstElementChild', { get: () => body.children[0] });
    const originalQuery = body.querySelector.bind(body);
    body.querySelector = selector => selector === '.slot-panel, .managed-account-list, .opencode-profile-list' ? panel : originalQuery(selector);
    draft.focus();
    const context = { group };
    require('node:vm').runInNewContext(source.slice(start, end) + '\nprioritizeLimitProviderAccounts(group);', context);
    assert.equal(body.children[0], section);
    assert.equal(body.children[1], guidance);
    assert.equal(document.activeElement, draft);
    assert.equal(draft.value, 'live draft');
    assert.equal(draft.selectionStart, 4);
    assert.equal(document.moves, 1);
    context.prioritizeLimitProviderAccounts(group);
    assert.equal(document.moves, 1, 'settled order does not move focused controls again');
  }
  const render = source.slice(source.indexOf('function renderLimitProviderCheckboxes('), source.indexOf('async function saveAccountCredential('));
  const connection = render.indexOf('optionsInner.append(limitProviderConnectionDetail(');
  const accounts = render.indexOf('moveLimitProviderLiveNode(optionsInner, accountGroup);');
  const settings = render.indexOf('optionsInner.append(settingsList)');
  const usage = render.indexOf('optionsInner?.append(limitProviderUsageItemsList(');
  assert.ok(connection >= 0 && connection < accounts && accounts < usage && usage < settings);
});

test('busy submit-row cancel settles its observed disabled mutations before returning to the event loop', () => {
  const document = createDocument();
  const observers = [], pending = new Set();
  // Reflect Chromium boolean attributes: setting true emits an attribute
  // mutation even if already true; removing an absent attribute emits none.
  document.defaultView.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
  };
  const h = harness({ submit: 'ownedSubmit' }, document);
  const cancel = h.submitActions.children[1];
  let disabled = cancel.disabled;
  Object.defineProperty(cancel, 'disabled', {
    get: () => disabled,
    set(value) {
      const mutated = Boolean(value) || disabled;
      disabled = Boolean(value);
      if (mutated) for (const observer of observers) {
        if (observer.targets.some(target => target.contains(cancel))) pending.add(observer);
      }
    }
  });
  function settle() {
    for (let round = 0; pending.size && round < 10; round++) {
      const batch = [...pending]; pending.clear();
      for (const observer of batch) observer.callback();
    }
    assert.equal(pending.size, 0, 'editor observer must not perpetually observe its own Cancel writes');
  }
  // Returning to settings while a provider check is pending, then completing
  // it, must keep the editor and provider-owned draft usable on each visit.
  for (let visit = 0; visit < 3; visit++) {
    h.container.querySelector('.slot-add').click();
    h.setBusy(true); settle();
    assert.equal(cancel.disabled, true);
    h.list.updateReadings([]); settle();
    h.setBusy(false); settle();
    assert.equal(cancel.disabled, false);
    cancel.click(); settle();
    assert.equal(h.input.value, 'draft');
    assert.equal(h.container.querySelector('.legacy-editor-reveal').inert, true);
  }
});

for (const native of [false, true]) {
  test(`persistent legacy toggle preserves ${native ? 'native login' : 'manual save'} while busy`, () => {
    let active = false;
    const h = harness(native ? { isOpen: () => active, allowBusyCancel: true } : {});
    // Count/reset initialization, just as provider-owned add callbacks do.
    const add = h.container.querySelector('.slot-add');
    add.click(); active = true;
    h.input.value = '草稿 draft'; h.input.selectionStart = 2;
    h.setBusy(true);
    assert.equal(add.classList.contains('hidden'), false);
    assert.equal(add.disabled, false);
    assert.equal(add.attributes['aria-expanded'], 'true');
    const reveal = h.container.querySelector('.legacy-editor-reveal');
    assert.equal(add.attributes['aria-controls'], reveal.id);
    add.click();
    assert.equal(reveal.inert, true);
    h.list.updateReadings([]);
    assert.equal(reveal.inert, true, 'owner updates must not reopen a collapsed draft');
    add.click();
    assert.equal(reveal.inert, false);
    assert.equal(h.input.value, '草稿 draft');
    assert.equal(h.input.selectionStart, 2);
    assert.equal(h.cancellations(), 0);
    assert.equal(h.additions(), 1);
  });
}
test('persistent entry folds and resumes replacement without switching to add', () => {
  const h = harness({ replaceVisibility: 'ownedReplacement' });
  [...h.container.walk()].find(node => node.dataset.slotAction?.startsWith('replace')).click();
  const add = h.container.querySelector('.slot-add');
  add.click(); add.click();
  assert.equal(h.container.querySelector('.legacy-slot-editor').classList.contains('is-replacing'), true);
  assert.equal(h.form.classList.contains('hidden'), true);
  assert.equal(h.replacement.classList.contains('hidden'), false);
  assert.equal(h.cancellations(), 0);
});

const { createPanel } = require('../../src/electron/renderer/limits/accountSlotsPanel');
const forms = require('../../src/electron/renderer/limits/accountPanels');
const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
function generic(login = false) {
  const document = createDocument(), calls = [], pending = [];
  const form = limitAccountFormsForRenderer().find(form => form.id === (login ? 'copilot' : 'qoder'));
  let cancellations = 0, builds = 0;
  const panel = createPanel({ document, form, label: form.id, t: (key, params) => translate('en', key, params),
    ipc: { list: async () => ({ ok: true, accounts: [] }), add: async (...args) => { calls.push(['add', ...args]); return new Promise(resolve => pending.push(resolve)); }, replace: async (...args) => { calls.push(['replace', ...args]); return { ok: false }; } },
    forms: { resolveOpenUrl: forms.resolveOpenUrl, createCredentialPanel(...args) { builds++; return forms.createCredentialPanel(...args); } },
    preserveScroll: fn => fn(), onChanged() {}, openExternal() {},
    loginAction: { signIn: async () => { calls.push(['login']); return new Promise(resolve => pending.push(resolve)); }, cancelSignIn() { cancellations++; } }
  });
  document.root.append(panel.element);
  return { document, panel, calls, pending, form, builds: () => builds, cancellations: () => cancellations, add: panel.element.querySelector('.slot-add') };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('generic toggle preserves draft, selection and pending save until success', async () => {
  const h = generic(); h.add.click();
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput');
  input.value = '草稿 draft'; input.selectionStart = 2;
  const saving = h.document.getElementById('qoderSlotDraftCredentialSubmit').click(); await flush();
  assert.equal(h.calls.length, 1);
  for (let cycle = 0; cycle < 3; cycle++) {
    h.add.click(); assert.equal(h.add.attributes['aria-expanded'], 'false');
    h.panel.update([], []); h.add.click();
    assert.equal(h.add.attributes['aria-expanded'], 'true');
    assert.equal(h.document.getElementById(input.id), input);
    assert.equal(input.value, '草稿 draft'); assert.equal(input.selectionStart, 2);
  }
  h.panel.openEditor(null);
  assert.equal(h.builds(), 1); assert.equal(h.cancellations(), 0); assert.equal(h.calls.length, 1);
  h.pending[0]({ ok: true, saved: true, verdict: 'valid', accounts: [] }); await saving;
  assert.equal(h.add.attributes['aria-expanded'], 'false');
});
test('generic login and replacement retain identity across toggle cycles', async () => {
  const h = generic(true); h.add.click();
  const signIn = [...h.panel.element.walk()].find(node => node.tagName === 'button' && node.textContent === translate('en', h.form.loginAction.labelKey));
  const login = signIn.click(); await flush();
  h.add.click(); h.add.click(); void signIn.click(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.cancellations(), 0); assert.equal(h.builds(), 1);
  h.pending[0]({ ok: false }); await login;
  const replacement = generic(); replacement.panel.openEditor({ id: 'existing' });
  const editor = replacement.panel.element.querySelector('.slot-editor');
  replacement.add.click(); replacement.add.click();
  assert.equal(replacement.builds(), 1);
  assert.equal(editor.children.some(node => node.classList.contains('credential-input')), false);
  const input = replacement.document.getElementById('qoderSlotDraftqoderCookieInput'); input.value = 'cookie draft';
  await replacement.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.equal(replacement.calls[0][0], 'replace');
  assert.equal(replacement.calls[0][2], 'existing');
});
