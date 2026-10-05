'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../../src/electron/renderer/syncContentForm');
const i18n = require('../../src/electron/renderer/i18n');
const aliasApi = require('../../src/electron/renderer/modelAliasForm');
const pricingApi = require('../../src/electron/renderer/customPricingForm');

function dom() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    querySelectorAll: () => [],
    createElement: () => node(),
    getElementById: id => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); }
  };
  function node(id = '') {
    const classes = new Set(['hidden']);
    const listeners = {};
    return {
      id, hidden: false, checked: false, disabled: false, open: false, value: '', textContent: '', children: [], listeners,
      classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key), toggle: (key, active) => active ? classes.add(key) : classes.delete(key) },
      append(...children) { children.forEach(child => { child.parentNode = this; }); this.children.push(...children); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      get options() { return this.children; },
      removeEventListener(event, fn) { listeners[event] = (listeners[event] || []).filter(item => item.fn !== fn); },
      addEventListener(event, fn, capture = false) { (listeners[event] ||= []).push({ fn, capture }); },
      async dispatch(event, data = {}) {
        // DOM dispatch runs listeners synchronously, including an async listener's
        // prefix. Await their results only after every listener has been invoked.
        const path = [];
        for (let current = this; current; current = current.parentNode) path.push(current);
        const work = [];
        const eventData = { target: this, preventDefault() {}, ...data };
        const invoke = (node, capture) => {
          for (const listener of node.listeners[event] || []) if (listener.capture === capture) work.push(listener.fn(eventData));
        };
        for (const node of path.slice().reverse()) invoke(node, true);
        for (const node of path) invoke(node, false);
        await Promise.all(work);
      },
      click() { if (!this.disabled) return this.dispatch('click'); },
      change(checked) { if (this.disabled) return; this.checked = checked; return this.dispatch('change'); },
      focus() { if (!this.disabled) document.activeElement = this; },
      showModal() { this.open = true; document.activeElement = this; }, close() { this.open = false; },
      matches(selector) { return selector === ':popover-open' && this.popoverOpen; },
      showPopover() { this.popoverOpen = true; }, hidePopover() { this.popoverOpen = false; },
      contains(other) { return this === other || this.children.includes(other); },
      setAttribute(name, value) { this[name] = value; },
      closest(selector) {
        // The real alias setup captures row clicks on its list ancestor.
        if (selector !== '.custom-pricing-edit') return null;
        for (let current = this; current; current = current.parentNode) {
          if (String(current.className || '').split(' ').includes('custom-pricing-edit')) return current;
        }
        return null;
      }
    };
  }
  return document;
}

function status(patch = {}) {
  return { identity: 'hub-one', destination: 'hub.example:17321', supported: true, serverTitlesEnabled: true,
    enabled: { sessionTitles: false, modelAliases: false, customPricing: false },
    revisions: { modelAliases: 2, customPricing: 4 }, pendingTitleCleanup: false, error: '', ...patch };
}

function fixture({ initial = status(), preview = {}, mode = 'client' } = {}) {
  const document = dom();
  let current = initial;
  let settings = { hubMode: mode, hubSyncSessionTitles: false };
  let push;
  const calls = { refresh: [], configure: [], saves: [], cleanup: 0 };
  const bridge = {
    getSyncContentStatus: async refresh => { calls.refresh.push(refresh); return structuredClone(current); },
    previewSyncContent: async kind => ({ ok: true, identity: current.identity, kind, revision: current.revisions[kind], localFingerprint: 'fingerprint', localCount: 2, serverCount: 3, hasServerValue: true, equal: false, ...preview }),
    configureSyncContent: async patch => {
      calls.configure.push(patch);
      current = { ...current, enabled: { ...current.enabled, [patch.kind]: patch.enabled } };
      return { ok: true, status: current };
    },
    retrySyncContentCleanup: async () => { calls.cleanup += 1; current = { ...current, pendingTitleCleanup: false, error: '' }; return { ok: true, status: current }; },
    onSyncContentPush: callback => { push = callback; return () => { push = null; }; }
  };
  const form = api.createSyncContentForm({ document, bridge, t: (key, params) => i18n.translate('en', key, params),
    saveSettings: async patch => { calls.saves.push(patch); settings = { ...settings, ...patch }; form.syncSettings(); }, getSettings: () => settings });
  const get = suffix => document.getElementById(`syncContent${suffix}`);
  return { document, bridge, form, get, calls,
    server(next) { current = next; },
    push(next) { current = next; push(next); },
    settings(next) { settings = { ...settings, ...next }; form.syncSettings(); } };
}

