'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const { LANGUAGE_OPTIONS, MESSAGES } = require('../../src/electron/renderer/i18n');
const { mergeRenderedSelection, mergeSubsetOrder } = require('../../src/electron/renderer/settingsListFilter');

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
  const order = ['claude', 'codex', 'opencode', 'zed', 'kilo'];
  // Only the rows matching a "kilo" query are rendered.
  assert.deepEqual(
    mergeRenderedSelection(stored, [['kilo', true]], order),
    ['claude', 'codex', 'opencode', 'zed', 'kilo']
  );
  // Unticking a visible row removes exactly that one.
  assert.deepEqual(
    mergeRenderedSelection(stored, [['codex', false]], order),
    ['claude', 'opencode', 'zed']
  );
  // A plain read of the DOM would have written just the rendered row.
  assert.notDeepEqual(mergeRenderedSelection(stored, [['kilo', true]], order), ['kilo']);
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
  assert.match(fn(app, 'onToolTrackingToggle'), /settingsListFilterApi\.mergeRenderedSelection\(\s*new Set\(String\(Object\.assign\(\{\}, state\.settings, \.\.\.pendingSettingsPatches\)\.clients/);
  assert.match(fn(app, 'onLimitProviderToggle'), /settingsListFilterApi\.mergeRenderedSelection\(\s*enabledLimitProviderSet\(\),/);
});

// A drop commits the order it reads off the list, so reordering a filtered list
// would persist only the matching rows' order. The keyboard path is safe from
// that (it derives the next order from settings, never from the DOM) but would
// move the row through positions the query has hidden, so it is off too.
test('neither list reorders by drag or keyboard while a filter is on', () => {
  const app = readRendererFile('app.js');
  const tools = fn(app, 'renderToolPreferencesNow');
  // Only the enabled group is ordered, so its rows alone take the gestures.
  assert.match(tools, /if \(!filtering && tracked\) row\.addEventListener\('pointerdown', \(event\) => clientPreferenceRowDrag\.startRowDrag/);
  assert.match(tools, /if \(!filtering && tracked\) \{[^}]*trackInput\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown/);
  const limits = fn(app, 'renderLimitProviderCheckboxesNow');
  assert.match(limits, /if \(!filtering && isEnabled\) row\.addEventListener\('pointerdown', \(event\) => limitProviderRowDrag\.startRowDrag/);
  assert.match(limits, /if \(!filtering && isEnabled\) \{[^}]*cb\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown/);
});

// The signature short-circuit compares the rendered child count against a
// constant list length. Left unchanged, a filtered list would fail that check on
// every stats tick and rebuild itself ~6s forever.
test('both render short-circuits account for the query and the rendered row count', () => {
  const app = readRendererFile('app.js');
  // Scoped to each render function: a whole-file token check passes while one
  // of the two lists still rebuilds itself on every stats tick.
  const tools = fn(app, 'renderToolPreferencesNow');
  assert.match(tools, /settingsListRendered\(els\.clientDisplayList, '\.tool-preference-row\[data-client\]', clients\.length, !matched\.size\)/);
  const limits = fn(app, 'renderLimitProviderCheckboxesNow');
  assert.match(limits, /settingsListRendered\(els\.limitProviderCheckboxes, '\.limit-provider-row\[data-provider\]', providers\.length, !matched\.size\)/);
  // Rows are counted wherever they sit, since the rest are nested in a group.
  const rendered = fn(app, 'settingsListRendered');
  assert.match(rendered, /list\.querySelectorAll\(rowSelector\)\.length === rowCount/);
  assert.match(rendered, /:scope > \.settings-list-empty/);
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

// Only the enabled group is reordered on screen, but the saved order covers
// every row. Disabled rows keep their slots, so re-enabling one restores it.
test('a reordered group is written back into the slots it occupied', () => {
  assert.deepEqual(mergeSubsetOrder(['a', 'x', 'b', 'y', 'c'], ['c', 'a', 'b']), ['c', 'x', 'a', 'y', 'b']);
  assert.deepEqual(mergeSubsetOrder(['a', 'x', 'b'], ['a', 'b']), ['a', 'x', 'b']);
  assert.deepEqual(mergeSubsetOrder(['x', 'y'], []), ['x', 'y']);
});

test('both lists group enabled rows above a collapsed group of the rest', () => {
  const app = readRendererFile('app.js');
  const limits = fn(app, 'renderLimitProviderCheckboxesNow');
  assert.match(limits, /if \(isEnabled\) els\.limitProviderCheckboxes\.insertBefore\(row, groups\.before\);\n\s*else groups\.rows\.append\(row\);/);
  const tools = fn(app, 'renderToolPreferencesNow');
  assert.match(tools, /if \(tracked\) els\.clientDisplayList\.insertBefore\(row, groups\.before\);\n\s*else groups\.rows\.append\(row\);/);
  // Drag and the order rows the drop rebuilds see the enabled group only.
  assert.match(app, /rowSelector: ':scope > \.limit-provider-row\[data-provider\]'/);
  assert.match(fn(app, 'preferenceRows'), /':scope > \.limit-provider-row\[data-provider\]'/);
  assert.match(fn(app, 'applyPreferenceOrder'), /list\.insertBefore\(row, tail\)/);
  // A disabled plugin provider's settings view mounts when its nested row
  // opens and goes inactive while the group is collapsed.
  assert.match(app, /!container\.closest\('\.is-filtered-out, \.settings-list-group\.hidden'\)/);
  assert.match(app, /target\.id === 'limitProviderDisabledGroup'/);
  assert.match(app, /els\.limitProviderCheckboxes\.contains\(target\) && \(target\.classList\.contains\('limit-provider-row'\)/);
  // A filter shows every match flat; so does a list with one side empty.
  assert.match(fn(app, 'renderSettingsListGroups'), /if \(filtering \|\| !enabledCount\)/);
  for (const locale of Object.keys(MESSAGES)) {
    for (const key of ['settings.limits.group.enabled', 'settings.limits.group.disabled', 'settings.tools.group.tracked', 'settings.tools.group.untracked', 'settings.list.group.showAll', 'settings.list.group.collapse']) {
      assert.ok(MESSAGES[locale][key], `${locale} ${key}`);
    }
  }
});

// Turning off a focused switch moves its row into the collapsed, inert group;
// focus goes to that group's toggle rather than the document.
test('a switch turned off hands focus to the collapsed group toggle', () => {
  const vm = require('node:vm');
  const source = fn(readRendererFile('app.js'), 'restoreSettingsListFocus');
  const focused = [];
  const node = (id, extra = {}) => ({ id, focus: () => focused.push(id), closest: () => null, ...extra });
  const group = { id: 'limitProviderDisabledGroup', inert: true };
  const nodes = {
    'limitProviderEnabled-zed': node('limitProviderEnabled-zed', { closest: () => group }),
    limitProviderDisabledGroupToggle: node('limitProviderDisabledGroupToggle'),
    'limitProviderEnabled-claude': node('limitProviderEnabled-claude')
  };
  const document = { body: {}, activeElement: null, getElementById: id => nodes[id] || null };
  document.activeElement = document.body;
  const context = { document };
  vm.runInNewContext(`${source}\nglobalThis.restore = restoreSettingsListFocus;`, context);
  context.restore('limitProviderEnabled-zed');
  context.restore('limitProviderEnabled-claude');
  group.inert = false;
  context.restore('limitProviderEnabled-zed');
  assert.deepEqual(focused, ['limitProviderDisabledGroupToggle', 'limitProviderEnabled-claude', 'limitProviderEnabled-zed']);
});

// A repaint while a tracking write is in flight groups rows by that write, so a
// tool just switched off is not drawn back into the tracked group.
test('tracked-tool grouping reads settings writes still in flight', () => {
  const vm = require('node:vm');
  const app = readRendererFile('app.js');
  const source = `${fn(app, 'pendingTrackedClients')}\n${fn(app, 'clientRowTracked')}`;
  const context = {
    state: { settings: { clients: 'codex,claude' } },
    pendingSettingsPatches: new Set([{ clients: 'claude' }]),
    qoderDisplayApi: require('../../src/electron/renderer/qoderDisplay')
  };
  vm.runInNewContext(`${source}\nglobalThis.tracked = clientRowTracked;`, context);
  assert.equal(context.tracked('codex'), false);
  assert.equal(context.tracked('claude'), true);
  context.pendingSettingsPatches.clear();
  assert.equal(context.tracked('codex'), true);
  // The cached rows are keyed on the same selection, so dropping a failed write
  // forces a rebuild.
  assert.match(fn(app, 'toolPreferenceRenderSignature'), /String\(pendingTrackedClients\(\) \|\| ''\)/);
});
