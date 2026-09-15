'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TOP_EDGE_ANIMATION_FRAME_MS,
  TOP_EDGE_ANIMATION_MS,
  TOP_EDGE_HIDE_PEEK_PX,
  TOP_EDGE_SNAP_THRESHOLD_PX,
  canUseTopEdgeHide,
  cursorHitsWindow,
  displayForTopEdge,
  displayTopY,
  expandedTopEdgeBounds,
  hiddenTopEdgeBounds,
  interpolatedTopEdgeBounds,
  isNearTopEdge,
  shouldDockToTopEdge,
  shouldHideDockedTopEdgeWindow,
  shouldRevealDockedTopEdgeWindow,
  shouldSkipFloatingBubbleAutoCollapse,
  shouldUndockFromTopEdge,
  topEdgeAnimationProgress
} = require('../../src/electron/topEdgeHide');
const { canUseFloatingBubble } = require('../../src/electron/floatingBubble');
const { MESSAGES } = require('../../src/electron/renderer/i18n');

const repoRoot = path.join(__dirname, '..', '..');
const mainPath = path.join(repoRoot, 'src', 'electron', 'main.js');
const appPath = path.join(repoRoot, 'src', 'electron', 'renderer', 'app.js');
const indexPath = path.join(repoRoot, 'src', 'electron', 'renderer', 'index.html');
const modulePath = path.join(repoRoot, 'src', 'electron', 'topEdgeHide.js');

const windowsBottomTaskbar = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
};
const windowsTopTaskbar = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 40, width: 1920, height: 1040 }
};
const macMenuBar = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 }
};
const secondaryOrigin = {
  bounds: { x: 1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: 1920, y: -200, width: 1920, height: 1040 }
};
const widget = { x: 80, y: 120, width: 340, height: 650 };

test('top-edge hide is available only for enabled movable window modes', () => {
  assert.equal(canUseTopEdgeHide({ topEdgeHideEnabled: true, windowBehavior: 'floating', trayMode: false }), true);
  assert.equal(canUseTopEdgeHide({ topEdgeHideEnabled: true, windowBehavior: 'normal', trayMode: false }), true);
  assert.equal(canUseTopEdgeHide({ topEdgeHideEnabled: false, windowBehavior: 'floating', trayMode: false }), false);
  assert.equal(canUseTopEdgeHide({ topEdgeHideEnabled: true, windowBehavior: 'desktop', trayMode: false }), false);
  assert.equal(canUseTopEdgeHide({ topEdgeHideEnabled: true, windowBehavior: 'floating', trayMode: true }), false);
});

test('top-edge hide stays independent of the floating bubble switch', () => {
  const topOnly = { topEdgeHideEnabled: true, floatingBubbleEnabled: false, windowBehavior: 'floating', trayMode: false };
  const bubbleOnly = { topEdgeHideEnabled: false, floatingBubbleEnabled: true, windowBehavior: 'floating', trayMode: false };
  assert.equal(canUseTopEdgeHide(topOnly), true);
  assert.equal(canUseFloatingBubble(topOnly), false);
  assert.equal(canUseTopEdgeHide(bubbleOnly), false);
  assert.equal(canUseFloatingBubble(bubbleOnly), true);
  assert.equal(
    shouldSkipFloatingBubbleAutoCollapse({ enabled: canUseTopEdgeHide(topOnly), docked: true }),
    true
  );
  assert.equal(
    shouldSkipFloatingBubbleAutoCollapse({ enabled: canUseTopEdgeHide(bubbleOnly), docked: true }),
    false
  );
});

test('displayTopY uses workArea when system UI occupies the top, otherwise Windows bounds', () => {
  assert.equal(displayTopY(windowsBottomTaskbar, 'win32'), 0);
  assert.equal(displayTopY(windowsTopTaskbar, 'win32'), 40);
  assert.equal(displayTopY(macMenuBar, 'darwin'), 25);
  assert.equal(displayTopY(secondaryOrigin, 'win32'), -200);
});

test('multi-monitor docking asks getDisplayMatching for the window bounds', () => {
  const calls = [];
  const getDisplayMatching = (bounds) => {
    calls.push(bounds);
    return secondaryOrigin;
  };
  assert.equal(displayForTopEdge({ x: 2100, y: -180, width: 340, height: 650 }, getDisplayMatching), secondaryOrigin);
  assert.deepEqual(calls[0], { x: 2100, y: -180, width: 340, height: 650 });
  assert.equal(displayForTopEdge(null, getDisplayMatching), null);
});

