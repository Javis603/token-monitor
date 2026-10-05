'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createModelAliasForm } = require('../../src/electron/renderer/modelAliasForm');
const { normalizeModelAliases, upsertModelAlias, upsertModelAliasBatch, modelAliasChoices } = require('../../src/electron/renderer/modelAliases');
const i18n = require('../../src/electron/renderer/i18n');
const pricingApi = require('../../src/electron/renderer/customPricingForm');

function documentFixture() {
  const nodes = new Map();
  function node() {
    const classes = new Set();
    const listeners = {};
    return { value: '', textContent: '', children: [], disabled: false,
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key), contains: (key) => classes.has(key), toggle: (key, active) => active ? classes.add(key) : classes.delete(key) },
      append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      setAttribute(key, value) { this[key] = value; },
      addEventListener: (event, handler) => { listeners[event] = handler; },
      dispatchEvent: (event) => listeners[event.type]?.(event),
      click() { if (!this.disabled) return listeners.click?.(); },
      focus() {
        if (document.activeElement === this) return;
        const previous = document.activeElement;
        document.activeElement = this;
        previous?.dispatchEvent({ type: 'blur' });
      } };
  }
  const document = { activeElement: null, querySelectorAll: () => [], createElement: node, getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, Object.assign(node(), { id })); return nodes.get(id); } };
  document.getElementById('modelAliasesForm').classList.add('hidden');
  return document;
}

function fixture(save, initial = {}) {
  const document = documentFixture();
  let aliases = initial.aliases || {};
  let modelIds = initial.modelIds || [];
  let locale = initial.locale;
  const t = key => locale ? i18n.translate(locale, key) : key;
  const form = createModelAliasForm({ document, t, getAliases: () => aliases, getModelIds: () => modelIds, saveAliases: async (value) => { if (save) await save(value); aliases = normalizeModelAliases(value); } });
  const get = (suffix) => document.getElementById(`modelAliases${suffix}`);
  const select = (suffix, id) => { get(`${suffix}Select`).focus(); get(`${suffix}Select`).value = id === null ? '__manual__' : `model:${id}`; get(`${suffix}Select`).dispatchEvent({ type: 'change' }); };
  const manual = (suffix, id) => { select(suffix, null); get(`${suffix}Input`).value = id; };
  const extra = (index = 0) => {
    const row = get('MoreSources').children[index];
    return { label: row.children[0].children[0], select: row.children[0].children[1], input: row.children[0].children[2], remove: row.children[1] };
  };
  return { form, get, select, manual, extra, aliases: () => aliases,
    updateModels: (ids) => { modelIds = ids; form.syncSettings(); },
    updateLocale: next => { locale = next; form.syncSettings(); } };
}

test('alias editor adds, edits and removes a persisted mapping', async () => {
  const f = fixture();
  f.get('AddButton').click();
  f.manual('Alias', ' anthropic/claude-opus-5 ');
  f.manual('Canonical', 'claude-opus-5');
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { 'anthropic/claude-opus-5': 'claude-opus-5' });
  const row = f.get('List').children[0];
  assert.equal(row.children[0].children[0].textContent, 'anthropic/claude-opus-5');
  assert.equal(row.children[0].children[1].textContent, '→ claude-opus-5');
  row.children[0].click();
  f.manual('Canonical', 'opus');
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { 'anthropic/claude-opus-5': 'opus' });
  await f.get('List').children[0].children[1].click();
  assert.deepEqual(f.aliases(), {});
});

test('invalid form and failed persistence keep the existing mapping and expose an error', async () => {
  const f = fixture(async () => { throw new Error('disk full'); });
  f.get('AddButton').click();
  await f.get('SaveButton').click();
  assert.equal(f.get('Error').classList.contains('hidden'), false);
  f.manual('Alias', 'alias');
  f.manual('Canonical', 'canonical');
  await f.get('SaveButton').click();
  assert.equal(f.get('Error').textContent, 'settings.modelAliases.saveError');
  assert.equal(f.get('Form').classList.contains('hidden'), false);
  assert.deepEqual(f.aliases(), {});
});