test('the form initializes before the asynchronous settings query has returned', () => {
  const document = dom();
  const form = api.createSyncContentForm({ document, bridge: {}, t: key => key,
    saveSettings: async () => {}, getSettings: () => null });
  assert.equal(document.getElementById('syncContentOptions').hidden, true);
  assert.equal(document.getElementById('syncContentsessionTitles').disabled, true);
  form.dispose();
});

test('all optional checkboxes default off and stay disabled until a supported status arrives', async () => {
  const f = fixture();
  for (const kind of ['sessionTitles', 'modelAliases', 'customPricing']) {
    assert.equal(f.get(kind).checked, false);
    assert.equal(f.get(kind).disabled, true);
  }
  await f.form.refresh();
  assert.equal(f.get('modelAliases').disabled, false);
  assert.equal(f.get('Notice').hidden, true);
  f.push(status({ serverTitlesEnabled: false }));
  assert.equal(f.get('sessionTitles').disabled, true);
  assert.equal(f.get('TitleUnavailable').hidden, false);
  assert.equal(f.get('TitleNote').hidden, true);
  f.push(status({ supported: false, error: 'unsupported' }));
  assert.equal(f.get('modelAliases').disabled, true);
  assert.match(f.get('Status').textContent, /Update the server/);
  assert.equal(f.get('Retry').hidden, false);
  assert.equal(f.get('Notice').hidden, false);
  assert.equal(f.get('TitleUnavailable').hidden, true);
  assert.equal(f.get('TitleNote').hidden, false);
});

for (const cancel of ['Cancel', 'escape']) test(`title consent supports ${cancel}, focus and a fresh destination without saving`, async () => {
  const f = fixture();
  await f.form.refresh();
  await f.get('sessionTitles').change(true);
  assert.equal(f.get('Dialog').open, true);
  assert.equal(f.get('SourceChoices').hidden, true);
  assert.equal(f.document.activeElement, f.get('Cancel'));
  assert.equal(f.get('sessionTitles').checked, false);
  assert.match(f.get('DialogCopy').textContent, /hub\.example:17321/);
  assert.match(f.get('DialogCopy').textContent, /project, client or work information/);
  assert.match(f.get('DialogCopy').textContent, /administrator and devices with shared access/);
  assert.match(f.get('DialogCopy').textContent, /Message bodies are never uploaded/);
  if (cancel === 'escape') await f.get('Dialog').dispatch('cancel'); else await f.get('Cancel').click();
  assert.equal(f.get('Dialog').open, false);
  assert.equal(f.document.activeElement, f.get('sessionTitles'));
  assert.deepEqual(f.calls.configure, []);
});

test('title enable sends confirmed:true only after consent; disabling never asks again', async () => {
  const f = fixture();
  await f.form.refresh();
  await f.get('sessionTitles').change(true);
  await f.get('Confirm').click();
  assert.deepEqual(f.calls.configure[0], { kind: 'sessionTitles', enabled: true, identity: 'hub-one', confirmed: true });
  assert.equal(f.get('sessionTitles').checked, true);
  assert.equal(f.get('sessionTitles').disabled, false);
  assert.equal(f.document.activeElement, f.get('sessionTitles'));
  await f.get('sessionTitles').change(false);
  assert.equal(f.get('Dialog').open, false);
  assert.deepEqual(f.calls.configure[1], { kind: 'sessionTitles', enabled: false, identity: 'hub-one' });
});

test('identity, destination or saved connection changes invalidate consent', async () => {
  for (const change of ['identity', 'destination', 'connection', 'refresh']) {
    const f = fixture();
    await f.form.refresh();
    await f.get('sessionTitles').change(true);
    if (change === 'identity') f.push(status({ identity: 'hub-two' }));
    if (change === 'destination') f.push(status({ destination: 'other.example:17321' }));
    if (change === 'connection') f.settings({ hubUrl: 'https://other.example' });
    if (change === 'refresh') { f.server(status({ identity: 'hub-two' })); await f.get('Confirm').click(); }
    assert.equal(f.get('Dialog').open, false, change);
    assert.deepEqual(f.calls.configure, [], change);
    assert.equal(f.get('sessionTitles').checked, false);
  }
});

