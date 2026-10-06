'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { addableLimitProviders, createEdgeDockComposer } = require('../../src/electron/renderer/edgeDock/composer');
const itemsApi = require('../../src/electron/renderer/edgeDock/items');
const { limitWindowLabel, mimoProductLabel } = require('../../src/shared/limits/windowLabels');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

// Just enough DOM for the composer: it builds with createElement and appends.
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

function accountChoices(provider, rows, presentationApi) {
  const root = new Element('div');
  const composer = createEdgeDockComposer({
    root, itemsApi, t: (key) => key,
    presentationApi,
    getSettings: () => ({ edgeDockItems: [{ type: 'limit', provider }] }),
    getStats: () => ({ limits: { providers: rows } }), save: () => {},
    providerLabel: (id) => id, providerColor: () => '#000000', hasProviderMark: () => false,
    maskEmail: (email) => email, mimoProductLabel,
    createRowDrag: () => ({ deferRender: () => false })
  });
  const all = (node) => [node, ...node.children.flatMap(all)];
  composer.render();
  all(root).find((node) => node.className === 'edge-dock-composer-item').listeners.click();
  return {
    composer,
    names: () => all(root).filter((node) => node.className === 'edge-dock-composer-account-name').map((node) => node.textContent)
  };
}

test('dock account choices distinguish MiMo products without changing sibling providers', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const labels = (provider, rows) => accountChoices(provider, rows, { connectedLimitProviders: () => [provider] }).names();
    assert.deepEqual(labels('mimo', [
      { provider: 'mimo', accountKey: 'console', accountName: 'MiMo abcdef1', accountLabel: 'Console' },
      { provider: 'mimo', accountKey: 'membership', accountName: 'MiMo abcdef1', accountLabel: 'Desktop Membership' }
    ]), ['MiMo abcdef1 · Console', 'MiMo abcdef1 · Desktop Membership']);
    assert.deepEqual(labels('mimo', [
      { provider: 'mimo', accountKey: 'console', accountLabel: 'Console', planLabel: 'Pay-as-you-go' },
      { provider: 'mimo', accountKey: 'membership', accountLabel: 'Desktop Membership', planLabel: 'Pro' }
    ]), ['Console', 'Desktop Membership']);
    assert.deepEqual(labels('codex', [
      { provider: 'codex', accountKey: 'a', accountName: 'Account A', accountLabel: 'Console' },
      { provider: 'codex', accountKey: 'b', accountName: 'Account B' }
    ]), ['Account A', 'Account B']);
    assert.deepEqual(labels('volcengine', [
      { provider: 'volcengine', accountKey: 'coding', accountLabel: 'Coding Plan', planLabel: 'Coding Plan' },
      { provider: 'volcengine', accountKey: 'agent', accountLabel: 'Agent Plan', planLabel: 'Agent Plan' }
    ]), ['Coding Plan', 'Agent Plan']);
  } finally {
    global.document = previousDocument;
  }
});

test('a MiMo product label change repaints its account choices', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const rows = ['a', 'b'].map((accountKey) => ({ provider: 'mimo', accountKey, accountName: 'MiMo abcdef1', planLabel: 'Pro' }));
    const { composer, names } = accountChoices('mimo', rows, {});
    assert.deepEqual(names(), ['MiMo abcdef1', 'MiMo abcdef1']);
    rows[1].accountLabel = 'Desktop Membership';
    composer.render();
    assert.deepEqual(names(), ['MiMo abcdef1', 'MiMo abcdef1 · Desktop Membership']);
  } finally {
    global.document = previousDocument;
  }
});

