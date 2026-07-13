'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  canUseFloatingBubble,
  collapsedFloatingBubbleBounds,
  dragFloatingBubbleBounds,
  expandedFloatingBubbleBounds,
  floatingBubbleCollapsedArea,
  floatingBubbleCollapsedMargin,
  floatingBubbleCollapsePlan,
  floatingBubbleInitialRendererQuery,
  floatingBubbleNativeGlassEnabled,
  floatingBubbleWindowChrome,
  moveFloatingBubbleBounds,
  normalizeInitialRendererViewState
} = require('../../src/electron/floatingBubble');

const workArea = { x: 0, y: 24, width: 1440, height: 876 };
const windowsDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1840, height: 1040 }
};
const stylesPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css');
const indexPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'index.html');
const bootPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'floatingBubbleBoot.js');

function cssBlock(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] || '';
}

test('floating bubble is available only for enabled movable window modes', () => {
  assert.equal(canUseFloatingBubble({ floatingBubbleEnabled: true, windowBehavior: 'floating', trayMode: false }), true);
  assert.equal(canUseFloatingBubble({ floatingBubbleEnabled: true, windowBehavior: 'normal', trayMode: false }), true);
  assert.equal(canUseFloatingBubble({ floatingBubbleEnabled: false, windowBehavior: 'floating', trayMode: false }), false);
  assert.equal(canUseFloatingBubble({ floatingBubbleEnabled: true, windowBehavior: 'desktop', trayMode: false }), false);
  assert.equal(canUseFloatingBubble({ floatingBubbleEnabled: true, windowBehavior: 'floating', trayMode: true }), false);
});

test('floating bubble disables native system glass while collapsed', () => {
  assert.equal(floatingBubbleNativeGlassEnabled({ systemGlass: true }, { collapsed: false }), true);
  assert.equal(floatingBubbleNativeGlassEnabled({ systemGlass: true }, { collapsed: true }), false);
  assert.equal(floatingBubbleNativeGlassEnabled({ systemGlass: false }, { collapsed: false }), false);
  assert.equal(
    floatingBubbleNativeGlassEnabled({ systemGlass: true, floatingBubbleEnabled: true }, { collapsed: false }, 'win32'),
    true
  );
  assert.equal(
    floatingBubbleNativeGlassEnabled({ systemGlass: false, floatingBubbleEnabled: true }, { collapsed: false }, 'win32'),
    false
  );
  assert.equal(
    floatingBubbleNativeGlassEnabled({ systemGlass: true, floatingBubbleEnabled: true }, { collapsed: true }, 'win32'),
    false
  );
  assert.equal(
    floatingBubbleNativeGlassEnabled({ systemGlass: true, floatingBubbleEnabled: true }, { collapsed: false }, 'darwin'),
    true
  );
});

test('floatingBubbleCollapsedArea uses physical display bounds on Windows', () => {
  assert.equal(floatingBubbleCollapsedArea(windowsDisplay, 'win32'), windowsDisplay.bounds);
  assert.equal(floatingBubbleCollapsedArea(windowsDisplay, 'darwin'), windowsDisplay.workArea);
  assert.equal(floatingBubbleCollapsedArea(windowsDisplay, 'linux'), windowsDisplay.workArea);
  assert.deepEqual(floatingBubbleCollapsedMargin('win32'), { x: 0, y: 0 });
  assert.deepEqual(floatingBubbleCollapsedMargin('darwin'), { x: 0, y: 8 });
});

test('floatingBubbleWindowChrome removes Windows native frame only for collapsed mini-window', () => {
  assert.deepEqual(floatingBubbleWindowChrome('win32', true), {
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false
  });
  assert.deepEqual(floatingBubbleWindowChrome('win32', false), {});
  assert.deepEqual(floatingBubbleWindowChrome('darwin', true), {});
});