test('failed title cleanup applies the confirmed off status and keeps the removal warning', async () => {
  const f = fixture({ initial: status({ enabled: { sessionTitles: true } }) });
  await f.form.refresh();
  f.bridge.configureSyncContent = async patch => ({ ok: false, error: 'cleanup_pending', status: status({ enabled: { sessionTitles: patch.enabled }, pendingTitleCleanup: true, error: 'cleanup_pending' }) });
  await f.get('sessionTitles').change(false);
  assert.equal(f.get('sessionTitles').checked, false);
  assert.equal(f.get('sessionTitles').disabled, true);
  assert.equal(f.get('Cleanup').hidden, false);
  assert.equal(f.get('Notice').hidden, true, 'cleanup keeps its dedicated warning without a duplicate notice');
  assert.match(f.get('Status').textContent, /previously shared titles/);
  await f.get('CleanupRetry').click();
  assert.equal(f.calls.cleanup, 1);
  assert.equal(f.get('Cleanup').hidden, true);
});

test('an offline device can revoke title sync immediately without waiting for discovery', async () => {
  const f = fixture({ initial: status({ error: 'unreachable', enabled: { sessionTitles: true } }) });
  await f.form.refresh();
  assert.equal(f.get('sessionTitles').disabled, false);
  f.bridge.getSyncContentStatus = async () => { throw Error('must not delay revocation'); };
  f.bridge.configureSyncContent = async patch => {
    f.calls.configure.push(patch);
    return { ok: false, error: 'cleanup_pending', status: status({ enabled: { sessionTitles: false }, pendingTitleCleanup: true, error: 'cleanup_pending' }) };
  };
  await f.get('sessionTitles').change(false);
  assert.equal(f.calls.configure.length, 1);
  assert.equal(f.get('sessionTitles').checked, false);
  assert.equal(f.get('Dialog').open, false);
  assert.equal(f.get('Cleanup').hidden, false);
});

test('equal settings choose server automatically with exact preview version and fingerprint', async () => {
  for (const kind of ['modelAliases', 'customPricing']) {
    const f = fixture({ preview: { equal: true } });
    await f.form.refresh();
    await f.get(kind).change(true);
    assert.equal(f.get('Dialog').open, false);
    assert.deepEqual(f.calls.configure[0], { kind, enabled: true, identity: 'hub-one', source: 'server', revision: kind === 'modelAliases' ? 2 : 4, localFingerprint: 'fingerprint' });
    assert.equal(f.get(kind).checked, true);
  }
});

test('different settings compare counts and offer both explicit sources', async () => {
  for (const [button, source] of [['UseServer', 'server'], ['Publish', 'local']]) {
    const f = fixture();
    await f.form.refresh();
    await f.get('modelAliases').change(true);
    assert.equal(f.get('modelAliases').checked, false);
    assert.match(f.get('Counts').textContent, /This device: 2 · Server: 3/);
    assert.equal(f.get('NoShared').hidden, true);
    await f.get(button).click();
    assert.equal(f.calls.configure[0].source, source);
    assert.equal(f.calls.configure[0].revision, 2);
  }
});

test('never initialized differs from an initialized empty value and still supports server source', async () => {
  for (const hasServerValue of [false, true]) {
    const f = fixture({ preview: { serverCount: 0, hasServerValue } });
    await f.form.refresh();
    await f.get('customPricing').change(true);
    assert.equal(f.get('NoShared').hidden, hasServerValue);
    assert.equal(f.get('UseServer').disabled, false);
    await f.get('UseServer').click();
    assert.equal(f.calls.configure[0].source, 'server');
  }
});

test('failed enable retains the initial checkbox and choice; retry takes a fresh preview', async () => {
  const f = fixture();
  await f.form.refresh();
  await f.get('customPricing').change(true);
  f.bridge.configureSyncContent = async () => ({ ok: false, error: 'conflict', status: status({ revisions: { modelAliases: 2, customPricing: 5 } }) });
  await f.get('Publish').click();
  assert.equal(f.get('customPricing').checked, false);
  assert.equal(f.get('Dialog').open, true);
  assert.match(f.get('DialogStatus').textContent, /another device; reload/);
  assert.equal(f.get('Publish').disabled, true);
  f.server(status({ revisions: { modelAliases: 2, customPricing: 5 } }));
  await f.get('DialogRetry').click();
  assert.equal(f.get('Dialog').open, true);
  assert.equal(f.get('Publish').disabled, false);
});

