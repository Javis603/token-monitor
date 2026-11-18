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
    this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } }; this.rect = { top: 360, bottom: 380, right: 300, width: 160, height: 210 }; this.tagName = tag; this.document = document; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.value = ''; this.className = '';
    this.classList = { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(v => v !== name).join(' '); }, toggle: (name, force) => { const yes = force ?? !this.classList.contains(name); this.classList[yes ? 'add' : 'remove'](name); return yes; } };
  }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = value; }
  get textContent() { return this.text || this.children.map(child => child.textContent || '').join(''); }
  append(...children) { children.forEach(child => this.insertBefore(child, null)); }
  insertBefore(child, before) { if (typeof child === 'string') child = { textContent: child }; child.remove?.(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parentElement = this; }
  moveBefore(child, before) { this.document.moves++; this.insertBefore(child, before); }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  get isConnected() { return this === this.document.root || Boolean(this.parentElement?.isConnected); }
  getBoundingClientRect() { return this.rect; }
  contains(node) { return [...this.walk()].includes(node); }
  showPopover() { this.popoverOpen = true; this.listeners.beforetoggle?.({ newState: 'open' }); this.listeners.toggle?.({ newState: 'open' }); }
  hidePopover() { this.popoverOpen = false; this.listeners.beforetoggle?.({ newState: 'closed' }); this.listeners.toggle?.({ newState: 'closed' }); }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  removeAttribute(key) { delete this.attributes[key]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { const previous = this.listeners[key]; this.listeners[key] = previous ? event => { previous(event); return fn(event); } : fn; }
  focus() { this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  *walk() { yield this; for (const child of this.children) if (child.walk) yield* child.walk(); }
  querySelector(selector) { return [...this.walk()].find(node => selector[0] === '#' ? node.id === selector.slice(1) : node.classList.contains(selector.slice(1))); }
  matches(selector) {
    if (selector === ':popover-open') return Boolean(this.popoverOpen);
    if (selector === '.slot-row[data-slot-draggable="true"]') return this.classList.contains('slot-row') && this.dataset.slotDraggable === 'true';
    return selector.split(', ').some(part => part[0] === '.' ? this.classList.contains(part.slice(1)) : this.tagName === part);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  removeEventListener(key, fn) { if (this.listeners[key] === fn) delete this.listeners[key]; }
  get offsetWidth() { return 160; }
  get scrollHeight() { return 208; }
  querySelectorAll(selector = '') { return [...this.walk()].filter(n => selector.startsWith('.slot-row') ? n.matches(selector) : ['button', 'input'].includes(n.tagName) && !n.disabled); }
  click() { const result = this.listeners.click?.({ detail: 0 }); if (this.attributes.popovertarget) { const menu = this.document.getElementById(this.attributes.popovertarget); if (menu.popoverOpen) menu.hidePopover(); else menu.showPopover(); } return result; }
  key(key, altKey = false) { return this.listeners.keydown?.({ key, altKey, preventDefault() {}, stopPropagation() {} }); }
}
function harness(translateMessage = t, providerId = 'qoder', loginAction, maskEmail) {
  const document = { defaultView: { innerWidth: 400, innerHeight: 400, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {}, moves: 0, createElement: tag => new Node(tag, document), createTextNode: text => ({ textContent: text }), getElementById: id => document.root.querySelector(`#${id}`) };
  const calls = []; let verdict = { saved: true, verdict: 'valid', accounts: [] };
  const records = [{ id: 'a', label: 'Zulu', fingerprint: 'aa', accountKey: 'ka', enabled: true }, { id: 'b', label: 'Alpha', fingerprint: 'bb', accountKey: 'kb', enabled: false }];
  const slotSettings = { qoderAccountSlots: records.map(record => ({ ...record, values: { qoderSite: 'cn', qoderCookie: 'SECRET' }, accountKeyAliases: record.id === 'a' ? ['old', 'kb'] : [] })) };
  const service = createAccountSlotService({ getSettings: () => slotSettings, write: async patch => Object.assign(slotSettings, patch) });
  const slots = service.list('qoder').accounts;
  slots.unshift({ id: 'default', label: '', enabled: true, accountKey: 'default', accountKeyAliases: [], fingerprint: 'abc', formValues: { qoderSite: 'cn' } });
  const ipc = Object.fromEntries(['rename', 'move', 'setEnabled', 'remove', 'add', 'replace'].map(op => [op, async (...args) => { calls.push([op, ...args]); return ['add', 'replace'].includes(op) ? verdict : { ok: true, accounts: slots }; }]));
  ipc.presentation = async (...args) => { calls.push(['presentation', ...args]); return { ok: true, accounts: slots, presentation: { qoder: { labels: {}, order: args[2] === 'order' ? args[3] : [] } } }; };
  const host = new Node('div', document);
  const defaultPanel = new Node('div', document);
  const defaultForm = createCredentialPanel(limitAccountFormsForRenderer().find(f => f.id === providerId), { document, translate: t, onToggle() {}, onClear() {}, onOpen() {}, onRefresh() {}, onSave() {} });
  for (const child of [...defaultForm.querySelector('.cursor-settings-details').children]) defaultPanel.append(child);
  host.append(defaultPanel);
  const panel = createPanel({ loginAction, maskEmail, defaultPanel, form: limitAccountFormsForRenderer().find(f => f.id === providerId), label: 'Qoder', document, t: translateMessage, ipc, forms: { createCredentialPanel, resolveOpenUrl }, preserveScroll: fn => fn(), onChanged() {}, openExternal() {} });
  host.append(panel.element);
  document.root = host;
  const update = () => panel.update(slots, [{ accountKey: 'ka', status: 'unauthorized', updatedAt: new Date().toISOString() }], true);
  update();
  const row = id => [...panel.element.walk()].find(node => node.dataset.slotId === id);
  const buttons = node => [...node.walk()].filter(n => n.tagName === 'button');
  const click = (node, text) => buttons(node).find(n => n.textContent === text).click();
  return { panel, slots, service, slotSettings, document, calls, ipc, defaultPanel, row, update, click, set verdict(v) { verdict = v; } };
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
test('explicit collection sources change row status without waiting for newer quota', () => {
  const h = harness(t, 'cline');
  const slots = [
    { id: 'detected', accountKey: 'local-key', source: 'discovered', collectionSources: ['local'], enabled: true },
    { id: 'saved', accountKey: 'saved-key', collectionSources: ['api'], enabled: true }
  ];
  const readings = slots.map(slot => ({ provider: 'cline', accountKey: slot.accountKey, status: 'ok' }));
  const status = id => h.row(id).querySelector('.slot-status').textContent;
  h.panel.update(slots, readings, { settings: { clineSourcePreference: 'local' } });
  assert.equal(status('saved'), 'Not collected');
  assert.equal(status('detected'), 'Connected');
  h.panel.update(slots, readings, { settings: { clineSourcePreference: 'api' } });
  assert.equal(status('detected'), 'Not collected');
  assert.equal(status('saved'), 'Connected');
});
test('a paired saved credential keeps its own replace and remove controls under one identity', async () => {
  const h = harness(t, 'cline');
  const detected = { id: 'detected', accountKey: 'shared', label: 'Work', source: 'discovered', sourceName: 'Cline', enabled: true };
  const saved = { id: 'saved', accountKey: 'shared', label: 'Work', credentialFor: detected.id, enabled: true };
  h.panel.update([detected, saved], [{ provider: 'cline', accountKey: 'shared', status: 'ok' }]);
  assert.deepEqual(h.panel.summary(), { total: 1, linked: 1 });
  const row = h.row(saved.id);
  assert.equal(row.querySelector('.slot-detail').textContent, 'Saved credential');
  assert.equal(row.querySelector('.slot-status').textContent, '');
  assert.equal(row.dataset.slotDraggable, 'false');
  h.click(row, 'Replace API key');
  assert.ok(h.document.getElementById('clineSlotDraftclineApiKeyInput'));
  h.click(h.panel.element, 'Cancel');
  h.click(row, 'Remove account');
  await h.click(row, 'Confirm remove');
  assert.deepEqual(h.calls[0], ['remove', 'cline', saved.id]);
});
test('account list distinguishes duplicate visible labels without revealing masked addresses', () => {
  const { maskEmailAddress } = require('../../src/electron/renderer/accountIdentity');
  const h = harness(t, 'qoder', undefined, maskEmailAddress);
  const slots = [
    { id: 'a', accountKey: 'alice@example.test', accountEmail: 'alice@example.test', enabled: true },
    { id: 'b', accountKey: 'anne@example.test', accountEmail: 'anne@example.test', enabled: true }
  ];
  const title = id => h.row(id).querySelector('.slot-name').textContent;
  h.panel.update(slots, []);
  const first = title('a');
  const second = title('b');
  assert.match(first, /^a\*\*\*e@example\.test · #[a-f0-9]+$/);
  assert.notEqual(first, second);
  const breakBeforeDomain = h.row('a').querySelector('.slot-name').children.find(node => node.tagName === 'wbr');
  assert.ok(breakBeforeDomain);
  h.panel.update([...slots].reverse(), []);
  assert.ok(h.row('a').querySelector('.slot-name').children.includes(breakBeforeDomain));
  assert.equal(title('a'), first);
  assert.equal(title('b'), second);
  h.panel.update(slots.map(row => ({ ...row, label: 'Work' })), []);
  assert.match(title('a'), /^Work · #/);
  assert.notEqual(title('a'), title('b'));
});

for (const [provider, expected] of [['ollama', 'settings.slots.invalidKey'], ['trae', 'settings.slots.fixToken']]) {
  test(`${provider} reports the failed credential lane for API and Web rows`, () => {
    const h = harness(key => key, provider);
    const slots = [{ id: 'a', accountKey: 'api', enabled: true }, { id: 'b', accountKey: 'web', enabled: true }];
    h.panel.update(slots, [
      { accountKey: 'api', source: 'api', status: 'unauthorized' },
      { accountKey: 'web', source: 'web', status: 'unauthorized' }
    ]);
    assert.equal(h.row('a').querySelector('.slot-status').textContent, expected);
    assert.equal(h.row('b').querySelector('.slot-status').textContent, 'settings.slots.invalidCookie');
  });
}
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
  assert.deepEqual(h.calls, [['setEnabled', 'qoder', 'a', false], ['setEnabled', 'qoder', 'b', true], ['presentation', 'qoder', 'ka', 'order', ['default', 'kb', 'ka']], ['presentation', 'qoder', 'kb', 'order', ['kb', 'default', 'ka']], ['remove', 'qoder', 'b']]);
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

test('a full account list explains its saved account limit inside the add form', async () => {
  const h = harness();
  h.slotSettings.qoderAccountSlots = Array.from({ length: 21 }, (_, index) => ({
    id: `account-${index}`, values: { qoderCookie: `fixture-${index}`, qoderSite: 'cn' }
  }));
  h.ipc.add = h.service.add;
  h.panel.openEditor(null);
  const input = h.document.getElementById('qoderSlotDraftqoderCookieInput');
  input.value = 'another-fixture';
  await h.document.getElementById('qoderSlotDraftCredentialSubmit').click();
  assert.equal(h.document.getElementById('qoderSlotDraftVerdict').textContent,
    'You can save up to 21 accounts for this provider. Remove one to add another.');
  assert.equal(h.panel.element.querySelector('.slot-message').textContent, '');
  assert.equal(input.value, 'another-fixture');
});

test('real aggregate name sorting is replaced by stored slots before an unowned default', () => {
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
  const context = { require: require('node:module').createRequire(mainPath), applyAccountOrder, LIMIT_PROVIDER_REGISTRY, settings: { deviceId: 'local', limitAccountPresentation: { qoder: { labels: { r2: 'Remote work' }, order: ['r2', 'r1'] } } }, pluginRuntime: null,
    accountSlotService: { list: id => ({ accounts: id === 'qoder' ? [{ accountKey: 'z' }, { accountKey: 'a' }] : [] }) } };
  vm.runInNewContext(source.slice(start, end), context);
  const stats = { limits: { providers: [{ provider: 'qoder', accountKey: 'a' }, { provider: 'qoder', accountKey: 'default' }, { provider: 'qoder', accountKey: 'z' }, { provider: 'qoder', accountKey: 'r1', sourceDeviceId: 'other' }, { provider: 'qoder', accountKey: 'r2', sourceDeviceId: 'other' }] } };
  const result = context.desktopQuotaStats(stats);
  // Shared remote ranks lead the fallback local subsequence on every desktop surface.
  assert.deepEqual(Array.from(result.limits.providers, row => row.accountKey), ['r2', 'r1', 'z', 'a', 'default']);
  assert.equal(result.limits.providers[0].accountDisplayName, 'Remote work');
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

for (const identity of ['current key', 'slot alias', 'reading alias']) {
  for (const reversed of [false, true]) test(`Alibaba saved slots match their own variant with ${identity} and ${reversed ? 'reversed' : 'forward'} readings`, () => {
    const h = harness(t, 'alibaba');
    const settings = { alibabaAccountSlots: ['cn', 'cn-personal'].map(variant => ({
      id: variant, label: '', enabled: true, accountKey: 'shared-uid',
      accountKeyAliases: identity === 'slot alias' ? ['previous-key'] : [],
      values: { alibabaCookie: `session=${variant}`, alibabaVariant: variant }
    })) };
    const service = createAccountSlotService({ getSettings: () => settings, write: async () => {} });
    const slots = service.list('alibaba').accounts;
    assert.deepEqual(slots.map(slot => slot.formValues.alibabaVariant), ['cn', 'cn-personal']);
    const readings = ['cn', 'cn-personal'].map(region => ({
      provider: 'alibaba', region, accountKey: identity === 'slot alias' ? 'previous-key' : identity === 'reading alias' ? 'resolved-uid' : 'shared-uid',
      accountKeyAliases: identity === 'reading alias' ? ['shared-uid'] : [],
      accountName: region === 'cn' ? 'Team owner' : 'Personal owner', status: region === 'cn' ? 'ok' : 'unauthorized'
    }));
    h.panel.update(slots, reversed ? readings.reverse() : readings);
    const team = h.row('cn'), personal = h.row('cn-personal');
    assert.equal(team.querySelector('.slot-name').textContent, 'Team owner');
    assert.equal(team.querySelector('.slot-status').classList.contains('slot-connected'), true);
    assert.equal(team.querySelector('.slot-fix').classList.contains('hidden'), true);
    assert.equal(personal.querySelector('.slot-name').textContent, 'Personal owner');
    assert.equal(personal.querySelector('.slot-status').classList.contains('slot-invalid'), true);
    assert.equal(personal.querySelector('.slot-fix').classList.contains('hidden'), false);
  });
}

test('Alibaba saved slots without a variant default to cn and reject missing or different reading regions', () => {
  const h = harness(t, 'alibaba');
  const settings = { alibabaAccountSlots: [{ id: 'legacy', label: '', enabled: true, accountKey: 'shared-uid', values: { alibabaCookie: 'session=legacy' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, write: async () => {} });
  const slots = service.list('alibaba').accounts;
  assert.equal(slots[0].formValues.alibabaVariant, undefined);
  for (const region of [undefined, 'intl', 'cn-personal']) {
    h.panel.update(slots, [{ provider: 'alibaba', accountKey: 'shared-uid', region, status: 'ok' }]);
    assert.equal(h.row('legacy').querySelector('.slot-status').classList.contains('slot-unavailable'), true, `must not borrow ${region} status`);
    assert.equal(h.row('legacy').querySelector('.slot-fix').classList.contains('hidden'), true);
  }
  h.panel.update(slots, [
    { provider: 'alibaba', accountKey: 'shared-uid', region: 'cn-personal', status: 'unauthorized' },
    { provider: 'alibaba', accountKey: 'shared-uid', region: 'cn', status: 'ok' }
  ]);
  assert.equal(h.row('legacy').querySelector('.slot-status').classList.contains('slot-connected'), true);
  assert.equal(h.row('legacy').querySelector('.slot-fix').classList.contains('hidden'), true);
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
  assert.equal(h.panel.element.querySelector('.slot-editor-reveal').classList.contains('hidden'), false);
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
  assert.equal(h.row('default').querySelector('.slot-actions').classList.contains('hidden'), false);
  assert.equal(buttons.length, 8);
  assert.match(h.row('default').textContent, /Environment variable/);
});

test('slot CSS uses defined theme tokens for light and dark surfaces and status', () => {
  const css = require('node:fs').readFileSync(require.resolve('../../src/electron/renderer/styles.css'), 'utf8');
  const slots = css.slice(css.indexOf('/* Local account slots'));
  const declared = new Set([...css.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  assert.match(slots, /\.slot-list \{[^}]*overflow: clip;/);
  assert.match(slots, /grid-template-columns: 14px minmax\(0, 1fr\) minmax\(0, max-content\) 28px/);
  assert.match(slots, /\.slot-status \{ min-width: 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis;/);
  assert.match(slots, /\.slot-name \{[^}]*text-wrap: balance;/);
  assert.match(slots, /\.slot-status \{[^}]*text-align: right;/);
  // These geometry properties are supplied by the shared drag controller.
  for (const key of ['--drag-y', '--drag-shift']) declared.add(key);
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
  assert.deepEqual(h.calls.map(call => call[0]), ['replace', 'presentation', 'setEnabled', 'rename']);
  assert.equal(h.calls.at(-1)[3], 'Queued');
});

test('stored slots then an unowned local default precede remote accounts in aggregate order', () => {
  const row = (accountKey, sourceDeviceId) => ({ provider: 'qoder', accountKey, sourceDeviceId });
  const rows = [row('remote-a', 'remote'), row('b', 'local'), row('remote-b', 'remote'), row('default', 'local'), row('a', 'local')];
  assert.deepEqual(applyAccountOrder(rows, { qoder: [{ accountKey: 'a' }, { accountKey: 'b' }] }, 'local').map(row => row.accountKey), ['a', 'b', 'default', 'remote-a', 'remote-b']);
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
  const context = { state, limitProviderEnabled: () => true, localDeviceLimitsProviders: () => null, limitAccountForm: id => state.settings.limitAccountForms.find(form => form.id === id), render() {},
    preserveSettingsPanelScroll: callback => callback(), renderExternalProviderStatus() {},
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
  context.renderAccountSlotPanels();
  await context.refreshAccountSlotPanels();
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[0][1], rows); assert.deepEqual(seen.at(-1)[1], rows);
});

test('loading unchanged slot metadata does not repaint the account panels', async () => {
  const { context, vm } = rendererSlotContext({ limits: { providers: [] } });
  let updates = 0;
  context.panel = { update() { updates += 1; } };
  vm.runInContext("accountSlotPanels.set('qoder', panel)", context);
  await context.refreshAccountSlotPanels();
  assert.ok(updates > 0, 'the initial slot list reaches the panel');
  const before = updates;
  await context.refreshAccountSlotPanels();
  assert.equal(updates, before, 'the same slot list requires no additional repaint');
});

test('settings sync updates account panels before reading their connection summaries', () => {
  const { source } = rendererSlotContext({ limits: { providers: [] } });
  const form = source.slice(source.indexOf('function syncSettingsForm()'), source.indexOf('function applyVisibleSettingsAppearance()'));
  const update = form.indexOf('renderLimitProviderCheckboxes();');
  const summarize = form.indexOf('renderExternalProviderStatus(form.id)');
  assert.ok(update !== -1 && summarize > update);
});

test('startup and settings pushes load slot lists with no mounted Settings panels', async () => {
  const { context, source, vm, calls } = rendererSlotContext({ limits: { providers: [] } });
  context.window.tokenMonitor.getSettings = async () => context.state.settings;
  const start = source.indexOf('  state.settings = await window.tokenMonitor.getSettings();', source.indexOf('async function init()'));
  const end = source.indexOf('  // Local appearance', start);
  await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
  assert.deepEqual(calls.sort(), limitAccountFormsForRenderer().filter(form => form.accountSlots && !form.accountSlotOwner).map(form => form.id).sort());
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

test('single line rows omit timestamps; only rejected credentials have a compact recovery after account details', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', status: 'ok' }, { accountKey: 'ka', status: 'unauthorized' }], true);
  assert.equal(h.row('default').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.ok(h.row('a').querySelector('.slot-copy').children.at(-1) === h.row('a').querySelector('.slot-fix'));
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
  assert.ok(editor.parentElement.parentElement.parentElement === list);
  assert.ok(list.children[list.children.indexOf(h.row('a')) + 1] === editor.parentElement.parentElement);
  assert.equal(editor.children.some(node => node.classList.contains('credential-input')), false);
  const submit = h.document.getElementById('qoderSlotDraftCredentialSubmit');
  assert.equal(submit.classList.contains('slot-save'), true);
  assert.equal(submit.parentElement.children[1].textContent, 'Cancel');
  h.panel.openEditor(null);
  assert.equal(editor.children[1].classList.contains('credential-input'), true);
  assert.equal(list.children[list.children.indexOf(editor.parentElement.parentElement) - 1].classList.contains('slot-add'), true);
  assert.equal(list.children.find(child => child.classList.contains('slot-add')).classList.contains('hidden'), false);
  h.click(h.row('default'), 'Replace cookie');
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.ok(h.defaultPanel.parentElement !== editor);
  assert.ok(list.children[list.children.indexOf(h.row('default')) + 1] === editor.parentElement.parentElement);
  h.update();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.ok(h.defaultPanel.parentElement !== editor);
  assert.equal([...h.panel.element.walk()].some(node => node.tagName === 'details'), false);
  h.click(editor, 'Cancel');
  assert.equal(editor.parentElement.parentElement.classList.contains('hidden'), true);
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

test('single line rows omit timestamps; only rejected credentials have a compact recovery after account details', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', status: 'ok' }, { accountKey: 'ka', status: 'unauthorized' }], true);
  assert.equal(h.row('default').querySelector('.slot-fix').classList.contains('hidden'), true);
  assert.equal(h.row('a').querySelector('.slot-copy').children.at(-1), h.row('a').querySelector('.slot-fix'));
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
  assert.equal(editor.parentElement.parentElement.parentElement, list);
  assert.equal(list.children[list.children.indexOf(h.row('a')) + 1], editor.parentElement.parentElement);
  assert.equal(editor.children.some(node => node.classList.contains('credential-input')), false);
  const submit = h.document.getElementById('qoderSlotDraftCredentialSubmit');
  assert.equal(submit.classList.contains('slot-save'), true);
  assert.equal(submit.parentElement.children[1].textContent, 'Cancel');
  h.panel.openEditor(null);
  assert.equal(editor.children[1].classList.contains('credential-input'), true);
  assert.equal(list.children[list.children.indexOf(editor.parentElement.parentElement) - 1].classList.contains('slot-add'), true);
  assert.equal(list.children.find(child => child.classList.contains('slot-add')).classList.contains('hidden'), false);
  h.click(h.row('default'), 'Replace cookie');
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.equal(list.children[list.children.indexOf(h.row('default')) + 1], editor.parentElement.parentElement);
  h.update();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
  assert.equal([...h.panel.element.walk()].some(node => node.tagName === 'details'), false);
  h.click(editor, 'Cancel');
  assert.equal(editor.parentElement.parentElement.classList.contains('hidden'), true);
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

for (const [id, fixture] of Object.entries(require('../fixtures/accountSlotsBatch').fixtures)) for (const legacy of id === 'trae' ? [false, true] : [false]) test(`${id}${legacy ? ' legacy' : ''}: slot editor renders and submits its complete field shape`, async () => {
  const h = harness();
  const form = limitAccountFormsForRenderer().find(f => f.id === id);
  assert.equal(form.accountSlots, true);
  const values = legacy ? { traeCookie: '', traeAccessToken: 'token-a', traeDeviceId: 'device-a' } : fixture.values('a');
  const selected = legacy ? 'traeAccessToken' : form.credentialChoice?.fields[0];
  assert.deepEqual(form.fields.map(f => f.key).sort(), Object.keys(values).sort());
  const submitted = [];
  const panel = createPanel({ form, label: id, document: h.document, t,
    ipc: { add: async (...args) => { submitted.push(args); return { saved: true, verdict: 'valid', accounts: [] }; } },
    forms: { createCredentialPanel, resolveOpenUrl }, preserveScroll: fn => fn(), onChanged() {}, openExternal() {} });
  h.document.root.append(panel.element);
  panel.openEditor(null);
  for (const field of form.fields) {
    const input = h.document.getElementById(`${id}SlotDraft${field.key}Input`);
    assert.ok(input, field.key);
    assert.equal(input.tagName, field.input === 'textarea' ? 'textarea' : 'input');
    input.value = values[field.key];
  }
  if (form.credentialChoice) h.document.getElementById(`${id}SlotDraft${form.credentialChoice.key}Input`).value = `${id}SlotDraft${selected}`;
  await h.document.getElementById(`${id}SlotDraftCredentialSubmit`).click();
  assert.equal(submitted[0][0], id);
  assert.deepEqual(submitted[0][1], Object.fromEntries(Object.entries(values).map(([key, value]) => [key, form.credentialChoice?.fields.includes(key) && key !== selected ? undefined : value])));
});

for (const id of ['factory', 'cline', 'hark', 'manus', 'zai']) test(`${id}: discovered row menu permits controls and directs sign-out without replace/remove`, () => {
  const h = harness();
  const slot = { id: 'ambient', enabled: true, source: 'discovered', accountKey: 'ambient-key', sourceName: `${id} sign-in`, accountEmail: 'person@example.com' };
  h.panel.update([slot], [{ accountKey: 'ambient-key', status: 'ok' }]);
  const row = h.row('ambient');
  assert.equal(row.querySelector('.slot-name').textContent, 'person@example.com');
  const text = row.textContent;
  assert.match(text, /Rename/);
  assert.match(text, /Pause/);
  assert.match(text, /Sign out in/);
  assert.doesNotMatch(text, /Replace API key|Remove account/);
});

test('a discovered row without a name or email is named after its app in the UI language', () => {
  const h = harness();
  const slot = { id: 'ambient', enabled: true, source: 'discovered', accountKey: 'ambient-key', sourceName: 'Cline' };
  h.panel.update([slot], [{ accountKey: 'ambient-key', status: 'ok' }]);
  assert.equal(h.row('ambient').querySelector('.slot-name').textContent, 'Cline sign-in');
  assert.match(h.row('ambient').textContent, /Sign out in Cline to remove this account\./);
});

test('OpenRouter single-key form submits to slot add without a profile-name field', async () => {
  const h = harness(t, 'openrouter'); h.panel.openEditor(null);
  h.panel.element.querySelector('.slot-editor').children[1].value = 'Work';
  h.document.getElementById('openrouterSlotDraftopenrouterApiKeyInput').value = 'fixture-secret';
  await h.document.getElementById('openrouterSlotDraftCredentialSubmit').click();
  assert.deepEqual(h.calls[0], ['add', 'openrouter', { openrouterApiKey: 'fixture-secret' }, 'Work']);
});


test('Copilot paste editor submits token and non-secret enterprise host to slot add', async () => {
  const h = harness(t, 'copilot'); h.panel.openEditor(null);
  h.panel.element.querySelector('.slot-editor').children[1].value = 'Work';
  h.document.getElementById('copilotSlotDraftcopilotApiTokenInput').value = 'fixture-secret';
  h.document.getElementById('copilotSlotDraftcopilotEnterpriseHostInput').value = 'ghe.example';
  await h.document.getElementById('copilotSlotDraftCredentialSubmit').click();
  assert.deepEqual(h.calls[0], ['add', 'copilot', { copilotApiToken: 'fixture-secret', copilotEnterpriseHost: 'ghe.example' }, 'Work']);
});

test('Copilot browser choice carries only host and flowId; cancelling fences stale progress and completion', async () => {
  const requests = [];
  let status, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const loginAction = {
    signIn: request => { requests.push(request); return pending; },
    cancelSignIn: request => { requests.push(['cancel', request]); },
    onLoginStatus: listener => { status = listener; return () => {}; }
  };
  const h = harness(t, 'copilot', loginAction); h.panel.openEditor(null);
  h.document.getElementById('copilotSlotDraftcopilotEnterpriseHostInput').value = 'ghe.example';
  const signingIn = h.click(h.panel.element, t('settings.copilot.signIn'));
  const request = requests[0];
  assert.deepEqual(request.values, { copilotEnterpriseHost: 'ghe.example' });
  assert.equal(typeof request.flowId, 'string');
  assert.ok(!JSON.stringify(request).includes('copilotApiToken'));
  const editor = h.panel.element.querySelector('.slot-editor');
  status({ flowId: 'stale', phase: 'authorize', userCode: 'OLD-CODE' });
  assert.ok(!editor.textContent.includes('OLD-CODE'));
  h.click(editor, 'Cancel');
  h.panel.openEditor(null);
  h.document.getElementById('copilotSlotDraftcopilotApiTokenInput').value = 'new-draft';
  finish({ ok: true, flowId: request.flowId });
  await signingIn;
  assert.equal(requests[1][0], 'cancel');
  assert.equal(h.document.getElementById('copilotSlotDraftcopilotApiTokenInput').value, 'new-draft');
});

test('token providers say token in the replace and fix actions', () => {
  for (const [id, expected] of [['copilot', /Replace token/], ['qoder', /Replace cookie/], ['openrouter', /Replace API key/]]) {
    const h = harness(t, id);
    assert.match(h.row('a').textContent, expected);
  }
});
// Exercise the real shared pointer controller, geometry solver and slot service.
async function withDrag(callback) {
  const previous = { window: global.window, requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame };
  const listeners = new Map(), frames = new Map(); let frame = 0;
  global.window = {
    addEventListener: (key, fn) => listeners.set(key, fn),
    removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); }
  };
  global.requestAnimationFrame = fn => { frames.set(++frame, fn); return frame; };
  global.cancelAnimationFrame = id => frames.delete(id);
  const h = harness();
  const layout = () => h.panel.element.querySelector('.slot-list').children.filter(n => n.dataset.slotId).forEach((row, index) => { row.rect = { top: index * 50, bottom: index * 50 + 50, height: 50 }; });
  layout();
  const emit = (type, y) => listeners.get(type)?.({ pointerId: 1, clientY: y, preventDefault() {} });
  const press = id => { const row = h.row(id); row.listeners.pointerdown({ button: 0, pointerId: 1, clientY: row.rect.top + 10, currentTarget: row, target: row.querySelector('.slot-drag-handle') }); };
  const flush = async () => {
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(); }
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  try { await callback({ ...h, emit, press, flush, layout, listeners }); }
  finally { Object.assign(global, previous); }
}

test('local drag publishes one complete order and persists the slot subsequence', () => withDrag(async h => {
  h.panel.update(h.service.list('qoder').accounts, []); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return h.service.presentation(...args); };
  h.press('b'); h.emit('pointermove', 10); h.emit('pointerup', 10); await h.flush();
  assert.deepEqual(h.calls, [['presentation', 'qoder', 'kb', 'order', ['kb', 'ka']]]);
  assert.deepEqual(h.slotSettings.qoderAccountSlots.map(slot => slot.id), ['b', 'a']);
}));

test('environment participates in shared drag order but credential actions stay hidden', () => withDrag(async h => {
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return { ok: true }; };
  h.panel.update([{ id: 'environment', accountKey: 'env', source: 'environment', enabled: true }, ...h.slots], []); h.layout();
  h.press('environment'); h.emit('pointermove', 190); h.emit('pointerup', 190); await h.flush();
  assert.equal(h.row('environment').dataset.slotDraggable, 'true');
  assert.equal(h.calls[0][0], 'presentation');
  assert.equal(h.calls[0][4].at(-1), 'env');
  for (const key of ['Replace cookie', 'Pause tracking', 'Remove account']) {
    assert.equal([...h.row('environment').walk()].find(n => n.textContent === key && n.tagName === 'button').classList.contains('hidden'), true);
  }
}));

for (const mode of ['rename', 'editor', 'menu']) test(`drag is suppressed while ${mode} is open`, () => withDrag(async h => {
  if (mode === 'rename') h.click(h.row('a'), 'Rename');
  if (mode === 'editor') h.panel.openEditor(null);
  if (mode === 'menu') h.row('a').querySelector('.plugin-more').click();
  h.press('b'); h.emit('pointermove', 0);
  assert.equal(h.listeners.has('pointermove'), false);
}));

test('a changed account set invalidates a frozen drag', () => withDrag(async h => {
  h.press('b'); h.emit('pointermove', 10);
  h.panel.update(h.slots.filter(slot => slot.id !== 'a'), []);
  h.emit('pointerup', 10); await h.flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row('a'), undefined);
}));

for (const action of ['move', 'remove', 'rename']) test(`pending ${action} blocks dragging the unified list`, () => withDrag(async h => {
  let finish;
  const wait = () => new Promise(resolve => { finish = () => resolve({ ok: true }); });
  if (action === 'move') { h.ipc.presentation = wait; h.click(h.row('a'), 'Move down'); }
  if (action === 'remove') { h.ipc.remove = wait; h.click(h.row('a'), 'Remove account'); h.click(h.row('a'), 'Confirm remove'); }
  if (action === 'rename') { h.ipc.rename = wait; h.click(h.row('a'), 'Rename'); h.row('a').querySelector('.slot-rename').value = 'New name'; h.row('a').querySelector('.slot-rename').key('Enter'); h.row('a').querySelector('.slot-rename').key('Escape'); }
  await h.flush(); h.press('b');
  assert.equal(h.listeners.has('pointermove'), false);
  finish(); await h.flush(); h.press('b');
  assert.equal(h.listeners.has('pointermove'), true);
  h.emit('pointercancel', 0);
}));

const remoteFixture = () => ({ records: [
  { provider: 'qoder', accountKey: 'r1', accountName: 'Remote One', sourceDeviceId: 'other', status: 'ok' },
  { provider: 'qoder', accountKey: 'r2', accountEmail: 'two@example.com', sourceDeviceId: 'other', status: 'unauthorized' },
  { provider: 'qoder', accountKey: 'owned', accountKeyAliases: ['old'], sourceDeviceId: 'other' },
  { provider: 'qoder', accountKey: 'unknown-local', sourceDeviceId: 'local' }
], devices: [{ deviceId: 'other', displayName: 'Office Mac' }], localDeviceId: 'local', presentation: {} });

test('remote rows share the list with device labels and presentation-only menu commands', async () => {
  const h = harness(), context = remoteFixture();
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return { ok: true, accounts: h.slots, presentation: { qoder: { labels: { r1: 'Remote work' }, order: ['r2', 'r1'] } } }; };
  h.panel.update(h.slots, [], context);
  assert.equal(h.row('remote:owned'), undefined);
  assert.equal(h.row('remote:unknown-local'), undefined);
  const row = h.row('remote:other:r1');
  assert.match(row.textContent, /Remote One.*Office Mac/);
  assert.match(row.textContent, /Connected/);
  const menu = row.querySelector('.plugin-menu');
  assert.deepEqual(menu.children.filter(n => n.tagName === 'button').map(n => n.textContent), ['Rename', 'Move up', 'Move down']);
  assert.match(menu.textContent, /on that device/);
  assert.equal(row.querySelector('.slot-fix').classList.contains('hidden'), true);
  await h.click(row, 'Move down');
  h.click(row, 'Rename'); row.querySelector('.slot-rename').value = 'Renamed remote';
  await row.querySelector('.slot-rename').key('Enter');
  assert.deepEqual(h.calls, [['presentation', 'qoder', 'r1', 'order', ['default', 'ka', 'kb', 'r2', 'r1']], ['presentation', 'qoder', 'r1', 'rename', 'Renamed remote']]);
  assert.equal(h.panel.element.querySelector('.slot-remote-list'), undefined);
  assert.deepEqual(h.panel.element.querySelector('.slot-list').children.filter(n => n.dataset.slotId).map(n => n.dataset.slotId), ['remote:other:r2', 'remote:other:r1', 'default', 'a', 'b']);
});

test('shared presentation names and ordering reach desktop titles including local owners', () => {
  const context = remoteFixture();
  const slots = [{ accountKey: 'local', label: 'Local Work', accountKeyAliases: ['old'] }];
  const records = [...context.records, { provider: 'qoder', accountKey: 'local', accountName: 'Native', accountEmail: 'local@example.com', sourceDeviceId: 'local' }];
  const presentation = { qoder: { labels: { r2: 'Remote Work', local: 'Shared Work', owned: 'Shared Work' }, order: ['r2', 'r1'] } };
  const result = applyAccountOrder(records, { qoder: slots }, 'local', presentation);
  assert.deepEqual(result.map(row => row.accountKey), ['r2', 'r1', 'owned', 'local', 'unknown-local']);
  const { accountTitleLabel } = require('../../src/electron/renderer/accountIdentity');
  assert.equal(accountTitleLabel(result[0]), 'Remote Work');
  assert.equal(result[3].accountName, 'Native');
  assert.equal(accountTitleLabel(result[3]), 'Shared Work');
  assert.equal(accountTitleLabel(result[2]), 'Shared Work');
  // Unnamed accounts keep their own name and email fields, so the title helper
  // still masks emails; only a user-chosen label becomes the display name.
  const unlabelled = applyAccountOrder([
    { provider: 'qoder', accountKey: 'local', accountName: 'Native' },
    { provider: 'qoder', accountKey: 'r9', accountEmail: 'private@example.com', sourceDeviceId: 'other' }
  ], { qoder: [{ accountKey: 'local' }] }, 'local', presentation);
  assert.equal(unlabelled[0].accountDisplayName, 'Shared Work');
  assert.equal(accountTitleLabel(unlabelled[0]), 'Shared Work');
  assert.equal(unlabelled[1].accountDisplayName, undefined);
  assert.equal(unlabelled[1].accountName, undefined);
  assert.doesNotMatch(accountTitleLabel(unlabelled[1], [unlabelled[1]], { maskEmail: true }), /private@/);
  assert.equal(accountName({ source: 'remote', fingerprint: 'abc' }, { accountKey: 'r', accountEmail: 'native@example.com' }, t, { labels: { r: 'Named' } }), 'Named');
  assert.equal(accountName({ source: 'remote', fingerprint: 'abc' }, {}, t), 'Account #abc');
});

test('remote drag crosses local rows and publishes the full known order', () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return { ok: true }; };
  h.press('remote:other:r2'); h.emit('pointermove', -100); h.emit('pointerup', -100); await h.flush();
  assert.deepEqual(h.calls, [['presentation', 'qoder', 'r2', 'order', ['r2', 'default', 'ka', 'kb', 'r1']]]);
  assert.deepEqual(h.slots.map(slot => slot.id), ['default', 'a', 'b']);
}));

test('a changed remote account set during drag does not persist the stale drop', () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(args); return { ok: true }; };
  h.press('remote:other:r2'); h.emit('pointermove', -100);
  h.panel.update(h.slots, [], { ...context, records: context.records.filter(row => row.accountKey !== 'r1') });
  h.emit('pointerup', -100); await h.flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row('remote:other:r1'), undefined);
}));

test('renderer desktop records project remote presentation for Limits and Home consumers', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function desktopLimitRecords()');
  const context = { window: { TokenMonitorAccountSlotsPanel: { applyAccountOrder } }, accountSlotLists: { qoder: [] }, state: {
    settings: { deviceId: 'local', limitAccountPresentation: { qoder: { labels: { r2: 'Remote work' }, order: ['r2', 'r1'] } } },
    stats: { limits: { providers: remoteFixture().records.slice(0, 2) } }
  } };
  vm.runInNewContext(source.slice(start, source.indexOf('\nfunction desktopSurfaceStats()', start)), context);
  const rows = context.desktopLimitRecords();
  assert.deepEqual(Array.from(rows, row => row.accountKey), ['r2', 'r1']);
  assert.equal(rows[0].accountDisplayName, 'Remote work');
});

for (const action of ['menu', 'Alt']) test(`pending remote drag save blocks ${action} steps and new remote drags`, () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  let finish;
  h.ipc.presentation = (...args) => {
    h.calls.push(['presentation', ...args]);
    return new Promise(resolve => { finish = () => resolve({ ok: true, accounts: h.slots, presentation: { qoder: { order: args[3] } } }); });
  };
  const attempt = () => action === 'menu' ? h.click(h.row('remote:other:r2'), 'Move down') : h.row('remote:other:r2').key('ArrowDown', true);
  h.press('remote:other:r2'); h.emit('pointermove', -100); h.emit('pointerup', -100);
  attempt();
  h.press('remote:other:r1');
  assert.equal(h.listeners.has('pointermove'), false, 'lock covers the deferred save before paint');
  await h.flush();
  attempt();
  h.press('remote:other:r1');
  assert.equal(h.listeners.has('pointermove'), false);
  const buttons = h.row('remote:other:r2').querySelector('.plugin-menu').children.filter(n => n.textContent === 'Move up' || n.textContent === 'Move down');
  assert.ok(buttons.every(n => n.disabled));
  h.panel.update(h.slots, [], context);
  attempt();
  finish(); await h.flush();
  assert.deepEqual(h.calls, [['presentation', 'qoder', 'r2', 'order', ['r2', 'default', 'ka', 'kb', 'r1']]]);
  h.press('remote:other:r1');
  assert.equal(h.listeners.has('pointermove'), true, 'remote drag unlocks');
  h.emit('pointercancel', 0);
}));

for (const action of ['move', 'rename']) test(`pending remote ${action} presentation write blocks remote drag and stale steps`, () => withDrag(async h => {
  h.panel.update(h.slots, [], remoteFixture());
  let finish;
  h.ipc.presentation = (...args) => { h.calls.push(args); return new Promise(resolve => { finish = () => resolve({ ok: true }); }); };
  if (action === 'move') h.click(h.row('remote:other:r1'), 'Move down');
  else {
    h.click(h.row('remote:other:r1'), 'Rename');
    const input = h.row('remote:other:r1').querySelector('.slot-rename');
    input.value = 'Remote name'; input.key('Enter'); input.key('Escape');
  }
  h.row('remote:other:r2').key('ArrowUp', true);
  h.press('remote:other:r2');
  assert.equal(h.listeners.has('pointermove'), false);
  await h.flush();
  finish(); await h.flush();
  assert.equal(h.calls.length, 1, 'no stale step was queued');
  h.press('remote:other:r2');
  assert.equal(h.listeners.has('pointermove'), true);
  h.emit('pointercancel', 0);
}));

for (const failure of ['rejected', 'thrown']) test(`failed remote drag save restores stored presentation order when ${failure}`, () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async () => {
    if (failure === 'thrown') throw new Error('write failed');
    return { ok: false };
  };
  const order = () => h.panel.element.querySelector('.slot-list').children.filter(n => n.dataset.slotId).map(n => n.dataset.slotId);
  h.press('remote:other:r2'); h.emit('pointermove', -100); h.emit('pointerup', -100);
  assert.deepEqual(order(), ['remote:other:r2', 'default', 'a', 'b', 'remote:other:r1']);
  await h.flush();
  assert.deepEqual(order(), ['default', 'a', 'b', 'remote:other:r1', 'remote:other:r2']);
  assert.equal(h.panel.element.querySelector('.slot-message').textContent, t('settings.slots.failed'));
  h.press('remote:other:r2');
  assert.equal(h.listeners.has('pointermove'), true);
  h.emit('pointercancel', 0);
}));

test('a remote drop that a push already put in place releases its save lock', () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return { ok: true }; };
  h.press('remote:other:r2'); h.emit('pointermove', -100);
  // A stats push reorders the aggregate so r2 already sits where it is dropped.
  const [r1, r2, ...rest] = context.records;
  h.panel.update(h.slots, [], { ...context, records: [r2, r1, ...rest], presentation: { order: ['r2', 'default', 'ka', 'kb', 'r1'] } });
  h.emit('pointerup', -100); await h.flush();
  assert.deepEqual(h.calls, [], 'nothing to save for a zero-step drop');
  await h.click(h.row('remote:other:r2'), 'Move down'); await h.flush();
  assert.equal(h.calls.filter(call => call[0] === 'presentation').length, 1, 'remote reordering is not left locked');
}));