test('normalizeInitialRendererViewState restores a persisted last-used view', () => {
  // All main views (incl. Home and Trends) must round-trip so a cold start can
  // reopen exactly where the user left off.
  assert.deepEqual(
    normalizeInitialRendererViewState({ period: 'today', breakdown: 'home' }),
    { period: 'today', breakdown: 'home' }
  );
  assert.deepEqual(
    normalizeInitialRendererViewState({ period: 'month', breakdown: 'trends' }),
    { period: 'month', breakdown: 'trends' }
  );
  assert.deepEqual(
    normalizeInitialRendererViewState({ period: 'allTime', breakdown: 'project' }),
    { period: 'allTime', breakdown: 'project' }
  );
  // A bogus saved snapshot collapses onto the provided fallback rather than the
  // hard default, so a partial/corrupt value can't wipe the live state.
  assert.deepEqual(
    normalizeInitialRendererViewState({ period: 'bad', breakdown: 'bad' }, { period: 'allTime', breakdown: 'session' }),
    { period: 'allTime', breakdown: 'session' }
  );
  // Empty snapshot (fresh install) falls back to the today/tool defaults.
  assert.deepEqual(
    normalizeInitialRendererViewState(undefined),
    { period: 'today', breakdown: 'tool' }
  );
});

test('floatingBubbleInitialRendererQuery primes the first collapsed mini-window paint', () => {
  // The view state always rides along (default today/tool when none is given)
  // so a persisted last view of tool/today is never mistaken for "no view".
  assert.deepEqual(
    floatingBubbleInitialRendererQuery({ collapsed: true, side: 'right' }, true),
    { period: 'today', breakdown: 'tool', floatingBubbleSide: 'right' }
  );
  assert.deepEqual(
    floatingBubbleInitialRendererQuery({ collapsed: true, side: 'top' }, true),
    { period: 'today', breakdown: 'tool' }
  );
  assert.deepEqual(
    floatingBubbleInitialRendererQuery({ collapsed: false, side: 'right' }, true),
    { period: 'today', breakdown: 'tool' }
  );
  assert.deepEqual(
    floatingBubbleInitialRendererQuery({ collapsed: true, side: 'right' }, false),
    { period: 'today', breakdown: 'tool' }
  );
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: false, side: null },
      { suppressInitialNumberAnimation: true }
    ),
    { period: 'today', breakdown: 'tool', suppressInitialNumberAnimation: '1' }
  );
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: true, side: 'left' },
      { collapsedWindow: true, suppressInitialNumberAnimation: true }
    ),
    { period: 'today', breakdown: 'tool', floatingBubbleSide: 'left', suppressInitialNumberAnimation: '1' }
  );
});

test('floatingBubbleInitialRendererQuery preserves renderer view state across window rebuilds', () => {
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: false, side: null },
      {
        suppressInitialNumberAnimation: true,
        viewState: { period: 'month', breakdown: 'limits' }
      }
    ),
    { suppressInitialNumberAnimation: '1', period: 'month', breakdown: 'limits' }
  );
  // A last view of trends must survive the round-trip too (was dropped before).
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: false, side: null },
      { viewState: { period: 'allTime', breakdown: 'trends' } }
    ),
    { period: 'allTime', breakdown: 'trends' }
  );
  // A default last view of today/tool is carried explicitly, not omitted.
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: false, side: null },
      {
        viewState: { period: 'today', breakdown: 'status' }
      }
    ),
    { period: 'today', breakdown: 'status' }
  );
  // A corrupt snapshot collapses to today/tool, still carried explicitly.
  assert.deepEqual(
    floatingBubbleInitialRendererQuery(
      { collapsed: true, side: 'left' },
      {
        collapsedWindow: true,
        viewState: { period: 'bad', breakdown: 'bad' }
      }
    ),
    { period: 'today', breakdown: 'tool', floatingBubbleSide: 'left' }
  );
});

test('collapsedFloatingBubbleBounds keeps the current narrow mini-window shape without requiring an edge', () => {
  const bounds = { x: 120, y: 80, width: 360, height: 520 };
  assert.deepEqual(collapsedFloatingBubbleBounds(bounds, workArea), {
    x: 120,
    y: 323,
    width: 18,
    height: 34
  });
  assert.deepEqual(collapsedFloatingBubbleBounds({ x: 1000, y: 80, width: 360, height: 520 }, workArea), {
    x: 1342,
    y: 323,
    width: 18,
    height: 34
  });
});