test('in-flight operations leave inputs off and disabled until main confirms', async () => {
  const f = fixture({ preview: { equal: true } });
  await f.form.refresh();
  let resolve;
  f.bridge.configureSyncContent = () => new Promise(done => { resolve = done; });
  const work = f.get('modelAliases').change(true);
  await new Promise(done => setImmediate(done));
  assert.equal(f.get('modelAliases').checked, false);
  assert.equal(f.get('modelAliases').disabled, true);
  f.push(status({ identity: 'hub-two' }));
  resolve({ ok: true, status: status({ enabled: { modelAliases: true } }) });
  await work;
  assert.equal(f.form.status().identity, 'hub-two');
  assert.equal(f.get('modelAliases').checked, false);
});

test('host receiver permission saves independently from sender choices; local and iCloud show a note', async () => {
  const f = fixture({ mode: 'host' });
  await f.form.refresh();
  await f.get('HostPermission').change(true);
  assert.deepEqual(f.calls.saves, [{ hubSyncSessionTitles: true }]);
  assert.deepEqual(f.calls.configure, []);
  assert.equal(f.get('sessionTitles').checked, false);
  assert.equal(f.get('HostRow').hidden, false);
  for (const hubMode of ['client', 'local', 'icloud']) {
    f.settings({ hubMode });
    assert.equal(f.get('HostRow').hidden, true);
    assert.equal(f.get('LocalNote').hidden, hubMode === 'client');
    assert.equal(f.get('Options').hidden, hubMode !== 'client');
  }
});

test('refresh coalesces and ignores stale results after a push; rendering never polls', async () => {
  const f = fixture();
  let resolve;
  f.bridge.getSyncContentStatus = refresh => { f.calls.refresh.push(refresh); return new Promise(done => { resolve = done; }); };
  const work = [f.form.refresh(), f.form.refresh(), f.form.refresh()];
  for (let i = 0; i < 10; i += 1) f.form.syncSettings();
  assert.deepEqual(f.calls.refresh, [true]);
  f.push(status({ revisions: { modelAliases: 9, customPricing: 11 } }));
  resolve(status());
  await Promise.all(work);
  assert.equal(f.form.status().revisions.modelAliases, 9);
});

test('unreachable and authentication errors disable unavailable controls and offer retry', async () => {
  const f = fixture();
  f.bridge.getSyncContentStatus = async () => { throw Error('secret transport failure'); };
  await f.form.refresh();
  assert.match(f.get('Status').textContent, /Check your connection and reload/);
  assert.doesNotMatch(f.get('Status').textContent, /secret transport/);
  assert.equal(f.get('modelAliases').disabled, true);
  f.bridge.getSyncContentStatus = async () => status({ error: 'unauthorized' });
  await f.get('Retry').click();
  assert.match(f.get('Status').textContent, /Check the saved connection/);
  assert.equal(f.get('customPricing').disabled, true);
});

test('five locales contain all sync content messages and matching parameters', () => {
  const keys = Object.keys(i18n.MESSAGES.en).filter(key => key.startsWith('settings.sync.content.'));
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja']) for (const key of keys) {
    assert.ok(Object.hasOwn(i18n.MESSAGES[locale], key), `${locale}: ${key}`);
    assert.ok(i18n.MESSAGES[locale][key].trim());
    assert.deepEqual(i18n.MESSAGES[locale][key].match(/\{\w+\}/g), i18n.MESSAGES.en[key].match(/\{\w+\}/g));
  }
});

const app = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
function sourceBetween(startAnchor, endAnchor) {
  const start = app.indexOf(startAnchor);
  const end = app.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(start >= 0, `Missing source anchor: ${startAnchor}`);
  assert.ok(end > start, `Missing or unordered source anchor: ${endAnchor}`);
  return app.slice(start, end);
}
function functionSource(name, next) { return sourceBetween(`function ${name}(`, `\nfunction ${next}(`); }

test('alias selectors include custom pricing config IDs absent from raw usage', async () => {
  const document = dom();
  const state = { stats: { modelAliasSourceIds: ['usage-only'] },
    settings: { modelAliases: {}, customModelPricing: [{ modelId: 'config-only', inputPerM: 1 }] } };
  const context = { document, state, customPricingFormApi: pricingApi, t: key => key, setAccountGroupExpanded() {},
    window: { TokenMonitorModelAliasForm: aliasApi, TokenMonitorSyncContentForm: api },
    syncContentForm: null, saveSettings: async () => {} };
  vm.createContext(context);
  vm.runInContext(`let modelAliasForm = null; let modelAliasSaveConflict = false; ${functionSource('setupModelAliasesUI', 'customPricingMeta')} setupModelAliasesUI();`, context);
  await document.getElementById('modelAliasesAddButton').click();
  for (const suffix of ['Alias', 'Canonical']) {
    const options = document.getElementById(`modelAliases${suffix}Select`).options.map(option => option.value);
    assert.ok(options.includes('model:usage-only'));
    assert.ok(options.includes('model:config-only'));
  }
});