test('Alt+arrow on a remote row is ignored while a remote row is dragged', () => withDrag(async h => {
  const context = remoteFixture();
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(['presentation', ...args]); return { ok: true }; };
  h.press('remote:other:r2'); h.emit('pointermove', -100);
  await h.row('remote:other:r1').key('ArrowDown', true); await h.flush();
  assert.deepEqual(h.calls, []);
  h.emit('pointercancel', -100); await h.flush();
}));

test('shared remote ranks precede unknown rows without a source device', () => {
  const records = [
    { provider: 'qoder', accountKey: 'r1', sourceDeviceId: 'other' },
    { provider: 'qoder', accountKey: 'plain' }
  ];
  assert.deepEqual(applyAccountOrder(records, { qoder: [] }, 'local', { qoder: { labels: {}, order: ['r1'] } }).map(row => row.accountKey), ['r1', 'plain']);
});

test('presentation labels keep the newest entries at the cap and ignore invalid ones', () => {
  const { normalizeAccountPresentation } = require('../../src/electron/limits/accountPresentation');
  const labels = { bad: 7, ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `L${i}`])), newest: 'New name' };
  const result = normalizeAccountPresentation({ qoder: { labels, order: [] } }).qoder.labels;
  assert.equal(Object.keys(result).length, 200);
  assert.equal(result.newest, 'New name');
  assert.equal(result.bad, undefined);
});