test('a stats-only repaint keeps an open window picker and its labels match the Limits view', () => {
  const previousDocument = global.document;
  const document = { createElement: (tag) => new Element(tag), activeElement: null };
  global.document = document;
  try {
    const root = new Element('div');
    const saves = [];
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
      save: (change) => saves.push(change),
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
    const nextControl = find(root, 'INPUT');
    document.activeElement = nextControl;
    select.listeners.blur();
    assert.equal(find(root, 'SELECT'), select);
    assert.equal(select.children.at(-1).textContent, 'Monthly');
    assert.equal(root.contains(nextControl), true);
    assert.equal(document.activeElement, nextControl);
    assert.equal(saves.length, 0, 'refreshing options must not save a selection');
    nextControl.checked = false;
    nextControl.listeners.change();
    assert.equal(saves.at(-1).edgeDockItems[0].showUsage, false);

    document.activeElement = select;
    stats.limits.providers[0].windows.pop();
    composer.render();
    assert.equal(select.children.at(-1).textContent, 'Monthly');
    document.activeElement = null;
    select.listeners.blur();
    assert.deepEqual(select.children.map((option) => option.textContent), [
      'settings.edgeDock.window.auto', 'Session', 'Weekly'
    ]);

    const first = { kind: 'session', label: 'Some quota', limitId: 'feature-a', windowMinutes: 300, additional: true };
    const second = { ...first, limitId: 'feature-b' };
    const secondary = { ...second, windowMinutes: 600 };
    settings.edgeDockItems = [{ type: 'limit', provider: 'codex', windowKey: itemsApi.limitWindowKey(second) }];
    stats = { limits: { providers: [{ provider: 'codex', windows: [first, second, secondary] }] } };
    composer.render();
    root.children[1].children[0].children.find((node) => node.dataset.itemId).listeners.click();
    const pinnedSelect = find(root, 'SELECT');
    assert.equal(new Set(pinnedSelect.children.map((option) => option.value)).size, 4);
    assert.equal(pinnedSelect.value, itemsApi.limitWindowKey(second));
    stats.limits.providers[0].windows[1] = { ...second, label: 'Renamed quota' };
    composer.render();
    assert.equal(find(root, 'SELECT').value, itemsApi.limitWindowKey(second));
    assert.equal(find(root, 'SELECT').children[2].textContent, 'Renamed quota');
    settings.showCodexAdditionalLimits = false;
    composer.render();
    assert.deepEqual(find(root, 'SELECT').children.map((option) => option.textContent), [
      'settings.edgeDock.window.auto', 'settings.edgeDock.window.unavailable'
    ]);
    settings.showCodexAdditionalLimits = true;
    composer.render();
    assert.equal(find(root, 'SELECT').value, itemsApi.limitWindowKey(second));
    const restoredSelect = find(root, 'SELECT');
    document.activeElement = restoredSelect;
    stats.limits.providers[0].windows[1] = { ...second, label: 'Latest quota label' };
    settings.showCodexAdditionalLimits = false;
    composer.render();
    assert.equal(find(root, 'SELECT'), restoredSelect);
    document.activeElement = null;
    restoredSelect.listeners.blur();
    assert.equal(restoredSelect.children.at(-1).textContent, 'settings.edgeDock.window.unavailable');
    assert.equal(restoredSelect.value, itemsApi.limitWindowKey(second));
    document.activeElement = restoredSelect;
    settings.showCodexAdditionalLimits = true;
    composer.render();
    document.activeElement = null;
    restoredSelect.listeners.blur();
    assert.equal(restoredSelect.children[2].textContent, 'Latest quota label');
    assert.equal(restoredSelect.value, itemsApi.limitWindowKey(second));
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

test('a row hidden from the provider card is not offered as a new pin, but an existing pin keeps its name', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const root = new Element('div');
    const weekly = { kind: 'weekly', label: 'Weekly', remainingPercent: 19 };
    const settings = { edgeDockItems: [{ type: 'limit', provider: 'claude' }] };
    const hidden = new Set([itemsApi.limitWindowKey(weekly)]);
    const composer = createEdgeDockComposer({
      root, itemsApi,
      t: (key) => key,
      presentationApi: {},
      getSettings: () => settings,
      getStats: () => ({ limits: { providers: [{ provider: 'claude', status: 'ok', windows: [
        { kind: 'session', label: 'Session', remainingPercent: 100 }, weekly
      ] }] } }),
      save() {},
      providerLabel: (id) => id,
      providerColor: () => '#fff',
      windowLabel: (record, quotaWindow) => limitWindowLabel(record.provider, quotaWindow),
      hasProviderMark: () => true,
      maskEmail: (email) => email,
      createRowDrag: () => ({ deferRender: () => false }),
      isWindowHidden: (providerId, quotaWindow) => providerId === 'claude' && hidden.has(itemsApi.limitWindowKey(quotaWindow))
    });
    const find = (node, tag) => node.tagName === tag ? node : node.children.map((child) => find(child, tag)).find(Boolean);
    const options = () => {
      composer.render();
      return find(root, 'SELECT').children.map((option) => option.textContent);
    };
    composer.render();
    root.children[1].children[0].children.find((node) => node.dataset.itemId).listeners.click();
    assert.deepEqual(options(), ['settings.edgeDock.window.auto', 'Session']);
    settings.edgeDockItems = [{ type: 'limit', provider: 'claude', windowKey: itemsApi.limitWindowKey(weekly) }];
    assert.deepEqual(options(), ['settings.edgeDock.window.auto', 'Session', 'Weekly']);
  } finally {
    global.document = previousDocument;
  }
});
