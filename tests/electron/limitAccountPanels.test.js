'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createSingleCredentialPanel } = require('../../src/electron/renderer/limits/accountPanels');
const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const i18n = require('../../src/electron/renderer/i18n');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.value = '';
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name)
    };
  }

  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  *walk() {
    yield this;
    for (const child of this.children) if (child instanceof Element) yield* child.walk();
  }
  byId(id) { return [...this.walk()].find((node) => node.id === id); }
  click() { return this.listeners.click(); }
}

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} renders a localized account panel and hands the draft to the caller`, async () => {
    const calls = [];
    const translated = (key, params) => i18n.translate('en', key, params);
    let save = async (_, value) => {
      calls.push(value);
      throw new Error('test failure');
    };
    const group = createSingleCredentialPanel(form, {
      document: { createElement: (tag) => new Element(tag) },
      translate: translated,
      onToggle: () => {},
      onOpen: () => {},
      onClear: () => {},
      onRefresh: () => {},
      onSave: (...args) => save(...args)
    });
    const input = group.byId(`${form.field}Input`);
    const error = group.byId(`${form.id}ErrorMessage`);
    const submit = group.byId(`${form.id}${form.input === 'textarea' ? 'CookieSubmit' : 'ApiKeySubmit'}`);
    assert.equal(group.byId(`${form.id}SettingsToggle`).attributes['aria-controls'], `${form.id}SettingsDetails`);
    assert.equal(group.byId(`${form.id}ManualPanel`).className, 'single-credential-manual-panel');
    assert.equal(group.byId(`${form.id}SettingsToggle`).children[0].textContent, translated(form.titleKey));
    assert.equal(input.placeholder, translated(form.placeholderKey));
    assert.equal(input.tagName, form.input === 'textarea' ? 'textarea' : 'input');
    if (form.input === 'textarea') assert.equal(input.rows, 3);
    else assert.equal(input.type, 'password');
    if (form.ariaLabelKey) assert.equal(input.attributes['aria-label'], translated(form.ariaLabelKey));
    if (form.noteKey) assert.equal(group.byId(`${form.id}ManualPanel`).children[0].textContent, translated(form.noteKey));

    // Even an empty draft reaches the caller: whether it is empty, rejected or
    // saved is the save path's call, and so is the message line.
    input.value = 'sample';
    await assert.rejects(submit.click(), /test failure/);
    assert.deepEqual(calls, ['sample']);
    assert.equal(input.value, 'sample');
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, translated(form.saveKey));
    assert.equal(error.classList.contains('hidden'), true);
    save = async (_, value, clearInput) => {
      calls.push(value);
      assert.equal(submit.textContent, translated('settings.common.checking'));
      clearInput();
    };
    await submit.click();
    assert.equal(input.value, '');
  });
}

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} ignores a second submit while the first save is pending`, async () => {
    let finish;
    let saves = 0;
    const group = createSingleCredentialPanel(form, {
      document: { createElement: (tag) => new Element(tag) },
      translate: (key) => i18n.translate('en', key),
      onToggle: () => {}, onOpen: () => {}, onClear: () => {}, onRefresh: () => {},
      onSave: async () => {
        saves++;
        await new Promise((resolve) => { finish = resolve; });
      }
    });
    group.byId(`${form.field}Input`).value = 'sample';
    const submit = group.byId(`${form.id}${form.input === 'textarea' ? 'CookieSubmit' : 'ApiKeySubmit'}`);
    const first = submit.click();
    assert.equal(submit.disabled, true);
    await submit.click();
    assert.equal(saves, 1);
    finish();
    await first;
    assert.equal(submit.disabled, false);
  });
}

// The save path every account form shares, run from app.js against a fake IPC.
function accountFormSave({ result, reject } = {}) {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const slice = (from, to) => {
    const start = app.indexOf(from);
    const end = app.indexOf(to, start);
    assert.ok(start !== -1 && end !== -1, `${from} should exist`);
    return app.slice(start, end);
  };
  const calls = [];
  const state = { accountPanelMessages: {}, settingsPushRevision: 0 };
  const context = {
    state,
    LIMIT_PROVIDERS: [{ id: 'deepseek', label: 'DeepSeek' }],
    window: { tokenMonitor: { limits: {
      saveCredential: async (...args) => {
        calls.push(['saveCredential', ...args]);
        if (reject) throw reject;
        return result;
      }
    } } },
    applyPersistedSettings: (settings) => calls.push(['applyPersistedSettings', settings]),
    renderExternalProviderStatus: () => calls.push(['render', { ...state.accountPanelMessages }]),
    markExternalProviderCheckPending: (id) => calls.push(['markPending', id]),
    refreshStats: async () => calls.push(['refreshStats']),
    setExternalAccountExpanded: (id, expanded) => calls.push(['expanded', id, expanded]),
    externalProviderAccountLinked: () => false
  };
  vm.runInNewContext(
    slice('function setAccountPanelMessage(', '\nfunction markExternalProviderCheckPending(')
      + slice('async function saveAccountFormCredential(', '\nfunction limitAccountForm('),
    context
  );
  const form = {
    id: 'deepseek',
    field: 'deepseekApiKey',
    emptyKey: 'settings.deepseek.statusNotSet',
    failedKey: 'settings.deepseek.saveFailed'
  };
  let cleared = false;
  return {
    calls,
    state,
    run: async (value, overrides = {}) => {
      cleared = false;
      await context.saveAccountFormCredential({ ...form, ...overrides }, value, () => { cleared = true; });
      return cleared;
    }
  };
}