test('incoming shared preferences repaint local and remote panel names and order', async () => {
  const h = harness(), context = remoteFixture();
  const a = h.slots.find(slot => slot.id === 'a'), b = h.slots.find(slot => slot.id === 'b');
  context.presentation = { labels: { [a.accountKey]: 'Synced Laptop', r1: 'Synced Remote' }, order: [b.accountKey, a.accountKey, 'r2', 'r1'] };
  h.panel.update(h.slots, [], context);
  const localIds = h.panel.element.querySelector('.slot-list').children.filter(node => node.dataset.slotId).map(node => node.dataset.slotId);
  assert.ok(localIds.indexOf('b') < localIds.indexOf('a'));
  assert.match(h.row('a').textContent, /Synced Laptop/);
  assert.match(h.row('remote:other:r1').textContent, /Synced Remote/);
  h.click(h.row('a'), 'Rename');
  assert.equal(h.row('a').querySelector('.slot-rename').value, 'Synced Laptop');
});

test('one shared order interleaves owners identically on either device, then appends unknown keys', () => {
  const rows = ['remote-new', 'local-new', 'remote-b', 'local-b', 'remote-a', 'local-a'].map(accountKey => ({ provider: 'deepseek', accountKey, sourceDeviceId: accountKey.startsWith('remote') ? 'windows' : 'mac' }));
  const presentation = { deepseek: { order: ['remote-a', 'local-a', 'remote-b', 'local-b'] } };
  const mac = { deepseek: ['local-a', 'local-b', 'local-new'].map(accountKey => ({ accountKey })) };
  const windows = { deepseek: ['remote-a', 'remote-b', 'remote-new'].map(accountKey => ({ accountKey })) };
  const known = presentation.deepseek.order;
  assert.deepEqual(applyAccountOrder(rows, mac, 'mac', presentation).map(r => r.accountKey), [...known, 'local-new', 'remote-new']);
  assert.deepEqual(applyAccountOrder(rows, windows, 'windows', presentation).map(r => r.accountKey), [...known, 'remote-new', 'local-new']);
  const aliased = [{ provider: 'deepseek', accountKey: 'resolved', accountKeyAliases: ['remote-a'], sourceDeviceId: 'windows' }, rows.at(-1)];
  assert.deepEqual(applyAccountOrder(aliased, mac, 'mac', presentation).map(r => r.accountKey), ['resolved', 'local-a']);
});