test('alias batch editor keeps selected and manual drafts and base when a newer shared push arrives', async () => {
  const document = dom();
  let current = status({ enabled: { modelAliases: true } });
  const state = { stats: { modelAliasSourceIds: ['b'] }, settings: { modelAliases: { a: 'original' }, modelAliasGrouping: 'off' } };
  const writes = [];
  const context = { document, state, structuredClone, queueMicrotask, customPricingFormApi: pricingApi,
    t: key => key, setAccountGroupExpanded() {},
    window: { TokenMonitorModelAliasForm: aliasApi, TokenMonitorSyncContentForm: api },
    syncContentForm: { base: () => api.snapshotBase(current) },
    saveSettings: async (patch, base) => {
      writes.push(api.decorateSettingsPatch(patch, current, base));
      if (base.revisions.modelAliases !== current.revisions.modelAliases) throw Error('CAS 409 conflict');
      state.settings = { ...state.settings, ...patch };
    }
  };
  vm.createContext(context);
  vm.runInContext(`let modelAliasForm = null; let modelAliasEdit = null; let modelAliasSaveConflict = false; ${functionSource('setupModelAliasesUI', 'customPricingMeta')} setupModelAliasesUI();`, context);
  await document.getElementById('modelAliasesAddButton').click();
  const alias = document.getElementById('modelAliasesAliasSelect');
  const canonical = document.getElementById('modelAliasesCanonicalInput');
  alias.value = 'model:b';
  const targetSelect = document.getElementById('modelAliasesCanonicalSelect');
  targetSelect.value = '__manual__';
  await targetSelect.dispatch('change');
  canonical.value = 'user-value';
  await document.getElementById('modelAliasesAddSourceButton').click();
  const extra = document.getElementById('modelAliasesMoreSources').children[0].children[0];
  extra.children[1].value = '__manual__';
  await extra.children[1].dispatch('change');
  extra.children[2].value = 'c';
  current = status({ enabled: { modelAliases: true }, revisions: { modelAliases: 3, customPricing: 4 } });
  state.settings.modelAliases = { a: 'new-server-value', c: 'remote' };
  vm.runInContext('modelAliasForm.syncSettings();', context);
  await document.getElementById('modelAliasesSaveButton').click();
  assert.equal(writes[0].syncContentBase.revisions.modelAliases, 2);
  assert.deepEqual(writes[0].modelAliases, { a: 'original', b: 'user-value', c: 'user-value' });
  assert.equal(alias.value, 'model:b');
  assert.equal(canonical.value, 'user-value');
  assert.equal(extra.children[2].value, 'c');
  assert.equal(document.getElementById('modelAliasesForm').classList.contains('hidden'), false);
  assert.equal(document.getElementById('modelAliasesError').textContent, 'settings.sync.content.conflict');
  await document.getElementById('modelAliasesSaveButton').click();
  assert.deepEqual(writes[1], writes[0]);
  assert.deepEqual(state.settings.modelAliases, { a: 'new-server-value', c: 'remote' });
});

test('pricing editor pins its whole collection and revision until the user closes it', async () => {
  const document = dom();
  let current = status({ enabled: { customPricing: true } });
  const state = { stats: {}, settings: { customModelPricing: [{ modelId: 'existing', inputPerM: 1 }] } };
  const writes = [];
  const context = { document, state, structuredClone, customPricingFormApi: pricingApi,
    t: key => key, formatCost: value => String(value), setAccountGroupExpanded() {}, renderCustomPricing() {},
    window: { tokenMonitor: {}, TokenMonitorSyncContentForm: api },
    syncContentForm: { base: () => api.snapshotBase(current) },
    saveSettings: async (patch, base) => { writes.push(api.decorateSettingsPatch(patch, current, base)); throw Error('CAS 409 conflict'); }
  };
  vm.createContext(context);
  vm.runInContext(`let openCustomPricingForm = null; ${functionSource('setupCustomPricingUI', 'setupCursorAccountUI')} setupCustomPricingUI(); openCustomPricingForm();`, context);
  document.getElementById('customPricingModelSelect').value = '__manual__';
  document.getElementById('customPricingModelInput').value = 'new-model';
  document.getElementById('customPricingInput').value = '2';
  document.getElementById('customPricingOutput').value = '3';
  current = status({ enabled: { customPricing: true }, revisions: { modelAliases: 2, customPricing: 5 } });
  state.settings.customModelPricing = [{ modelId: 'existing', inputPerM: 7 }];
  await document.getElementById('customPricingSaveButton').click();
  assert.equal(writes[0].syncContentBase.revisions.customPricing, 4);
  assert.equal(writes[0].customModelPricing.find(entry => entry.modelId === 'existing').inputPerM, 1);
  assert.equal(document.getElementById('customPricingInput').value, '2');
  assert.equal(document.getElementById('customPricingForm').classList.contains('hidden'), false);
  assert.equal(document.getElementById('customPricingError').textContent, 'settings.sync.content.conflict');
});

