'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const verticalDragSort = require('../../src/electron/renderer/verticalDragSort.js');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`).exec(source);
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

// The controller is loaded through a fake `window` rather than `require`, so the
// same UMD path the renderer uses is what these tests exercise.
function loadController(context) {
  vm.runInNewContext(readRendererFile('rowDragController.js'), context);
  return context.window.TokenMonitorRowDragController;
}

// A three-row list in a 500px panel anchored at viewport top, so a client Y and
// the controller's content-space Y are the same number.
function createDragHarness(config = {}) {
  const listeners = new Map();
  const frames = [];
  const timers = [];
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    }
  };
  const api = loadController({
    window,
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: () => {},
    setTimeout: (callback) => timers.push(callback)
  });

  const makeRow = (id, top) => ({
    dataset: { provider: id },
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top, height: 40, bottom: top + 40 }),
    contains: () => true,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {}
  });
  const rows = [makeRow('a', 0), makeRow('b', 40), makeRow('c', 80)];
  const panel = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
  const list = { classList: { add() {}, remove() {} }, querySelectorAll: () => rows };

  const controller = api.createRowDragController({
    dragSort: verticalDragSort,
    getList: () => list,
    getScrollPanel: () => panel,
    rowSelector: '.row',
    idKey: 'provider',
    dragExcluded: '.excluded',
    ...config
  });

  return {
    controller,
    frames,
    timers,
    press: (clientY) => controller.startRowDrag({
      button: 0,
      pointerId: 1,
      clientY,
      currentTarget: rows[0],
      target: { closest: () => null }
    }, 'a'),
    dispatch: (type, clientY) => {
      const event = { pointerId: 1, clientY, preventDefault() {} };
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    }
  };
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

test('the renderer loads the drag modules', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<script src="verticalDragSort\.js"><\/script>/);
  // The controller consumes the geometry module, so it must load after it.
  assert.ok(
    html.indexOf('<script src="verticalDragSort.js">') < html.indexOf('<script src="rowDragController.js">'),
    'rowDragController.js should load after verticalDragSort.js'
  );
  const app = readRendererFile('app.js');
  assert.match(app, /const verticalDragSortApi = window\.TokenMonitorVerticalDragSort;/);
  assert.match(app, /const rowDragControllerApi = window\.TokenMonitorRowDragController;/);
});

test('limit provider rows drag from the row itself, not a handle', () => {
  const app = readRendererFile('app.js');
  const start = app.indexOf('function renderLimitProviderCheckboxes()');
  const end = app.indexOf('function setLimitProviderSettingsExpanded(');
  assert.ok(start !== -1 && end > start, 'renderLimitProviderCheckboxes should precede the helper');
  const body = app.slice(start, end);
  assert.doesNotMatch(body, /createPreferenceOrderHandle/);
  assert.match(body, /row\.addEventListener\('pointerdown', \(event\) => limitProviderRowDrag\.startRowDrag\(event, id\)\);/);
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
  assert.match(app, /if \(limitProviderRowDrag\.deferRender\(\)\) return;/);
  const controller = readRendererFile('rowDragController.js');
  assert.match(controller, /function deferRender\(\) \{\s*if \(!drag\) return false;\s*drag\.renderPending = true;\s*return true;\s*\}/);
});