test('panel has one interleaved list and local and remote moves publish every visible key', async () => {
  const h = harness(), context = remoteFixture();
  context.presentation = { order: ['r1', 'ka', 'r2', 'kb', 'default'] };
  h.ipc.presentation = async (...args) => { h.calls.push(args); return { ok: true, presentation: { qoder: { order: args[3] } } }; };
  h.panel.update(h.slots, [], context);
  const order = () => h.panel.element.querySelector('.slot-list').children.filter(n => n.dataset.slotId).map(n => n.dataset.slotId);
  assert.deepEqual(order(), ['remote:other:r1', 'a', 'remote:other:r2', 'b', 'default']);
  assert.equal(h.panel.element.querySelector('.slot-remote-list'), undefined);
  assert.equal(h.panel.element.querySelector('.slot-list').children.at(-1).className, 'slot-add');
  await h.click(h.row('a'), 'Move up');
  assert.deepEqual(h.calls[0], ['qoder', 'ka', 'order', ['ka', 'r1', 'r2', 'kb', 'default']]);
  await h.row('remote:other:r2').key('ArrowDown', true);
  assert.deepEqual(h.calls[1], ['qoder', 'r2', 'order', ['ka', 'r1', 'kb', 'r2', 'default']]);
});

test('local drag crosses remote neighbours and publishes the same full order', () => withDrag(async h => {
  const context = remoteFixture();
  context.presentation = { order: ['r1', 'ka', 'r2', 'kb', 'default'] };
  h.panel.update(h.slots, [], context); h.layout();
  h.ipc.presentation = async (...args) => { h.calls.push(args); return { ok: true }; };
  h.press('b'); h.emit('pointermove', 0); h.emit('pointerup', 0); await h.flush();
  assert.deepEqual(h.calls, [['qoder', 'kb', 'order', ['kb', 'r1', 'ka', 'r2', 'default']]]);
}));

