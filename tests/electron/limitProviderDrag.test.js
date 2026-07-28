'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`).exec(source);
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

test('limit provider expansion goes through one shared helper', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function setLimitProviderSettingsExpanded\(providerId\) \{/);
  // The disclosure no longer hand-rolls the three class/aria mutations.
  assert.match(app, /disclosure\.addEventListener\('click', \(\) => \{\s*setLimitProviderSettingsExpanded\(/);
});

test('the limit provider row carries the drag transform contract', () => {
  const css = readRendererFile('styles.css');
  const row = cssRule(css, '.settings-panel .limit-provider-row');
  assert.match(row, /position: relative;/);
  // Hover keeps the default cursor; only the active drag changes it.
  assert.doesNotMatch(row, /cursor: grab;/);
  assert.match(row, /touch-action: pan-y;/);
  assert.match(row, /transform: translateY\(calc\(var\(--drag-y, 0px\) \+ var\(--drag-shift, 0px\)\)\);/);
  assert.match(row, /transform 170ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
});

test('the dragged row floats without a transform transition', () => {
  const css = readRendererFile('styles.css');
  const dragging = cssRule(css, '.settings-panel .limit-provider-row.dragging');
  assert.match(dragging, /z-index: 2;/);
  assert.match(dragging, /cursor: grabbing;/);
  assert.doesNotMatch(dragging, /transform \d/);
});

test('the reordering list dims its other rows and freezes the accordion', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /\.limit-provider-list\.drag-active \.limit-provider-row:not\(\.dragging\) \{ opacity: 0\.78; \}/);
  assert.match(css, /\.limit-provider-list\.is-reordering \.accordion-animated-container \{ transition: none; \}/);
});

test('the limit provider row no longer shares the handle drag highlight', () => {
  const css = readRendererFile('styles.css');
  assert.doesNotMatch(css, /\.settings-panel \.limit-provider-row\.is-dragging/);
  // The other five lists keep it.
  assert.match(css, /\.tool-preference-row\.is-dragging/);
  assert.match(css, /\.view-preference-row\.is-dragging/);
  assert.match(css, /\.home-module-preference-row\.is-dragging/);
  assert.match(css, /\.home-limit-provider-row\.is-dragging/);
});

test('reduced motion drops the limit provider row transition', () => {
  const css = readRendererFile('styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tray-composer-item \{ transition: none; \}\s*\.settings-panel \.limit-provider-row \{ transition: none; \}\s*\}/);
});

// The grab handle was the only hint that the rows could be reordered, so
// removing it leaves the list with no affordance unless the note says so.
test('the limits section tells the user rows can be dragged', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<p class="settings-note" data-i18n="settings\.limits\.reorderNote">[\s\S]*?<\/p>\s*<div id="limitProviderCheckboxes"/);
  const i18n = readRendererFile('i18n.js');
  assert.equal((i18n.match(/'settings\.limits\.reorderNote':/g) || []).length, 5, 'one entry per bundled locale');
});

test('the renderer loads the vertical drag module', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<script src="verticalDragSort\.js"><\/script>/);
  const app = readRendererFile('app.js');
  assert.match(app, /const verticalDragSortApi = window\.TokenMonitorVerticalDragSort;/);
});

test('limit provider rows drag from the row itself, not a handle', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function renderLimitProviderCheckboxes()');
  const end = app.indexOf('function setLimitProviderSettingsExpanded(');
  assert.ok(start !== -1 && end > start, 'renderLimitProviderCheckboxes should precede the helper');
  const body = app.slice(start, end);
  assert.doesNotMatch(body, /createPreferenceOrderHandle/);
  assert.match(body, /row\.addEventListener\('pointerdown', \(event\) => startLimitProviderRowDrag\(event, id\)\);/);
  // The keyboard reorder entry point moves onto the checkbox, keys unchanged.
  assert.match(body, /cb\.setAttribute\('aria-keyshortcuts', 'ArrowUp ArrowDown Home End'\);/);
  assert.match(body, /cb\.addEventListener\('keydown', \(event\) => onPreferenceOrderKeydown\(event, 'provider', id\)\);/);
});

test('the other five preference lists keep the drag handle', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function createPreferenceOrderHandle\(\{ kind, id, label, count \}\)/);
  const handleCalls = app.match(/createPreferenceOrderHandle\(\{/g) || [];
  assert.equal(handleCalls.length, 6, 'one definition plus five remaining call sites');
});

test('a stats repaint mid-drag is deferred instead of replacing the rows', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /if \(limitProviderDrag\) \{\s*limitProviderDrag\.renderPending = true;\s*return;\s*\}/);
});

test('the drag suppresses the click that would otherwise toggle the checkbox', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function suppressNextLimitProviderClick\(\)/);
  assert.match(app, /window\.addEventListener\('click', swallow, true\);/);
});
