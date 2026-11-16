'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accountName, accountStatus, applyAccountOrder, createPanel } = require('../../src/electron/renderer/limits/accountSlotsPanel');
const { createCredentialPanel, resolveOpenUrl } = require('../../src/electron/renderer/limits/accountPanels');
const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const { translate } = require('../../src/electron/renderer/i18n');
const t = (key, params) => translate('en', key, params);
class Node {
  constructor(tag, document) {
    this.tagName = tag; this.document = document; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.value = ''; this.className = '';
    this.classList = { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(v => v !== name).join(' '); }, toggle: (name, force) => { const yes = force ?? !this.classList.contains(name); this.classList[yes ? 'add' : 'remove'](name); return yes; } };
  }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = value; }
  get textContent() { return this.text || this.children.map(child => child.textContent || '').join(''); }
  append(...children) { children.forEach(child => this.insertBefore(child, null)); }
  insertBefore(child, before) { if (typeof child === 'string') child = { textContent: child }; child.remove?.(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parentElement = this; }
  moveBefore(child, before) { this.document.moves++; this.insertBefore(child, before); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  get isConnected() { return this === this.document.root || Boolean(this.parentElement?.isConnected); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  focus() { this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  *walk() { yield this; for (const child of this.children) if (child.walk) yield* child.walk(); }
  querySelector(selector) { return [...this.walk()].find(node => selector[0] === '#' ? node.id === selector.slice(1) : node.classList.contains(selector.slice(1))); }
  click() { return this.listeners.click?.(); }
  key(key, altKey = false) { return this.listeners.keydown?.({ key, altKey, preventDefault() {}, stopPropagation() {} }); }
}
function harness() {
  const document = { moves: 0, createElement: tag => new Node(tag, document), createTextNode: text => ({ textContent: text }), getElementById: id => document.root.querySelector(`#${id}`) };
  const calls = []; let verdict = { saved: true, verdict: 'valid', accounts: [] };
  const slots = [{ id: 'a', label: 'Zulu', fingerprint: 'aa', accountKey: 'ka', enabled: true }, { id: 'b', label: 'Alpha', fingerprint: 'bb', accountKey: 'kb', enabled: false }];
  const ipc = Object.fromEntries(['rename', 'move', 'setEnabled', 'remove', 'add', 'replace'].map(op => [op, async (...args) => { calls.push([op, ...args]); return ['add', 'replace'].includes(op) ? verdict : { ok: true, accounts: slots }; }]));
  const host = new Node('div', document);
  const defaultPanel = new Node('div', document);
  host.append(defaultPanel);
  const panel = createPanel({ defaultPanel, form: limitAccountFormsForRenderer().find(f => f.id === 'qoder'), label: 'Qoder', document, t, ipc, forms: { createCredentialPanel, resolveOpenUrl }, preserveScroll: fn => fn(), onChanged() {}, openExternal() {}, confirm: () => true });
  host.append(panel.element);
  document.root = host;
  const update = () => panel.update(slots, [{ accountKey: 'ka', status: 'unauthorized', updatedAt: new Date().toISOString() }], true);
  update();
  const row = id => [...panel.element.walk()].find(node => node.dataset.slotId === id);
  const buttons = node => [...node.walk()].filter(n => n.tagName === 'button');
  const click = (node, text) => buttons(node).find(n => n.textContent === text).click();
  return { panel, slots, document, calls, defaultPanel, row, update, click, set verdict(v) { verdict = v; } };
}
test('slot names and status respect labels, native identity, fingerprint, pause and stale', () => {
  assert.equal(accountName({ label: 'Work', fingerprint: 'abc' }, { accountEmail: 'x@y' }, t), 'Work');
  assert.equal(accountName({ fingerprint: 'abc' }, { accountEmail: 'x@y' }, t), 'x@y');
  assert.equal(accountName({ fingerprint: 'abc' }, null, t), 'Account #abc');
  assert.equal(accountStatus({ enabled: false }, { status: 'unauthorized' }), 'paused');
  assert.equal(accountStatus({ enabled: true }, { status: 'unauthorized' }), 'invalid');
  assert.equal(accountStatus({ enabled: true }, { status: 'ok', stale: true }), 'stale');
  assert.equal(accountStatus({ enabled: true }, { status: 'ok' }), 'connected');
});
test('stored account order is applied after name aggregation without mutating input', () => {
  const records = [{ provider: 'qoder', accountKey: 'b' }, { provider: 'deepseek' }, { provider: 'qoder', accountKey: 'default' }, { provider: 'qoder', accountKey: 'a' }];
  const ordered = applyAccountOrder(records, { qoder: [{ accountKey: 'a' }, { accountKey: 'b' }] });
  assert.deepEqual(ordered.map(r => r.accountKey), ['default', undefined, 'a', 'b']);
  assert.equal(records[0].accountKey, 'b');
});
test('menu operations and Alt arrows use the slot IPC', async () => {
  const h = harness();
  await h.click(h.row('a'), 'Pause tracking');
  await h.click(h.row('b'), 'Resume tracking');
  await h.click(h.row('a'), 'Move down');
  await h.row('b').key('ArrowUp', true);
  await h.click(h.row('b'), 'Remove account');
  assert.deepEqual(h.calls, [['setEnabled', 'qoder', 'a', false], ['setEnabled', 'qoder', 'b', true], ['move', 'qoder', 'a', 'down'], ['move', 'qoder', 'b', 'up'], ['remove', 'qoder', 'b']]);
});
test('rename Enter saves, Escape cancels; pushes retain input, caret and open menu', async () => {
  const h = harness();
  h.click(h.row('a'), '⋯');
  h.update();
  assert.equal(h.row('a').querySelector('.slot-menu').classList.contains('hidden'), false);
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Draft'; input.selectionStart = 2;
  h.update();
  assert.equal(h.document.activeElement, input); assert.equal(input.selectionStart, 2); assert.equal(input.value, 'Draft');
  await input.key('Enter');
  assert.deepEqual(h.calls[0], ['rename', 'qoder', 'a', 'Draft']);
  h.click(h.row('a'), 'Rename');
  await h.row('a').querySelector('.slot-rename').key('Escape');
  assert.equal(h.calls.length, 1);
});
test('different-account replacement offers add, preserves drafts across pushes and clears after save', async () => {
  const h = harness(); h.verdict = { saved: false, verdict: 'differentAccount' };
  h.click(h.row('a'), 'Replace cookie');
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput'); input.value = 'fake-cookie'; input.focus();
  h.update(); assert.equal(h.document.activeElement, input); assert.equal(input.value, 'fake-cookie');
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.equal(h.calls[0][0], 'replace');
  assert.match(h.panel.element.textContent, /different account/);
  h.verdict = { saved: true, verdict: 'valid', accounts: h.slots };
  await h.click(h.panel.element, 'Add as another account');
  assert.equal(h.calls[1][0], 'add'); assert.equal(h.calls[1][2].qoderCookie, 'fake-cookie');
  assert.equal(input.value, '');
});
test('add form submits optional name and independent site through slot IPC only', async () => {
  const h = harness(); h.panel.openEditor(null);
  h.panel.element.querySelector('.slot-editor').children[1].value = 'New';
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'fake';
  h.document.getElementById('qoderSlotDraftqoderSiteInput').value = 'cn';
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.deepEqual(h.calls[0], ['add', 'qoder', { qoderSite: 'cn', qoderCookie: 'fake' }, 'New']);
});

test('real aggregate name sorting is replaced by stored slot order with default first', () => {
  const { aggregateLimits } = require('../../src/shared/limits/core');
  const now = Date.now();
  const row = (accountKey, accountName) => ({ provider: 'qoder', accountKey, accountName, status: 'ok', windows: [], updatedAt: new Date(now).toISOString() });
  const aggregate = aggregateLimits([{ deviceId: 'local', limits: { multiAccountProviders: ['qoder'], providers: [row('default', 'Middle'), row('work', 'Zulu'), row('personal', 'Alpha')] } }], 0, now);
  assert.deepEqual(aggregate.providers.map(r => r.accountName), ['Alpha', 'Middle', 'Zulu']);
  const result = applyAccountOrder(aggregate.providers, { qoder: [{ accountKey: 'work' }, { accountKey: 'personal' }] });
  assert.deepEqual(result.map(r => r.accountName), ['Middle', 'Zulu', 'Alpha']);
});

test('native desktop quota projection uses the same order for Edge Dock, Notch and bubble consumers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const mainPath = path.resolve(__dirname, '../../src/electron/main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  const start = source.indexOf('function desktopQuotaStats(');
  const end = source.indexOf('\nfunction syncPluginQuotaSurfaceDemand(', start);
  const context = { require: require('node:module').createRequire(mainPath), applyAccountOrder, pluginRuntime: null,
    accountSlotService: { list: id => ({ accounts: id === 'qoder' ? [{ accountKey: 'z' }, { accountKey: 'a' }] : [] }) } };
  vm.runInNewContext(source.slice(start, end), context);
  const stats = { limits: { providers: [{ provider: 'qoder', accountKey: 'a' }, { provider: 'qoder', accountKey: 'default' }, { provider: 'qoder', accountKey: 'z' }] } };
  const result = context.desktopQuotaStats(stats);
  assert.deepEqual(Array.from(result.limits.providers, row => row.accountKey), ['default', 'z', 'a']);
  assert.equal(stats.limits.providers[0].accountKey, 'a');
  assert.equal(context.desktopQuotaStats(null), null);
});


test('local raw slot readings use aggregate freshness without borrowing a remote healthy status', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const file = path.resolve(__dirname, '../../src/electron/main.js');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('function injectLocalDeviceStatus(');
  const end = source.indexOf('\nfunction macWidgetConfiguration', start);
  const context = { require: require('node:module').createRequire(file), settings: { deviceId: 'local' },
    lastCollectedDevice: null, localDevice: null, mode: 'local', attachLocalPresentationNativeViews() {} };
  vm.runInNewContext(source.slice(start, end), context);
  const stats = { devices: [{ deviceId: 'local', limits: { refreshMs: 60000, providers: [
    { provider: 'qoder', accountKey: 'old', status: 'ok', updatedAt: '2000-01-01T00:00:00Z' },
    { provider: 'qoder', accountKey: 'bad', status: 'unauthorized', updatedAt: new Date().toISOString() }
  ] } }], limits: { providers: [{ provider: 'qoder', status: 'ok' }] } };
  const rows = context.injectLocalDeviceStatus(stats).devices[0].limits.providers;
  assert.equal(accountStatus({ enabled: true }, rows[0]), 'stale');
  assert.equal(accountStatus({ enabled: true }, rows[1]), 'invalid');
});

test('alias ownership follows current keys before aliases in rows and account order', () => {
  const h = harness();
  h.slots[0].aliases = ['old', 'kb'];
  const rows = [{ provider: 'qoder', accountKey: 'old', status: 'unauthorized' },
    { provider: 'qoder', accountKey: 'kb', status: 'ok' }, { provider: 'qoder', accountKey: 'default', status: 'ok' }];
  h.panel.update(h.slots, rows, true);
  assert.match(h.row('a').textContent, /Cookie expired/);
  assert.match(h.row('default').textContent, /Connected/);
  assert.deepEqual(applyAccountOrder(rows, { qoder: h.slots }).map(row => row.accountKey), ['default', 'old', 'kb']);
  h.slots[1].enabled = true;
  h.panel.update(h.slots, rows, true);
  assert.match(h.row('b').textContent, /Connected/);
});

test('Home preserves slot order before card limit while preserving quota sorted provider positions', () => {
  const { homeLimitAccountsForProviders } = require('../../src/electron/renderer/homeOverview');
  const row = (provider, accountKey, remainingPercent) => ({ provider, accountKey, windows: [{ kind: 'monthly', remainingPercent }] });
  const result = homeLimitAccountsForProviders({ providers: [row('qoder', 'default', 90), row('qoder', 'first', 50), row('qoder', 'last', 10), row('other', 'x', 30)],
    providerOptions: [{ id: 'qoder' }, { id: 'other' }], limit: 3, orderedAccountProviders: ['qoder'] });
  assert.deepEqual(result.map(row => row.key), ['qoder:default', 'other:x', 'qoder:first']);
});

test('cancelled pending save cannot close or clear a newer credential draft', async () => {
  const h = harness(); let resolve;
  h.verdict = new Promise(r => { resolve = r; });
  h.panel.openEditor(h.slots[0]);
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'old';
  const pending = h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  h.click(h.panel.element, 'Cancel');
  h.panel.openEditor(null);
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput');
  input.value = 'new-secret'; input.focus();
  resolve({ saved: true, verdict: 'valid', accounts: h.slots });
  await pending;
  assert.equal(h.document.getElementById(input.id), input);
  assert.equal(input.value, 'new-secret');
  assert.equal(h.panel.element.querySelector('.slot-editor').classList.contains('hidden'), false);
});

test('locale translation updates live menus fix and add actions without recreating drafts', () => {
  const h = harness();
  h.click(h.row('a'), '⋯');
  h.panel.openEditor(null);
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput'); input.value = 'draft';
  const scope = { querySelectorAll(selector) {
    const key = { '[data-i18n]': 'i18n', '[data-i18n-aria-label]': 'i18nAriaLabel', '[data-i18n-placeholder]': 'i18nPlaceholder' }[selector];
    return [...h.document.root.walk()].filter(node => node.dataset[key]);
  } };
  require('../../src/electron/renderer/i18n').applyTranslations(scope, 'zh-TW');
  assert.match(h.row('a').textContent, /更換 Cookie/);
  assert.equal(h.panel.element.querySelector('.slot-add').textContent, translate('zh-TW', 'settings.slots.add', { provider: 'Qoder' }));
  assert.equal(h.row('a').querySelector('.slot-menu').classList.contains('hidden'), false);
  assert.equal(input.value, 'draft');
});

test('default row owns credential actions and first account opens retained default settings', () => {
  const h = harness();
  h.row('default').key('ArrowUp', true);
  assert.equal(h.calls.length, 0);
  assert.match(h.row('default').textContent, /Replace cookie/);
  assert.match(h.row('default').textContent, /Clear cookie/i);
  h.click(h.row('default'), 'Replace cookie');
  const region = h.defaultPanel.parentElement;
  assert.equal(region.open, true);
  assert.equal(region.children[0].textContent, 'Default account settings');
  h.panel.update([], [], false);
  assert.equal(h.row('default'), undefined);
  region.open = false;
  h.click(h.panel.element, t('settings.slots.add', { provider: 'Qoder' }));
  assert.equal(region.open, true);
  assert.equal(h.panel.element.querySelector('.slot-editor').classList.contains('hidden'), true);
  assert.equal(region.children[1], h.defaultPanel);
});