test('snap zone is the window top entering the display top threshold', () => {
  assert.equal(isNearTopEdge({ ...widget, y: 0 }, windowsBottomTaskbar, 'win32'), true);
  assert.equal(isNearTopEdge({ ...widget, y: TOP_EDGE_SNAP_THRESHOLD_PX }, windowsBottomTaskbar, 'win32'), true);
  assert.equal(isNearTopEdge({ ...widget, y: TOP_EDGE_SNAP_THRESHOLD_PX + 1 }, windowsBottomTaskbar, 'win32'), false);
  assert.equal(isNearTopEdge({ ...widget, y: 40 }, windowsTopTaskbar, 'win32'), true);
  assert.equal(isNearTopEdge({ ...widget, y: 40 + TOP_EDGE_SNAP_THRESHOLD_PX + 1 }, windowsTopTaskbar, 'win32'), false);
});

test('maximized windows and collapsed bubbles do not dock', () => {
  const settings = { topEdgeHideEnabled: true, windowBehavior: 'floating', trayMode: false };
  const nearTop = { ...widget, y: 0 };
  assert.equal(shouldDockToTopEdge({
    bounds: nearTop, display: windowsBottomTaskbar, settings, platform: 'win32'
  }), true);
  assert.equal(shouldDockToTopEdge({
    bounds: nearTop, display: windowsBottomTaskbar, settings, maximized: true, platform: 'win32'
  }), false);
  assert.equal(shouldDockToTopEdge({
    bounds: nearTop, display: windowsBottomTaskbar, settings, floatingBubbleCollapsed: true, platform: 'win32'
  }), false);
  assert.equal(shouldDockToTopEdge({
    bounds: nearTop, display: windowsBottomTaskbar, settings: { ...settings, windowBehavior: 'desktop' }, platform: 'win32'
  }), false);
});

test('expanded and hidden bounds keep width/height and only translate y', () => {
  assert.deepEqual(expandedTopEdgeBounds(widget, windowsBottomTaskbar, 'win32'), {
    x: 80, y: 0, width: 340, height: 650
  });
  assert.deepEqual(hiddenTopEdgeBounds(widget, windowsBottomTaskbar, 'win32'), {
    x: 80,
    y: 0 - 650 + TOP_EDGE_HIDE_PEEK_PX,
    width: 340,
    height: 650
  });
  assert.deepEqual(expandedTopEdgeBounds(widget, windowsTopTaskbar, 'win32'), {
    x: 80, y: 40, width: 340, height: 650
  });
  assert.deepEqual(hiddenTopEdgeBounds(widget, windowsTopTaskbar, 'win32'), {
    x: 80,
    y: 40 - 650 + TOP_EDGE_HIDE_PEEK_PX,
    width: 340,
    height: 650
  });
  assert.deepEqual(hiddenTopEdgeBounds({ ...widget, x: 5000 }, secondaryOrigin, 'win32'), {
    x: 1920 + 1920 - 340,
    y: -200 - 650 + TOP_EDGE_HIDE_PEEK_PX,
    width: 340,
    height: 650
  });
});

test('dragging the expanded window past the snap zone undocks', () => {
  assert.equal(shouldUndockFromTopEdge({ ...widget, y: 0 }, windowsBottomTaskbar, 'win32'), false);
  assert.equal(shouldUndockFromTopEdge({ ...widget, y: TOP_EDGE_SNAP_THRESHOLD_PX }, windowsBottomTaskbar, 'win32'), false);
  assert.equal(shouldUndockFromTopEdge({ ...widget, y: TOP_EDGE_SNAP_THRESHOLD_PX + 1 }, windowsBottomTaskbar, 'win32'), true);
});

test('hide follows pointer leave even while focused; reveal is hover or force, not Alt+Tab', () => {
  assert.equal(shouldHideDockedTopEdgeWindow({
    enabled: true, docked: true, hidden: false, cursorInside: false
  }), true);
  assert.equal(shouldHideDockedTopEdgeWindow({
    enabled: true, docked: true, hidden: false, focused: true, cursorInside: false
  }), true);
  assert.equal(shouldHideDockedTopEdgeWindow({
    enabled: true, docked: true, hidden: false, cursorInside: true
  }), false);
  assert.equal(shouldHideDockedTopEdgeWindow({
    enabled: true, docked: true, hidden: false, cursorInside: false, moving: true
  }), false);
  assert.equal(shouldHideDockedTopEdgeWindow({
    enabled: true, docked: true, hidden: false, cursorInside: false, maximized: true
  }), false);
  assert.equal(shouldRevealDockedTopEdgeWindow({
    docked: true, hidden: true, cursorInside: true
  }), true);
  assert.equal(shouldRevealDockedTopEdgeWindow({
    docked: true, hidden: true, cursorInside: false, focused: true
  }), false);
  assert.equal(shouldRevealDockedTopEdgeWindow({
    docked: true, hidden: true, cursorInside: false, force: true
  }), true);
  assert.equal(shouldRevealDockedTopEdgeWindow({
    docked: true, hidden: true, cursorInside: false
  }), false);
});

