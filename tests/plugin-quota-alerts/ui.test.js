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