test('settings decoration applies only to opted-in mutations and never silently replaces a supplied stale base', () => {
  const current = status({ enabled: { modelAliases: true, customPricing: true } });
  const old = api.snapshotBase(status({ identity: 'old-hub', revisions: { modelAliases: 1, customPricing: 0 } }));
  for (const patch of [{ modelAliases: {} }, { modelAliasGrouping: 'prefix' }, { customModelPricing: [] }]) {
    assert.deepEqual(api.decorateSettingsPatch(patch, current, old).syncContentBase, old);
    assert.equal(api.decorateSettingsPatch(patch, status()), patch);
  }
  const other = { sessionTitlesEnabled: true, hubSyncSessionTitles: true };
  assert.equal(api.decorateSettingsPatch(other, current), other);
  assert.equal(Object.hasOwn(other, 'syncContentBase'), false);
});

test('grouping and pricing removal conflicts are visible next to their controls even without an open form', () => {
  const document = dom();
  const context = { document, window: { TokenMonitorSyncContentForm: api }, t: key => i18n.translate('en', key) };
  vm.createContext(context);
  vm.runInContext(sourceBetween('function setSyncContentEditError(', '\nasync function saveSettings('), context);
  for (const [patch, id] of [[{ modelAliasGrouping: 'prefix' }, 'modelAliasesError'], [{ customModelPricing: [] }, 'customPricingSyncError']]) {
    context.setSyncContentEditError(patch, Error('CAS 409 conflict'));
    assert.equal(document.getElementById(id).classList.contains('hidden'), false);
    assert.match(document.getElementById(id).textContent, /Shared settings changed on another device/);
    context.setSyncContentEditError(patch, null);
    assert.equal(document.getElementById(id).classList.contains('hidden'), true);
  }
});


test('shared disclosure refreshes on opening and cancels unconfirmed consent on closing', async () => {
  const f = fixture();
  f.form.setExpanded(true);
  await f.form.refresh();
  assert.deepEqual(f.calls.refresh, [true]);
  await f.get('sessionTitles').change(true);
  assert.equal(f.get('Dialog').open, true);
  f.form.setExpanded(false);
  assert.equal(f.get('Dialog').open, false);
  assert.equal(f.get('sessionTitles').checked, false);
  assert.deepEqual(f.calls.configure, []);
});

test('closing while settings preview is pending prevents a late confirmation dialog', async () => {
  const f = fixture();
  await f.form.refresh();
  let resolve;
  f.bridge.previewSyncContent = () => new Promise(done => { resolve = done; });
  const changing = f.get('modelAliases').change(true);
  await new Promise(done => setImmediate(done));
  assert.equal(typeof resolve, 'function', 'the preview request must have started');
  f.form.setExpanded(false);
  resolve({ ok: true, identity: 'hub-one', kind: 'modelAliases', revision: 2, equal: false, hasServerValue: true });
  await changing;
  assert.equal(f.get('Dialog').open, false);
  assert.deepEqual(f.calls.configure, []);
});


test('server-title help opens with focus or click and closes on Escape, collapse and permission changes', async () => {
  const f = fixture({ initial: status({ serverTitlesEnabled: false }) });
  await f.form.refresh();
  const trigger = f.get('TitleHelp'), popover = f.get('TitleHelpPopover');
  await trigger.dispatch('focus');
  assert.equal(popover.popoverOpen, true);
  assert.equal(trigger['aria-expanded'], 'true');
  await trigger.dispatch('keydown', { key: 'Escape' });
  assert.equal(popover.popoverOpen, false);
  await trigger.click();
  assert.equal(popover.popoverOpen, true);
  f.form.setExpanded(false);
  assert.equal(popover.popoverOpen, false);
  await trigger.click();
  f.push(status({ identity: 'hub-two', serverTitlesEnabled: false }));
  assert.equal(popover.popoverOpen, false);
  await trigger.click();
  f.push(status({ identity: 'hub-two' }));
  assert.equal(popover.popoverOpen, false);
  assert.deepEqual(f.calls.configure, []);
});


