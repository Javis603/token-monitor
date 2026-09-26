'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createCredentialPanel } = require('../../src/electron/renderer/limits/accountPanels');
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
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name))
    };
  }

  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  get text() {
    return this.children.map((child) => (child instanceof Element ? child.text : String(child.textContent ?? child))).join('')
      || this.textContent || '';
  }
  *walk() {
    yield this;
    for (const child of this.children) if (child instanceof Element) yield* child.walk();
  }
  byId(id) { return [...this.walk()].find((node) => node.id === id); }
  click() { return this.listeners.click(); }
  change(value) { this.value = value; return this.listeners.change(); }
}

// A document whose lookups see the one panel under test, the way the live one
// sees it once the panel is inserted.
function panelDocument() {
  let root = null;
  return {
    setRoot: (node) => { root = node; },
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: (id) => root?.byId(id) || null,
    querySelectorAll: (selector) => {
      const form = selector.match(/data-credential-form="([^"]+)"/)?.[1];
      return root ? [...root.walk()].filter((node) => node.dataset.credentialForm === form && node.dataset.byField) : [];
    }
  };
}

function renderPanel(form, callbacks = {}) {
  const document = panelDocument();
  const group = createCredentialPanel(form, {
    document,
    translate: (key, params) => i18n.translate('en', key, params),
    onToggle: () => {}, onOpen: () => {}, onClear: () => {}, onRefresh: () => {}, onSave: async () => {},
    ...callbacks
  });
  document.setRoot(group);
  return { group, document };
}

const translated = (key, params) => i18n.translate('en', key, params);

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} renders a localized account panel and hands the draft to the caller`, async () => {
    const calls = [];
    let save = async (_, values) => {
      calls.push(values);
      throw new Error('test failure');
    };
    const { group } = renderPanel(form, { onSave: (...args) => save(...args) });
    const error = group.byId(`${form.id}ErrorMessage`);
    const submit = group.byId(`${form.id}CredentialSubmit`);
    const manual = group.byId(`${form.id}ManualPanel`);
    assert.equal(group.byId(`${form.id}SettingsToggle`).attributes['aria-controls'], `${form.id}SettingsDetails`);
    assert.equal(manual.className, 'credential-manual-panel');
    assert.equal(group.byId(`${form.id}SettingsToggle`).children[0].textContent, translated(form.titleKey));
    for (const field of form.fields) {
      const input = group.byId(`${field.key}Input`);
      assert.ok(input, `${field.key} control`);
      const placedInManual = [...manual.walk()].includes(input);
      assert.equal(placedInManual, form.manual.some((block) => block.field === field.key), `${field.key} placement`);
      if (field.input === 'select') {
        assert.equal(input.tagName, 'select');
        assert.deepEqual(input.children.map((option) => option.value), field.options.map((option) => option.value));
        continue;
      }
      assert.equal(input.tagName, field.input === 'textarea' ? 'textarea' : 'input');
      if (field.input === 'textarea') assert.equal(input.rows, 3);
      else assert.equal(input.type, field.input);
      if (field.placeholderKey) assert.equal(input.placeholder, translated(field.placeholderKey));
      if (field.ariaLabelKey) assert.equal(input.attributes['aria-label'], translated(field.ariaLabelKey));
      input.value = `${field.key}-draft`;
    }

    // Every field reaches the caller: whether the draft is complete, rejected
    // or saved is the save path's call, and so is the message line.
    const expected = Object.fromEntries(form.fields.map((field) => [
      field.key,
      field.input === 'select' ? field.options[0].value : `${field.key}-draft`
    ]));
    for (const field of form.fields) if (field.input === 'select') group.byId(`${field.key}Input`).value = field.options[0].value;
    await assert.rejects(submit.click(), /test failure/);
    assert.deepEqual(calls, [expected]);
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, translated(form.saveKey));
    assert.equal(error.classList.contains('hidden'), true);
    save = async (_, values, clearInput) => {
      assert.equal(submit.textContent, translated('settings.common.checking'));
      clearInput();
    };
    await submit.click();
    // Clearing the draft empties secrets and leaves settings beside them.
    for (const field of form.fields) {
      assert.equal(group.byId(`${field.key}Input`).value, field.secret ? '' : expected[field.key], field.key);
    }
  });
}

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} ignores a second submit while the first save is pending`, async () => {
    let finish;
    let saves = 0;
    const { group } = renderPanel(form, {
      onSave: async () => {
        saves++;
        await new Promise((resolve) => { finish = resolve; });
      }
    });
    const submit = group.byId(`${form.id}CredentialSubmit`);
    const first = submit.click();
    assert.equal(submit.disabled, true);
    await submit.click();
    assert.equal(saves, 1);
    finish();
    await first;
    assert.equal(submit.disabled, false);
  });
}

