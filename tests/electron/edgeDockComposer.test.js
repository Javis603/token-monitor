'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { addableLimitProviders, createEdgeDockComposer } = require('../../src/electron/renderer/edgeDock/composer');
const itemsApi = require('../../src/electron/renderer/edgeDock/items');
const { limitWindowLabel, mimoProductLabel, mimoAccountGroups } = require('../../src/shared/limits/windowLabels');
const accountIdentity = require('../../src/electron/renderer/accountIdentity');
const { createLimitWindowsView } = require('../../src/electron/renderer/limits/windowsView');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

// Just enough DOM for the composer: it builds with createElement and appends.
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, contains: name => (this.className || '').split(' ').includes(name) };
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
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
  getAttribute(name) { return this.attributes?.[name]; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  querySelector(selector) {
    const matches = node => selector === '.select-control-trigger[aria-expanded="true"]'
      && node.classList.contains('select-control-trigger') && node.getAttribute('aria-expanded') === 'true';
    for (const child of this.children) {
      if (matches(child)) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
}

function accountChoices(provider, rows, presentationApi, settings = {}) {
  const root = new Element('div');
  const composer = createEdgeDockComposer({
    root, itemsApi, t: (key) => key,
    presentationApi,
    getSettings: () => ({ ...settings, edgeDockItems: [{ type: 'limit', provider }] }),
    getStats: () => ({ limits: { providers: rows } }), save: () => {},
    providerLabel: (id) => id, providerColor: () => '#000000', hasProviderMark: () => false,
    maskEmail: (email) => settings.maskLimitAccountEmails ? accountIdentity.maskEmailAddress(email) : email, mimoProductLabel,
    limitAccountTitle: createLimitWindowsView({ mimoProductLabel, mimoAccountGroups, accountIdentity,
      settings: () => settings }).limitAccountTitle,
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
    ]), ['Account 1 · Console', 'Account 2 · Desktop Membership']);
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

test('MiMo account choices repaint when product labels or account identity change', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const rows = ['a', 'b'].map((accountKey) => ({ provider: 'mimo', accountKey, accountName: 'MiMo abcdef1', planLabel: 'Pro' }));
    const { composer, names } = accountChoices('mimo', rows, {});
    assert.deepEqual(names(), ['MiMo abcdef1', 'MiMo abcdef1']);
    rows[1].accountLabel = 'Desktop Membership';
    composer.render();
    assert.deepEqual(names(), ['MiMo abcdef1', 'MiMo abcdef1 · Desktop Membership']);
    const maskedRows = [
      { provider: 'mimo', accountKey: 'sha256:aaaaaa', accountEmail: 'james@example.com', accountLabel: 'Console' },
      { provider: 'mimo', accountKey: 'sha256:bbbbbb', accountEmail: 'jones@example.com', accountLabel: 'Console' }
    ];
    const masked = accountChoices('mimo', maskedRows, {}, { maskLimitAccountEmails: true });
    assert.equal(new Set(masked.names()).size, 2);
    maskedRows[1].accountEmail = maskedRows[0].accountEmail;
    masked.composer.render();
    assert.equal(new Set(masked.names()).size, 1);
    assert.ok(masked.names().every(name => !/james@|jones@/.test(name)));
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
  assert.match(app, /\.orderedLimitProviders\(desktopLimitProviders\(\), state\.settings\?\.limitProviderOrder\)/);
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

test('Refresh can be added and removed without freezing automatic providers or changing readout order', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const root = new Element('div');
    const settings = { edgeDockItems: null };
    const saves = [];
    let providers = ['claude'];
    const composer = createEdgeDockComposer({
      root, itemsApi, t: (key) => key,
      presentationApi: { connectedLimitProviders: () => providers },
      getSettings: () => settings, getStats: () => ({}),
      save: (patch) => { saves.push(patch); Object.assign(settings, patch); composer.render(); },
      providerLabel: (id) => id, providerColor: () => '#fff', hasProviderMark: () => false,
      createRowDrag: () => ({ deferRender: () => false })
    });
    const all = (node) => [node, ...node.children.flatMap(all)];
    const find = (className) => all(root).find((node) => node.className === className);
    const labels = () => all(root).filter((node) => node.className === 'edge-dock-composer-item').map((node) => node.getAttribute('aria-label'));
    const openAdd = () => find('edge-dock-composer-add').listeners.click();
    const refreshOption = () => all(root).find((node) => node.className === 'edge-dock-composer-menu-option'
      && node.children.some((child) => child.textContent === 'settings.common.refresh'));
    composer.render();
    assert.deepEqual(labels(), ['claude']);
    openAdd();
    refreshOption().listeners.click();
    assert.deepEqual(saves.at(-1), { edgeDockRefreshEnabled: true });
    assert.equal(settings.edgeDockItems, null);
    assert.deepEqual(labels(), ['claude', 'settings.common.refresh']);
    assert.equal(find('edge-dock-composer-hint').textContent, 'settings.edgeDock.refreshNote');
    const action = all(root).find((node) => node.getAttribute('aria-label') === 'settings.common.refresh');
    assert.equal(action.dataset.itemId, undefined, 'fixed action stays outside drag ordering');
    assert.equal(action.listeners.pointerdown, undefined);
    providers = ['claude', 'codex'];
    composer.render();
    assert.deepEqual(labels(), ['claude', 'codex', 'settings.common.refresh']);
    openAdd();
    assert.equal(refreshOption(), undefined, 'an enabled action cannot be added twice');
    all(root).find((node) => node.getAttribute('aria-label') === 'settings.common.refresh').listeners.click();
    find('edge-dock-composer-remove').listeners.click();
    assert.deepEqual(saves.at(-1), { edgeDockRefreshEnabled: false });
    assert.equal(settings.edgeDockItems, null);
    assert.deepEqual(labels(), ['claude', 'codex']);
    openAdd();
    assert.ok(refreshOption());
    refreshOption().listeners.click();
    find('edge-dock-composer-reset').listeners.click();
    assert.equal(settings.edgeDockRefreshEnabled, false);
    assert.equal(settings.edgeDockItems, null);
    settings.edgeDockItems = [{ type: 'stat', metric: 'today' }, { type: 'stat', metric: 'month' }];
    composer.render();
    openAdd();
    refreshOption().listeners.click();
    assert.deepEqual(settings.edgeDockItems.map((item) => item.metric), ['today', 'month']);
    all(root).find((node) => node.dataset.itemId === 'stat:today').listeners.click();
    find('edge-dock-composer-remove').listeners.click();
    assert.deepEqual(settings.edgeDockItems, [{ type: 'stat', metric: 'month' }]);
    assert.equal(settings.edgeDockRefreshEnabled, true);
  } finally { global.document = previousDocument; }
});

test('independent Notch composer writes its item key without changing the side composer', () => {
  const previous = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const settings = { edgeDockRefreshEnabled: true, edgeDockItems: [{ type: 'stat', metric: 'today' }], notchItems: [{ type: 'limit', provider: 'codex' }] };
    const root = new Element('div');
    let saved;
    const composer = createEdgeDockComposer({ root, itemsApi, itemsKey: 'notchItems', t: (key) => key, presentationApi: {}, getSettings: () => settings, getStats: () => ({}), save: (patch) => { saved = patch;Object.assign(settings, patch); }, providerLabel: (id) => id, providerColor: () => '#fff', windowLabel: () => '', hasProviderMark: () => false, maskEmail: (s) => s, createRowDrag: () => ({ deferRender: () => false }) });
    const descendants = (node) => [node, ...node.children.flatMap(descendants)];
    composer.render();
    descendants(root).find((n) => n.dataset.itemId === 'limit:codex').listeners.click();
    const control = descendants(root).find((n) => n.tagName === 'INPUT');
    control.checked = true;control.listeners.change();
    assert.deepEqual(Object.keys(saved), ['notchItems']);
    assert.equal(settings.notchItems[0].accountMode, 'active');
    assert.equal(descendants(root).some((n) => n.textContent === 'settings.edgeDock.showUsage'), false);
    assert.equal(descendants(root).some((n) => n.textContent === 'settings.edgeDock.showSessions'), false);
    assert.equal(settings.edgeDockItems[0].metric, 'today');
    composer.render();
    assert.equal(descendants(root).some((n) => n.dataset.itemId === 'action:refresh'), false);
    descendants(root).find((n) => n.className === 'edge-dock-composer-reset').listeners.click();
    assert.deepEqual(saved, { notchItems: null, notchRefreshEnabled: false });
    assert.equal(settings.edgeDockRefreshEnabled, true);
    assert.equal(settings.edgeDockItems[0].metric, 'today');
  } finally { global.document = previous; }
});