test('title help responds to hover and permits crossing the gap into its popover', async () => {
  const f = fixture({ initial: status({ serverTitlesEnabled: false }) });
  await f.form.refresh();
  const trigger = f.get('TitleHelp'), popover = f.get('TitleHelpPopover');
  assert.equal(trigger.hidden, false);
  await trigger.dispatch('pointerenter');
  assert.equal(popover.popoverOpen, true);
  await trigger.dispatch('pointerleave', { relatedTarget: null });
  await popover.dispatch('pointerenter');
  await new Promise(done => setTimeout(done, 180));
  assert.equal(popover.popoverOpen, true);
  await popover.dispatch('pointerleave');
  await new Promise(done => setTimeout(done, 180));
  assert.equal(popover.popoverOpen, false);
  f.push(status());
  assert.equal(trigger.hidden, true);
  assert.deepEqual(f.calls.configure, []);
});


for (const action of ['edit', 'remove']) test(`alias ${action} uses the displayed collection and base when the revision push arrives first`, async () => {
  const document = dom();
  let current = status({ enabled: { modelAliases: true } });
  const state = { settings: { modelAliases: { a: 'original', b: 'original' }, modelAliasGrouping: 'off' } };
  const writes = [];
  const context = { document, state, structuredClone, queueMicrotask, customPricingFormApi: pricingApi,
    t: key => key, setAccountGroupExpanded() {},
    window: { TokenMonitorModelAliasForm: aliasApi, TokenMonitorSyncContentForm: api },
    syncContentForm: { base: () => api.snapshotBase(current) },
    saveSettings: async (patch, base) => {
      writes.push(api.decorateSettingsPatch(patch, current, base));
      if (base.revisions.modelAliases !== current.revisions.modelAliases) throw Error('CAS 409 conflict');
      state.settings = { ...state.settings, ...patch };
    }
  };
  vm.createContext(context);
  vm.runInContext(`let modelAliasForm = null; let modelAliasEdit = null; let modelAliasSaveConflict = false; ${functionSource('setupModelAliasesUI', 'customPricingMeta')} setupModelAliasesUI();`, context);
  // A status push can precede the matching settings push. Clicking the row
  // must not pair its old map with revision 3, which CAS would otherwise admit.
  current = status({ enabled: { modelAliases: true }, revisions: { modelAliases: 3, customPricing: 4 } });
  const row = document.getElementById('modelAliasesList').children[0];
  if (action === 'remove') await row.children[1].click();
  else {
    await row.children[0].click();
    const targetSelect = document.getElementById('modelAliasesCanonicalSelect');
    targetSelect.value = '__manual__';
    await targetSelect.dispatch('change');
    document.getElementById('modelAliasesCanonicalInput').value = 'user-value';
    state.settings.modelAliases = { a: 'remote', c: 'new' };
    vm.runInContext('modelAliasForm.syncSettings();', context);
    await document.getElementById('modelAliasesSaveButton').click();
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].syncContentBase.revisions.modelAliases, 2);
  assert.deepEqual(writes[0].modelAliases, action === 'remove' ? { b: 'original' } : { a: 'user-value', b: 'original' });
  assert.equal(document.getElementById('modelAliasesError').textContent, 'settings.sync.content.conflict');
  if (action === 'edit') {
    assert.equal(document.getElementById('modelAliasesCanonicalInput').value, 'user-value');
    assert.equal(document.getElementById('modelAliasesForm').classList.contains('hidden'), false);
  }
});

test('a destination change during consent confirmation cannot restore focus or apply stale success', async () => {
  const f = fixture();
  await f.form.refresh();
  await f.get('sessionTitles').change(true);
  let resolve;
  f.bridge.configureSyncContent = () => new Promise(done => { resolve = done; });
  const confirmation = f.get('Confirm').click();
  await new Promise(done => setImmediate(done));
  assert.equal(typeof resolve, 'function');
  f.push(status({ destination: 'other.example:17321' }));
  resolve({ ok: true, status: status({ enabled: { sessionTitles: true } }) });
  await confirmation;
  assert.equal(f.form.status().destination, 'other.example:17321');
  assert.equal(f.get('sessionTitles').checked, false);
  assert.notEqual(f.document.activeElement, f.get('sessionTitles'));
  assert.equal(f.get('Dialog').open, false);
});

