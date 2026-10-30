'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../../plugins/quota-alerts/manifest.json');
const { localize } = require('../../src/shared/plugins/localized');
const { message } = require('../../plugins/quota-alerts/delivery.cjs');

// Minimal DOM adapter: verifies actual UI lifecycle and text generation without
// starting a browser. Layout/screenshots remain separate manual GUI acceptance.
class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.value = ''; this.checked = false;
    this.style = { setProperty() {} }; this.classes = new Set();
    this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
}
const all = root => [root, ...root.children.flatMap(all)];

test('six complete locales cover manifest, settings and desktop notification text', async () => {
  const { messages, resolveLocale, t } = await import('../../plugins/quota-alerts/i18n.mjs');
  const keys = Object.keys(messages.en).sort();
  for (const [locale, dictionary] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, locale);
    assert.equal(localize(manifest.name, locale), dictionary.name);
    for (const field of require('../../plugins/quota-alerts/settings-schema.json').fields) assert.equal(localize(field.label, locale), dictionary[field.id]);
    const notification = await message({ event: 'low', provider: 'fixture', providerLabel: 'Fixture', remaining: 4, windows: [
      { kind: 'session', displayLabel: 'Session', remainingPercent: 4, resetsAt: '2026-10-30T10:00:00Z' },
      { kind: 'weekly', displayLabel: 'Weekly', remainingPercent: 70 }
    ] }, Date.parse('2026-10-29T10:00:00Z'), locale);
    assert.ok(notification.title.includes(dictionary.notifyTitle.replace('{provider}', 'Fixture')));
    assert.ok(notification.body.includes('Session'));
    assert.ok(notification.body.includes(t(locale, 'remaining', { percent: 4 })));
    assert.ok(!/\{\w+\}/.test(notification.body));
  }
  assert.equal(resolveLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(resolveLocale('zh-Hant-HK'), 'zh-TW');
  assert.equal(resolveLocale('ja-JP'), 'ja'); assert.equal(resolveLocale('pt-PT'), 'pt-BR');
  assert.equal(resolveLocale('de-DE'), 'en');
});

test('settings-only manifest has no duplicate host form or display placements', () => {
  assert.equal(manifest.settings, undefined);
  assert.deepEqual(manifest.views.map(v => v.surfaces), [['settings']]);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function pendingSettings(t) {
  const oldDoc = globalThis.document, oldObserver = globalThis.MutationObserver;
  globalThis.document = { documentElement: { lang: 'en' }, createElement: tag => new Element(tag), activeElement: null };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.document = oldDoc; globalThis.MutationObserver = oldObserver; });
  const root = new Element('main'), updates = [], notifications = [];
  const { defaults } = require('../../plugins/quota-alerts/preferences.cjs');
  let snapshot = { revision: 0, values: { ...defaults } };
  const { activate } = await import('../../plugins/quota-alerts/ui.mjs');
  const view = activate({ backend: {
    subscribe() { return () => {}; },
    async call(method, args) {
      if (method === 'preferences.get') return structuredClone(snapshot);
      if (method === 'status') return { state: 'off' };
      if (method === 'preferences.update') return new Promise((resolve, reject) => updates.push({ ...args, reject,
        finish() {
          assert.equal(args.expectedRevision, snapshot.revision, 'writes use the last confirmed revision');
          snapshot = { revision: snapshot.revision + 1, values: { ...snapshot.values, ...args.patch } };
          resolve(structuredClone(snapshot));
        }
      }));
      if (method === 'notification.test') { notifications.push(structuredClone(snapshot)); return [{ status: 'submitted' }]; }
      throw Error('Unexpected operation');
    }
  } }).mount(root);
  t.after(() => view.dispose());
  await settle();
  return { root, updates, notifications, view, get snapshot() { return snapshot; },
    inputs: Object.fromEntries(all(root).filter(n => n.tag === 'input').map(n => [n.name, n])),
    testButton: all(root).find(n => n.tag === 'button') };
}