test('Notch refresh action uses the shared composer without changing side settings or automatic providers', () => {
  const previous = global.document;
  global.document = { createElement: tag => new Element(tag), activeElement: null };
  try {
    const settings = { notchItems: null, edgeDockRefreshEnabled: true };
    const root = new Element('div'); const saves = [];
    const composer = createEdgeDockComposer({ root, itemsApi, itemsKey: 'notchItems',
      t: key => key, presentationApi: { connectedLimitProviders: () => ['codex'] },
      getSettings: () => settings, getStats: () => ({}),
      save: patch => { saves.push(patch); Object.assign(settings, patch); composer.render(); },
      providerLabel: id => id, providerColor: () => '#fff', hasProviderMark: () => false,
      createRowDrag: () => ({ deferRender: () => false }) });
    const all = n => [n, ...n.children.flatMap(all)];
    const find = cls => all(root).find(n => n.className === cls);
    composer.render(); assert.equal(all(root).some(n => n.dataset.itemId === 'action:refresh'), false);
    find('edge-dock-composer-add').listeners.click();
    all(root).find(n => n.className === 'edge-dock-composer-menu-option'
      && n.children.some(c => c.textContent === 'settings.common.refresh')).listeners.click();
    assert.deepEqual(saves.at(-1), { notchRefreshEnabled: true });
    assert.equal(settings.notchItems, null); assert.equal(settings.edgeDockRefreshEnabled, true);
    assert.ok(all(root).some(n => n.textContent === 'settings.notch.refreshNote'));
    find('edge-dock-composer-remove').listeners.click();
    assert.deepEqual(saves.at(-1), { notchRefreshEnabled: false });
    assert.equal(settings.edgeDockRefreshEnabled, true);
  } finally { global.document = previous; }
});