test('selects drive their dependent hints, notes and landing page before they are saved', async () => {
  const forms = Object.fromEntries(limitAccountFormsForRenderer().map((form) => [form.id, form]));
  const { resolveOpenUrl, syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');

  const changes = [];
  const alibaba = renderPanel(forms.alibaba, { onFieldChange: (_, field, value) => changes.push([field.key, value]) });
  const variant = alibaba.group.byId('alibabaVariantInput');
  const hint = [...alibaba.group.walk()].find((node) => node.tagName === 'code' && node.dataset.byField);
  const personalNote = [...alibaba.group.walk()].find((node) => node.dataset.i18n === 'settings.alibaba.personalNote');
  syncCredentialFields(forms.alibaba, { document: alibaba.document, settings: { alibabaVariant: 'intl' } });
  assert.equal(variant.value, 'intl');
  assert.equal(hint.textContent, 'GetSubscriptionSummary');
  assert.equal(personalNote.classList.contains('hidden'), true);
  await variant.change('cn-personal');
  assert.equal(hint.textContent, '/tokenplan/personal/api/v2/usage');
  assert.equal(personalNote.classList.contains('hidden'), false);
  assert.deepEqual(changes, [['alibabaVariant', 'cn-personal']]);
  assert.match(resolveOpenUrl(forms.alibaba, { document: alibaba.document }), /token-plan\/personal$/);

  // An unknown or empty stored value falls back to the first option.
  syncCredentialFields(forms.alibaba, { document: alibaba.document, settings: { alibabaVariant: '' } });
  assert.equal(variant.value, 'cn');

  const qoder = renderPanel(forms.qoder);
  syncCredentialFields(forms.qoder, { document: qoder.document, settings: { qoderSite: 'cn' } });
  assert.equal(qoder.group.byId('qoderSiteInput').value, 'cn');
  assert.match(qoder.group.byId('qoderManualPanel').text, /qoder\.com\.cn\/account\/usage/);
  assert.equal(resolveOpenUrl(forms.qoder, { document: qoder.document }), 'https://qoder.com.cn/account/usage');

  const zai = renderPanel(forms.zai);
  syncCredentialFields(forms.zai, { document: zai.document, settings: { zaiApiRegion: 'bigmodel-cn' } });
  assert.equal(resolveOpenUrl(forms.zai, { document: zai.document }), 'https://bigmodel.cn/coding-plan/personal/usage');
  assert.equal([...zai.group.byId('zaiManualPanel').walk()].some((node) => node.id === 'zaiApiRegionInput'), false,
    'the region stays reachable once the paste panel hides');

  // MiniMax follows the region of its last successful poll.
  assert.equal(resolveOpenUrl(forms.minimax, { provider: { region: 'en' } }), 'https://platform.minimax.io/user-center/payment/token-plan');
  assert.equal(resolveOpenUrl(forms.minimax, { provider: null }), 'https://platform.minimaxi.com/user-center/payment/token-plan');
});

test('a plain-text setting is shown again after a save, a secret never is', () => {
  const forms = Object.fromEntries(limitAccountFormsForRenderer().map((form) => [form.id, form]));
  const { syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');
  const devin = renderPanel(forms.devin);
  syncCredentialFields(forms.devin, { document: devin.document, settings: { devinOrganization: 'org_1', devinBearerToken: 'set' } });
  assert.equal(devin.group.byId('devinOrganizationInput').value, 'org_1');
  assert.equal(devin.group.byId('devinBearerTokenInput').value, '');
  const trae = renderPanel(forms.trae);
  syncCredentialFields(forms.trae, { document: trae.document, settings: { traeDeviceId: 'set' } });
  assert.equal(trae.group.byId('traeDeviceIdInput').value, '');
});

// The save path every account panel shares, run from app.js against a fake IPC.
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
      + slice('async function saveAccountCredential(', '\nfunction limitAccountForm('),
    context
  );
  let cleared = false;
  return {
    calls,
    state,
    message: () => JSON.parse(JSON.stringify(state.accountPanelMessages.deepseek ?? null)),
    run: async (values, options = {}) => {
      cleared = false;
      await context.saveAccountCredential('deepseek', values, {
        failedKey: 'settings.deepseek.saveFailed',
        clearInput: () => { cleared = true; },
        ...options
      });
      return cleared;
    }
  };
}

