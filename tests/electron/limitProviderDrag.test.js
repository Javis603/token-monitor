'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  // Account rows notify their original live toggle; automatic/provider-only
  // panels use the same outer helper directly.
  assert.match(app, /const toggleOptions = \(\) => \{[\s\S]*?accountToggle\.click\(\);[\s\S]*?setLimitProviderSettingsExpanded\(/);
  assert.match(app, /main\.addEventListener\('click', toggleOptions\)/);
  assert.match(app, /function syncLimitProviderAccountExpansion\(providerId, expanded\)/);
});

test('the limit provider row carries the drag transform contract', () => {
  const css = readRendererFile('styles.css');
  const row = cssRule(css, '.settings-panel .limit-provider-row');
  assert.match(row, /position: relative;/);
  // The base row never advertises a grab interaction; expandable rows get a
  // separate pointer affordance and only an active drag uses grabbing.
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

// A repaint held back during the drag is flushed on drop, and it sorts from
// state.settings — which the deferred save has not written yet.
test('the drop mirrors the new order locally before anything can repaint', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function onLimitProviderPointerUp(');
  const end = app.indexOf('function onLimitProviderDragAbort(', start);
  assert.ok(start !== -1 && end > start);
  const body = app.slice(start, end);
  const mirror = body.indexOf('state.settings = { ...state.settings, limitProviderOrder: value }');
  const finish = body.indexOf('finishLimitProviderDrag(true);', mirror);
  assert.ok(mirror !== -1, 'the new order should be mirrored into state.settings');
  assert.ok(finish > mirror, 'the mirror must land before the drag is finished and repaints flush');
  // onPreferenceOrderCommit compares against the value just mirrored, so it
  // would treat the write as a no-op.
  assert.match(body, /saveSettings\(\{ limitProviderOrder: value \}\)/);
  assert.doesNotMatch(body, /onPreferenceOrderCommit\(/);
});

// Below the 4px threshold a press is a click; above it the drag swallows the
// click. Arming from the row's own controls made that coin-flip decide whether
// the checkbox and the disclosure worked at all.
test('a press on the row own controls never arms a drag', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /const LIMIT_PROVIDER_DRAG_EXCLUDED = 'button:not\(\.limit-provider-main\), input, select, textarea, a, \.accordion-animated-container';/);
  const start = app.indexOf('function startLimitProviderRowDrag(');
  const body = app.slice(start, app.indexOf('function setLimitProviderDragListeners(', start));
  const guard = body.indexOf('LIMIT_PROVIDER_DRAG_EXCLUDED');
  const arm = body.indexOf('limitProviderDrag = {');
  assert.ok(guard !== -1 && arm > guard, 'the guard must run before the drag state is built');
  // `closest` walks past the row, and setupSettingsSections makes the whole
  // section an `.accordion-animated-container` — the same class the per-row
  // options panel uses. Unscoped, the guard matches every row and kills the
  // drag entirely.
  assert.match(body, /rowEl\.contains\(excluded\)/);
});

test('the provider main row is one accessible disclosure beside the checkbox', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const start = app.indexOf('function renderLimitProviderCheckboxes(');
  const end = app.indexOf('function limitProviderAccountGroup(', start);
  assert.ok(start !== -1 && end > start);
  const body = app.slice(start, end);

  assert.match(body, /main = document\.createElement\('button'\)/);
  assert.match(body, /main\.className = 'limit-provider-main'/);
  assert.match(body, /main\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(body, /main\.setAttribute\('aria-controls', optionsContainer\.id\)/);
  assert.match(body, /const toggleOptions = \(\) => \{/);
  assert.match(body, /main\.addEventListener\('click', toggleOptions\)/);
  assert.doesNotMatch(body, /limit-provider-disclosure|row\.addEventListener\('click'/);
  assert.match(css, /\.limit-provider-main\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.settings-panel \.limit-provider-row > \.accordion-animated-container\s*\{[^}]*cursor:\s*default/);
});

test('pointer capture starts only after the row crosses the drag threshold', () => {
  const app = readRendererFile('app.js');
  const armStart = app.indexOf('function startLimitProviderRowDrag(');
  const armBody = app.slice(armStart, app.indexOf('function setLimitProviderDragListeners(', armStart));
  assert.doesNotMatch(armBody, /setPointerCapture|lostpointercapture/);

  const moveStart = app.indexOf('function onLimitProviderPointerMove(');
  const moveBody = app.slice(moveStart, app.indexOf('function onLimitProviderPointerUp(', moveStart));
  const threshold = moveBody.indexOf('LIMIT_PROVIDER_DRAG_THRESHOLD');
  const capture = moveBody.indexOf('setPointerCapture');
  const begin = moveBody.indexOf('beginLimitProviderDrag()');
  assert.ok(threshold !== -1 && capture > threshold, 'capture should wait until the drag threshold is crossed');
  assert.ok(begin > capture, 'capture should be active before the drag starts moving rows');
  assert.match(moveBody, /addEventListener\('lostpointercapture', onLimitProviderDragAbort\)/);
});

test('the drag releases pointer capture before the reorder', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function finishLimitProviderDrag(');
  const body = app.slice(start, app.indexOf('function suppressNextLimitProviderClick(', start));
  const release = body.indexOf('releasePointerCapture');
  const reorder = body.indexOf("applyPreferenceOrder('provider'");
  assert.ok(release !== -1 && reorder > release, 'capture is released before the node moves');
  assert.match(body, /removeEventListener\('lostpointercapture', onLimitProviderDragAbort\)/);
});

test('the drop preserves settings scroll across the DOM reorder and deferred repaint', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function finishLimitProviderDrag(');
  const body = app.slice(start, app.indexOf('function suppressNextLimitProviderClick(', start));
  const preserve = body.indexOf('preserveSettingsPanelScroll(() => {');
  const reorder = body.indexOf("applyPreferenceOrder('provider'");
  const pendingRender = body.indexOf('if (renderPending) renderLimitProviderCheckboxes();');

  assert.ok(preserve !== -1, 'drop should snapshot the scroll position before landing');
  assert.ok(reorder > preserve, 'the DOM reorder should happen inside the scroll-preserved transaction');
  assert.ok(pendingRender > reorder, 'a deferred repaint should be covered by the same transaction');
});

test('a committed drop suppresses transform settling through the first landed paint', () => {
  const app = readRendererFile('app.js');
  const css = readRendererFile('styles.css');
  const helperStart = app.indexOf('function releaseLimitProviderLandingStyleAfterPaint(');
  const finishStart = app.indexOf('function finishLimitProviderDrag(', helperStart);
  const helper = app.slice(helperStart, finishStart);
  const finishBody = app.slice(finishStart, app.indexOf('function suppressNextLimitProviderClick(', finishStart));
  const landingRule = cssRule(css, '.settings-panel .limit-provider-list.is-landing .limit-provider-row');
  const frames = [];
  const timers = [];
  const removed = [];
  const list = {
    classList: {
      remove(value) { removed.push(value); }
    }
  };

  vm.runInNewContext(
    `${helper}\nreleaseLimitProviderLandingStyleAfterPaint(list);`,
    {
      list,
      requestAnimationFrame: (callback) => frames.push(callback),
      setTimeout: (callback) => timers.push(callback)
    }
  );

  assert.deepEqual(removed, []);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(removed, []);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(removed, ['is-landing']);

  const suppress = finishBody.indexOf("list?.classList.add('is-landing')");
  const reorder = finishBody.indexOf("applyPreferenceOrder('provider'");
  const clearShift = finishBody.indexOf("el.style.removeProperty('--drag-shift')");
  const release = finishBody.indexOf('releaseLimitProviderLandingStyleAfterPaint(list)');
  assert.ok(suppress !== -1 && reorder > suppress, 'transition suppression should precede the DOM reorder');
  assert.ok(clearShift > reorder, 'drag offsets should clear only after the final order is in the DOM');
  assert.ok(release > clearShift, 'transition suppression should survive until the landing is complete');
  assert.doesNotMatch(landingRule, /transform/);
});

// `blur` does not bubble, so a capture listener on `window` is the standard way
// to observe every element's blur — which is exactly wrong here. The press moves
// focus off whatever was clicked last, and that blur cancelled the drag before
// it began: the first drag after opening settings or collapsing the section
// always failed, then every later one worked because focus sat on the body.
test('only the window own blur aborts the drag', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /window\[method\]\('blur', onLimitProviderDragAbort\);/);
  assert.doesNotMatch(app, /'blur', onLimitProviderDragAbort, true/);
});

test('the drag suppresses the click that would otherwise toggle provider details', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /function suppressNextLimitProviderClick\(\)/);
  assert.match(app, /window\.addEventListener\('click', swallow, true\);/);
});