test('third-party headline controls persist a specific account independently of card visibility', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const root = new Element('div');
    const settings = { edgeDockItems: [{ type: 'limit', provider: 'thirdparty', hiddenAccounts: ['c'] }] };
    let rows = ['a', 'b', 'c'].map((accountKey) => ({ provider: 'thirdparty', accountKey, accountName: `Account ${accountKey}` }));
    const saves = [];
    const composer = createEdgeDockComposer({
      root, itemsApi, t: (key) => key, presentationApi: {},
      getSettings: () => settings, getStats: () => ({ limits: { providers: rows } }),
      save: (patch) => { saves.push(patch); Object.assign(settings, patch); composer.render(); },
      providerLabel: (id) => id, providerColor: () => '#fff', hasProviderMark: () => false,
      maskEmail: (email) => email, createRowDrag: () => ({ deferRender: () => false })
    });
    const all = (node) => [node, ...node.children.flatMap(all)];
    const radio = (value) => all(root).find((node) => node.type === 'radio' && node.value === value);
    const chooseMode = (value) => { const input = radio(value); input.checked = true; input.listeners.change(); };
    const accountPicker = () => all(root).find((node) => node.tagName === 'LABEL'
      && node.children[0]?.textContent === 'trayComposer.account.specificLabel').children[1];
    composer.render();
    all(root).find((node) => node.className === 'edge-dock-composer-item').listeners.click();
    assert.equal(radio('lowest').checked, true);
    chooseMode('specific');
    assert.equal(settings.edgeDockItems[0].accountKey, 'a');
    assert.deepEqual(accountPicker().children.map((option) => option.value), ['a', 'b']);
    let select = accountPicker();
    global.document.activeElement = select;
    select.value = 'b';
    select.listeners.change();
    global.document.activeElement = null;
    select.listeners.blur();
    assert.equal(settings.edgeDockItems[0].accountKey, 'b');
    assert.deepEqual(settings.edgeDockItems[0].hiddenAccounts, ['c']);
    assert.equal(all(root).filter((node) => node.className === 'edge-dock-composer-account-name').length, 3);
    chooseMode('lowest');
    chooseMode('specific');
    assert.equal(accountPicker().value, 'b', 'mode changes retain the explicit account');
    select = accountPicker();
    global.document.activeElement = select;
    rows = rows.filter((row) => row.accountKey !== 'b');
    composer.render();
    assert.equal(accountPicker(), select, 'stats refresh keeps the native picker attached while focused');
    global.document.activeElement = null;
    select.listeners.blur();
    assert.equal(select.value, 'b');
    assert.equal(select.children.find((option) => option.value === 'b').disabled, true);
    assert.equal(select.children.find((option) => option.value === 'b').textContent, 'trayComposer.account.none');
    assert.equal(saves.at(-1).edgeDockItems[0].accountKey, 'b', 'missing account never persists a sibling fallback');
  } finally {
    global.document = previousDocument;
  }
});

