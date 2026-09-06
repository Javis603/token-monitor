'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const { LANGUAGE_OPTIONS, MESSAGES } = require('../../src/electron/renderer/i18n');
const { mergeRenderedSelection } = require('../../src/electron/renderer/settingsListFilter');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

// Assertions are scoped to one function's body so a match somewhere else in
// this 16k-line file cannot stand in for the code under test.
function fn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

// Escapes every regex metacharacter, backslash included. Escaping only periods
// left `\\` active, which CodeQL flags as incomplete escaping and which would
// quietly break these assertions the day a list key contains one.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LISTS = [
  { input: 'clientDisplaySearchInput', list: 'clientDisplayList', placeholder: 'settings.tools.search' },
  { input: 'limitProviderSearchInput', list: 'limitProviderCheckboxes', placeholder: 'settings.limits.search' }
];

// Both lists are rebuilt wholesale on every stats tick. A field rendered inside
// one would be destroyed and re-created under the user's cursor, losing the
// query and the caret mid-word, so the markup keeps it outside the container.
test('each searchable list has a static field above it, outside the list container', () => {
  const html = readRendererFile('index.html');
  for (const { input, list, placeholder } of LISTS) {
    assert.match(html, new RegExp(`<input id="${escapeRegExp(input)}"[^>]*data-i18n-placeholder="${escapeRegExp(placeholder)}"`), input);
    assert.ok(html.indexOf(`id="${input}"`) < html.indexOf(`id="${list}"`), `${input} should precede its list`);
    const between = html.slice(html.indexOf(`id="${input}"`), html.indexOf(`id="${list}"`));
    assert.ok(!between.includes(`id="${list}"`));
    assert.doesNotMatch(between, /<div id="clientDisplayList"|<div id="limitProviderCheckboxes"/);
  }
});

test('the renderer loads the shared filter module', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<script src="settingsListFilter\.js"><\/script>/);
  assert.match(readRendererFile('app.js'), /const settingsListFilterApi = window\.TokenMonitorSettingsListFilter;/);
});

// The toggles keep the stored selection as their base rather than replacing it
// with a read of the DOM. Exercised through the shared helper both call sites
// use, so this asserts the behaviour and not the shape of the code.
test('a toggle applied to a partially rendered list preserves the rows it cannot see', () => {
  const stored = ['claude', 'codex', 'opencode', 'zed'];
  const order = ['claude', 'codex', 'opencode', 'zed', 'kilocode'];
  // Only the rows matching a "kilo" query are rendered.
  assert.deepEqual(
    mergeRenderedSelection(stored, [['kilocode', true]], order),
    ['claude', 'codex', 'opencode', 'zed', 'kilocode']
  );
  // Unticking a visible row removes exactly that one.
  assert.deepEqual(
    mergeRenderedSelection(stored, [['codex', false]], order),
    ['claude', 'opencode', 'zed']
  );
  // A plain read of the DOM would have written just the rendered row.
  assert.notDeepEqual(mergeRenderedSelection(stored, [['kilocode', true]], order), ['kilocode']);
});

test('an unfiltered toggle writes the same selection the old DOM read produced', () => {
  const order = ['claude', 'codex', 'opencode', 'zed'];
  const rendered = [['claude', true], ['codex', false], ['opencode', true], ['zed', true]];
  assert.deepEqual(
    mergeRenderedSelection(['claude', 'codex', 'opencode', 'zed'], rendered, order),
    rendered.filter(([, checked]) => checked).map(([id]) => id)
  );
});

