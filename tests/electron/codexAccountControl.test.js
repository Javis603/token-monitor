'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCodexAccountControl } = require('../../src/electron/providers/codex/accountControl');

function fakeElement(tagName) {
  const classes = new Set();
  const listeners = new Map();
  const attributes = new Map();
  const node = {
    tagName,
    children: [],
    textContent: '',
    disabled: false,
    hovered: false,
    focused: false,
    classList: {
      add: (name) => classes.add(name),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    matches() { return this.hovered || this.focused; },
    async dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        await listener({ stopPropagation() {}, ...event });
      }
    }
  };
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (value) => {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    }
  });
  return node;
}

function fakeDocument() {
  return { createElement: (tagName) => fakeElement(tagName) };
}

test('shared Codex account control keeps hover, locking, active and failure behavior aligned', async () => {
  let renderCount = 0;
  let resolveSwitch;
  const translations = {
    'limits.codex.activeAccountHint': 'Local',
    'limits.codex.switchAccount': 'Switch',
    'limits.codex.switching': 'Switching',
    'limits.codex.switchFailed': 'Failed',
    'limits.codex.switchFailedShort': 'Failed',
    'limits.codex.switchAccountTitle': 'Switch account',
    'settings.codex.unnamedAccount': 'Unnamed'
  };
  const control = createCodexAccountControl({
    document: fakeDocument(),
    requestAnimationFrame: (callback) => callback(),
    translate: (key) => translations[key] || key,
    requestRender: () => { renderCount += 1; },
    switchAccount: () => new Promise((resolve) => { resolveSwitch = resolve; })
  });
  const zone = control.render({
    titleNode: fakeElement('span'),
    switchAccount: { id: 'account-a' },
    accountLabel: 'a@example.com'
  });
  const button = zone.children[1].children[0];
  zone.hovered = true;
  await zone.dispatch('pointerenter');
  assert.equal(control.deferRender({ querySelector: () => zone }), true);
  zone.hovered = false;
  await zone.dispatch('pointerleave');
  assert.equal(renderCount, 1, 'the deferred stats repaint resumes after hover ends');

  const switching = button.dispatch('click');
  await Promise.resolve();
  const otherZone = control.render({
    titleNode: fakeElement('span'),
    switchAccount: { id: 'account-b' },
    accountLabel: 'b@example.com'
  });
  assert.equal(otherZone.children[1].children[0].disabled, true, 'one switch locks every account row');
  resolveSwitch({ ok: false, error: 'Credential write failed' });
  await switching;

  const failedZone = control.render({
    titleNode: fakeElement('span'),
    switchAccount: { id: 'account-a' },
    accountLabel: 'a@example.com'
  });
  const failedButton = failedZone.children[1].children[0];
  assert.equal(failedZone.classList.contains('is-error'), true);
  assert.equal(failedButton.textContent, 'Failed');
  assert.equal(failedButton.title, 'Credential write failed');

  const activeZone = control.render({ titleNode: fakeElement('span'), active: true });
  assert.equal(activeZone.classList.contains('limit-account-active-zone'), true);
  assert.equal(activeZone.children[1].textContent, '\u2713');
  assert.equal(activeZone.children[2].textContent, 'Local');
});
