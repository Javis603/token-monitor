'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  WIDGET_SIZE_LIMITS,
  normalizeWidgetDimensions,
  resizeWidgetBounds
} = require('../../src/electron/windowState');

const workArea = { x: 0, y: 24, width: 1440, height: 876 };

test('normalizeWidgetDimensions rounds and clamps explicit widget dimensions', () => {
  assert.deepEqual(normalizeWidgetDimensions({ width: 600, height: 80 }), { width: 600, height: 80 });
  // Fractional input is rounded to whole pixels.
  assert.deepEqual(normalizeWidgetDimensions({ width: 600.4, height: 80.7 }), { width: 600, height: 81 });
  // The compact horizontal bar from issue #873 may be shorter than the generic
  // minimum window height, so 56px must survive normalization.
  assert.deepEqual(normalizeWidgetDimensions({ width: 457, height: 56 }), { width: 457, height: 56 });
  // Below the floors clamps up; above the ceilings clamps down.
  assert.deepEqual(normalizeWidgetDimensions({ width: 10, height: 10 }), {
    width: WIDGET_SIZE_LIMITS.minWidth,
    height: WIDGET_SIZE_LIMITS.minHeight
  });
  assert.deepEqual(normalizeWidgetDimensions({ width: 99999, height: 99999 }), {
    width: WIDGET_SIZE_LIMITS.maxWidth,
    height: WIDGET_SIZE_LIMITS.maxHeight
  });
});

test('normalizeWidgetDimensions rejects missing or non-finite dimensions', () => {
  assert.equal(normalizeWidgetDimensions(null), null);
  assert.equal(normalizeWidgetDimensions({}), null);
  assert.equal(normalizeWidgetDimensions({ width: 600, height: 'wide' }), null);
  assert.equal(normalizeWidgetDimensions({ width: 0, height: 80 }), null);
  assert.equal(normalizeWidgetDimensions({ width: -10, height: 80 }), null);
  assert.equal(normalizeWidgetDimensions({ width: NaN, height: 80 }), null);
});

test('resizeWidgetBounds keeps the top-left anchor for in-work-area sizes', () => {
  const current = { x: 100, y: 100, width: 340, height: 650 };
  assert.deepEqual(resizeWidgetBounds(current, { width: 800, height: 100 }, workArea), {
    x: 100,
    y: 100,
    width: 800,
    height: 100
  });
});

test('resizeWidgetBounds pulls a grown widget back inside the work area', () => {
  // Anchored near the right/bottom edge: growing must not overflow the screen.
  const nearRight = { x: 1300, y: 800, width: 140, height: 90 };
  const resized = resizeWidgetBounds(nearRight, { width: 600, height: 80 }, workArea);
  assert.equal(resized.width, 600);
  assert.equal(resized.height, 80);
  assert.ok(resized.x >= workArea.x);
  assert.ok(resized.y >= workArea.y);
  assert.ok(resized.x + resized.width <= workArea.x + workArea.width);
  assert.ok(resized.y + resized.height <= workArea.y + workArea.height);
});

test('resizeWidgetBounds fits oversized requests to the work area', () => {
  // The global ceilings (1600×1400) can exceed a display's work area; the
  // window must never end up bigger than the screen it is anchored inside.
  const current = { x: 100, y: 100, width: 340, height: 650 };
  const resized = resizeWidgetBounds(current, { width: 1600, height: 1400 }, workArea);
  assert.deepEqual(resized, {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height
  });
});

test('resizeWidgetBounds returns null for invalid input', () => {
  assert.equal(resizeWidgetBounds(null, { width: 600, height: 80 }, workArea), null);
  assert.equal(resizeWidgetBounds({ x: 0, y: 0, width: 340, height: 650 }, { width: 0, height: 0 }, workArea), null);
  assert.equal(resizeWidgetBounds({ x: 0, y: 0, width: 340, height: 650 }, { width: 600, height: 80 }, null), null);
});

test('widget size Settings surface, preload bridge and IPC handler are wired', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const indexPath = path.join(rendererDir, 'index.html');
  const stylesPath = path.join(rendererDir, 'styles.css');
  const preloadPath = path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js');
  const mainPath = path.join(__dirname, '..', '..', 'src', 'electron', 'main.js');
  const html = fs.readFileSync(indexPath, 'utf8');
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const main = fs.readFileSync(mainPath, 'utf8');
  assert.match(html, /type="number" id="widgetWidthInput"/);
  assert.match(html, /type="number" id="widgetHeightInput"/);
  assert.match(html, /id="widgetSizeResetButton"/);
  assert.match(preload, /setWidgetSize:\s*\(size\)\s*=>\s*ipcRenderer\.invoke\('window:setSize',\s*size\)/);
  assert.match(main, /ipcMain\.handle\('window:setSize'/);
  // The BrowserWindow constraints must share the same floors/ceilings, or a
  // saved short widget would be silently re-clamped on relaunch.
  assert.match(main, /const WINDOW_LIMITS = WIDGET_SIZE_LIMITS/);
  // Horizontal bar mode (issue #873): wide, short widgets keep limits on a
  // scrolling horizontal rail and totals on one row, scoped by aspect ratio so
  // the narrow floating-bubble surface keeps its existing compact layout.
  assert.match(styles, /@media \(max-height: 200px\) and \(min-aspect-ratio: 3 \/ 1\)/);
  assert.match(styles, /\.limits-panel\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styles, /\.shell\.limits-mode \.total-panel/);
  // Multi-account providers lay their account chips on the same horizontal
  // rail inside the bar layout, instead of stacking vertically.
  assert.match(styles, /\.limit-row-group\s*\{[^}]*display:\s*flex/s);
  assert.ok((styles.match(/\.limit-account-list\s*\{/g) || []).length >= 2);
  // The active view is exposed as a shell class in the renderer.
  const appJs = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(appJs, /classList\.toggle\('limits-mode',\s*state\.breakdown === 'limits'\)/);
});