test('slide animation only interpolates y, easing in on hide and out on show', () => {
  const expanded = { x: 80, y: 0, width: 340, height: 650 };
  const hidden = hiddenTopEdgeBounds(expanded, windowsBottomTaskbar, 'win32');
  assert.equal(TOP_EDGE_ANIMATION_MS, 240);
  assert.equal(TOP_EDGE_ANIMATION_FRAME_MS, 16);
  assert.equal(topEdgeAnimationProgress(0, true), 0);
  assert.equal(topEdgeAnimationProgress(1, true), 1);
  assert.equal(topEdgeAnimationProgress(0, false), 0);
  assert.equal(topEdgeAnimationProgress(1, false), 1);
  assert.ok(topEdgeAnimationProgress(0.5, true) < 0.5);
  assert.ok(topEdgeAnimationProgress(0.5, false) > 0.5);
  assert.deepEqual(interpolatedTopEdgeBounds(expanded, hidden, 0), { ...hidden, y: expanded.y });
  assert.deepEqual(interpolatedTopEdgeBounds(expanded, hidden, 1), hidden);
  const midHide = interpolatedTopEdgeBounds(expanded, hidden, 0.5);
  assert.equal(midHide.x, hidden.x);
  assert.equal(midHide.width, hidden.width);
  assert.equal(midHide.height, hidden.height);
  assert.ok(midHide.y < expanded.y);
  assert.ok(midHide.y > hidden.y);
  const midShow = interpolatedTopEdgeBounds(hidden, expanded, 0.5);
  assert.equal(midShow.width, expanded.width);
  assert.equal(midShow.height, expanded.height);
  assert.ok(midShow.y > hidden.y);
  assert.ok(midShow.y < expanded.y);
  const shifted = interpolatedTopEdgeBounds(
    { ...expanded, x: 120 },
    { ...hidden, x: 80 },
    0.5
  );
  assert.equal(shifted.x, 120);
});

test('the remaining strip is the on-screen slice of the full window bounds', () => {
  const hidden = hiddenTopEdgeBounds(widget, windowsBottomTaskbar, 'win32');
  assert.equal(cursorHitsWindow({ x: 100, y: 2 }, hidden), true);
  assert.equal(cursorHitsWindow({ x: 100, y: hidden.y - 1 }, hidden), false);
  assert.equal(cursorHitsWindow({ x: 100, y: hidden.y + hidden.height }, hidden), false);
});

test('settings UI sits beside Floating Bubble and wires a new key', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const main = fs.readFileSync(mainPath, 'utf8');
  const presenceGroup = html.slice(
    html.indexOf('settings-presence-group'),
    html.indexOf('id="showTrayIconInput"')
  );
  assert.match(presenceGroup, /id="floatingBubbleInput"/);
  assert.match(presenceGroup, /id="topEdgeHideInput"/);
  assert.ok(presenceGroup.indexOf('id="floatingBubbleInput"') < presenceGroup.indexOf('id="topEdgeHideInput"'));
  assert.match(html, /data-i18n="settings\.display\.topEdgeHide"/);
  assert.match(html, /data-i18n="settings\.display\.topEdgeHideNote"/);
  assert.match(app, /topEdgeHideInput: document\.getElementById\('topEdgeHideInput'\)/);
  assert.match(app, /saveSettings\(\{ topEdgeHideEnabled: els\.topEdgeHideInput\.checked \}\)/);
  assert.match(main, /topEdgeHideEnabled: false,/);
  assert.match(main, /topEdgeHideDocked: false,/);
  assert.match(main, /topEdgeHideEnabled: parseBoolean\(patch\.topEdgeHideEnabled/);
  assert.doesNotMatch(main, /topEdgeHideEnabled:\s*[^\n]*edgeDrawerEnabled/);
});