test('environment rename uses presentation IPC without changing the credential', async () => {
  const h = harness();
  h.panel.update([{ id: 'environment', source: 'environment', accountKey: 'env', fingerprint: 'env', enabled: true }], []);
  h.click(h.row('environment'), 'Rename');
  const input = h.row('environment').querySelector('.slot-rename'); input.value = 'Build machine';
  await input.key('Enter');
  assert.deepEqual(h.calls, [['presentation', 'qoder', 'env', 'rename', 'Build machine']]);
});

test('remote device lines reuse session icons before names and follow scoped overrides on update', () => {
  const h = harness();
  const devices = [
    { deviceId: 'desktop', displayName: 'imac-m1', deviceKind: 'desktop' },
    { deviceId: 'laptop', displayName: 'macbook-air', deviceKind: 'laptop' },
    { deviceId: 'linux', displayName: 'ubuntu', deviceKind: 'linux' }
  ];
  const context = {
    localDeviceId: 'local', devices,
    records: devices.map(device => ({ provider: 'qoder', accountKey: device.deviceId, sourceDeviceId: device.deviceId, status: 'ok' })),
    settings: { deviceIconScope: 'hub', deviceIconOverrides: { local: { desktop: 'cloud' }, hub: {} } }
  };
  const check = (id, kind, name) => {
    const line = h.row(`remote:${id}:${id}`).querySelector('.slot-device-token');
    assert.ok(line, 'remote row has the Sessions device-line class');
    assert.equal(line.children[0].className, `device-kind-icon device-kind-${kind}`);
    assert.equal(line.children[0].attributes['aria-hidden'], 'true');
    assert.equal(line.children[1].textContent, name, 'device icon precedes the name');
  };
  h.panel.update(h.slots, [], context);
  check('desktop', 'desktop', 'imac-m1');
  check('laptop', 'laptop', 'macbook-air');
  check('linux', 'linux', 'ubuntu');
  assert.equal(h.row('a').querySelector('.row-device'), undefined, 'local rows have no device line');
  context.settings.deviceIconOverrides.hub.desktop = 'server';
  context.devices[0].displayName = 'renamed-imac';
  h.panel.update(h.slots, [], context);
  check('desktop', 'server', 'renamed-imac');
});


