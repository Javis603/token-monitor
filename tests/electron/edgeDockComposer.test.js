'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { addableLimitProviders, createEdgeDockComposer } = require('../../src/electron/renderer/edgeDock/composer');
const itemsApi = require('../../src/electron/renderer/edgeDock/items');
const { limitWindowLabel } = require('../../src/shared/limits/windowLabels');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('a stats-only repaint keeps an open window picker and its labels match the Limits view', () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.style = { setProperty() {} };
      this.classList = { toggle() {}, add() {} };
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get firstChild() { return this.children[0]; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute() {}
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  }
  const previousDocument = global.document;
  const document = { createElement: (tag) => new Element(tag), activeElement: null };
  global.document = document;
  try {
    const root = new Element('div');
    const settings = { edgeDockItems: [{ type: 'limit', provider: 'claude' }] };
    let stats = { limits: { providers: [{ provider: 'claude', status: 'ok', windows: [
      { kind: 'session', label: 'Session', remainingPercent: 100 },
      { kind: 'weekly', label: 'Weekly', remainingPercent: 19 }
    ] }] }, periods: { today: { totalTokens: 100 } } };
    const composer = createEdgeDockComposer({
      root, itemsApi,
      t: (key) => key,
      presentationApi: {},
      getSettings: () => settings,
      getStats: () => stats,
      save: () => {},
      providerLabel: (id) => id,
      providerColor: () => '#fff',
      windowLabel: (record, quotaWindow) => limitWindowLabel(record.provider, quotaWindow),
      hasProviderMark: () => true,
      maskEmail: (email) => email,
      createRowDrag: () => ({ deferRender: () => false })
    });
    const find = (node, tag) => node.tagName === tag ? node : node.children.map((child) => find(child, tag)).find(Boolean);
    composer.render();
    const button = root.children[1].children[0].children.find((node) => node.dataset.itemId);
    button.listeners.click();
    const select = find(root, 'SELECT');
    assert.deepEqual(select.children.map((option) => option.textContent), [
      'settings.edgeDock.window.auto', 'Session', 'Weekly'
    ]);
    document.activeElement = select;
    stats = { ...stats, periods: { today: { totalTokens: 200 } } };
    composer.render();
    assert.equal(find(root, 'SELECT'), select);
    stats = { ...stats, limits: { providers: [{ ...stats.limits.providers[0], windows: [
      { kind: 'session', label: 'Session', remainingPercent: 90 },
      { kind: 'weekly', label: 'Weekly', remainingPercent: 19 },
      { kind: 'billing', label: 'Monthly', remainingPercent: 70 }
    ] }] } };
    composer.render();
    assert.equal(find(root, 'SELECT'), select);
    document.activeElement = null;
    composer.render();
    assert.notEqual(find(root, 'SELECT'), select);
    assert.equal(find(root, 'SELECT').children.at(-1).textContent, 'Monthly');
  } finally {
    global.document = previousDocument;
  }
});

// A provider that reports no quota has no cell in automatic mode. The add menu
// still needs to offer it alongside the connected providers.
test('a provider the user enabled but that reports nothing is still offered', () => {
  assert.deepEqual(
    addableLimitProviders(['claude', 'codex', 'cursor'], ['codex']),
    ['claude', 'cursor']
  );
});

test('the order is the one it was handed, so the menu follows the limits order', () => {
  assert.deepEqual(
    addableLimitProviders(['cursor', 'claude', 'codex'], []),
    ['cursor', 'claude', 'codex']
  );
});

test('providers already added to the dock are skipped', () => {
  assert.deepEqual(addableLimitProviders(['claude', 'codex'], ['codex', 'claude']), []);
});

test('ids are compared case-insensitively, so a cased entry cannot double up', () => {
  assert.deepEqual(addableLimitProviders(['Claude', 'codex'], ['CLAUDE']), ['codex']);
});

test('nothing enabled and nothing left both yield an empty section', () => {
  assert.deepEqual(addableLimitProviders([], ['codex']), []);
  assert.deepEqual(addableLimitProviders(undefined, undefined), []);
  assert.deepEqual(addableLimitProviders(['claude'], ['claude']), []);
});

// The rule above is only worth anything if the menu asks it: a helper that exists
// but is never wired would pass every test above and still leave the gap open.
test('the add menu offers all enabled providers in one limits section', () => {
  const composer = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'composer.js'), 'utf8');
  assert.match(composer, /section\('settings\.edgeDock\.addLimits', addableLimitProviders\(/);
  assert.match(composer, /addableLimitProviders\(\s*enabledLimitProviders\?\.\(\) \|\| connectedProviders\(\),/);
});

test('the composer is handed the enabled providers in the user\'s limits order', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /enabledLimitProviders: \(\) => limitProviderOrderApi/);
  assert.match(app, /\.orderedLimitProviders\(LIMIT_PROVIDERS, state\.settings\?\.limitProviderOrder\)/);
  assert.match(app, /\.filter\(\(\{ id \}\) => enabledLimitProviderSet\(\)\.has\(id\)\)/);
});
