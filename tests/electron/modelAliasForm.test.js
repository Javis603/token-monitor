'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createModelAliasForm } = require('../../src/electron/renderer/modelAliasForm');
const { normalizeModelAliases, upsertModelAlias } = require('../../src/electron/renderer/modelAliases');

function fixture(save) {
  const nodes = new Map();
  function node() {
    const classes = new Set();
    const listeners = {};
    return { value: '', textContent: '', children: [], disabled: false,
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key), contains: (key) => classes.has(key), toggle: (key, active) => active ? classes.add(key) : classes.delete(key) },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener: (event, handler) => { listeners[event] = handler; },
      click: () => listeners.click?.(), focus() {} };
  }
  const document = { createElement: node, getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } };
  let aliases = {};
  const form = createModelAliasForm({ document, t: (key) => key, getAliases: () => aliases, saveAliases: async (value) => { if (save) await save(value); aliases = normalizeModelAliases(value); } });
  const get = (suffix) => document.getElementById(`modelAliases${suffix}`);
  return { form, get, aliases: () => aliases };
}

test('alias editor adds, edits and removes a persisted mapping', async () => {
  const f = fixture();
  f.get('AddButton').click();
  f.get('AliasInput').value = ' anthropic/claude-opus-5 ';
  f.get('CanonicalInput').value = 'claude-opus-5';
  await f.get('SaveButton').click();
  assert.deepEqual(f.aliases(), { 'anthropic/claude-opus-5': 'claude-opus-5' });
  const row = f.get('List').children[0];
  assert.equal(row.children[0].children[0].textContent, 'anthropic/claude-opus-5');
  assert.equal(row.children[0].children[1].textContent, '→ claude-opus-5');
  row.children[0].click();
  f.get('CanonicalInput').value = 'opus';
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
  f.get('AliasInput').value = 'alias';
  f.get('CanonicalInput').value = 'canonical';
  await f.get('SaveButton').click();
  assert.equal(f.get('Error').textContent, 'settings.modelAliases.saveError');
  assert.equal(f.get('Form').classList.contains('hidden'), false);
  assert.deepEqual(f.aliases(), {});
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