test('title-help headings reuse the existing localized deployment target labels', () => {
  const html = fs.readFileSync(require.resolve('../../src/electron/renderer/index.html'), 'utf8');
  for (const target of ['Node', 'Worker']) {
    const key = `settings.sync.hubBuild.target${target}`;
    assert.match(html, new RegExp(`<dt data-i18n="${key.replaceAll('.', '\\.')}">`));
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja']) assert.ok(i18n.MESSAGES[locale][key]);
  }
});


for (const source of ['catch-up', 'server-adoption']) test(`alias ${source} pairs settings push with its new revision before rendering rows`, async () => {
  const { createSyncContentRuntime, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');
  const { normalizeSharedSyncValue } = require('../../src/shared/syncContent');
  const document = dom();
  const state = { settings: { hubMode: 'client', modelAliases: { a: 'old', b: 'old' }, modelAliasGrouping: 'off' } };
  let saved = normalizeSyncContentState(null);
  let remote = { version: 1, revision: 2, value: { modelAliases: { a: 'old', b: 'old' }, modelAliasGrouping: 'off' } };
  let push;
  let context;
  const writes = [];
  const runtime = createSyncContentRuntime({
    getContext: () => ({ mode: 'client', url: 'https://hub.example', secret: 'secret', deviceId: 'one' }),
    getState: () => saved, saveState: next => { saved = next; }, normalizeValue: normalizeSharedSyncValue,
    getLocalValue: () => ({ modelAliases: state.settings.modelAliases, modelAliasGrouping: state.settings.modelAliasGrouping }),
    applyLocalValue: (_kind, value) => {
      state.settings = { ...state.settings, ...value, syncContentStatus: runtime.status() };
      form.syncSettings();
      vm.runInContext('modelAliasForm.syncSettings();', context);
    },
    onStatus: next => push?.(next),
    request: async (_ctx, path, method, body) => {
      if (path.endsWith('/content')) return { status: 200, body: { version: 1, sharedSettings: true, sessionTitles: { enabled: true } } };
      if (method === 'PUT') {
        writes.push(body);
        if (body.baseRevision !== remote.revision) return { status: 409, body: remote };
        remote = { ...remote, revision: remote.revision + 1, value: body.value };
      }
      return { status: 200, body: structuredClone(remote) };
    }
  });
  const form = api.createSyncContentForm({ document, bridge: { onSyncContentPush: callback => { push = callback; } },
    t: key => key, saveSettings: async () => {}, getSettings: () => state.settings });
  context = { document, state, structuredClone, customPricingFormApi: pricingApi, t: key => key, setAccountGroupExpanded() {},
    window: { TokenMonitorModelAliasForm: aliasApi, TokenMonitorSyncContentForm: api }, syncContentForm: form,
    saveSettings: async (patch, base) => {
      await runtime.publishPatch(patch, base);
      state.settings = { ...state.settings, ...patch };
    }
  };
  vm.createContext(context);
  vm.runInContext(`let modelAliasForm = null; let modelAliasSaveConflict = false; ${functionSource('setupModelAliasesUI', 'customPricingMeta')} setupModelAliasesUI();`, context);
  const preview = await runtime.preview('modelAliases');
  await runtime.configure({ ...preview, enabled: true, source: 'server' });
  remote = { ...remote, revision: 3, value: { modelAliases: { a: 'remote', c: 'new' }, modelAliasGrouping: 'off' } };
  if (source === 'catch-up') await runtime.refresh();
  else {
    await runtime.configure({ identity: runtime.status().identity, kind: 'modelAliases', enabled: false });
    const adoption = await runtime.preview('modelAliases');
    await runtime.configure({ ...adoption, enabled: true, source: 'server' });
  }
  assert.equal(form.base().revisions.modelAliases, 3);
  assert.deepEqual(state.settings.modelAliases, { a: 'remote', c: 'new' });
  await document.getElementById('modelAliasesList').children[0].children[1].click();
  assert.equal(writes.at(-1).baseRevision, 3);
  assert.deepEqual(writes.at(-1).value.modelAliases, { c: 'new' });
  assert.equal(document.getElementById('modelAliasesError').textContent, '');
  form.dispose();
});


test('rerendering the same paired settings DTO does not replace a newer status push', async () => {
  const f = fixture();
  await f.form.refresh(false);
  f.settings({ syncContentStatus: status() });
  f.push(status({ revisions: { modelAliases: 3, customPricing: 4 } }));
  f.form.syncSettings();
  assert.equal(f.form.base().revisions.modelAliases, 3);
  f.form.dispose();
});
