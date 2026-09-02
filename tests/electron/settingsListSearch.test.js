'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const { LANGUAGE_OPTIONS, MESSAGES } = require('../../src/electron/renderer/i18n');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
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
    assert.match(html, new RegExp(`<input id="${input}"[^>]*data-i18n-placeholder="${placeholder.replace(/\./g, '\\.')}"`), input);
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

// A pure read of the rendered checkboxes is the whole selection only while the
// list is unfiltered. Once a query hides rows it becomes a partial read, and
// writing it back would untrack every client the query happens to hide.
test('the tracked-tools toggle merges the rendered checkboxes into the stored selection', () => {
  const app = readRendererFile('app.js');
  const body = app.slice(app.indexOf('async function onToolTrackingToggle()'), app.indexOf('async function onClientVisibilityToggle'));
  assert.match(body, /new Set\(enabledClientSet\(\)\)/);
  assert.match(body, /orderedClients\(KNOWN_CLIENTS/);
  assert.doesNotMatch(body, /Array\.from\(els\.clientDisplayList\.querySelectorAll[\s\S]*?\.map\(/);
});

test('the limit-provider toggle merges the rendered checkboxes into the stored selection', () => {
  const app = readRendererFile('app.js');
  const body = app.slice(app.indexOf('async function onLimitProviderToggle()'), app.indexOf('async function onLimitProviderMove'));
  assert.match(body, /new Set\(enabledLimitProviderSet\(\)\)/);
  assert.match(body, /orderedLimitProviders\(LIMIT_PROVIDERS/);
  assert.doesNotMatch(body, /Array\.from\(els\.limitProviderCheckboxes\.querySelectorAll[\s\S]*?\.map\(/);
});

// A drop commits the order it reads off the list, so reordering a filtered list
// would persist only the matching rows' order.
test('neither list starts a reorder drag while a filter is on', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /if \(!filtering\) row\.addEventListener\('pointerdown', \(event\) => clientPreferenceRowDrag\.startRowDrag/);
  assert.match(app, /if \(!filtering\) row\.addEventListener\('pointerdown', \(event\) => limitProviderRowDrag\.startRowDrag/);
});

// The signature short-circuit compares the rendered child count against a
// constant list length. Left unchanged, a filtered list would fail that check on
// every stats tick and rebuild itself ~6s forever.
test('both render short-circuits account for the query and the filtered row count', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /query: toolPreferenceQuery\(\),/);
  assert.match(app, /query: limitProviderQuery\(\),/);
  assert.match(app, /els\.clientDisplayList\.children\.length === expectedRowCount/);
  assert.match(app, /els\.limitProviderCheckboxes\.children\.length === expectedRowCount/);
  assert.doesNotMatch(app, /children\.length === KNOWN_CLIENTS\.length/);
  assert.doesNotMatch(app, /children\.length === LIMIT_PROVIDERS\.length/);
});

test('the search strings and the no-matches note exist in every bundled locale', () => {
  for (const locale of LANGUAGE_OPTIONS.map((option) => option.value).filter((value) => value !== 'auto')) {
    for (const key of ['settings.tools.search', 'settings.limits.search', 'settings.search.noMatches']) {
      assert.ok(MESSAGES[locale][key], `${locale} should define ${key}`);
    }
  }
});