test('model choices merge supplied IDs with saved aliases without invalid or duplicate options', () => {
  assert.deepEqual(modelAliasChoices(['raw/id', 'raw/id', 'priced-only', '', null, 'x'.repeat(257)], { saved: 'target' }), ['priced-only', 'raw/id', 'saved', 'target']);
});

test('app setup supplies custom pricing config IDs absent from raw usage to both alias selectors', () => {
  const document = documentFixture();
  const state = { stats: { modelAliasSourceIds: ['usage-only'] },
    settings: { modelAliases: {}, customModelPricing: [{ modelId: 'config-only', inputPerM: 1 }] } };
  const context = { document, state, customPricingFormApi: pricingApi, t: key => key, setAccountGroupExpanded() {},
    window: { TokenMonitorModelAliasForm: { createModelAliasForm } }, syncContentForm: null, saveSettings: async () => {} };
  const app = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function setupModelAliasesUI(');
  const end = app.indexOf('\nfunction customPricingMeta(', start);
  assert.ok(start >= 0 && end > start);
  vm.createContext(context);
  vm.runInContext(`let modelAliasForm = null; let modelAliasSaveConflict = false; ${app.slice(start, end)} setupModelAliasesUI();`, context);
  document.getElementById('modelAliasesAddButton').click();
  for (const suffix of ['Alias', 'Canonical']) {
    const options = document.getElementById(`modelAliases${suffix}Select`).children.map(option => option.value);
    assert.ok(options.includes('model:usage-only'));
    assert.ok(options.includes('model:config-only'));
  }
});

test('choice refresh waits for a focused picker to blur and leaves unchanged options intact', () => {
  const f = fixture(null, { modelIds: ['raw/a', 'target'] });
  f.get('AddButton').click();
  f.select('Alias', 'raw/a');
  const select = f.get('AliasSelect');
  const original = select.children.slice();
  f.updateModels(['raw/a', 'new/id', 'target']);
  f.updateModels(['raw/a', 'new/id', 'latest/id', 'target']);
  assert.deepEqual(select.children, original);
  assert.equal(select.value, 'model:raw/a');
  f.get('CancelButton').focus();
  assert.ok(select.children.some(option => option.value === 'model:latest/id'));
  assert.ok(select.children.some(option => option.value === 'model:new/id'));
  assert.equal(select.value, 'model:raw/a');
  const refreshed = select.children.slice();
  f.form.syncSettings();
  assert.deepEqual(select.children, refreshed);
});

test('static and extra captions follow the selected or manual control with unique row IDs', () => {
  const f = fixture(null, { modelIds: ['a', 'target'] });
  f.get('AddButton').click();
  for (const suffix of ['Alias', 'Canonical']) {
    assert.equal(f.get(`${suffix}Label`).for, f.get(`${suffix}Select`).id);
    f.manual(suffix, 'draft');
    assert.equal(f.get(`${suffix}Label`).for, f.get(`${suffix}Input`).id);
    f.select(suffix, suffix === 'Alias' ? 'a' : 'target');
    assert.equal(f.get(`${suffix}Label`).for, f.get(`${suffix}Select`).id);
  }
  f.get('AddSourceButton').click();
  const first = f.extra();
  assert.equal(first.label.for, first.select.id);
  first.select.value = '__manual__';
  first.select.dispatchEvent({ type: 'change' });
  assert.equal(first.label.for, first.input.id);
  first.remove.click();
  f.get('AddSourceButton').click();
  assert.notEqual(f.extra().select.id, first.select.id);
  assert.notEqual(f.extra().input.id, first.input.id);
});

test('language changes refresh existing extra row text and accessible names without changing drafts', () => {
  const f = fixture(null, { locale: 'en' });
  f.get('AddButton').click();
  f.get('AddSourceButton').click();
  const extra = f.extra();
  extra.select.value = '__manual__';
  extra.select.dispatchEvent({ type: 'change' });
  extra.input.value = 'custom/draft';
  f.updateLocale('zh-CN');
  assert.equal(extra.label.textContent, i18n.translate('zh-CN', 'settings.modelAliases.alias'));
  assert.equal(extra.remove.textContent, i18n.translate('zh-CN', 'settings.modelAliases.remove'));
  assert.equal(extra.input['aria-label'], i18n.translate('zh-CN', 'settings.modelAliases.alias'));
  assert.equal(extra.select.children.at(-1).textContent, i18n.translate('zh-CN', 'settings.customPricing.manualEntry'));
  assert.equal(extra.input.value, 'custom/draft');
  assert.equal(extra.select.value, '__manual__');
});

test('selectors and manual entry can save multiple aliases to the same target', async () => {
  const f = fixture(null, { modelIds: ['raw/a', 'raw/b', 'canonical'] });
  f.get('AddButton').click();
  assert.deepEqual(f.get('AliasSelect').children.map(option => option.textContent), ['settings.customPricing.selectModel', 'canonical', 'raw/a', 'raw/b', 'settings.customPricing.manualEntry']);
  f.select('Alias', 'raw/a');
  f.form.syncSettings();
  f.select('Canonical', 'canonical');
  f.get('AddSourceButton').click();
  f.extra().select.value = 'model:raw/b';
  f.get('AddSourceButton').click();
  const manual = f.extra(1);
  manual.select.value = '__manual__';
  manual.select.dispatchEvent({ type: 'change' });
  manual.input.value = ' custom/c ';
  assert.equal(manual.input.classList.contains('hidden'), false);
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { 'raw/a': 'canonical', 'raw/b': 'canonical', 'custom/c': 'canonical' });
  assert.equal(f.get('List').children.length, 3);
});