test('app-wired composer preserves account edits while asynchronous settings writes are pending', async () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new Element(tag), activeElement: null };
  try {
    const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
    const factory = app.slice(app.indexOf('function createDockItemsComposer('), app.indexOf('\nconst edgeDockComposer ='));
    const saveSource = app.slice(app.indexOf('async function saveSettings('), app.indexOf('\n// The resolved settings of a write'));
    const state = { settings: { edgeDockItems: [{ type: 'limit', provider: 'thirdparty', accountMode: 'specific', accountKey: 'a' }] },
      stats: { limits: { providers: ['a', 'b'].map((accountKey) => ({ provider: 'thirdparty', accountKey, accountName: accountKey })) } } };
    const pendingSettingsPatches = new Set();
    const writes = [];
    const api = { updateSettings: (patch) => new Promise((resolve) => { writes.push({ patch, resolve }); }) };
    const save = Function('window', 'state', 'pendingSettingsPatches', 'setSyncContentEditError', 'appearancePreview',
      'syncContentForm', 'applyPersistedSettings', `${saveSource}; return saveSettings;`)(
      { tokenMonitor: api }, state, pendingSettingsPatches, () => {}, {}, null,
      (next) => { state.settings = next; }
    );
    let settingsReader;
    const saveTasks = [];
    const window = {
      TokenMonitorEdgeDockComposer: { createEdgeDockComposer: (deps) => {
        settingsReader = deps.getSettings;
        return createEdgeDockComposer({ ...deps, save: (patch) => {
          const task = deps.save(patch); saveTasks.push(task); return task;
        } });
      } },
      TokenMonitorEdgeDockItems: itemsApi, TokenMonitorEdgeDockPresentation: {},
      TokenMonitorLimitProviders: { LIMIT_PROVIDER_LABELS: { thirdparty: 'Third-party APIs' } }
    };
    const root = new Element('div');
    const create = Function('window', 'state', 'pendingSettingsPatches', 't', 'saveSettings', 'mimoProductLabel', 'limitAccountTitle',
      'rowDragControllerApi', 'verticalDragSortApi', 'preserveSettingsPanelScroll', 'limitMarksWithIcon',
      'limitProviderColor', 'desktopSurfaceStats', 'pluginLimitMetadata', 'desktopLimitProviders', `${factory}; return createDockItemsComposer;`)(
      window, state, pendingSettingsPatches, (key) => key, save, () => '', () => '',
      { createRowDragController: () => ({ deferRender: () => false }) }, {}, (fn) => fn(), new Set(), () => '#fff', () => state.stats, () => null, () => []
    );
    const composer = create(root, 'edgeDockItems');
    const all = (node) => [node, ...node.children.flatMap(all)];
    const chooseMode = (value) => {
      const input = all(root).find((node) => node.type === 'radio' && node.value === value);
      input.checked = true; input.listeners.change();
    };
    composer.render();
    all(root).find((node) => node.className === 'edge-dock-composer-item').listeners.click();
    const select = all(root).find((node) => node.tagName === 'LABEL'
      && node.children[0]?.textContent === 'trayComposer.account.specificLabel').children[1];
    global.document.activeElement = select;
    select.value = 'b'; select.listeners.change();
    global.document.activeElement = null; select.listeners.blur();
    chooseMode('lowest');
    chooseMode('specific');
    assert.equal(state.settings.edgeDockItems[0].accountKey, 'a', 'IPC replies are still delayed');
    assert.deepEqual(writes.map(({ patch }) => [patch.edgeDockItems[0].accountMode, patch.edgeDockItems[0].accountKey]), [
      ['specific', 'b'], ['lowest', 'b'], ['specific', 'b']
    ]);
    // A push/ack for the first write must not hide the newer pending mode.
    writes[0].resolve({ ...state.settings, ...writes[0].patch }); await saveTasks[0];
    assert.equal(settingsReader().edgeDockItems[0].accountMode, 'specific');
    writes[1].resolve({ ...state.settings, ...writes[1].patch }); await saveTasks[1];
    assert.equal(settingsReader().edgeDockItems[0].accountMode, 'specific');
    writes[2].resolve({ ...state.settings, ...writes[2].patch }); await saveTasks[2];
    assert.equal(state.settings.edgeDockItems[0].accountKey, 'b');
    assert.equal(pendingSettingsPatches.size, 0);
    state.settings = { ...state.settings, edgeDockItems: [{ type: 'limit', provider: 'thirdparty', accountMode: 'lowest', accountKey: 'external' }] };
    assert.equal(settingsReader().edgeDockItems[0].accountKey, 'external', 'settled writes do not mask later settings');
  } finally { global.document = previousDocument; }
});