test('an empty draft asks for the credential without calling main', async () => {
  const save = accountFormSave();
  assert.equal(await save.run('   '), false);
  assert.equal(save.calls.some(([name]) => name === 'saveCredential'), false);
  assert.deepEqual({ ...save.state.accountPanelMessages.deepseek }, { key: 'settings.common.credentialRequired' });
});

test('a rejected credential keeps the draft and the current status', async () => {
  for (const [result, expected] of [
    [{ saved: false, verdict: 'invalid', status: 'unauthorized' },
      { key: 'settings.common.credentialRejected', params: { provider: 'DeepSeek' } }],
    [{ saved: false, verdict: 'invalid', status: 'invalidFormat' },
      { key: 'settings.common.credentialInvalidFormat' }]
  ]) {
    const save = accountFormSave({ result });
    assert.equal(await save.run('sk-test'), false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(save.calls.find(([name]) => name === 'saveCredential'))),
      ['saveCredential', 'deepseek', { deepseekApiKey: 'sk-test' }]
    );
    assert.equal(save.calls.some(([name]) => name === 'markPending'), false, 'a rejected key must not drop the linked status');
    assert.deepEqual(JSON.parse(JSON.stringify(save.state.accountPanelMessages.deepseek)), expected);
  }
  const clineStyle = accountFormSave({ result: { saved: false, verdict: 'invalid', status: 'unauthorized' } });
  await clineStyle.run('sk-test', { validation: { invalidKey: 'settings.cline.validationInvalid' } });
  assert.equal(clineStyle.state.accountPanelMessages.deepseek.key, 'settings.cline.validationInvalid');
});

test('a confirmed credential is cleared from the draft and re-checked', async () => {
  const save = accountFormSave({ result: { saved: true, verdict: 'valid', status: 'ok', settings: { next: true } } });
  assert.equal(await save.run('sk-test'), true);
  assert.deepEqual(save.calls.map(([name]) => name), [
    'render', 'saveCredential', 'applyPersistedSettings', 'markPending', 'render', 'refreshStats', 'expanded', 'render'
  ]);
  assert.equal(save.state.accountPanelMessages.deepseek, undefined);
});

test('a credential the probe could not confirm is saved with a notice that retires on the next check', async () => {
  for (const [status, key] of [
    ['sourceRateLimited', 'settings.common.credentialSavedRateLimited'],
    ['rateLimited', 'settings.common.credentialSavedRateLimited'],
    ['unavailable', 'settings.common.credentialSavedUnconfirmed'],
    ['error', 'settings.common.credentialSavedUnconfirmed']
  ]) {
    const save = accountFormSave({ result: { saved: true, verdict: 'indeterminate', status } });
    assert.equal(await save.run('sk-test'), true, status);
    assert.ok(save.calls.some(([name]) => name === 'markPending'), status);
    assert.deepEqual(JSON.parse(JSON.stringify(save.state.accountPanelMessages.deepseek)), {
      key, params: { provider: 'DeepSeek' }, tone: 'notice', untilChecked: true
    }, status);
  }
});

test('a superseded save changes nothing and a failed write names the error', async () => {
  const superseded = accountFormSave({ result: { saved: false, verdict: 'superseded', status: 'superseded' } });
  assert.equal(await superseded.run('sk-test'), false);
  assert.equal(superseded.state.accountPanelMessages.deepseek, undefined);
  assert.equal(superseded.calls.some(([name]) => name === 'markPending'), false);

  const failed = accountFormSave({ reject: new Error('disk full') });
  assert.equal(await failed.run('sk-test'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(failed.state.accountPanelMessages.deepseek)), {
    key: 'settings.deepseek.saveFailed', params: { message: 'disk full' }
  });
});

test('every shared account message exists in each locale with its placeholders', () => {
  for (const [key, params] of [
    ['settings.common.credentialRequired', []],
    ['settings.common.credentialInvalidFormat', []],
    ['settings.common.credentialRejected', ['provider']],
    ['settings.common.credentialSavedRateLimited', ['provider']],
    ['settings.common.credentialSavedUnconfirmed', ['provider']]
  ]) {
    for (const [locale, messages] of Object.entries(i18n.MESSAGES)) {
      assert.ok(Object.hasOwn(messages, key), `${key} missing in ${locale}`);
      for (const param of params) assert.match(messages[key], new RegExp(`\\{${param}\\}`), `${key} ${locale}`);
    }
  }
});