test('floatingBubbleCollapsePlan can collapse from the current position without edge docking', () => {
  assert.equal(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'floating' },
      { suppressNextCollapse: true }
    ),
    null
  );
  assert.deepEqual(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'floating' }
    ),
    {
      side: 'left',
      expandedBounds: { x: 120, y: 120, width: 360, height: 520 },
      collapsedBounds: { x: 120, y: 363, width: 18, height: 34 }
    }
  );
});

test('floatingBubbleCollapsePlan reuses the last dragged mini-window position', () => {
  assert.deepEqual(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'normal' },
      { collapsedBounds: { x: 640, y: 220, width: 18, height: 34 } }
    ),
    {
      side: 'left',
      expandedBounds: { x: 120, y: 120, width: 360, height: 520 },
      collapsedBounds: { x: 640, y: 220, width: 18, height: 34 }
    }
  );
  assert.deepEqual(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'normal' },
      { collapsedBounds: { x: 1414, y: 220, width: 18, height: 34 } }
    ),
    {
      side: 'right',
      expandedBounds: { x: 120, y: 120, width: 360, height: 520 },
      collapsedBounds: { x: 1422, y: 220, width: 18, height: 34 }
    }
  );
  assert.deepEqual(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'normal' },
      { collapsedBounds: { x: 2000, y: 220, width: 18, height: 34 } }
    ),
    {
      side: 'right',
      expandedBounds: { x: 120, y: 120, width: 360, height: 520 },
      collapsedBounds: { x: 1422, y: 220, width: 18, height: 34 }
    }
  );
});

test('floatingBubbleCollapsePlan can clamp the mini-window against Windows physical edges', () => {
  assert.deepEqual(
    floatingBubbleCollapsePlan(
      { x: 120, y: 120, width: 360, height: 520 },
      windowsDisplay.workArea,
      { floatingBubbleEnabled: true, windowBehavior: 'normal' },
      {
        collapsedArea: windowsDisplay.bounds,
        collapsedMargin: floatingBubbleCollapsedMargin('win32'),
        collapsedBounds: { x: 1902, y: 1060, width: 18, height: 34 }
      }
    ),
    {
      side: 'right',
      expandedBounds: { x: 120, y: 120, width: 360, height: 520 },
      collapsedBounds: { x: 1902, y: 1046, width: 18, height: 34 }
    }
  );
});

test('expandedFloatingBubbleBounds opens near the mini-window and stays inside the work area', () => {
  assert.deepEqual(expandedFloatingBubbleBounds({ x: 1100, y: 500, width: 18, height: 34 }, workArea, { width: 360, height: 520 }), {
    x: 758,
    y: 257,
    width: 360,
    height: 520
  });
  assert.deepEqual(expandedFloatingBubbleBounds({ x: 8, y: 8, width: 18, height: 34 }, workArea, { width: 360, height: 520 }), {
    x: 8,
    y: 32,
    width: 360,
    height: 520
  });
});

test('moveFloatingBubbleBounds drags the mini-window while clamping it inside the work area', () => {
  assert.deepEqual(moveFloatingBubbleBounds({ x: 640, y: 220, width: 18, height: 34 }, workArea, { dx: 40, dy: -30 }), {
    x: 680,
    y: 190,
    width: 18,
    height: 34
  });
  assert.deepEqual(moveFloatingBubbleBounds({ x: 8, y: 30, width: 18, height: 34 }, workArea, { dx: -80, dy: -80 }), {
    x: 0,
    y: 32,
    width: 18,
    height: 34
  });
  assert.deepEqual(moveFloatingBubbleBounds({ x: 1420, y: 220, width: 18, height: 34 }, workArea, { dx: 80, dy: 0 }), {
    x: 1422,
    y: 220,
    width: 18,
    height: 34
  });
  assert.deepEqual(moveFloatingBubbleBounds({ x: 1414, y: 220, width: 18, height: 34 }, workArea, { dx: 0, dy: 0 }), {
    x: 1422,
    y: 220,
    width: 18,
    height: 34
  });
});