test('explicit shared clear removes an inherited display name without mutating the reading', () => {
  const reading = { provider: 'qoder', accountKey: 'a', accountName: 'Native name', accountDisplayName: 'Old custom' };
  const result = applyAccountOrder([reading], { qoder: [{ accountKey: 'a', label: 'Old slot' }] }, '', { qoder: { labels: { a: '' }, order: [] } });
  assert.equal(result[0].accountDisplayName, undefined);
  assert.equal(result[0].accountName, 'Native name');
  assert.equal(reading.accountDisplayName, 'Old custom');
  assert.equal(applyAccountOrder([reading], {}, '', {})[0].accountDisplayName, 'Old custom', 'absent local label retains remote display metadata');
});

test('completed browser login cannot close a new draft opened while list refresh is pending', async () => {
  const started = Promise.withResolvers(), listed = Promise.withResolvers();
  const h = harness(t, 'copilot', { signIn: async () => ({ ok: true }), cancelSignIn() {}, onLoginStatus: () => () => {} });
  h.ipc.list = () => { started.resolve(); return listed.promise; };
  h.panel.openEditor(null);
  const signingIn = h.click(h.panel.element, t('settings.copilot.signIn'));
  await started.promise;
  h.click(h.panel.element.querySelector('.slot-editor'), 'Cancel');
  h.panel.openEditor(null);
  const input = h.document.getElementById('copilotSlotDraftcopilotApiTokenInput');
  input.value = 'new-draft';
  listed.resolve({ ok: true, accounts: h.slots });
  await signingIn;
  assert.equal(h.panel.element.querySelector('.slot-editor-reveal').classList.contains('hidden'), false);
  assert.equal(h.document.getElementById(input.id), input);
  assert.equal(input.value, 'new-draft');
});

test('inline pencil starts renaming without opening the actions menu', () => {
  const h = harness();
  const pencil = h.row('a').querySelector('.slot-rename-button');
  assert.ok(pencil, 'account name has a direct rename button');
  assert.equal(pencil.attributes['aria-label'], 'Rename');
  pencil.click();
  assert.equal(h.document.activeElement, h.row('a').querySelector('.slot-rename'));
  assert.equal(h.row('a').querySelector('.plugin-menu').popoverOpen, undefined);
});

test('rename saves on blur and leaves focus on the control the user clicked', async () => {
  const h = harness();
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Work';
  const next = h.row('b').querySelector('.plugin-more'); next.focus();
  await input.listeners.blur?.();
  assert.deepEqual(h.calls, [['rename', 'qoder', 'a', 'Work']]);
  assert.equal(h.row('a').querySelector('.slot-rename'), undefined);
  assert.equal(h.document.activeElement, next);
});

test('Enter followed by blur saves a pending rename only once', async () => {
  const h = harness(); let resolve;
  h.ipc.rename = (...args) => { h.calls.push(['rename', ...args]); return new Promise(r => { resolve = r; }); };
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Work';
  const pending = input.key('Enter');
  await Promise.resolve();
  await input.listeners.blur?.();
  assert.equal(h.calls.length, 1);
  assert.equal(input.readOnly, true, 'a submitted draft cannot change while saving');
  resolve({ ok: true, accounts: h.slots });
  await pending;
  assert.equal(h.calls.length, 1);
});

test('Escape cancels rename before the resulting blur can save it', async () => {
  const h = harness();
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Cancelled';
  await input.key('Escape');
  await input.listeners.blur?.();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row('a').querySelector('.slot-rename'), undefined);
});