test('a rejected or incomplete draft keeps the draft and the current status', async () => {
  for (const [result, expected, messages] of [
    [{ saved: false, verdict: 'invalid', status: 'unauthorized' },
      { key: 'settings.common.credentialRejected', params: { provider: 'DeepSeek' } }],
    [{ saved: false, verdict: 'invalid', status: 'invalidFormat' },
      { key: 'settings.common.credentialInvalidFormat' }],
    [{ saved: false, verdict: 'invalid', status: 'required' },
      { key: 'settings.common.credentialRequired' }],
    // A panel may replace each shared message with its own guidance.
    [{ saved: false, verdict: 'invalid', status: 'unauthorized' },
      { key: 'settings.cline.validationInvalid', params: { provider: 'DeepSeek' } }, { rejected: 'settings.cline.validationInvalid' }],
    [{ saved: false, verdict: 'invalid', status: 'required' },
      { key: 'settings.devin.credentialsRequired' }, { required: 'settings.devin.credentialsRequired' }]
  ]) {
    const save = accountFormSave({ result });
    assert.equal(await save.run({ deepseekApiKey: 'sk-test' }, messages ? { messages } : {}), false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(save.calls.find(([name]) => name === 'saveCredential'))),
      ['saveCredential', 'deepseek', { deepseekApiKey: 'sk-test' }]
    );
    assert.equal(save.calls.some(([name]) => name === 'markPending'), false, 'a rejected key must not drop the linked status');
    assert.deepEqual(save.message(), expected);
  }
});

test('a confirmed credential is cleared from the draft and re-checked', async () => {
  const save = accountFormSave({ result: { saved: true, verdict: 'valid', status: 'ok', settings: { next: true } } });
  assert.equal(await save.run({ deepseekApiKey: 'sk-test' }), true);
  assert.deepEqual(save.calls.map(([name]) => name), [
    'render', 'saveCredential', 'applyPersistedSettings', 'markPending', 'render', 'refreshStats', 'expanded', 'render'
  ]);
  assert.equal(save.message(), null);
});

test('a credential the probe could not confirm is saved with a notice that retires on the next check', async () => {
  for (const [status, key] of [
    ['sourceRateLimited', 'settings.common.credentialSavedRateLimited'],
    ['rateLimited', 'settings.common.credentialSavedRateLimited'],
    ['unavailable', 'settings.common.credentialSavedUnconfirmed'],
    ['error', 'settings.common.credentialSavedUnconfirmed']
  ]) {
    const save = accountFormSave({ result: { saved: true, verdict: 'indeterminate', status } });
    assert.equal(await save.run({ deepseekApiKey: 'sk-test' }), true, status);
    assert.ok(save.calls.some(([name]) => name === 'markPending'), status);
    assert.deepEqual(save.message(), { key, params: { provider: 'DeepSeek' }, tone: 'notice', untilChecked: true }, status);
  }
});

test('a superseded save changes nothing and a failed write names the error', async () => {
  const superseded = accountFormSave({ result: { saved: false, verdict: 'superseded', status: 'superseded' } });
  assert.equal(await superseded.run({ deepseekApiKey: 'sk-test' }), false);
  assert.equal(superseded.message(), null);
  assert.equal(superseded.calls.some(([name]) => name === 'markPending'), false);

  const failed = accountFormSave({ reject: new Error('disk full') });
  assert.equal(await failed.run({ deepseekApiKey: 'sk-test' }), false);
  assert.deepEqual(failed.message(), { key: 'settings.deepseek.saveFailed', params: { message: 'disk full' } });
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