test('threshold blur leaves the next switch clickable and serializes its save before a notification test', async t => {
  const f = await pendingSettings(t);
  f.inputs.threshold.value = '20'; f.inputs.threshold.listeners.blur();
  assert.equal(f.inputs.lowQuota.disabled, false, 'blur must not cancel the following native switch click');
  f.inputs.lowQuota.checked = true; f.inputs.lowQuota.listeners.change();
  assert.equal(f.updates.length, 1, 'the second save waits for the threshold revision');
  assert.equal(f.inputs.lowQuota.checked, true);
  assert.equal(f.testButton.disabled, false, 'blur must not cancel a following test-button click either');
  const testing = f.testButton.listeners.click();
  assert.equal(f.notifications.length, 0);
  f.updates[0].finish(); await settle();
  assert.deepEqual(f.updates[1].patch, { lowQuota: true });
  assert.equal(f.updates[1].expectedRevision, 1);
  assert.equal(f.inputs.lowQuota.checked, true, 'pending toggle stays visible after the earlier save');
  f.updates[1].finish(); await testing;
  assert.deepEqual(f.notifications[0].values, { lowQuota: true, threshold: 20, recovery: false });
});

test('a failed threshold save rolls back its value while a queued switch still saves', async t => {
  const f = await pendingSettings(t);
  f.inputs.threshold.value = '20'; f.inputs.threshold.listeners.blur();
  assert.equal(f.inputs.lowQuota.disabled, false);
  f.inputs.lowQuota.checked = true; f.inputs.lowQuota.listeners.change();
  f.updates[0].reject(Error('fixture write failure')); await settle();
  assert.equal(f.updates.length, 2);
  assert.equal(f.updates[1].expectedRevision, 0);
  assert.equal(f.inputs.threshold.value, 10);
  assert.equal(f.inputs.lowQuota.checked, true);
  f.updates[1].finish(); await settle();
  assert.deepEqual(f.snapshot.values, { lowQuota: true, threshold: 10, recovery: false });
  assert.ok(all(f.root).some(n => n.textContent.includes('Save failed')));
});

test('switch edits during a pending save preserve the final intent and dispose stops queued writes', async t => {
  const f = await pendingSettings(t);
  f.inputs.lowQuota.checked = true; f.inputs.lowQuota.listeners.change();
  assert.equal(f.inputs.lowQuota.disabled, false);
  f.inputs.lowQuota.checked = false; f.inputs.lowQuota.listeners.change();
  f.updates[0].finish(); await settle();
  assert.deepEqual(f.updates[1].patch, { lowQuota: false });
  f.inputs.recovery.checked = true; f.inputs.recovery.listeners.change();
  assert.equal(f.view.hasUnsavedChanges(), true);
  f.view.dispose(); f.updates[1].finish(); await settle();
  assert.equal(f.updates.length, 2, 'disposal prevents the queued recovery write');
  assert.equal(f.snapshot.values.lowQuota, false);
  assert.equal(f.snapshot.values.recovery, false);
});