test('failed blur save preserves the draft for retry without taking focus back', async () => {
  const h = harness();
  h.ipc.rename = (...args) => { h.calls.push(['rename', ...args]); return { ok: false }; };
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename'); input.value = 'Retry me';
  const next = h.row('b').querySelector('.plugin-more'); next.focus();
  await input.listeners.blur?.();
  assert.equal(h.calls.length, 1);
  assert.equal(h.row('a').querySelector('.slot-rename'), input);
  assert.equal(input.value, 'Retry me');
  assert.equal(input.readOnly, false);
  assert.equal(h.document.activeElement, next);
  h.ipc.rename = (...args) => { h.calls.push(['rename', ...args]); return { ok: true, accounts: h.slots }; };
  input.focus(); await input.key('Enter');
  assert.equal(h.calls.length, 2);
  assert.equal(h.row('a').querySelector('.slot-rename'), undefined);
});

test('blur during composition saves the final text only after composition ends', async () => {
  const h = harness();
  h.click(h.row('a'), 'Rename');
  const input = h.row('a').querySelector('.slot-rename');
  input.listeners.compositionstart?.(); input.value = '工';
  h.row('b').querySelector('.plugin-more').focus();
  await input.listeners.blur?.();
  assert.equal(h.calls.length, 0);
  input.value = '工作'; await input.listeners.compositionend?.();
  assert.deepEqual(h.calls, [['rename', 'qoder', 'a', '工作']]);
});

test('opening rename and clicking away without editing does not clear an inherited name', async () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'default', accountDisplayName: 'Other device label', status: 'ok' }]);
  h.click(h.row('default'), 'Rename');
  const input = h.row('default').querySelector('.slot-rename');
  assert.equal(input.value, '');
  h.row('a').querySelector('.plugin-more').focus();
  await input.listeners.blur();
  assert.deepEqual(h.calls, []);
  assert.equal(h.row('default').querySelector('.slot-rename'), undefined);
});

for (const variant of ['intl', 'cn-personal', 'intl-personal']) test(`Alibaba environment ${variant} DTO matches the successful plan reading`, () => {
  const h = harness(t, 'alibaba');
  const settings = { alibabaVariant: '' };
  const service = createAccountSlotService({ getSettings: () => settings, write: async () => {},
    env: { ALIBABA_TOKEN_PLAN_COOKIE: 'session=SECRET-env', ALIBABA_TOKEN_PLAN_VARIANT: variant } });
  const accounts = service.list('alibaba').accounts;
  const environment = accounts.find(account => account.id === 'environment');
  h.panel.update(accounts, [
    { provider: 'alibaba', accountKey: environment.accountKey, region: 'cn', status: 'unauthorized' },
    { provider: 'alibaba', accountKey: environment.accountKey, region: variant, status: 'ok' }
  ]);
  assert.equal(h.row('environment').querySelector('.slot-status').classList.contains('slot-connected'), true);
  assert.equal(environment.formValues.alibabaVariant, variant);
  assert.ok(!JSON.stringify(accounts).includes('SECRET'));
  assert.equal(settings.alibabaVariant, '');
});

test('Alibaba environment DTO respects a stored variant override without changing its fingerprint', () => {
  const { accountValuesFingerprint, defaultAccountValues } = require('../../src/shared/limits/accountSlots');
  const { limitProviderEntry } = require('../../src/shared/limits/registry');
  const settings = { alibabaVariant: 'cn-personal' };
  const env = { ALIBABA_TOKEN_PLAN_COOKIE: 'session=SECRET-env', ALIBABA_TOKEN_PLAN_VARIANT: 'intl' };
  const service = createAccountSlotService({ getSettings: () => settings, write: async () => {}, env });
  const account = service.list('alibaba').accounts[0];
  assert.equal(account.formValues.alibabaVariant, 'cn-personal');
  assert.equal(account.fingerprint, accountValuesFingerprint(defaultAccountValues(limitProviderEntry('alibaba'), settings, env)).slice(7, 19));
});

test('source-excluded accounts do not inherit a connected retained reading', () => {
  assert.equal(accountStatus({ enabled: true, sourceSelected: false }, { status: 'ok' }), 'notCollected');
});

test('Command Code displays its plan independently of the account title and updates it in place', () => {
  const h = harness(t, 'commandcode');
  const slot = { id: 'account', accountKey: 'key', fingerprint: 'abc123', enabled: true };
  const quota = { provider: 'commandcode', accountKey: 'key', status: 'ok', source: 'web', accountLabel: 'Pro' };
  h.panel.update([slot], [quota], {});
  const row = h.row('account');
  assert.equal(row.querySelector('.slot-name').textContent, 'Account #abc123');
  assert.equal(row.querySelector('.slot-detail').textContent, 'Pro');
  h.panel.update([{ ...slot, label: 'Work' }], [{ ...quota, accountLabel: 'Max' }], {});
  assert.equal(h.row('account'), row);
  assert.equal(row.querySelector('.slot-name').textContent, 'Work');
  assert.equal(row.querySelector('.slot-detail').textContent, 'Max');
  h.panel.update([slot], [{ ...quota, accountEmail: 'user@example.com', accountName: 'User', accountLabel: 'Pro' }], {});
  assert.equal(row.querySelector('.slot-name').textContent, 'user@example.com');
  assert.match(row.querySelector('.slot-detail').textContent, /Pro$/);
});

test('account plan details honor provider plan policies and do not repeat identity as a plan', () => {
  for (const [provider, metadata, expected] of [
    ['cursor', { accountLabel: 'user@example.com', accountEmail: 'user@example.com' }, ''],
    ['qoder', { accountLabel: 'User', accountName: 'User' }, ''],
    ['mimo', { accountLabel: 'Console', planLabel: 'Pro' }, 'Pro'],
    ['minimax', { accountLabel: 'Profile' }, ''],
    ['qoder', { accountLabel: 'Old', planLabel: 'Premium' }, 'Premium']
  ]) {
    const h = harness();
    // The policy belongs to the reading provider; the generic panel consumes its metadata.
    const slot = { id: 'account', accountKey: 'key', enabled: true, fingerprint: '123' };
    h.panel.update([slot], [{ provider, accountKey: 'key', status: 'ok', ...metadata }], {});
    const detail = h.row('account').querySelector('.slot-detail').textContent;
    assert.equal(detail, [expected, t('settings.slots.savedSource')].filter(Boolean).join(' · '), provider);
  }
});

test('healthy account shows its source with accessible status; failures keep explicit status and source detail', () => {
  const h = harness(t, 'commandcode');
  const slot = { id: 'account', accountKey: 'key', fingerprint: 'abc', enabled: true };
  const quota = { provider: 'commandcode', accountKey: 'key', source: 'web', status: 'ok', accountLabel: 'Pro' };
  const update = (account, reading) => h.panel.update([account], [reading], {});
  update(slot, quota);
  const row = h.row('account'), status = row.querySelector('.slot-status');
  assert.equal(status.textContent, 'Web');
  assert.equal(status.attributes['aria-label'], 'Connected · Web');
  assert.equal(status.classList.contains('slot-connected'), true);
  assert.equal(row.querySelector('.slot-detail').textContent, 'Pro');
  for (const [account, reading, expected] of [
    [{ ...slot, enabled: false }, quota, 'paused'],
    [{ ...slot, sourceSelected: false }, quota, 'notCollected'],
    [slot, { ...quota, status: 'unauthorized' }, 'invalid'],
    [slot, { ...quota, stale: true }, 'stale']
  ]) {
    update(account, reading);
    assert.equal(status.classList.contains('slot-connected'), false);
    assert.equal(status.classList.contains(`slot-${expected}`), true);
    assert.notEqual(status.textContent, 'Web');
    assert.equal(row.querySelector('.slot-detail').textContent, 'Pro · Web');
  }
});


test('connection failures do not suggest credential replacement; rejected credentials retain one recovery action', () => {
  const h = harness();
  h.panel.update(h.slots, [{ accountKey: 'ka', status: 'unavailable' }], true);
  assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('hidden'), true);
  h.panel.update(h.slots, [{ accountKey: 'ka', status: 'unauthorized', source: 'web' }], true);
  const row = h.row('a');
  const fix = row.querySelector('.slot-fix');
  assert.equal(fix.classList.contains('hidden'), false);
  assert.equal(fix.textContent, 'Replace credential');
  const copy = row.querySelector('.slot-copy');
  assert.ok(copy.children.indexOf(row.querySelector('.slot-detail')) < copy.children.indexOf(fix));
  fix.click();
  assert.ok(h.document.getElementById('qoderSlotDraftqoderCookieInput'));
});

test('provider collection disabled is distinct from failed credentials and per-account pause', () => {
  const h = harness(t, 'openrouter');
  const saved = JSON.stringify(h.slots);
  for (const readings of [[], [{ accountKey: 'ka', status: 'ok' }], [{ accountKey: 'ka', status: 'unauthorized' }]]) {
    h.panel.update(h.slots, readings, { providerEnabled: false });
    assert.equal(h.row('a').querySelector('.slot-status').textContent, t('settings.limits.status.disabled'));
    assert.equal(h.row('a').querySelector('.slot-fix').classList.contains('hidden'), true);
    assert.equal(h.row('b').querySelector('.slot-status').textContent, t('settings.slots.paused'));
  }
  assert.equal(JSON.stringify(h.slots), saved, 'provider selection does not pause or mutate stored accounts');
  h.panel.update(h.slots, [{ accountKey: 'ka', status: 'ok' }], { providerEnabled: true });
  assert.equal(h.row('a').querySelector('.slot-status').classList.contains('slot-connected'), true);
  h.panel.update(h.slots, [{ accountKey: 'ka', status: 'unauthorized' }], { providerEnabled: true });
  assert.equal(h.row('a').querySelector('.slot-status').classList.contains('slot-invalid'), true);
});

