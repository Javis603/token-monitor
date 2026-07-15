'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
  assert.match(app, /applyBarScale\(fill, safePercent \/ 100\)/);
  assert.match(app, /state\.animateBarsFromZero[\s\S]*?transform: 'scaleX\(0\)'[\s\S]*?duration: 420/s);
  assert.match(applyBarScale, /for \(const animation of fill\.getAnimations\(\)\) animation\.cancel\(\)/);
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

  assert.match(app, /const liveMotionSnapshot = !state\.periodMotionActive && !state\.animateBarsFromZero[\s\S]*?captureBreakdownMotion\(\)/);
  assert.match(app, /if \(liveMotionSnapshot\) animateBreakdownFrom\(liveMotionSnapshot, \{ duration: 600 \}\)/);
  assert.match(app, /animateNumber\(els\.totalTokens, state\.currentTotal, nextTotal, state\.periodMotionActive \? 800 : 1000, fitTotalNumber\)/);
  assert.match(app, /animateRowNumber\(row\.querySelector\('\.row-value'\), 0, value, duration\)/);
});

test('view changes render immediately without a page crossfade', () => {
  const css = read('styles.css');
  const app = read('app.js');

  assert.doesNotMatch(app, /startViewTransition|renderViewChange|animateFallbackViewPanel/);
  assert.doesNotMatch(css, /view-transition-name|::view-transition|motion-view-(?:in|out)/);
  assert.match(app, /function renderBreakdownChange\(breakdown, options = \{\}\)/);
  assert.match(app, /state\.animateBarsFromZero = true;[\s\S]*?let renderSucceeded = false;[\s\S]*?render\(\);[\s\S]*?renderSucceeded = true;[\s\S]*?state\.animateBarsFromZero = false;[\s\S]*?if \(!renderSucceeded\) state\.animateChartsOnRender = false;/);
  assert.match(app, /else renderBreakdownChange\(id\)/);
  assert.match(app, /renderBreakdownChange\(viewId\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bar-fill,[\s\S]*?\.tab-indicator[\s\S]*?transition:\s*none/s);
});

test('headline counting respects reduced-motion preferences', () => {
  const app = read('app.js');
  const animateNumber = app.slice(
    app.indexOf('function animateNumber('),
    app.indexOf('const rowNumberAnimationHandles', app.indexOf('function animateNumber('))
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
  assert.match(app, /const HOME_HEAT_CELL_MOTION_MS = 360/);
  assert.match(app, /const viewport = activityScroll\?\.getBoundingClientRect\(\)/);
  assert.match(app, /rect\.right > viewport\.left && rect\.left < viewport\.right/);
  assert.match(app, /const firstVisibleColumn = visibleCells\.length \? visibleCells\[0\]\.column : 0/);
  assert.match(app, /const heatColumnDelay = \(HOME_HISTORY_MOTION_MS - HOME_HEAT_CELL_MOTION_MS\) \/ Math\.max\(1, lastVisibleColumn - firstVisibleColumn\)/);
  assert.match(app, /delay: \(column - firstVisibleColumn\) \* heatColumnDelay/);
  assert.match(app, /duration: HOME_HEAT_CELL_MOTION_MS/);
  assert.match(app, /strokeDasharray: `\$\{length\} \$\{length\}`[\s\S]*?strokeDashoffset: length[\s\S]*?strokeDashoffset: 0/);
  assert.equal((app.match(/duration: HOME_HISTORY_MOTION_MS/g) || []).length, 2);
  assert.match(app, /clipPath: 'inset\(0 100% 0 0\)'[\s\S]*?clipPath: 'inset\(0 0 0 0\)'/);
  assert.match(app, /if \(prefersReducedMotion\(\)\) return/);
  assert.match(app, /new ResizeObserver\(applySettledLayout\)/);
  assert.match(app, /setupHomeActivityScroller\(activityScroll, \(\) => animateHomeHistoryVisuals\(activityScroll, activityCanvas, chart\)\)/);
});