test('desktop-only switches autosave, roll back on failure, locale and disposal work', async t => {
  const oldDoc = globalThis.document, oldObserver = globalThis.MutationObserver;
  let localeChange, disconnected = false, unsubscribe = false, rejectNext = false;
  const root = new Element('main'), calls = [];
  const { defaults } = require('../../plugins/quota-alerts/preferences.cjs');
  let snapshot = { revision: 0, values: { ...defaults } };
  globalThis.document = { documentElement: { lang: 'zh-TW' }, createElement: tag => new Element(tag), activeElement: null };
  globalThis.MutationObserver = class { constructor(fn) { localeChange = fn; } observe() {} disconnect() { disconnected = true; } };
  t.after(() => { globalThis.document = oldDoc; globalThis.MutationObserver = oldObserver; });
  const { activate } = await import('../../plugins/quota-alerts/ui.mjs');
  const mount = activate({ host: { async call() { throw Error('No background authority should be requested by the UI'); } }, backend: {
    subscribe() { return () => { unsubscribe = true; }; },
    async call(method, args) {
      calls.push([method, args]);
      if (method === 'preferences.get') return structuredClone(snapshot);
      if (method === 'status') return { state: 'off', background: false };
      if (method === 'preferences.update') {
        if (rejectNext) { rejectNext = false; throw Error('fixture disk failure'); }
        snapshot = { revision: snapshot.revision + 1, values: { ...snapshot.values, ...args.patch } }; return structuredClone(snapshot);
      }
      if (method === 'notification.test') return [{ channel: 'os', status: 'submitted' }];
      throw Error('Unexpected call');
    }
  } }).mount(root);
  await settle();
  const inputs = Object.fromEntries(all(root).filter(n => n.tag === 'input').map(n => [n.name, n]));
  assert.equal(inputs.lowQuota.attributes.role, 'switch');
  assert.equal(inputs.enabled, undefined);
  assert.equal(all(root).filter(n => n.tag === 'button').length, 1, 'one desktop test, no save button');
  assert.deepEqual(Object.keys(inputs).sort(), ['lowQuota', 'recovery', 'threshold']);
  assert.equal(inputs.dryRun, undefined, 'no extra test-mode switch is required');
  const initialTest = all(root).find(n => n.tag === 'button' && n.dataset.channel === 'os');
  assert.equal(initialTest.disabled, false, 'test is available before either automatic alert is enabled');
  const beforeTest = structuredClone(snapshot);
  await initialTest.listeners.click();
  assert.deepEqual(snapshot, beforeTest);
  assert.equal(calls.filter(([method]) => method === 'notification.test').length, 1);

  inputs.lowQuota.checked = true; inputs.lowQuota.listeners.change(); await settle();
  assert.equal(snapshot.values.lowQuota, true); assert.equal(inputs.lowQuota.checked, true);
  assert.deepEqual(calls.find(([name]) => name === 'preferences.update')[1].patch, { lowQuota: true });
  rejectNext = true; inputs.lowQuota.checked = false; inputs.lowQuota.listeners.change(); await settle();
  assert.equal(inputs.lowQuota.checked, true); assert.equal(inputs.lowQuota.disabled, false);
  assert.ok(all(root).some(n => n.textContent.includes('儲存失敗')));
  inputs.threshold.value = '15'; inputs.threshold.listeners.blur(); await settle();
  assert.equal(snapshot.values.threshold, 15);
  inputs.recovery.checked = true; inputs.recovery.listeners.change(); await settle();
  inputs.lowQuota.checked = false; inputs.lowQuota.listeners.change(); await settle();
  assert.equal(snapshot.values.lowQuota, false); assert.equal(snapshot.values.recovery, true);
  const testButton = all(root).find(n => n.tag === 'button' && n.dataset.channel === 'os');
  assert.equal(testButton.disabled, false, 'manual test stays available after changing alert preferences');
  await testButton.listeners.click();
  assert.ok(calls.some(([method]) => method === 'notification.test'));
  mount.update({ data: { state: 'monitoring', background: false, settings: { lowQuota: true } } });
  const stateText = () => all(root).find(n => n.className === 'qa-state').textContent;
  assert.equal(stateText(), '只在此設定頁開啟時監察配額');
  mount.update({ data: { state: 'monitoring', background: true, settings: { lowQuota: true } } });
  assert.equal(stateText(), '正在監察配額');
  globalThis.document.documentElement.lang = 'ja'; localeChange();
  assert.ok(all(root).some(n => n.textContent === 'クォータ不足の通知'));
  mount.dispose(); assert.equal(root.children.length, 0); assert.ok(disconnected && unsubscribe);
});