// A repaint held back during the drag is flushed on drop, and it sorts from
// state.settings — which the deferred save has not written yet.
test('the drop mirrors the new order locally before anything can repaint', () => {
  const controller = readRendererFile('rowDragController.js');
  const start = controller.indexOf('function onPointerUp(');
  const end = controller.indexOf('function onDragAbort(', start);
  assert.ok(start !== -1 && end > start);
  const body = controller.slice(start, end);
  const mirror = body.indexOf('mirrorOrder(value)');
  const finish = body.indexOf('finishRowDrag(true);', mirror);
  const persist = body.indexOf('persistOrder(value)', finish);
  assert.ok(mirror !== -1, 'the new order should be mirrored before the drag finishes');
  assert.ok(finish > mirror, 'the mirror must land before the drag is finished and repaints flush');
  assert.ok(persist > finish, 'persisting happens after the landed row has painted');

  // The limits list mirrors into state.settings and saves directly:
  // onPreferenceOrderCommit compares against the value just mirrored, so it
  // would treat the write as a no-op.
  const app = readRendererFile('app.js');
  const wiring = app.slice(app.indexOf('const limitProviderRowDrag = '), app.indexOf('function renderViewPreferences('));
  assert.match(wiring, /mirrorOrder: \(value\) => \{ state\.settings = \{ \.\.\.state\.settings, limitProviderOrder: value \}; \}/);
  assert.match(wiring, /persistOrder: \(value\) => void saveSettings\(\{ limitProviderOrder: value \}\)/);
  assert.doesNotMatch(wiring, /onPreferenceOrderCommit\(/);
});

// Below the 4px threshold a press is a click; above it the drag swallows the
// click. Arming from the row's own controls made that coin-flip decide whether
// the checkbox and the disclosure worked at all.
test('a press on the row own controls never arms a drag', () => {
  const app = readRendererFile('app.js');
  assert.match(app, /const LIMIT_PROVIDER_DRAG_EXCLUDED = 'button:not\(\.limit-provider-main\), input, select, textarea, a, \.accordion-animated-container';/);
  assert.match(app, /dragExcluded: LIMIT_PROVIDER_DRAG_EXCLUDED,/);
  const controller = readRendererFile('rowDragController.js');
  const start = controller.indexOf('function startRowDrag(');
  const body = controller.slice(start, controller.indexOf('function beginRowDrag(', start));
  const guard = body.indexOf('dragExcluded');
  const arm = body.indexOf('drag = {');
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
  const controller = readRendererFile('rowDragController.js');
  const armStart = controller.indexOf('function startRowDrag(');
  const armBody = controller.slice(armStart, controller.indexOf('function beginRowDrag(', armStart));
  assert.doesNotMatch(armBody, /setPointerCapture|lostpointercapture/);

  const moveStart = controller.indexOf('function onPointerMove(');
  const moveBody = controller.slice(moveStart, controller.indexOf('function onPointerUp(', moveStart));
  const threshold = moveBody.indexOf('< threshold');
  const capture = moveBody.indexOf('setPointerCapture');
  const begin = moveBody.indexOf('beginRowDrag()');
  assert.ok(threshold !== -1 && capture > threshold, 'capture should wait until the drag threshold is crossed');
  assert.ok(begin > capture, 'capture should be active before the drag starts moving rows');
  assert.match(moveBody, /addEventListener\('lostpointercapture', onDragAbort\)/);
});

test('the drag releases pointer capture before the reorder', () => {
  const controller = readRendererFile('rowDragController.js');
  const start = controller.indexOf('function finishRowDrag(');
  const body = controller.slice(start, controller.indexOf('function suppressNextClick(', start));
  const release = body.indexOf('releasePointerCapture');
  const reorder = body.indexOf('applyOrder(current.order)');
  assert.ok(release !== -1 && reorder > release, 'capture is released before the node moves');
  assert.match(body, /removeEventListener\('lostpointercapture', onDragAbort\)/);
});

test('the drop preserves settings scroll across the DOM reorder and deferred repaint', () => {
  const controller = readRendererFile('rowDragController.js');
  const start = controller.indexOf('function finishRowDrag(');
  const body = controller.slice(start, controller.indexOf('function suppressNextClick(', start));
  const preserve = body.indexOf('preserveScroll(() => {');
  const reorder = body.indexOf('applyOrder(current.order)');
  const pendingRender = body.indexOf('if (renderPending) requestRender();');

  assert.ok(preserve !== -1, 'drop should snapshot the scroll position before landing');
  assert.ok(reorder > preserve, 'the DOM reorder should happen inside the scroll-preserved transaction');
  assert.ok(pendingRender > reorder, 'a deferred repaint should be covered by the same transaction');

  // The limits list supplies the settings panel guard.
  const app = readRendererFile('app.js');
  const wiring = app.slice(app.indexOf('const limitProviderRowDrag = '), app.indexOf('function renderViewPreferences('));
  assert.match(wiring, /preserveScroll: preserveSettingsPanelScroll,/);
  assert.match(wiring, /applyOrder: \(order\) => applyPreferenceOrder\('provider', order\),/);
  assert.match(wiring, /requestRender: \(\) => renderLimitProviderCheckboxes\(\)/);
});

test('a committed drop suppresses transform settling through the first landed paint', () => {
  const controller = readRendererFile('rowDragController.js');
  const css = readRendererFile('styles.css');
  const helperStart = controller.indexOf('function releaseLandingStyleAfterPaint(');
  const finishStart = controller.indexOf('function finishRowDrag(', helperStart);
  const helper = controller.slice(helperStart, finishStart);
  const finishBody = controller.slice(finishStart, controller.indexOf('function suppressNextClick(', finishStart));
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
    `${helper}\nreleaseLandingStyleAfterPaint(list);`,
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
  const reorder = finishBody.indexOf('applyOrder(current.order)');
  const clearShift = finishBody.indexOf("el.style.removeProperty('--drag-shift')");
  const release = finishBody.indexOf('releaseLandingStyleAfterPaint(list)');
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
  const controller = readRendererFile('rowDragController.js');
  assert.match(controller, /window\[method\]\('blur', onDragAbort\);/);
  assert.doesNotMatch(controller, /'blur', onDragAbort, true/);
});

test('the drag suppresses the click that would otherwise toggle provider details', () => {
  const controller = readRendererFile('rowDragController.js');
  assert.match(controller, /function suppressNextClick\(\)/);
  assert.match(controller, /window\.addEventListener\('click', swallow, true\);/);
});

// The gesture itself, driven end to end. The source-shape assertions above lock
// the ordering constraints; this one proves the extracted controller still
// reorders, and that a press under the threshold stays a click.
test('the controller reorders on a drag and stays a click under the threshold', () => {
  const applied = [];
  const mirrored = [];
  const persisted = [];
  const harness = createDragHarness({
    applyOrder: (order) => applied.push(order),
    mirrorOrder: (value) => mirrored.push(value),
    persistOrder: (value) => persisted.push(value)
  });

  // A 2px press stays under the 4px threshold: no drag, no write.
  harness.press(10);
  assert.equal(harness.controller.isDragging(), true, 'the press arms the gesture');
  harness.dispatch('pointermove', 12);
  harness.dispatch('pointerup', 12);
  assert.deepEqual(applied, []);
  assert.deepEqual(mirrored, []);
  assert.equal(harness.controller.isDragging(), false);

  // Dragging the first row past the last one commits the new order.
  harness.press(10);
  harness.dispatch('pointermove', 100);
  harness.dispatch('pointerup', 100);
  // Joined rather than compared as arrays: the order is built inside the vm
  // realm, so its Array prototype is not this realm's.
  assert.deepEqual(applied.map((order) => order.join(',')), ['b,c,a']);
  assert.deepEqual(mirrored, ['b,c,a']);
  // Persisting waits for the landed paint: one rAF, then one timeout.
  assert.deepEqual(persisted, []);
  harness.frames.at(-1)();
  harness.timers.at(-1)();
  assert.deepEqual(persisted, ['b,c,a']);
});

test('a repaint requested mid-drag is deferred and flushed once on drop', () => {
  const renders = [];
  const harness = createDragHarness({ requestRender: () => renders.push('render') });

  // Idle: the caller repaints normally.
  assert.equal(harness.controller.deferRender(), false);

  harness.press(10);
  harness.dispatch('pointermove', 100);
  assert.equal(harness.controller.deferRender(), true, 'a repaint mid-drag is held back');
  assert.equal(harness.controller.deferRender(), true);
  assert.deepEqual(renders, [], 'nothing repaints while the pointer is down');

  harness.dispatch('pointerup', 100);
  assert.deepEqual(renders, ['render'], 'the held repaint flushes exactly once on drop');
});