test('refreshing choices and switching input modes preserves manual drafts', async () => {
  const f = fixture(null, { modelIds: ['raw/a', 'canonical'] });
  f.get('AddButton').click();
  f.manual('Alias', 'draft');
  f.manual('Canonical', 'new target');
  f.select('Alias', 'raw/a');
  f.select('Alias', null);
  assert.equal(f.get('AliasInput').value, 'draft');
  f.updateModels(['raw/a', 'canonical', 'new/id']);
  assert.equal(f.get('AliasSelect').value, '__manual__');
  assert.equal(f.get('AliasInput').value, 'draft');
  assert.equal(f.get('CanonicalInput').value, 'new target');
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { draft: 'new target' });
});

test('an invalid extra source prevents the entire form from being persisted', async () => {
  let writes = 0;
  const f = fixture(() => { writes += 1; }, { aliases: { old: 'target' } });
  f.get('AddButton').click();
  f.manual('Alias', 'new');
  f.manual('Canonical', 'target');
  f.get('AddSourceButton').click();
  await f.get('SaveButton').click();
  assert.equal(writes, 0);
  assert.deepEqual(f.aliases(), { old: 'target' });
  assert.equal(f.get('Error').textContent, 'settings.modelAliases.invalid');
  assert.equal(f.get('Form').classList.contains('hidden'), false);
});

test('a selected ID that disappears from usage remains available as a manual draft', async () => {
  const f = fixture(null, { modelIds: ['raw/a', 'target'] });
  f.get('AddButton').click();
  f.select('Alias', 'raw/a');
  f.select('Canonical', 'target');
  f.updateModels(['target']);
  assert.equal(f.get('AliasSelect').value, '__manual__');
  assert.equal(f.get('AliasInput').value, 'raw/a');
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { 'raw/a': 'target' });
});

test('a model named like the manual-entry sentinel remains selectable', async () => {
  const f = fixture(null, { modelIds: ['__manual__', 'target'] });
  f.get('AddButton').click();
  f.select('Alias', '__manual__');
  f.select('Canonical', 'target');
  assert.equal(f.get('AliasInput').classList.contains('hidden'), true);
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { __manual__: 'target' });
});

