'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('period tabs use one sliding selection indicator', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const app = read('app.js');

  assert.match(html, /<nav class="tabs"[\s\S]*?<span class="tab-indicator" aria-hidden="true"><\/span>[\s\S]*?data-period="today"[\s\S]*?data-period="month"[\s\S]*?data-period="allTime"/);
  assert.match(css, /\.tab-indicator\s*\{[^}]*transform:\s*translate3d\(calc\(var\(--period-index\)/s);
  assert.match(css, /\.tab-indicator\s*\{[^}]*transition:\s*transform 220ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/s);
  assert.match(app, /style\.setProperty\('--period-index', String\(activeIndex\)\)/);
  assert.match(app, /tab\.setAttribute\('aria-pressed', String\(active\)\)/);
});

test('data bars animate on the compositor instead of changing layout width', () => {
  const css = read('styles.css');
  const app = read('app.js');
  const applyBarScale = app.slice(
    app.indexOf('function applyBarScale('),
    app.indexOf('function rowWidth(', app.indexOf('function applyBarScale('))
  );

  assert.match(css, /\.bar-fill\s*\{[^}]*transform:\s*scaleX\(var\(--bar-scale, 0\)\)/s);
  assert.match(css, /\.limit-meter-fill\s*\{[^}]*transform:\s*scaleX\(var\(--bar-scale, 0\)\)/s);
  assert.doesNotMatch(css, /(?:\.bar-fill|\.limit-meter-fill)\s*\{[^}]*transition:\s*width/s);
  assert.match(app, /applyBarScale\(fill, width \/ 100\)/);
  // The limit meter moved to the shared Limits view with the rest of the rows.
  assert.match(read('limits/windowsView.js'), /applyBarScale\(fill, safePercent \/ 100\)/);
  assert.match(app, /state\.animateBarsFromZero[\s\S]*?animateBarBetween\(fill, 0, safeScale, 0, 420\)/s);
  assert.match(applyBarScale, /animateBarBetween\(fill, 0, safeScale, 0, 420\)/);
});

test('cached Limits bars replay their entrance motion when the view is revisited', () => {
  const app = read('app.js');
  const animateCachedLimitBarsFromZero = app.slice(
    app.indexOf('function animateCachedLimitBarsFromZero('),
    app.indexOf('function rowWidth(', app.indexOf('function animateCachedLimitBarsFromZero('))
  );
  const renderLimits = app.slice(
    app.indexOf('function renderLimits('),
    app.indexOf('function serviceStatusLabel(', app.indexOf('function renderLimits('))
  );

  assert.match(animateCachedLimitBarsFromZero, /if \(!state\.animateBarsFromZero \|\| prefersReducedMotion\(\)\) return;/);
  assert.match(animateCachedLimitBarsFromZero, /querySelectorAll\('\.limit-meter-fill'\)/);
  assert.match(animateCachedLimitBarsFromZero, /fill\.style\.getPropertyValue\('--bar-scale'\)/);
  assert.match(animateCachedLimitBarsFromZero, /animateBarBetween\(fill, 0, targetScale, 0, 420\)/);
  assert.match(
    renderLimits,
    /state\.limitPanelRenderSignature === renderSignature[\s\S]*?animateCachedLimitBarsFromZero\(\);\s*return;/
  );
});

