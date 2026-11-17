'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accountName, accountStatus, applyAccountOrder, createPanel } = require('../../src/electron/renderer/limits/accountSlotsPanel');
const { createCredentialPanel, resolveOpenUrl } = require('../../src/electron/renderer/limits/accountPanels');
const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { LIMIT_PROVIDER_REGISTRY } = require('../../src/shared/limits/registry');
const { isProviderStale } = require('../../src/shared/limits/core');
const { translate } = require('../../src/electron/renderer/i18n');
const t = (key, params) => translate('en', key, params);
class Node {
  constructor(tag, document) {
    this.style = {}; this.rect = { top: 360, bottom: 380, right: 300, width: 160, height: 210 }; this.tagName = tag; this.document = document; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.value = ''; this.className = '';
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
  getBoundingClientRect() { return this.rect; }
  contains(node) { return [...this.walk()].includes(node); }
  showPopover() { this.popoverOpen = true; this.listeners.beforetoggle?.({ newState: 'open' }); this.listeners.toggle?.({ newState: 'open' }); }
  hidePopover() { this.popoverOpen = false; this.listeners.beforetoggle?.({ newState: 'closed' }); this.listeners.toggle?.({ newState: 'closed' }); }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { const previous = this.listeners[key]; this.listeners[key] = previous ? event => { previous(event); return fn(event); } : fn; }
  focus() { this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  *walk() { yield this; for (const child of this.children) if (child.walk) yield* child.walk(); }
  querySelector(selector) { return [...this.walk()].find(node => selector[0] === '#' ? node.id === selector.slice(1) : node.classList.contains(selector.slice(1))); }
  matches(selector) { return selector === ':popover-open' && Boolean(this.popoverOpen); }
  get offsetWidth() { return 160; }
  get scrollHeight() { return 208; }
  querySelectorAll() { return [...this.walk()].filter(n => ['button', 'input'].includes(n.tagName) && !n.disabled); }
  click() { const result = this.listeners.click?.({ detail: 0 }); if (this.attributes.popovertarget) { const menu = this.document.getElementById(this.attributes.popovertarget); if (menu.popoverOpen) menu.hidePopover(); else menu.showPopover(); } return result; }
  key(key, altKey = false) { return this.listeners.keydown?.({ key, altKey, preventDefault() {}, stopPropagation() {} }); }
}
function harness(translateMessage = t) {
  const document = { defaultView: { innerWidth: 400, innerHeight: 400, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {}, moves: 0, createElement: tag => new Node(tag, document), createTextNode: text => ({ textContent: text }), getElementById: id => document.root.querySelector(`#${id}`) };
  const calls = []; let verdict = { saved: true, verdict: 'valid', accounts: [] };
  const records = [{ id: 'a', label: 'Zulu', fingerprint: 'aa', accountKey: 'ka', enabled: true }, { id: 'b', label: 'Alpha', fingerprint: 'bb', accountKey: 'kb', enabled: false }];
  const slotSettings = { qoderAccountSlots: records.map(record => ({ ...record, values: { qoderSite: 'cn', qoderCookie: 'SECRET' }, accountKeyAliases: record.id === 'a' ? ['old', 'kb'] : [] })) };
  const service = createAccountSlotService({ getSettings: () => slotSettings });
  const slots = service.list('qoder').accounts;
  slots.unshift({ id: 'default', label: '', enabled: true, accountKey: 'default', accountKeyAliases: [], fingerprint: 'abc', formValues: { qoderSite: 'cn' } });
  const ipc = Object.fromEntries(['rename', 'move', 'setEnabled', 'remove', 'add', 'replace'].map(op => [op, async (...args) => { calls.push([op, ...args]); return ['add', 'replace'].includes(op) ? verdict : { ok: true, accounts: slots }; }]));
  const host = new Node('div', document);
  const defaultPanel = new Node('div', document);
  const defaultForm = createCredentialPanel(limitAccountFormsForRenderer().find(f => f.id === 'qoder'), { document, translate: t, onToggle() {}, onClear() {}, onOpen() {}, onRefresh() {}, onSave() {} });
  for (const child of [...defaultForm.querySelector('.cursor-settings-details').children]) defaultPanel.append(child);
  host.append(defaultPanel);
  const panel = createPanel({ defaultPanel, form: limitAccountFormsForRenderer().find(f => f.id === 'qoder'), label: 'Qoder', document, t: translateMessage, ipc, forms: { createCredentialPanel, resolveOpenUrl }, preserveScroll: fn => fn(), onChanged() {}, openExternal() {} });
  host.append(panel.element);
  document.root = host;
  const update = () => panel.update(slots, [{ accountKey: 'ka', status: 'unauthorized', updatedAt: new Date().toISOString() }], true);
  update();
  const row = id => [...panel.element.walk()].find(node => node.dataset.slotId === id);
  const buttons = node => [...node.walk()].filter(n => n.tagName === 'button');
  const click = (node, text) => buttons(node).find(n => n.textContent === text).click();
  return { panel, slots, document, calls, ipc, defaultPanel, row, update, click, set verdict(v) { verdict = v; } };
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
  assert.deepEqual(ordered.map(r => r.accountKey), ['a', undefined, 'b', 'default']);
  assert.equal(records[0].accountKey, 'b');
});
test('menu operations and Alt arrows use the slot IPC', async () => {
  const h = harness();
  await h.click(h.row('a'), 'Pause tracking');
  await h.click(h.row('b'), 'Resume tracking');
  await h.click(h.row('a'), 'Move down');
  await h.row('b').key('ArrowUp', true);
  await h.click(h.row('b'), 'Remove account');
  await h.click(h.row('b'), 'Confirm remove');
  assert.deepEqual(h.calls, [['setEnabled', 'qoder', 'a', false], ['setEnabled', 'qoder', 'b', true], ['move', 'qoder', 'a', 'down'], ['move', 'qoder', 'b', 'up'], ['remove', 'qoder', 'b']]);
});
test('rename Enter saves, Escape cancels; pushes retain input, caret and open menu', async () => {
  const h = harness();
  h.row('a').querySelector('.plugin-more').click();
  h.update();
  assert.equal(h.row('a').querySelector('.plugin-menu').popoverOpen, true);
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
  const result = applyAccountOrder(aggregate.providers, { qoder: [{ accountKey: 'work' }, { accountKey: 'personal' }] }, 'local');
  assert.deepEqual(result.map(r => r.accountName), ['Zulu', 'Alpha', 'Middle']);
});

test('native desktop quota projection uses the same order for Edge Dock, Notch and bubble consumers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const mainPath = path.resolve(__dirname, '../../src/electron/main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  const start = source.indexOf('function desktopQuotaStats(');
  const end = source.indexOf('\nfunction syncPluginQuotaSurfaceDemand(', start);
  const context = { require: require('node:module').createRequire(mainPath), applyAccountOrder, LIMIT_PROVIDER_REGISTRY, settings: { deviceId: 'local' }, pluginRuntime: null,
    accountSlotService: { list: id => ({ accounts: id === 'qoder' ? [{ accountKey: 'z' }, { accountKey: 'a' }] : [] }) } };
  vm.runInNewContext(source.slice(start, end), context);
  const stats = { limits: { providers: [{ provider: 'qoder', accountKey: 'a' }, { provider: 'qoder', accountKey: 'default' }, { provider: 'qoder', accountKey: 'z' }] } };
  const result = context.desktopQuotaStats(stats);
  assert.deepEqual(Array.from(result.limits.providers, row => row.accountKey), ['z', 'a', 'default']);
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
    ACCOUNT_SLOT_PROVIDER_IDS: new Set(LIMIT_PROVIDER_REGISTRY.filter(entry => entry.accountSlots).map(entry => entry.id)), isProviderStale,
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
  assert.deepEqual(h.slots[1].accountKeyAliases, ['old', 'kb']);
  const rows = [{ provider: 'qoder', accountKey: 'old', status: 'unauthorized' },
    { provider: 'qoder', accountKey: 'kb', status: 'ok' }, { provider: 'qoder', accountKey: 'default', status: 'ok' }];
  h.panel.update(h.slots, rows, true);
  assert.match(h.row('a').textContent, /Cookie expired/);
  assert.match(h.row('default').textContent, /Connected/);
  assert.deepEqual(applyAccountOrder(rows, { qoder: h.slots }).map(row => row.accountKey), ['default', 'old', 'kb']);
  h.slots.find(slot => slot.id === 'b').enabled = true;
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
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
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
  h.row('a').querySelector('.plugin-more').click();
  h.panel.openEditor(null);
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput'); input.value = 'draft';
  const scope = { querySelectorAll(selector) {
    const key = { '[data-i18n]': 'i18n', '[data-i18n-aria-label]': 'i18nAriaLabel', '[data-i18n-placeholder]': 'i18nPlaceholder' }[selector];
    return [...h.document.root.walk()].filter(node => node.dataset[key]);
  } };
  require('../../src/electron/renderer/i18n').applyTranslations(scope, 'zh-TW');
  assert.match(h.row('a').textContent, /更換 Cookie/);
  assert.equal(h.panel.element.querySelector('.slot-add').textContent, translate('zh-TW', 'settings.slots.add', { provider: 'Qoder' }));
  assert.equal(h.row('a').querySelector('.plugin-menu').popoverOpen, true);
  assert.equal(input.value, 'draft');
});

test('default row shares menu and naming and retains default form for replacement', async () => {
  const h = harness();
  const menu = row => row.querySelector('.plugin-menu').children.map(node => node.textContent);
  assert.deepEqual(menu(h.row('default')), menu(h.row('a')));
  assert.match(h.row('default').querySelector('.slot-name').textContent, /Account #/);
  assert.doesNotMatch(h.row('default').textContent, /Default account|Clear cookie|Refresh/);
  h.click(h.row('default'), 'Replace cookie');
  const editor = h.panel.element.querySelector('.slot-editor');
  assert.equal(editor.children[0].textContent, 'Replace credential');
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.ok(h.defaultPanel.parentElement !== editor);
  await h.click(h.row('default'), 'Pause tracking');
  assert.deepEqual(h.calls[0], ['setEnabled', 'qoder', 'default', false]);
  h.panel.update([{ id: 'a', enabled: true, accountKey: 'ka' }, { id: 'default', enabled: false, label: 'Personal', fingerprint: 'abc', source: 'environment' }, { id: 'b', enabled: true, accountKey: 'kb' }], [], true);
  assert.equal(h.row('default').querySelector('.slot-name').textContent, 'Personal');
  const buttons = h.row('default').querySelector('.plugin-menu').children;
  assert.equal(h.row('default').querySelector('.slot-actions').classList.contains('hidden'), true);
  assert.equal(buttons.length, 8);
  assert.match(h.row('default').textContent, /From environment variable/);
});

test('slot CSS uses defined theme tokens for light and dark surfaces and status', () => {
  const css = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/styles.css'), 'utf8');
  const slots = css.slice(css.indexOf('/* Local account slots'));
  const declared = new Set([...css.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  assert.match(slots, /\.slot-list \{[^}]*overflow: clip;/);
  assert.match(slots, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, max-content\) 28px/);
  assert.match(slots, /\.slot-status \{ min-width: 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(slots, /\.slot-name \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(slots, /\.slot-status \{[^}]*text-align: right;/);
  for (const match of slots.matchAll(/var\((--[\w-]+)/g)) assert.ok(declared.has(match[1]), match[1]);
  for (const token of ['--panel-rgb', '--line', '--text', '--muted', '--success', '--red', '--yellow']) assert.ok(slots.includes(`var(${token})`), token);
});

test('pending slot save queues move pause and rename without dropping operations', async () => {
  const h = harness(); let resolve;
  h.verdict = new Promise(r => { resolve = r; });
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'replacement';
  const saving = h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  await Promise.resolve();
  const move = h.click(h.row('a'), 'Move down');
  const pause = h.click(h.row('a'), 'Pause tracking');
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Queued';
  const rename = input.key('Enter');
  assert.deepEqual(h.calls.map(call => call[0]), ['replace']);
  resolve({ saved: true, verdict: 'valid', accounts: h.slots });
  await Promise.all([saving, move, pause, rename]);
  assert.deepEqual(h.calls.map(call => call[0]), ['replace', 'move', 'setEnabled', 'rename']);
  assert.equal(h.calls.at(-1)[3], 'Queued');
});

test('local default then stored slots precede remote accounts in aggregate order', () => {
  const row = (accountKey, sourceDeviceId) => ({ provider: 'qoder', accountKey, sourceDeviceId });
  const rows = [row('remote-a', 'remote'), row('b', 'local'), row('remote-b', 'remote'), row('default', 'local'), row('a', 'local')];
  assert.deepEqual(applyAccountOrder(rows, { qoder: [{ accountKey: 'a' }, { accountKey: 'b' }] }, 'local').map(row => row.accountKey), ['a', 'b', 'remote-a', 'remote-b', 'default']);
});

test('stale translations describe data rather than expired credentials', () => {
  for (const [locale, expected] of [['en', 'Stale'], ['zh-TW', '資料未更新'], ['zh-CN', '数据未更新'], ['ja', '古いデータ']]) assert.equal(translate(locale, 'settings.slots.stale'), expected);
});

test('China replacement initializes redacted form values and retains site on indeterminate save', async () => {
  const h = harness();
  assert.deepEqual(h.slots[0].formValues, { qoderSite: 'cn' });
  assert.ok(!JSON.stringify(h.slots).includes('SECRET'));
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
  const site = h.document.getElementById('qoderSlotDraftqoderSiteInput');
  assert.equal(site.value, 'cn');
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'replacement';
  h.update(); assert.equal(site.value, 'cn');
  h.verdict = { saved: true, verdict: 'unavailable', accounts: h.slots };
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.equal(h.calls[0][3].qoderSite, 'cn');
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
  h.document.getElementById('qoderSlotDraftqoderSiteInput').value = 'global';
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'replacement';
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.equal(h.calls[1][3].qoderSite, 'global');
});

function rendererSlotContext(stats) {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const state = { stats, settings: { deviceId: 'local', limitAccountForms: limitAccountFormsForRenderer() } };
  const calls = [];
  const context = { state, localDeviceLimitsProviders: () => null, limitAccountForm: id => state.settings.limitAccountForms.find(form => form.id === id), render() {},
    localProviderStatuses: id => (stats.limits?.providers || []).filter(row => row.provider === id),
    window: { tokenMonitor: { limits: { accountSlots: { list: async id => { calls.push(id); return { ok: true, accounts: [{ accountKey: 'z' }] }; } } } } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const accountSlotPanels ='), source.indexOf('function desktopLimitRecords()')), context);
  return { context, source, vm, calls };
}

test('slot panel readings retain legacy aggregate fallback without devices', async () => {
  const rows = [{ provider: 'qoder', status: 'unauthorized' }];
  const { context, vm } = rendererSlotContext({ limits: { providers: rows } });
  const seen = [];
  context.panel = { update: (...args) => seen.push(args) };
  vm.runInContext("accountSlotPanels.set('qoder', panel)", context);
  await context.refreshAccountSlotPanels();
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[0][1], rows); assert.deepEqual(seen.at(-1)[1], rows);
});

test('startup and settings pushes load slot lists with no mounted Settings panels', async () => {
  const { context, source, vm, calls } = rendererSlotContext({ limits: { providers: [] } });
  context.window.tokenMonitor.getSettings = async () => context.state.settings;
  const start = source.indexOf('  state.settings = await window.tokenMonitor.getSettings();', source.indexOf('async function init()'));
  const end = source.indexOf('  // Local appearance', start);
  await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
  assert.deepEqual(calls.sort(), ['deepseek', 'qoder']);
  assert.equal(vm.runInContext('accountSlotLists.qoder[0].accountKey', context), 'z');
  const push = source.slice(source.indexOf('window.tokenMonitor.onSettingsPush?.((next)'), source.indexOf('window.tokenMonitor.codex.onActiveAccount'));
  assert.match(push, /refreshAccountSlotPanels\(\)/);
});

test('slot freshness honors Hub threshold upload interval floor and registry opt-ins', () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/main.js'), 'utf8');
  const context = { settings: { deviceId: 'local' }, lastCollectedDevice: null, mode: 'local', localDevice: null,
    attachLocalPresentationNativeViews() {}, isProviderStale, LIMIT_PROVIDER_REGISTRY: [...LIMIT_PROVIDER_REGISTRY, { id: 'future', accountSlots: true }] };
  vm.createContext(context);
  vm.runInContext(source.match(/const ACCOUNT_SLOT_PROVIDER_IDS = .*;/)[0], context);
  vm.runInContext(source.slice(source.indexOf('function injectLocalDeviceStatus('), source.indexOf('function macWidgetConfiguration(')), context);
  for (const [age, interval, expected] of [[5, 0, false], [15, 0, true], [35, 20 * 60000, false], [45, 20 * 60000, true]]) {
    const stats = { staleAfterMs: 10 * 60000, devices: [{ deviceId: 'local', syncUploadIntervalMs: interval, limits: { refreshMs: 60000, providers: ['qoder', 'future'].map(provider => ({ provider, status: 'ok', updatedAt: new Date(Date.now() - age * 60000).toISOString() })) } }] };
    assert.deepEqual(Array.from(context.injectLocalDeviceStatus(stats).devices[0].limits.providers, row => row.stale), [expected, expected]);
  }
  const body = source.slice(source.indexOf('function injectLocalDeviceStatus('), source.indexOf('function macWidgetConfiguration('));
  assert.doesNotMatch(body, /require\(/);
});


test('slot popover escapes clipping flips upward and retains keyboard focus across pushes', () => {
  const h = harness();
  const row = h.row('b'); const more = row.querySelector('.plugin-more');
  const menu = row.querySelector('.plugin-menu');
  more.click();
  assert.equal(menu.attributes.popover, 'auto');
  assert.equal(menu.popoverOpen, true);
  assert.equal(menu.style.top, '146px');
  assert.equal(menu.style.left, '140px');
  assert.equal(h.document.activeElement, menu.children[0]);
  menu.key('ArrowDown');
  const focused = h.document.activeElement;
  assert.equal(focused, menu.children[1]);
  h.update();
  assert.equal(menu.popoverOpen, true);
  assert.equal(h.document.activeElement, focused);
  menu.key('End');
  assert.equal(h.document.activeElement, menu.children[7]);
  menu.key('Escape');
  assert.equal(menu.popoverOpen, false);
  assert.equal(more.attributes['aria-expanded'], 'false');
  assert.equal(h.document.activeElement, more);
  more.click();
  menu.hidePopover(); // Native light dismissal uses the same beforetoggle lifecycle.
  assert.equal(menu.popoverOpen, false);
  assert.equal(h.document.activeElement, more);
  more.rect = { top: 10, bottom: 30, right: 300 };
  more.click();
  assert.equal(menu.style.top, '34px');
  const css = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/styles.css'), 'utf8');
  assert.match(css, /\.plugin-menu \{ position: fixed; inset: auto; margin: 0;/);
});

for (const nextId of ['a', 'b']) test(`cancelled pending rename cannot finish a newer rename on ${nextId}`, async () => {
  const h = harness(); let resolve;
  h.ipc.rename = () => new Promise(r => { resolve = r; });
  h.click(h.row('a'), 'Rename');
  const old = h.row('a').querySelector('.slot-rename'); old.value = 'Old';
  const pending = old.key('Enter');
  await Promise.resolve();
  await old.key('Escape');
  h.click(h.row(nextId), 'Rename');
  const input = h.row(nextId).querySelector('.slot-rename'); input.value = 'New'; input.selectionStart = 2;
  resolve({ ok: true, accounts: h.slots });
  await pending;
  h.update();
  assert.equal(h.row(nextId).querySelector('.slot-rename'), input);
  assert.equal(input.value, 'New'); assert.equal(input.selectionStart, 2);
  assert.equal(h.document.activeElement, input);
});

test('slot actions menu items and add row declare visible keyboard focus', () => {
  const css = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/styles.css'), 'utf8');
  assert.match(css, /\.slot-panel \.plugin-more:focus-visible, \.slot-fix:focus-visible, \.slot-add:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: -2px;/);
});


test('shared action menu is loaded before both consumers and owns the plugin plate', () => {
  const fs = require('node:fs');
  const read = name => fs.readFileSync(require.resolve('../../src/electron/renderer/' + name), 'utf8');
  assert.equal(typeof require('../../src/electron/renderer/actionMenu').create, 'function');
  for (const name of ['pluginSettings.js', 'limits/accountSlotsPanel.js']) assert.match(read(name), /(?:actionMenuApi|menus)\.create\(document,/);
  const html = read('index.html');
  assert.ok(html.indexOf('src="selectControl.js"') < html.indexOf('src="actionMenu.js"'));
  for (const name of ['pluginSettings.js', 'limits/accountSlotsPanel.js']) assert.ok(html.indexOf('src="actionMenu.js"') < html.indexOf(`src="${name}"`));
  assert.match(read('actionMenu.js'), /positionApi.popupPosition/);
  assert.match(read('actionMenu.js'), /positionApi.navigate/);
  assert.doesNotMatch(read('limits/accountSlotsPanel.js'), /showPopover|popupPosition/);
  assert.doesNotMatch(read('styles.css'), /\.slot-menu/);
});

test('single line rows omit timestamps; only failing rows have a compact recovery beneath the name', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', status: 'ok' }, { accountKey: 'ka', status: 'unauthorized' }], true);
  assert.equal(h.row('default').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.ok(h.row('a').querySelector('.slot-copy').children[1] === h.row('a').querySelector('.slot-fix'));
  assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('plugin-inline-action'), true);
  assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('hidden'), false);
  assert.equal(h.row('b').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.equal(h.row('a').querySelector('.slot-updated'), undefined);
  assert.ok(h.row('a').querySelector('.plugin-more-icon'));
  const i18n = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/i18n.js'), 'utf8');
  assert.doesNotMatch(i18n, /settings.slots.(?:updated|notUpdated)/);
});

test('editors occupy the group at their owner and use existing form actions including cancel', () => {
  const h = harness();
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
  const editor = h.panel.element.querySelector('.slot-editor');
  const list = h.panel.element.querySelector('.slot-list');
  assert.ok(editor.parentElement === list);
  assert.ok(list.children[list.children.indexOf(h.row('a')) + 1] === editor);
  assert.equal(editor.children.some(node => node.classList.contains('credential-input')), false);
  const submit = h.document.getElementById('qoderSlotDraftCredentialSubmit');
  assert.equal(submit.classList.contains('slot-save'), true);
  assert.equal(submit.parentElement.children[1].textContent, 'Cancel');
  h.panel.openEditor(null);
  assert.equal(editor.children[1].classList.contains('credential-input'), true);
  assert.equal(list.children[list.children.indexOf(editor) + 1].classList.contains('slot-add'), true);
  assert.equal(list.children.at(-1).classList.contains('hidden'), true);
  h.click(h.row('default'), 'Replace cookie');
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.ok(h.defaultPanel.parentElement !== editor);
  assert.ok(list.children[list.children.indexOf(h.row('default')) + 1] === editor);
  h.update();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.ok(h.defaultPanel.parentElement !== editor);
  assert.equal([...h.panel.element.walk()].some(node => node.tagName === 'details'), false);
  h.click(editor, 'Cancel');
  assert.equal(editor.classList.contains('hidden'), true);
  assert.equal(editor.children.length, 0);
});


test('a failing default row opens the same retained default editor from its recovery line', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', status: 'unauthorized' }], true);
  const fix = h.row('default').querySelector('.slot-fix');
  assert.equal(fix.classList.contains('hidden'), false);
  fix.click();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
});


test('shared menu module navigates enabled controls, restores focus and retains native target semantics', () => {
  const h = harness();
  const { create } = require('../../src/electron/renderer/actionMenu');
  const menu = create(h.document, 'Actions', (text, fn, className) => {
    const button = new Node('button', h.document); button.className = className; button.textContent = text; button.addEventListener('click', fn); return button;
  });
  const first = new Node('button', h.document);
  const disabled = new Node('button', h.document); disabled.disabled = true;
  const last = new Node('button', h.document);
  menu.popover.append(first, disabled, last);
  h.document.root.append(menu.element);
  assert.equal(menu.trigger.attributes.popovertarget, menu.popover.id);
  assert.equal(menu.popover.attributes.popover, 'auto');
  assert.ok(menu.trigger.querySelector('.plugin-more-icon'));
  menu.trigger.key('ArrowUp');
  assert.ok(h.document.activeElement === last);
  menu.popover.key('Home');
  assert.ok(h.document.activeElement === first);
  menu.popover.key('ArrowDown');
  assert.ok(h.document.activeElement === last);
  menu.popover.hidePopover();
  assert.ok(h.document.activeElement === menu.trigger);
  assert.equal(menu.trigger.attributes['aria-expanded'], 'false');
  menu.trigger.click();
  menu.popover.key('Escape');
  assert.equal(menu.popover.popoverOpen, false);
  assert.ok(h.document.activeElement === menu.trigger);
});

test('a rename finishes on its own row after another row starts renaming', async () => {
  const h = harness(); let resolve;
  h.ipc.rename = () => new Promise(r => { resolve = r; });
  h.click(h.row('a'), 'Rename');
  const first = h.row('a').querySelector('.slot-rename'); first.value = 'First';
  const pending = first.key('Enter');
  await Promise.resolve();
  h.click(h.row('b'), 'Rename');
  resolve({ ok: true, accounts: h.slots });
  await pending;
  assert.equal(h.row('a').querySelector('.slot-rename'), undefined);
  assert.ok(h.row('b').querySelector('.slot-rename'));
  assert.ok(h.document.activeElement === h.row('b').querySelector('.slot-rename'), 'row B keeps rename focus');
});

test('Enter that confirms an IME composition does not save the rename', async () => {
  const h = harness();
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = '工作';
  await input.listeners.keydown({ key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.calls.length, 0);
  assert.equal(h.row('a').querySelector('.slot-rename'), input);
});

test('adding a different account twice while the first add is pending saves it once', async () => {
  const h = harness(); h.verdict = { saved: false, verdict: 'differentAccount' };
  h.click(h.row('a'), 'Replace cookie');
  h.document.getElementById('qoderSlotDraftqoderCookieInput').value = 'fake-cookie';
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  let resolve;
  h.ipc.add = (...args) => { h.calls.push(['add', ...args]); return new Promise(r => { resolve = r; }); };
  h.click(h.panel.element, 'Add as another account');
  h.click(h.panel.element, 'Add as another account');
  await Promise.resolve(); await Promise.resolve();
  resolve({ saved: true, verdict: 'valid', accounts: h.slots });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  if (resolve) resolve({ saved: true, verdict: 'valid', accounts: h.slots });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.calls.filter(call => call[0] === 'add').length, 1);
});

test('full account order places the default placeholder in the middle', () => {
  const slots = [{ id: 'a', accountKey: 'a' }, { id: 'default', accountKey: 'fixed', label: 'Personal' }, { id: 'b', accountKey: 'b' }];
  const rows = ['b', 'fixed', 'a'].map(accountKey => ({ provider: 'deepseek', accountKey }));
  assert.deepEqual(applyAccountOrder(rows, { deepseek: slots }).map(row => row.accountKey), ['a', 'fixed', 'b']);
});


test('shared action menu is loaded before both consumers and owns the plugin plate', () => {
  const fs = require('node:fs');
  const read = name => fs.readFileSync(require.resolve('../../src/electron/renderer/' + name), 'utf8');
  assert.equal(typeof require('../../src/electron/renderer/actionMenu').create, 'function');
  for (const name of ['pluginSettings.js', 'limits/accountSlotsPanel.js']) assert.match(read(name), /(?:actionMenuApi|menus)\.create\(document,/);
  const html = read('index.html');
  assert.ok(html.indexOf('src="selectControl.js"') < html.indexOf('src="actionMenu.js"'));
  for (const name of ['pluginSettings.js', 'limits/accountSlotsPanel.js']) assert.ok(html.indexOf('src="actionMenu.js"') < html.indexOf(`src="${name}"`));
  assert.match(read('actionMenu.js'), /positionApi.popupPosition/);
  assert.match(read('actionMenu.js'), /positionApi.navigate/);
  assert.doesNotMatch(read('limits/accountSlotsPanel.js'), /showPopover|popupPosition|function positionMenu/);
  assert.doesNotMatch(read('styles.css'), /\.slot-menu/);
});

test('single line rows omit timestamps; only failing rows have a compact recovery beneath the name', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', status: 'ok' }, { accountKey: 'ka', status: 'unauthorized' }], true);
  assert.equal(h.row('default').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.equal(h.row('a').querySelector('.slot-copy').children[1], h.row('a').querySelector('.slot-fix'));
  assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('plugin-inline-action'), true);
  assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('hidden'), false);
  assert.equal(h.row('b').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.equal(h.row('a').querySelector('.slot-updated'), undefined);
  assert.ok(h.row('a').querySelector('.plugin-more-icon'));
  const i18n = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/i18n.js'), 'utf8');
  assert.doesNotMatch(i18n, /settings.slots.(?:updated|notUpdated)/);
});

test('editors occupy the group at their owner and use existing form actions including cancel', () => {
  const h = harness();
  h.panel.openEditor(h.slots.find(slot => slot.id === 'a'));
  const editor = h.panel.element.querySelector('.slot-editor');
  const list = h.panel.element.querySelector('.slot-list');
  assert.equal(editor.parentElement, list);
  assert.equal(list.children[list.children.indexOf(h.row('a')) + 1], editor);
  assert.equal(editor.children.some(node => node.classList.contains('credential-input')), false);
  const submit = h.document.getElementById('qoderSlotDraftCredentialSubmit');
  assert.equal(submit.classList.contains('slot-save'), true);
  assert.equal(submit.parentElement.children[1].textContent, 'Cancel');
  h.panel.openEditor(null);
  assert.equal(editor.children[1].classList.contains('credential-input'), true);
  assert.equal(list.children[list.children.indexOf(editor) + 1].classList.contains('slot-add'), true);
  assert.equal(list.children.at(-1).classList.contains('hidden'), true);
  h.click(h.row('default'), 'Replace cookie');
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.equal(list.children[list.children.indexOf(h.row('default')) + 1], editor);
  h.update();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.equal([...h.panel.element.walk()].some(node => node.tagName === 'details'), false);
  h.click(editor, 'Cancel');
  assert.equal(editor.classList.contains('hidden'), true);
  assert.equal(h.defaultPanel.isConnected, true);
});


test('slot remove arms in place then confirms without a native dialog', async () => {
  const h = harness(); const row = h.row('a');
  row.querySelector('.plugin-more').click();
  const menu = row.querySelector('.plugin-menu');
  const remove = menu.children.at(-1);
  await remove.click();
  assert.equal(h.calls.length, 0);
  assert.equal(menu.popoverOpen, true);
  assert.equal(remove.textContent, 'Confirm remove');
  assert.equal(remove.attributes['aria-label'], 'Confirm remove');
  assert.equal(h.document.activeElement, remove);
  assert.ok(remove.classList.contains('menu-destructive'));
  assert.ok(remove.classList.contains('confirming'));
  await remove.click();
  assert.equal(menu.popoverOpen, false);
  assert.deepEqual(h.calls, [['remove', 'qoder', 'a']]);
});
for (const close of ['escape', 'outside', 'other action']) test(`slot remove disarms on ${close}`, async () => {
  const h = harness(); const row = h.row('a');
  const trigger = row.querySelector('.plugin-more'); trigger.click();
  const menu = row.querySelector('.plugin-menu'); const remove = menu.children.at(-1);
  await remove.click();
  if (close === 'escape') menu.key('Escape');
  else if (close === 'outside') menu.hidePopover();
  else await h.click(row, 'Pause tracking');
  trigger.click();
  assert.equal(remove.textContent, 'Remove account');
  assert.equal(remove.attributes['aria-label'], 'Remove account');
  assert.equal(remove.classList.contains('confirming'), false);
  await remove.click();
  assert.equal(h.calls.filter(call => call[0] === 'remove').length, 0);
});
test('armed remove survives provider render and live locale translation', () => {
  let language = 'en';
  const h = harness((key, params) => translate(language, key, params)); const row = h.row('a'); row.querySelector('.plugin-more').click();
  const menu = row.querySelector('.plugin-menu'); const remove = menu.children.at(-1); remove.click();
  h.update();
  assert.equal(menu.popoverOpen, true);
  assert.equal(h.document.activeElement, remove);
  assert.equal(remove.textContent, 'Confirm remove');
  for (const [locale, label] of Object.entries({ en: 'Confirm remove', 'zh-TW': '確認移除', 'zh-CN': '确认移除', ko: '삭제 확인', ja: '削除を確認', es: 'Confirmar eliminación', 'pt-BR': 'Confirmar remoção' })) {
    language = locale;
    // The application's live i18n pass follows these data attributes.
    remove.textContent = translate(locale, remove.dataset.i18n);
    remove.setAttribute('aria-label', translate(locale, remove.dataset.i18nAriaLabel));
    assert.equal(remove.textContent, label);
    h.update();
    assert.equal(remove.textContent, label);
    assert.equal(menu.popoverOpen, true);
    assert.equal(remove.attributes['aria-label'], remove.textContent);
  }
});
test('slot native confirmation plumbing is absent', () => {
  const fs = require('node:fs');
  const read = name => fs.readFileSync(require.resolve('../../src/electron/renderer/' + name), 'utf8');
  assert.doesNotMatch(read('limits/accountSlotsPanel.js'), /\bconfirm\s*[(:]/);
  const setup = read('app.js').split('TokenMonitorAccountSlotsPanel.createPanel({')[1].split('accountSlotPanels.set')[0];
  assert.doesNotMatch(setup, /window\.confirm|\bconfirm\s*:/);
});
test('shared menu ARIA applies to slot actions and plugin actions while preserving switch rows', () => {
  const h = harness(); const row = h.row('a');
  assert.equal(row.querySelector('.plugin-more').attributes['aria-haspopup'], 'menu');
  const popover = row.querySelector('.plugin-menu');
  assert.equal(popover.attributes.role, 'menu');
  assert.equal(popover.attributes['aria-labelledby'], row.querySelector('.plugin-more').id);
  for (const node of popover.children) assert.equal(node.attributes.role, node.tagName === 'hr' ? 'separator' : 'menuitem');
  const { create } = require('../../src/electron/renderer/actionMenu');
  const menu = create(h.document, 'Plugin actions', () => new Node('button', h.document));
  const label = new Node('label', h.document); const toggle = new Node('input', h.document); toggle.setAttribute('role', 'switch'); label.append(toggle);
  const auto = new Node('label', h.document); const checkbox = new Node('input', h.document); checkbox.type = 'checkbox'; auto.append(checkbox);
  const action = new Node('button', h.document);
  menu.appendItems(label, auto, action);
  assert.equal(menu.trigger.attributes['aria-haspopup'], 'menu');
  assert.equal(menu.popover.attributes.role, 'menu');
  assert.equal(menu.popover.attributes['aria-labelledby'], menu.trigger.id);
  assert.equal(action.attributes.role, 'menuitem');
  assert.equal(toggle.attributes.role, 'switch');
  assert.equal(checkbox.attributes.role, undefined);
  assert.equal(label.attributes.role, undefined);
  assert.equal(auto.attributes.role, undefined);
  const source = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/pluginSettings'), 'utf8');
  assert.match(source, /menu\.appendItems\(button/);
  assert.match(source, /menu\.appendItems\(leadingControl/);
  assert.match(source, /menu\.appendItems\(automatic/);
});

test('an armed remove item has its own tinted background, matching other inline confirmations', () => {
  const css = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/styles.css'), 'utf8');
  assert.match(css, /\.plugin-menu button\.menu-destructive\.confirming \{ color: var\(--red\); background: rgba\(255, 91, 91, 0\.12\);/);
  assert.match(css, /\.managed-account-remove\.confirming \{[^}]*background: rgba\(255, 91, 91, 0\.12\);/);
});

for (const event of ['resize', 'scroll']) test(`detached open action menu releases global listeners on ${event}`, () => {
  const h = harness(); const listeners = new Map();
  const track = target => {
    target.addEventListener = (name, callback) => listeners.set(name, callback);
    target.removeEventListener = (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); };
  };
  track(h.document); track(h.document.defaultView);
  const menu = h.row('a').querySelector('.plugin-menu');
  menu.showPopover();
  assert.equal(listeners.size, 2);
  h.panel.element.remove();
  listeners.get(event)();
  assert.equal(listeners.size, 0);
});

test('a reading that resolved to its real key keeps its place with a cached pre-resolution slot list', () => {
  const cached = { deepseek: [{ id: 'first', accountKey: 'provisional-first' }, { id: 'second', accountKey: 'second' }] };
  const records = [
    { provider: 'deepseek', accountKey: 'second' },
    { provider: 'deepseek', accountKey: 'resolved-first', accountKeyAliases: ['provisional-first'] }
  ];
  assert.deepEqual(applyAccountOrder(records, cached).map(row => row.accountKey), ['resolved-first', 'second']);
});