test('both toggles route through the shared merge rather than reading the DOM directly', () => {
  const app = readRendererFile('app.js');
  assert.match(fn(app, 'onToolTrackingToggle'), /settingsListFilterApi\.mergeRenderedSelection\(\s*enabledClientSet\(\),/);
  assert.match(fn(app, 'onLimitProviderToggle'), /settingsListFilterApi\.mergeRenderedSelection\(\s*enabledLimitProviderSet\(\),/);
});

// A drop commits the order it reads off the list, so reordering a filtered list
// would persist only the matching rows' order. The keyboard path is safe from
// that (it derives the next order from settings, never from the DOM) but would
// move the row through positions the query has hidden, so it is off too.
test('neither list reorders by drag or keyboard while a filter is on', () => {
  const app = readRendererFile('app.js');
  const tools = fn(app, 'renderToolPreferencesNow');
  assert.match(tools, /if \(!filtering\) row\.addEventListener\('pointerdown', \(event\) => clientPreferenceRowDrag\.startRowDrag/);
  assert.match(tools, /if \(!filtering\) trackInput\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown/);
  const limits = fn(app, 'renderLimitProviderCheckboxesNow');
  assert.match(limits, /if \(!filtering\) row\.addEventListener\('pointerdown', \(event\) => limitProviderRowDrag\.startRowDrag/);
  assert.match(limits, /if \(!filtering\) cb\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown/);
});

// The signature short-circuit compares the rendered child count against a
// constant list length. Left unchanged, a filtered list would fail that check on
// every stats tick and rebuild itself ~6s forever.
test('both render short-circuits account for the query and the rendered row count', () => {
  const app = readRendererFile('app.js');
  // Scoped to each render function: a whole-file token check passes while one
  // of the two lists still rebuilds itself on every stats tick.
  const tools = fn(app, 'renderToolPreferencesNow');
  assert.match(tools, /els\.clientDisplayList\.children\.length === expectedRowCount/);
  assert.match(tools, /const expectedRowCount = clients\.length \+ \(matched\.size \? 0 : 1\)/);
  const limits = fn(app, 'renderLimitProviderCheckboxesNow');
  assert.match(limits, /els\.limitProviderCheckboxes\.children\.length === expectedRowCount/);
  assert.match(limits, /const expectedRowCount = providers\.length \+ \(matched\.size \? 0 : 1\)/);
  assert.match(fn(app, 'toolPreferenceRenderSignature'), /query: toolPreferenceQuery\(\),/);
  assert.match(fn(app, 'limitProviderSettingsRenderSignature'), /query: limitProviderQuery\(\),/);
  assert.doesNotMatch(app, /children\.length === KNOWN_CLIENTS\.length/);
  assert.doesNotMatch(app, /children\.length === LIMIT_PROVIDERS\.length/);
});

// The limits rows adopt singleton live nodes from index.html by reparenting
// them. A row that is not rendered leaves them inside the outgoing row, which
// `previousRows` removal then detaches from the document permanently — every
// hidden provider's account panel would be gone until the app restarted.
test('filtered-out rows are hidden, never omitted from the DOM', () => {
  const app = readRendererFile('app.js');
  assert.match(fn(app, 'renderToolPreferencesNow'), /row\.classList\.toggle\('is-filtered-out', !matched\.has\(id\)\)/);
  assert.match(fn(app, 'renderLimitProviderCheckboxesNow'), /matched\.has\(id\) \? '' : ' is-filtered-out'/);
  const css = readRendererFile('styles.css');
  assert.match(css, /\.tool-preference-row\.is-filtered-out,\s*\.settings-panel \.limit-provider-row\.is-filtered-out \{\s*display: none;/);
});

// The row shows `settingsLabel || label`, so searching the name printed on
// screen must not be the thing that hides it.
test('the limits filter searches the name the row actually displays', () => {
  const app = readRendererFile('app.js');
  assert.match(fn(app, 'limitProviderRows'), /\$\{settingsLabel \|\| label\} \$\{label\} \$\{id\}/);
  assert.match(app, /text\.textContent = settingsLabel \|\| label;/);
});

test('the search strings and the no-matches note exist in every bundled locale', () => {
  for (const locale of LANGUAGE_OPTIONS.map((option) => option.value).filter((value) => value !== 'auto')) {
    for (const key of ['settings.tools.search', 'settings.limits.search', 'settings.search.noMatches']) {
      assert.ok(MESSAGES[locale][key], `${locale} should define ${key}`);
    }
  }
});