test('account context follows pending provider selection and the master limits switch', () => {
  const { context, source, vm } = rendererSlotContext({ limits: { providers: [] } });
  context.desktopLimitProviders = () => [{ id: 'openrouter' }, { id: 'claude' }];
  context.limitProviderOrderApi = require('../../src/electron/renderer/limits/providerOrder');
  context.DEFAULT_LIMIT_PROVIDER_ORDER = 'openrouter,claude';
  vm.runInContext(source.slice(source.indexOf('function configuredLimitProviderSelection()'), source.indexOf('function missingLimitProviderStatus()')), context);
  context.state.settings.limitProviders = 'openrouter,claude';
  assert.equal(context.limitAccountContext('openrouter').providerEnabled, true);
  context.state.pendingLimitProviderSelection = { limitsEnabled: true, limitProviders: 'claude' };
  assert.equal(context.limitAccountContext('openrouter').providerEnabled, false);
  assert.equal(context.limitAccountContext('claude').providerEnabled, true);
  context.state.settings.limitProviders = 'claude';
  context.state.pendingLimitProviderSelection = null;
  assert.equal(context.limitAccountContext('openrouter').providerEnabled, false);
  context.state.settings.limitsEnabled = false;
  assert.equal(context.limitAccountContext('claude').providerEnabled, false);
});


test('device disclosure keeps local failures and remote health separate without duplicate accounts or requests', () => {
  const h = harness();
  const now = new Date().toISOString();
  const remote = { provider: 'qoder', accountKey: 'ka', source: 'web', status: 'ok', updatedAt: now };
  const local = { ...remote, status: 'unauthorized' };
  const context = { localDeviceId: 'local', records: [{ ...remote, sourceDeviceId: 'laptop' }], devices: [
    { deviceId: 'local', deviceKind: 'desktop', limits: { providers: [local] } },
    { deviceId: 'laptop', deviceKind: 'laptop', displayName: 'MacBook Pro', limits: { providers: [remote] } }
  ] };
  h.panel.update(h.slots, [local], context);
  assert.equal(h.row('remote:laptop:ka'), undefined);
  const row = h.row('a'), toggle = row.querySelector('.slot-device-toggle');
  assert.ok(toggle);
  assert.equal(toggle.textContent, 'This deviceMacBook Pro');
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.children[0].children[0].className, 'device-kind-icon device-kind-desktop');
  assert.equal(toggle.children[1].children[0].className, 'device-kind-icon device-kind-laptop');
  assert.match(row.querySelector('.slot-status').textContent, /Cookie expired/);
  toggle.click();
  const list = row.querySelector('.slot-device-list');
  assert.equal(list.classList.contains('accordion-animated-container'), true);
  assert.equal(list.children[0].classList.contains('accordion-animation-inner'), true);
  assert.equal(list.classList.contains('hidden'), false);
  assert.equal(list.inert, false);
  assert.match(list.children[0].children[0].textContent, /Cookie expired/);
  assert.match(list.children[0].children[1].textContent, /Web.*Current quota source/);
  const localFix = list.children[0].children[0].querySelector('.slot-device-fix');
  assert.equal(localFix.classList.contains('hidden'), false);
  assert.equal(list.children[0].children[1].querySelector('.slot-device-fix').classList.contains('hidden'), true);
  h.panel.update(h.slots, [local], context);
  assert.equal(row.querySelector('.slot-device-toggle'), toggle);
  assert.equal(list.children[0].children[0].querySelector('.slot-device-fix'), localFix);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  toggle.click();
  assert.equal(list.classList.contains('hidden'), true);
  assert.equal(list.inert, true);
  assert.deepEqual(h.calls, []);
});

test('device disclosure respects pause, provider disable, stale peers and disappearance', () => {
  const h = harness();
  const row = { provider: 'qoder', accountKey: 'kb', status: 'ok' };
  const context = { localDeviceId: 'local', providerEnabled: false,
    records: [{ ...row, sourceDeviceId: 'peer' }], devices: [{ deviceId: 'peer', stale: true, limits: { providers: [row] } }] };
  h.panel.update(h.slots, [row], context);
  assert.equal(h.row('a').querySelector('.slot-device-toggle'), undefined, 'exact owner wins over sibling alias');
  h.row('b').querySelector('.slot-device-toggle').click();
  const list = h.row('b').querySelector('.slot-device-list');
  assert.equal(list.children[0].children[0].querySelector('.slot-status').textContent, 'Paused');
  assert.equal(list.children[0].children[1].querySelector('.slot-status').textContent, 'Stale');
  assert.doesNotMatch(list.children[0].children[1].textContent, /1970|Current quota source/);
  h.slots.find(slot => slot.id === 'b').enabled = true;
  h.panel.update(h.slots, [row], context);
  assert.equal(list.children[0].children[0].querySelector('.slot-status').textContent, 'Disabled');
  h.panel.update(h.slots, [row], { ...context, records: [], devices: [] });
  assert.equal(h.row('b').querySelector('.row-device'), undefined);
  assert.equal(list.classList.contains('hidden'), true);
  assert.equal(list.inert, true);
  assert.equal(h.row('b').classList.contains('slot-devices-expanded'), false);
});

test('device disclosure includes two remote peers without inventing a local login', () => {
  const h = harness();
  const reading = { provider: 'qoder', accountKey: 'only-remote', status: 'ok' };
  h.panel.update(h.slots, [], { localDeviceId: 'local', records: [{ ...reading, sourceDeviceId: 'one' }], devices: [
    { deviceId: 'one', displayName: 'Office', limits: { providers: [reading] } },
    { deviceId: 'two', displayName: 'Laptop', limits: { providers: [reading] } }
  ] });
  const row = h.row('remote:one:only-remote');
  const toggle = row.querySelector('.slot-device-toggle');
  assert.match(toggle.textContent, /Office.*Laptop/);
  assert.doesNotMatch(toggle.textContent, /This device/);
  toggle.click();
  const list = row.querySelector('.slot-device-list');
  assert.equal(list.children[0].children.length, 2);
  for (const child of list.children[0].children) assert.equal(child.querySelector('.slot-device-fix').classList.contains('hidden'), true);
});

test('device disclosure never joins Alibaba sibling plan variants', () => {
  const h = harness(t, 'alibaba');
  const slots = [{ id: 'team', accountKey: 'uid', enabled: true, formValues: { alibabaVariant: 'cn' } },
    { id: 'personal', accountKey: 'uid', enabled: true, formValues: { alibabaVariant: 'cn-personal' } }];
  const remote = { provider: 'alibaba', accountKey: 'uid', region: 'cn-personal', status: 'ok' };
  h.panel.update(slots, [], { localDeviceId: 'local', records: [{ ...remote, sourceDeviceId: 'peer' }],
    devices: [{ deviceId: 'peer', limits: { providers: [remote] } }] });
  assert.equal(h.row('team').querySelector('.row-device'), undefined);
  assert.ok(h.row('personal').querySelector('.slot-device-toggle'));
});

test('Alibaba remote plans remain separate from local owners and each other', () => {
  const h = harness(t, 'alibaba');
  const team = { provider: 'alibaba', accountKey: 'uid', region: 'cn', status: 'unauthorized', sourceDeviceId: 'peer' };
  const personal = { ...team, region: 'cn-personal', status: 'ok', source: 'web' };
  const context = { localDeviceId: 'local', records: [team, personal],
    devices: [{ deviceId: 'peer', displayName: 'MacBook Pro', limits: { providers: [team, personal] } }] };
  const remoteRows = () => [...h.panel.element.walk()].filter(node => node.dataset.slotId?.startsWith('remote:'));
  h.panel.update([], [], context);
  assert.equal(remoteRows().length, 2);
  assert.equal(new Set(remoteRows().map(node => node.dataset.slotId)).size, 2);
  assert.ok(remoteRows()[0].querySelector('.slot-invalid'));
  assert.ok(remoteRows()[1].querySelector('.slot-connected'));
  assert.ok(remoteRows().every(node => node.querySelector('.row-device').textContent === 'MacBook Pro'));

  h.panel.update([{ id: 'local-team', accountKey: 'old-uid', enabled: true }], [team],
    { ...context, records: context.records.map(row => ({ ...row, accountKeyAliases: ['old-uid'] })) });
  assert.equal(remoteRows().length, 1);
  assert.ok(remoteRows()[0].querySelector('.slot-connected'));
  assert.ok(h.row('local-team').querySelector('.slot-device-toggle'));
});

test('raw device observations use aggregate freshness for remote disclosure too', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const file = path.resolve(__dirname, '../../src/electron/main.js'), source = fs.readFileSync(file, 'utf8');
  const context = { settings: { deviceId: 'local' }, ACCOUNT_SLOT_PROVIDER_IDS: new Set(['qoder']), isProviderStale,
    lastCollectedDevice: null, localDevice: null, mode: 'local', attachLocalPresentationNativeViews() {} };
  vm.runInNewContext(source.slice(source.indexOf('function injectLocalDeviceStatus('), source.indexOf('function macWidgetConfiguration(')), context);
  const stats = { devices: [{ deviceId: 'remote', limits: { refreshMs: 60000, providers: [
    { provider: 'qoder', accountKey: 'old', status: 'ok', updatedAt: '2000-01-01T00:00:00Z' }
  ] } }] };
  assert.equal(context.injectLocalDeviceStatus(stats).devices[0].limits.providers[0].stale, true);
});