test('removing an extra source and cancelling clears only the draft', async () => {
  const f = fixture(null, { aliases: { a: 'target' } });
  f.get('List').children[0].children[0].click();
  f.get('AddSourceButton').click();
  f.extra().remove.click();
  assert.equal(f.get('MoreSources').children.length, 0);
  f.get('AddSourceButton').click();
  f.get('CancelButton').click();
  f.get('AddButton').click();
  assert.equal(f.get('MoreSources').children.length, 0);
  assert.equal(f.get('AliasSelect').value, '');
  assert.deepEqual(f.aliases(), { a: 'target' });
});

test('saving locks the complete draft and preserves it after a persistence failure', async () => {
  let reject;
  const f = fixture(() => new Promise((_resolve, fail) => { reject = fail; }), { modelIds: ['a', 'b', 'target'] });
  f.get('AddButton').click();
  f.select('Alias', 'a');
  f.select('Canonical', 'target');
  f.get('AddSourceButton').click();
  f.extra().select.value = 'model:b';
  const pending = f.get('SaveButton').click();
  assert.equal(f.get('AliasSelect').disabled, true);
  assert.equal(f.extra().select.disabled, true);
  assert.equal(f.extra().remove.disabled, true);
  assert.equal(f.get('CancelButton').disabled, true);
  f.get('AddSourceButton').click();
  assert.equal(f.get('MoreSources').children.length, 1);
  reject(new Error('disk full'));
  await pending;
  assert.equal(f.get('AliasSelect').value, 'model:a');
  assert.equal(f.extra().select.value, 'model:b');
  assert.equal(f.get('CanonicalSelect').value, 'model:target');
  assert.equal(f.get('SaveButton').disabled, false);
  assert.equal(f.get('Form').classList.contains('hidden'), false);
  assert.deepEqual(f.aliases(), {});
});

test('a batch edit replaces the edited source, preserves siblings and validates all sources before saving', () => {
  const source = { old: 'target', sibling: 'target', unrelated: 'other' };
  assert.deepEqual(upsertModelAliasBatch(source, ['new', 'second'], 'target', 'old'), { sibling: 'target', unrelated: 'other', new: 'target', second: 'target' });
  for (const ids of [[], ['a', ''], ['a', 3], ['a', 'target'], ['OpenAI/GPT_5.5', 'openai/gpt-5-5'], ['a', 'x'.repeat(257)]]) {
    assert.equal(upsertModelAliasBatch(source, ids, 'target', 'old'), null);
  }
  assert.deepEqual(source, { old: 'target', sibling: 'target', unrelated: 'other' });
  const full = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`alias${i}`, 'target']));
  assert.equal(upsertModelAliasBatch(full, ['new', 'second'], 'target', 'alias0'), null);
  assert.equal(Object.keys(upsertModelAliasBatch(full, ['new'], 'target', 'alias0')).length, 4096);
  assert.equal(Object.keys(upsertModelAliasBatch(full, ['alias0', 'alias1'], 'new target')).length, 4096);
  assert.deepEqual(upsertModelAliasBatch({}, ['__proto__', 'constructor'], 'target'), JSON.parse('{"__proto__":"target","constructor":"target"}'));
});

test('settings normalization bounds malformed and duplicate entries without changing the source', () => {
  const source = { ' OPENAI/GPT-5.5 ': 'gpt-5.5', 'openai/gpt-5-5': 'other', empty: '', invalid: 4 };
  assert.deepEqual(normalizeModelAliases(source), { 'OPENAI/GPT-5.5': 'gpt-5.5' });
  assert.equal(source.invalid, 4);
  assert.deepEqual(upsertModelAlias(source, 'openai/gpt-5-5', 'new'), { 'openai/gpt-5-5': 'new' });
  assert.equal(upsertModelAlias({}, 'same', 'same'), null);
  assert.equal(upsertModelAlias({}, 'a'.repeat(257), 'b'), null);
  const oversized = Object.fromEntries(Array.from({ length: 4100 }, (_, i) => [`alias${i}`, 'model']));
  assert.equal(Object.keys(normalizeModelAliases(oversized)).length, 4096);
});