test('dragFloatingBubbleBounds anchors the mini-window to the OS cursor point', () => {
  assert.deepEqual(
    dragFloatingBubbleBounds(
      { x: 640, y: 220, width: 18, height: 34 },
      workArea,
      { x: 700, y: 250 },
      { offsetX: 6, offsetY: 12 }
    ),
    {
      x: 694,
      y: 238,
      width: 18,
      height: 34
    }
  );
  assert.deepEqual(
    dragFloatingBubbleBounds(
      { x: 640, y: 220, width: 18, height: 34 },
      workArea,
      { x: 5000, y: -200 },
      { offsetX: 9, offsetY: 17 }
    ),
    {
      x: 1422,
      y: 32,
      width: 18,
      height: 34
    }
  );
  assert.deepEqual(
    dragFloatingBubbleBounds(
      { x: 640, y: 220, width: 18, height: 34 },
      workArea,
      { x: 700, y: 250 },
      { offsetX: 3, offsetY: 5, offsetRatioX: 0.5, offsetRatioY: 0.25 }
    ),
    {
      x: 691,
      y: 242,
      width: 18,
      height: 34
    }
  );
});

test('floating bubble collapsed styles fill the mini window with app glass styling', () => {
  const css = fs.readFileSync(stylesPath, 'utf8');
  const html = fs.readFileSync(indexPath, 'utf8');
  const boot = fs.readFileSync(bootPath, 'utf8');
  assert.ok(html.indexOf('floatingBubbleBoot.js') < html.indexOf('styles.css'));
  assert.match(boot, /floatingBubbleSide/);
  assert.match(boot, /suppressInitialNumberAnimation/);
  assert.match(boot, /__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__/);
  assert.match(boot, /\['home', 'tool', 'status', 'device', 'model', 'project', 'session', 'limits', 'trends'\]\.includes\(breakdown\)/);
  assert.match(boot, /document\.documentElement\.classList\.add/);
  assert.match(css, /html\.floating-bubble-collapsed-left,\s*body\.floating-bubble-collapsed-left/);
  assert.match(css, /html\.floating-bubble-collapsed-right,\s*body\.floating-bubble-collapsed-right/);
  const collapsedBlock = cssBlock(css, 'html\\.floating-bubble-collapsed-left,\\s*body\\.floating-bubble-collapsed-left,\\s*html\\.floating-bubble-collapsed-right,\\s*body\\.floating-bubble-collapsed-right');
  const tabBlock = cssBlock(css, '\\.floating-bubble-tab');
  assert.match(collapsedBlock, /rgb\(var\(--glass-rgb\)\);/);
  assert.match(tabBlock, /appearance:\s*none;/);
  assert.match(tabBlock, /border:\s*0;/);
  assert.match(tabBlock, /background:\s*transparent;/);
  assert.match(tabBlock, /box-shadow:\s*none;/);
  assert.match(tabBlock, /backdrop-filter:\s*none;/);
  assert.match(css, /html\.floating-bubble-collapsed-left body \.shell,\s*html\.floating-bubble-collapsed-right body \.shell/);
  assert.match(css, /html\.floating-bubble-collapsed-left body \.floating-bubble-tab/);
  assert.match(css, /html\.floating-bubble-collapsed-left,\s*body\.floating-bubble-collapsed-left\s*\{[\s\S]*border-radius:\s*0;/);
});

test('floatingBubbleCollapsePlan honors a custom handle size', () => {
  const settings = { floatingBubbleEnabled: true };
  const workArea = { x: 0, y: 0, width: 1000, height: 800 };
  const bounds = { x: 700, y: 300, width: 260, height: 360 };
  const plan = floatingBubbleCollapsePlan(bounds, workArea, settings, {
    handleWidth: 80,
    handleHeight: 30
  });
  assert.equal(plan.collapsedBounds.width, 80);
  assert.equal(plan.collapsedBounds.height, 32); // normalizeHandleSize floors height at 32
});
