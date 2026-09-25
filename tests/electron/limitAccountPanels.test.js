'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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
  test(`${form.id} renders a localized account panel and preserves the draft on failure`, async () => {
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
    input.value = '   ';
    await submit.click();
    assert.equal(calls.length, 0);
    assert.equal(error.textContent, translated(form.emptyKey));
    assert.equal(error.classList.contains('hidden'), false);
    input.value = 'sample';
    await submit.click();
    assert.deepEqual(calls, ['sample']);
    assert.equal(input.value, 'sample');
    assert.equal(error.textContent, translated(form.failedKey, { message: 'test failure' }));
    save = async (_, value, clearInput) => {
      calls.push(value);
      clearInput();
    };
    await submit.click();
    assert.equal(input.value, '');
    assert.equal(error.classList.contains('hidden'), true);
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

for (const form of limitAccountFormsForRenderer().filter((entry) => entry.validation)) {
  test(`${form.id} validation shows provider-specific errors and never clears an unvalidated draft`, async () => {
    const translated = (key, params) => i18n.translate('en', key, params);
    let result;
    const group = createSingleCredentialPanel(form, {
      document: { createElement: (tag) => new Element(tag) },
      translate: translated,
      onToggle: () => {}, onOpen: () => {}, onClear: () => {}, onRefresh: () => {},
      onSave: async (_, value, clearInput) => {
        if (result instanceof Error) throw result;
        if (result) {
          const error = new Error('validation failed');
          error.validationStatus = result;
          throw error;
        }
        clearInput();
      }
    });
    const input = group.byId(`${form.field}Input`);
    const submit = group.byId(`${form.id}ApiKeySubmit`);
    const error = group.byId(`${form.id}ErrorMessage`);
    input.value = 'sample';
    for (const [status, key] of [
      ['unauthorized', form.validation.invalidKey],
      ['rateLimited', form.validation.rateLimitedKey],
      ['sourceRateLimited', form.validation.rateLimitedKey],
      ['unavailable', form.validation.unavailableKey]
    ]) {
      result = status;
      await submit.click();
      assert.equal(input.value, 'sample');
      assert.equal(error.textContent, translated(key));
      assert.equal(submit.disabled, false);
      assert.equal(submit.textContent, translated(form.saveKey));
    }
    result = new Error('save failed');
    await submit.click();
    assert.equal(error.textContent, translated(form.failedKey, { message: 'save failed' }));
    assert.equal(input.value, 'sample');
    result = null;
    await submit.click();
    assert.equal(input.value, '');
  });
}