test('custom plugin composer items hide while inactive and restore without changing saved references', () => {
  const previous = global.document;
  global.document = { createElement: tag => new Element(tag), activeElement: null };
  try {
    const root = new Element('div');
    let status = 'active';
    const settings = { edgeDockItems: [{ type: 'plugin', ref: 'sample-plugin/card' }] }, saved = JSON.stringify(settings), sizes = [];
    const composer = createEdgeDockComposer({ root, itemsApi, t: key => key, presentationApi: {},
      getSettings: () => settings, getStats: () => ({}), save() { assert.fail('status changes must not write settings'); },
      pluginLabel: () => 'Custom panel', pluginView: () => ({ status }), pluginMark: (_, size) => { sizes.push(size); return new Element('svg'); },
      providerLabel: id => id, providerColor: () => '#fff', hasProviderMark: () => false,
      createRowDrag: () => ({ deferRender: () => false }) });
    const all = node => [node, ...node.children.flatMap(all)];
    composer.render();
    let button = all(root).find(node => node.className === 'edge-dock-composer-item');
    assert.equal(button.children[0].children[0].tagName, 'SVG');
    assert.equal(button.attributes['aria-label'], 'Custom panel');
    button.listeners.click();
    assert.ok(sizes.includes(16)); assert.ok(sizes.includes(13));
    for (const inactive of ['disabled', 'needsApproval', 'safeMode', 'crashed', 'invalid', 'pluginsOff', 'missing']) {
      status = inactive; composer.render();
      button = all(root).find(node => node.className === 'edge-dock-composer-item');
      assert.equal(button, undefined);
      assert.equal(JSON.stringify(settings), saved);
    }
    status = 'active'; composer.render();
    assert.ok(all(root).some(node => node.className === 'edge-dock-composer-item'));
  } finally { global.document = previous; }
});
test('sorting or removing visible items preserves hidden module and view slots', () => {
  const previous = global.document;
  global.document = { createElement: tag => new Element(tag), activeElement: null };
  try {
    const root = new Element('div'), hiddenView = { type: 'plugin', ref: 'sample-plugin/card' }, hiddenModule = { type: 'limit', provider: 'plugin:sample-plugin:credits' };
    const settings = { edgeDockItems: [{ type: 'stat', metric: 'today' }, hiddenView, { type: 'limit', provider: 'codex' }, hiddenModule, { type: 'stat', metric: 'liveRate' }] };
    let drag;
    const composer = createEdgeDockComposer({ root, itemsApi, t: key => key, presentationApi: {},
      getSettings: () => settings, getStats: () => ({}), save: patch => Object.assign(settings, patch),
      pluginView: () => ({ status: 'disabled' }), moduleView: () => ({ status: 'disabled' }),
      providerLabel: id => id, providerColor: () => '#fff', hasProviderMark: () => false,
      createRowDrag: options => { drag = options; return { deferRender: () => false }; } });
    const all = node => [node, ...node.children.flatMap(all)];
    composer.render();
    assert.equal(all(root).filter(node => node.className === 'edge-dock-composer-item').length, 3);
    drag.persistOrder(['stat:liveRate', 'limit:codex', 'stat:today']);
    assert.deepEqual(settings.edgeDockItems.map(itemsApi.itemId), ['stat:liveRate', 'plugin:sample-plugin/card', 'limit:codex', 'limit:plugin:sample-plugin:credits', 'stat:today']);
    composer.render();
    all(root).find(node => node.className === 'edge-dock-composer-item').listeners.click();
    all(root).find(node => node.className === 'edge-dock-composer-remove').listeners.click();
    assert.ok(settings.edgeDockItems.some(item => itemsApi.itemId(item) === itemsApi.itemId(hiddenView)));
    assert.ok(settings.edgeDockItems.some(item => itemsApi.itemId(item) === itemsApi.itemId(hiddenModule)));
    composer.render();
    all(root).find(node => node.className === 'edge-dock-composer-item').listeners.click();
    settings.edgeDockItems = settings.edgeDockItems.filter(item => itemsApi.itemId(item) !== itemsApi.itemId(hiddenView));
    all(root).find(node => node.className === 'edge-dock-composer-remove').listeners.click();
    assert.equal(settings.edgeDockItems.some(item => itemsApi.itemId(item) === itemsApi.itemId(hiddenView)), false, 'a stale pane must not restore an externally removed hidden reference');
    assert.ok(settings.edgeDockItems.some(item => itemsApi.itemId(item) === itemsApi.itemId(hiddenModule)));
  } finally { global.document = previous; }
});
