'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const usageItemsApi = require('../../src/shared/limits/usageItems');
const i18n = require('../../src/electron/renderer/i18n');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }
  change() { return Promise.all((this.listeners.get('change') || []).map((handler) => handler())); }
}

const FACTORY = {
  provider: 'factory',
  windows: [
    { kind: 'session', label: '5-hour' },
    { kind: 'weekly', label: 'Weekly' },
    { kind: 'billing', label: 'Monthly' },
    { kind: 'session', label: 'Core 5-hour', additional: true },
    { kind: 'weekly', label: 'Core Weekly', additional: true },
    { kind: 'billing', label: 'Core Monthly', additional: true },
    { kind: 'billing', label: 'Balance', metric: 'credits' }
  ]
};

const CODEX = {
  provider: 'codex',
  windows: [
    { kind: 'session', label: 'Session' },
    { kind: 'weekly', label: 'Weekly' }
  ]
};

const rowId = (provider, index) => usageItemsApi.limitUsageRowId(provider.provider, provider.windows[index]);

// app.js is a browser entry point. Execute its actual checklist builder with
// a small DOM, as the other renderer unit tests do for entry-point functions.
function checklistHarness(settings = {}, save = () => {}) {
  const match = source.match(/function limitProviderUsageItemsList\([^\n]*\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'the checklist builder exists');
  const state = { settings };
  const saves = [];
  const build = vm.runInNewContext(`(${match[0]})`, {
    document: { createElement: (tag) => new Element(tag) },
    usageItemsApi,
    state,
    t: (key) => i18n.translate('en', key),
    saveSettings: (patch) => {
      saves.push(patch.limitProviderHiddenItems);
      return save(patch);
    }
  });
  const render = (provider, reusableInputs) => build(
    provider.provider, usageItemsApi.limitProviderUsageRows(provider), reusableInputs
  );
  const inputs = (group) => group.children[1].children.map((row) => row.children[0]);
  return { state, saves, render, inputs };
}

test('usage checklists enumerate the provider\'s real rows with its own labels', () => {
  const { render, inputs, saves } = checklistHarness({
    limitProviderHiddenItems: { factory: [rowId(FACTORY, 3), 'credits'] }
  });
  const group = render(FACTORY);
  assert.deepEqual(inputs(group).map((input) => [input.type, input.checked]), [
    ['checkbox', true], ['checkbox', true], ['checkbox', true],
    ['checkbox', false], ['checkbox', true], ['checkbox', true], ['checkbox', false]
  ]);
  const labels = group.children[1].children;
  assert.ok(labels.every((label) => label.tagName === 'label'));
  // One checkbox per rendered row, named what the card names it.
  assert.deepEqual(labels.map((label) => label.children[1].textContent), [
    '5-hour', 'Weekly', 'Monthly', 'Core 5-hour', 'Core Weekly', 'Core Monthly', 'Balance'
  ]);
  assert.ok(inputs(render(CODEX)).every((input) => input.checked));
  assert.deepEqual(saves, [], 'rendering alone must not persist a change');
});

test('a checklist starts visible without settings and can restore its last hidden item', async () => {
  const harness = checklistHarness(null);
  const [session] = harness.inputs(harness.render(CODEX));
  assert.equal(session.checked, true);
  session.checked = false;
  await session.change();
  assert.deepEqual(harness.state.settings.limitProviderHiddenItems, { codex: [rowId(CODEX, 0)] });
  session.checked = true;
  await session.change();
  assert.deepEqual(harness.state.settings.limitProviderHiddenItems, {});
  assert.deepEqual(harness.saves, [{ codex: [rowId(CODEX, 0)] }, {}]);
});

test('quick toggles compose before settings writes finish and preserve unrelated settings', async () => {
  const pending = [];
  const harness = checklistHarness(
    { limitProviderHiddenItems: { deepseek: ['credits'] }, currency: 'EUR' },
    () => new Promise((resolve) => pending.push(resolve))
  );
  const [session, weekly] = harness.inputs(harness.render(CODEX));
  session.checked = false;
  const first = session.change();
  weekly.checked = false;
  const second = weekly.change();
  try {
    assert.equal(pending.length, 2);
    assert.deepEqual(harness.saves, [
      { deepseek: ['credits'], codex: [rowId(CODEX, 0)] },
      { deepseek: ['credits'], codex: [rowId(CODEX, 0), rowId(CODEX, 1)] }
    ]);
    assert.deepEqual(
      harness.state.settings.limitProviderHiddenItems,
      { deepseek: ['credits'], codex: [rowId(CODEX, 0), rowId(CODEX, 1)] }
    );
    assert.equal(harness.state.settings.currency, 'EUR');
  } finally {
    pending.forEach((resolve) => resolve());
    await Promise.all([first, second]);
  }
});

test('reused inputs refresh checked state without duplicate handlers or stale settings', async () => {
  const harness = checklistHarness({ limitProviderHiddenItems: { codex: [rowId(CODEX, 0)] } });
  const rows = usageItemsApi.limitProviderUsageRows(CODEX);
  const original = harness.inputs(harness.render(CODEX));
  const reusable = new Map(rows.map((entry, index) => [
    `codex:item:${entry.id}`, original[index]
  ]));
  harness.state.settings = { limitProviderHiddenItems: { codex: [rowId(CODEX, 1)], deepseek: ['spend'] } };
  const rerendered = harness.inputs(harness.render(CODEX, reusable));
  for (let index = 0; index < original.length; index += 1) {
    assert.equal(rerendered[index], original[index]);
    assert.equal(rerendered[index].listeners.get('change').length, 1);
  }
  assert.equal(rerendered[0].checked, true);
  assert.equal(rerendered[1].checked, false);
  rerendered[1].checked = true;
  await rerendered[1].change();
  assert.deepEqual(harness.saves, [{ deepseek: ['spend'] }]);
});