test('main process translates the existing window instead of rebuilding a mini-window', () => {
  const main = fs.readFileSync(mainPath, 'utf8');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  assert.match(main, /require\('\.\/topEdgeHide'\)/);
  assert.match(main, /syncTopEdgeHideAvailability/);
  assert.match(main, /scheduleTopEdgeHideAutoHide/);
  assert.match(main, /displayForTopEdge\(/);
  assert.match(main, /screen\.getDisplayMatching/);
  assert.match(main, /shouldSkipFloatingBubbleAutoCollapse/);
  assert.doesNotMatch(moduleSource, /replaceMainWindow/);
  assert.doesNotMatch(moduleSource, /collapsedFloatingBubble/);
  assert.doesNotMatch(moduleSource, /side:\s*'top'/);
  const applyFn = main.slice(
    main.indexOf('function applyTopEdgeBounds('),
    main.indexOf('\nfunction ', main.indexOf('function applyTopEdgeBounds(') + 1)
  );
  assert.match(applyFn, /setBounds/);
  assert.match(applyFn, /setPosition/);
  assert.match(applyFn, /nudgeWindowsWindowByY/);
  assert.match(applyFn, /setWindowsDwmTransitionsEnabled/);
  assert.match(applyFn, /sameWindowBounds\(/);
  assert.match(applyFn, /interpolatedTopEdgeBounds/);
  assert.match(applyFn, /TOP_EDGE_ANIMATION_MS/);
  assert.match(applyFn, /TOP_EDGE_ANIMATION_FRAME_MS/);
  assert.doesNotMatch(applyFn, /process\.platform === 'darwin'/);
  assert.equal(typeof require('../../src/electron/windowState').sameWindowBounds, 'function');
  assert.doesNotMatch(applyFn, /replaceMainWindow/);
  const hideFn = main.slice(
    main.indexOf('function hideTopEdgeWindow('),
    main.indexOf('\nfunction ', main.indexOf('function hideTopEdgeWindow(') + 1)
  );
  assert.match(hideFn, /applyTopEdgeBounds/);
  assert.doesNotMatch(hideFn, /isFocused/);
  assert.doesNotMatch(hideFn, /replaceMainWindow/);
  assert.doesNotMatch(hideFn, /collapsedFloatingBubble:\s*true/);
  const applySettings = main.slice(
    main.indexOf('function applyWindowSettings('),
    main.indexOf('\nfunction ', main.indexOf('function applyWindowSettings(') + 1)
  );
  assert.match(applySettings, /topEdgeHidden \|\| skipTaskbarForSettings\(settings\)/);
  assert.match(applySettings, /behavior\.focusable && !topEdgeHidden/);
  assert.doesNotMatch(main, /if \(topEdgeHideState\.hidden\) revealTopEdgeHide\(\{ focus: false \}\)/);
  assert.match(main, /win\.on\('moved', \(\) => \{\s*if \(topEdgeHideState\.applyingBounds\) return;/);
});

test('enabling the setting docks a window already sitting in the snap zone', () => {
  const main = fs.readFileSync(mainPath, 'utf8');
  const syncFn = main.slice(
    main.indexOf('function syncTopEdgeHideAvailability('),
    main.indexOf('\nfunction ', main.indexOf('function syncTopEdgeHideAvailability(') + 1)
  );
  const adoptFn = main.slice(
    main.indexOf('function maybeDockTopEdgeFromCurrentBounds('),
    main.indexOf('\nfunction ', main.indexOf('function maybeDockTopEdgeFromCurrentBounds(') + 1)
  );
  assert.match(syncFn, /maybeDockTopEdgeFromCurrentBounds\(\)/);
  assert.match(adoptFn, /shouldDockToTopEdge/);
  assert.match(adoptFn, /dockTopEdge\(/);
  assert.doesNotMatch(adoptFn, /topEdgeHideDocked/);
});

test('every locale has a title and the requested Chinese note', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ko', 'ja']) {
    assert.ok(MESSAGES[locale]['settings.display.topEdgeHide'], locale);
    assert.ok(MESSAGES[locale]['settings.display.topEdgeHideNote'], locale);
  }
  assert.equal(
    MESSAGES['zh-CN']['settings.display.topEdgeHideNote'],
    '拖到屏幕顶部后，鼠标离开即藏入顶部，移到细条上再展开'
  );
  assert.equal(
    MESSAGES['zh-TW']['settings.display.topEdgeHideNote'],
    '拖到螢幕頂部後，滑鼠離開即藏入頂部，移到細條上再展開'
  );
});