test('period changes preserve row identity, animate rank changes, and count from the previous total', () => {
  const app = read('app.js');
  const handler = app.slice(
    app.indexOf("for (const tab of document.querySelectorAll('.tab'))"),
    app.indexOf("els.breakdown.addEventListener('click'", app.indexOf("for (const tab of document.querySelectorAll('.tab'))"))
  );

  assert.match(handler, /const snapshot = captureBreakdownMotion\(\)/);
  assert.match(handler, /animateBreakdownFrom\(snapshot, \{ duration: 800 \}\)/);
  assert.doesNotMatch(handler, /state\.currentTotal = 0/);
  assert.match(app, /barScale: trackWidth > 0 \? Math\.max\(0, Math\.min\(1, fillWidth \/ trackWidth\)\) : 0/);
  assert.match(app, /previous\.top - row\.getBoundingClientRect\(\)\.top/);
  assert.match(app, /animateBarBetween\(fill, previous\.barScale, targetScale, 0, duration\)/);
  assert.match(app, /animateBarBetween\(fill, 0, targetScale, delay, Math\.max\(1, duration - delay\)\)/);
  assert.match(app, /function animateRowNumber\(el, from, to, duration = 420\)/);
  assert.match(app, /animateRowNumber\(row\.querySelector\('\.row-value'\), previous\.value, value, duration\)/);
  assert.match(app, /value: Number\(row\.querySelector\('\.row-value'\)\?\.dataset\.motionValue/);
});

test('live row updates count and resize bars together without slowing the headline', () => {
  const app = read('app.js');
  const renderRows = app.slice(app.indexOf('function renderRows('), app.indexOf('function deviceLabel('));

  assert.match(renderRows, /const rowsChanged =[\s\S]*?const liveMotionSnapshot = rowsChanged && !state\.periodMotionActive && !state\.animateBarsFromZero[\s\S]*?captureBreakdownMotion\(\)/);
  assert.ok(renderRows.indexOf('captureBreakdownMotion()') < renderRows.indexOf('if (structureChanged)'));
  assert.match(app, /if \(liveMotionSnapshot\) animateBreakdownFrom\(liveMotionSnapshot, \{ duration: 600 \}\)/);
  assert.match(app, /const animationFrom = numberAnimHandle \? numberAnimValue : state\.currentTotal/);
  assert.match(app, /animateTotalNumber\(els\.totalTokens, animationFrom, nextTotal, state\.periodMotionActive \? 800 : 1000\)/);
  assert.match(app, /animateRowNumber\(row\.querySelector\('\.row-value'\), 0, value, duration\)/);
});

test('unrelated rerenders do not truncate an in-flight headline count', () => {
  const app = read('app.js');
  const renderTotal = app.slice(
    app.indexOf('const totalChanged = nextTotal !== state.currentTotal'),
    app.indexOf('state.currentTotal = nextTotal', app.indexOf('const totalChanged = nextTotal !== state.currentTotal'))
  );

  assert.match(app, /let numberAnimTarget = null;\s*let numberAnimValue = 0;/);
  assert.match(app, /function headlineNumberIsAnimatingTo\(value\) \{\s*return Boolean\(numberAnimHandle\) && numberAnimTarget === value;\s*\}/);
  assert.match(app, /numberAnimTarget = to;\s*numberAnimValue = from;/);
  assert.match(app, /numberAnimValue = from \+ delta \* easeOutQuart\(progress\)/);
  assert.match(renderTotal, /else if \(!headlineNumberIsAnimatingTo\(nextTotal\)\) \{\s*cancelNumberAnimation\(\)/);
  assert.doesNotMatch(renderTotal, /else \{\s*cancelNumberAnimation\(\)/);
});

test('row motion preserves matching targets and continues changed targets from the visual state', () => {
  const app = read('app.js');
  const animateRowNumber = app.slice(
    app.indexOf('function animateRowNumber('),
    app.indexOf('function animateBreakdownFrom(', app.indexOf('function animateRowNumber('))
  );
  const animateBarBetween = app.slice(
    app.indexOf('function animateBarBetween('),
    app.indexOf('function captureTrendBarMotion(', app.indexOf('function animateBarBetween('))
  );

  assert.match(app, /const rowNumberAnimations = new Map\(\);\s*const rowBarAnimations = new Map\(\);/);
  assert.match(animateRowNumber, /if \(previous\?\.target === to\) return;/);
  assert.match(animateRowNumber, /const startValue = Number\.isFinite\(previous\?\.value\) \? previous\.value : from;/);
  assert.match(animateRowNumber, /const motion = \{ handle: 0, target: to, value: startValue \}/);
  assert.match(animateBarBetween, /const previousIsActive = previous\?\.animation\.pending \|\| previous\?\.animation\.playState === 'running';/);
  assert.match(animateBarBetween, /if \(previousIsActive && Math\.abs\(previous\.target - toScale\) < 0\.001\) return;/);
  assert.ok(
    animateBarBetween.indexOf('for (const animation of fill.getAnimations()) animation.cancel()')
      < animateBarBetween.indexOf('if (Math.abs(toScale - fromScale) < 0.001) return'),
    'a stale bar tween must be cancelled even when the new target already matches the visual scale'
  );
  assert.match(animateBarBetween, /animation\.onfinish = forget;\s*animation\.oncancel = forget;\s*rowBarAnimations\.set\(fill, motion\);/);
});

test('view changes render immediately without a page crossfade', () => {
  const css = read('styles.css');
  const app = read('app.js');

  assert.doesNotMatch(app, /startViewTransition|renderViewChange|animateFallbackViewPanel/);
  assert.doesNotMatch(css, /view-transition-name|::view-transition|motion-view-(?:in|out)/);
  assert.match(app, /function renderBreakdownChange\(breakdown, options = \{\}\)/);
  assert.match(app, /state\.animateBarsFromZero = true;[\s\S]*?let renderSucceeded = false;[\s\S]*?render\(\);[\s\S]*?renderSucceeded = true;[\s\S]*?state\.animateBarsFromZero = false;[\s\S]*?if \(!renderSucceeded\) state\.animateChartsOnRender = false;/);
  assert.match(app, /else renderBreakdownChange\(id\)/);
  assert.match(app, /renderBreakdownChange\(viewId, \{ fromHome: true \}\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bar-fill,[\s\S]*?\.tab-indicator[\s\S]*?transition:\s*none/s);
});

test('headline counting respects reduced-motion preferences', () => {
  const app = read('app.js');
  const animateNumber = app.slice(
    app.indexOf('function animateNumber('),
    app.indexOf('const rowNumberAnimations', app.indexOf('function animateNumber('))
  );

  assert.match(animateNumber, /if \(prefersReducedMotion\(\)\) \{[\s\S]*?el\.textContent = formatNumber\(to\);[\s\S]*?onDone\(\);[\s\S]*?return;/);
});

test('Trends bars grow from the baseline and preserve matching period heights', () => {
  const app = read('app.js');
  const css = read('styles.css');

  assert.match(app, /function captureTrendBarMotion\(\)[\s\S]*?\.spark-bar\[data-motion-key\][\s\S]*?getBoundingClientRect\(\)\.height/);
  assert.match(app, /bar\.dataset\.motionKey = String\(finalPoints\[index\]\?\.\[labelKey\] \|\| index\)/);
  assert.match(app, /const fromScale = fromZero \|\| !previous[\s\S]*?previous\.height \/ targetHeight/);
  assert.match(app, /transform: `scaleY\(\$\{fromScale\}\)`[\s\S]*?transform: 'scaleY\(1\)'[\s\S]*?duration: 420/);
  assert.match(css, /\.trends-spark \.spark-bar\s*\{[^}]*transform-box:\s*fill-box;[^}]*transform-origin:\s*bottom center;/s);
});

test('Home history visuals reveal left to right only when entering the view', () => {
  const app = read('app.js');

  assert.match(app, /state\.animateChartsOnRender = true/);
  assert.match(app, /\.heat-base-layer \.heat/);
  assert.match(app, /const HOME_HISTORY_MOTION_MS = 920/);
  assert.match(app, /const HOME_HEATMAP_MOTION_MS = 640/);
  assert.match(app, /const HOME_HEAT_CELL_MOTION_MS = 240/);
  assert.match(app, /const viewport = activityScroll\?\.getBoundingClientRect\(\)/);
  assert.match(app, /rect\.right > viewport\.left && rect\.left < viewport\.right/);
  assert.match(app, /const firstVisibleColumn = visibleCells\.length \? visibleCells\[0\]\.column : 0/);
  assert.match(app, /const heatColumnDelay = \(HOME_HEATMAP_MOTION_MS - HOME_HEAT_CELL_MOTION_MS\) \/ Math\.max\(1, lastVisibleColumn - firstVisibleColumn\)/);
  assert.match(app, /delay: \(column - firstVisibleColumn\) \* heatColumnDelay/);
  assert.match(app, /duration: HOME_HEAT_CELL_MOTION_MS/);
  assert.match(app, /duration: HOME_HEAT_CELL_MOTION_MS,[\s\S]*?easing: 'cubic-bezier\(0\.22, 1, 0\.36, 1\)'/);
  assert.match(app, /TokenMonitorChartMotion\.reveal/);
  const homeHistoryMotion = app.slice(app.indexOf('function animateHomeHistoryVisuals('), app.indexOf('function applyBarScale('));
  assert.equal((homeHistoryMotion.match(/duration: HOME_HISTORY_MOTION_MS/g) || []).length, 1);
  assert.match(read('chartMotion.js'), /clipPath: 'inset\(0 100% 0 0\)'[\s\S]*?clipPath: 'inset\(0 0% 0 0\)'/);
  assert.match(app, /if \(prefersReducedMotion\(\)\) return/);
  assert.match(app, /new ResizeObserver\(applySettledLayout\)/);
  assert.match(
    app,
    /setupHomeActivityScroller\(activityScroll,\s*\(\)\s*=>\s*\{[\s\S]*?animateHomeHistoryVisuals\(activityScroll, activityCanvas, chart\)[\s\S]*?\}\)/
  );
});

function headlineResizeHarness() {
  const app = read('app.js');
  const animationStart = app.indexOf('function easeOutQuart(');
  const animationEnd = app.indexOf('const rowNumberAnimations', animationStart);
  const resizeStart = app.indexOf('let resizeLayoutFrame = 0;');
  const resizeEnd = app.indexOf("els.swapSettingsRefreshInput.addEventListener", resizeStart);
  assert.ok(animationStart >= 0 && animationEnd > animationStart);
  assert.ok(resizeStart >= 0 && resizeEnd > resizeStart);

  let nextFrame = 0;
  let onResize;
  const frames = new Map();
  const total = { textContent: '' };
  const calls = { fits: 0, compact: [], bubbleRefreshes: 0 };
  const context = {
    els: { totalTokens: total },
    state: { currentTotal: 111 },
    performance: { now: () => 0 },
    prefersReducedMotion: () => false,
    formatNumber: value => String(Math.round(value)),
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    window: {
      addEventListener(event, callback) {
        assert.equal(event, 'resize');
        onResize = callback;
      }
    },
    fitTotalNumber() { calls.fits += 1; },
    updateTotalCompact(value) {
      calls.compact.push(value);
      calls.fits += 1;
    },
    refreshFloatingBubbleBitmapForDeviceScale() { calls.bubbleRefreshes += 1; },
    settleMotionAnimations() { throw new Error('A resize must only settle the headline'); }
  };
  vm.runInNewContext(
    app.slice(animationStart, animationEnd) + app.slice(resizeStart, resizeEnd)
      + '\nthis.animateForTest = animateTotalNumber;'
      + '\nthis.readMotionForTest = () => ({ handle: numberAnimHandle, target: numberAnimTarget, value: numberAnimValue });',
    context
  );
  return {
    total, calls, frames, context,
    resize: () => onResize(),
    animate: (from, to) => context.animateForTest(total, from, to, 1000),
    flush(now = 100) {
      for (const id of [...frames.keys()]) {
        const callback = frames.get(id);
        if (!callback) continue;
        frames.delete(id);
        callback(now);
      }
    }
  };
}

test('resize events coalesce and wait for the viewport font to settle', () => {
  const harness = headlineResizeHarness();
  for (let i = 0; i < 8; i += 1) harness.resize();
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.calls.fits, 0);
  harness.flush();
  assert.equal(harness.calls.fits, 0, 'the first frame leaves viewport units time to settle');
  assert.equal(harness.frames.size, 1);
  harness.resize();
  harness.flush();
  assert.equal(harness.calls.fits, 1);
  assert.equal(harness.calls.bubbleRefreshes, 1);
  assert.equal(harness.frames.size, 0);
  assert.deepEqual(harness.calls.compact, []);

  harness.resize();
  harness.flush(200);
  assert.equal(harness.calls.fits, 1);
  harness.flush(216);
  assert.equal(harness.calls.fits, 2);
  assert.equal(harness.calls.bubbleRefreshes, 2);
});

test('a resize settles and fits the active headline before another count frame can clip it', () => {
  const harness = headlineResizeHarness();
  harness.animate(100, 2000);
  harness.resize();
  harness.resize();
  harness.flush();
  assert.equal(harness.calls.fits, 0);
  harness.flush();

  assert.equal(harness.total.textContent, '2000');
  assert.deepEqual(harness.calls.compact, [2000]);
  assert.equal(harness.calls.fits, 1);
  assert.equal(harness.calls.bubbleRefreshes, 1);
  assert.deepEqual({ ...harness.context.readMotionForTest() }, { handle: 0, target: null, value: 2000 });
  assert.equal(harness.frames.size, 0);
  harness.flush(500);
  assert.equal(harness.total.textContent, '2000');
  assert.equal(harness.calls.fits, 1);
});

test('a target arriving before the resize frame wins over the previous headline target', () => {
  const harness = headlineResizeHarness();
  harness.animate(100, 2000);
  harness.resize();
  harness.animate(150, 3000);
  harness.flush();
  assert.equal(harness.calls.fits, 0);
  harness.flush();

  assert.equal(harness.total.textContent, '3000');
  assert.deepEqual(harness.calls.compact, [3000]);
  assert.equal(harness.calls.fits, 1);
  assert.equal(harness.frames.size, 0);
  assert.deepEqual({ ...harness.context.readMotionForTest() }, { handle: 0, target: null, value: 3000 });
});
