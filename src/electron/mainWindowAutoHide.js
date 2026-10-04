'use strict';

const SIDES = ['left', 'right', 'top', 'bottom'];
const SNAP_DISTANCE = 16;
const STRIP = 8;

function overlap(a, b, axis) {
  const size = axis === 'x' ? 'width' : 'height';
  return Math.max(0, Math.min(a[axis] + a[size], b[axis] + b[size]) - Math.max(a[axis], b[axis]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(Math.max(min, max), value));
}

function displayFor(bounds, displays) {
  return displays.reduce((best, display) => {
    const area = overlap(bounds, display.bounds, 'x') * overlap(bounds, display.bounds, 'y');
    return area > best.area ? { display, area } : best;
  }, { display: null, area: 0 }).display;
}

function exposed(display, displays, side, bounds) {
  const outer = display.bounds;
  const vertical = side === 'left' || side === 'right';
  const boundary = vertical
    ? (side === 'left' ? outer.x : outer.x + outer.width)
    : (side === 'top' ? outer.y : outer.y + outer.height);
  return !displays.some((other) => {
    if (other === display || other.id === display.id) return false;
    const rect = other.bounds;
    const crosses = vertical
      ? rect.x < boundary + 1 && rect.x + rect.width > boundary - 1
      : rect.y < boundary + 1 && rect.y + rect.height > boundary - 1;
    return crosses && overlap(bounds, rect, vertical ? 'y' : 'x') > 0;
  });
}

function dockBounds(bounds, area, side) {
  const result = { ...bounds };
  if (side === 'left') result.x = area.x;
  if (side === 'right') result.x = area.x + area.width - bounds.width;
  if (side === 'top') result.y = area.y;
  if (side === 'bottom') result.y = area.y + area.height - bounds.height;
  if (side === 'left' || side === 'right') result.y = clamp(bounds.y, area.y, area.y + area.height - bounds.height);
  else result.x = clamp(bounds.x, area.x, area.x + area.width - bounds.width);
  return result;
}

function hiddenTarget(bounds, area, side) {
  const result = { ...bounds };
  if (side === 'left') result.x = area.x - bounds.width + STRIP;
  if (side === 'right') result.x = area.x + area.width - STRIP;
  if (side === 'top') result.y = area.y - bounds.height + STRIP;
  if (side === 'bottom') result.y = area.y + area.height - STRIP;
  return result;
}

function visibleBounds(bounds, displays) {
  const display = displayFor(bounds, displays) || displays[0];
  if (!display) return bounds;
  const area = display.workArea;
  return {
    ...bounds,
    x: clamp(bounds.x, area.x, area.x + Math.max(0, area.width - bounds.width)),
    y: clamp(bounds.y, area.y, area.y + Math.max(0, area.height - bounds.height))
  };
}

function dockTarget(bounds, displays, preferredSide = null) {
  const display = displayFor(bounds, displays);
  if (!display) return null;
  const area = display.workArea;
  const distances = {
    left: Math.abs(bounds.x - area.x),
    right: Math.abs(bounds.x + bounds.width - area.x - area.width),
    top: Math.abs(bounds.y - area.y),
    bottom: Math.abs(bounds.y + bounds.height - area.y - area.height)
  };
  const candidates = (preferredSide ? [preferredSide] : SIDES)
    .filter((side) => distances[side] <= SNAP_DISTANCE && exposed(display, displays, side, bounds))
    .sort((a, b) => distances[a] - distances[b]);
  const side = candidates[0];
  return side ? { side, display, bounds: dockBounds(bounds, area, side) } : null;
}

function restoredDockTarget(bounds, displays, side) {
  if (!SIDES.includes(side)) return null;
  const safe = visibleBounds(bounds, displays);
  const display = displayFor(safe, displays) || displays[0];
  if (!display || !exposed(display, displays, side, safe)) return null;
  return { side, display, bounds: dockBounds(safe, display.workArea, side) };
}

function pointInside(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

function sameBounds(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createMainWindowAutoHide(options) {
  const win = options.window;
  const screen = options.screen;
  const settings = options.getSettings;
  const save = options.save;
  const platform = options.platform || process.platform;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const animationMs = options.animationMs === undefined ? 170 : options.animationMs;
  const reducedMotion = options.reducedMotion || (() => false);
  const fullscreen = options.isForegroundFullscreen || (() => false);
  let side = null;
  let expanded = null;
  let display = null;
  let hidden = false;
  let activeReveal = false;
  let interacting = false;
  const expectedMoves = [];
  let lastProgrammaticBounds = null;
  let pollTimer = null;
  let resizePersistTimer = null;
  let intentTimer = null;
  let animationTimer = null;
  let disposed = false;
  let restoredInitialSide = false;
  let pendingRestore = null;

  function clearIntent() {
    if (intentTimer) clearTimeoutFn(intentTimer);
    intentTimer = null;
  }

  function clearAnimation() {
    if (animationTimer) clearIntervalFn(animationTimer);
    animationTimer = null;
  }

  function moveTo(target, instant = false) {
    clearAnimation();
    const start = win.getBounds();
    if (sameBounds(start, target)) return;
    if (instant || animationMs <= 0 || reducedMotion()) {
      expectedMoves.push(target);
      if (expectedMoves.length > 32) expectedMoves.shift();
      lastProgrammaticBounds = target;
      win.setBounds(target);
      return;
    }
    const began = Date.now();
    const step = () => {
      if (disposed || win.isDestroyed()) { clearAnimation(); return; }
      const progress = Math.min(1, (Date.now() - began) / animationMs);
      const eased = 1 - (1 - progress) ** 3;
      const next = {
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: target.width,
        height: target.height
      };
      expectedMoves.push(next);
      if (expectedMoves.length > 32) expectedMoves.shift();
      lastProgrammaticBounds = next;
      win.setBounds(next);
      if (progress === 1) clearAnimation();
    };
    animationTimer = setIntervalFn(step, 16);
    step();
  }

  function emit() {
    options.onState?.({ side, hidden });
  }

  function remember(nextSide, bounds) {
    const current = settings();
    if (current.mainWindowAutoHideSide === nextSide && sameBounds(current.windowBounds, bounds)) return;
    current.mainWindowAutoHideSide = nextSide;
    current.windowBounds = bounds;
    save();
  }

  function clearResizePersist() {
    if (resizePersistTimer) clearTimeoutFn(resizePersistTimer);
    resizePersistTimer = null;
  }

  function eligible() {
    const current = settings();
    return platform === 'win32' && current?.mainWindowAutoHideEnabled !== false
      && !current?.trayMode && !current?.edgeDockEnabled && !current?.floatingBubbleEnabled
      && current?.windowBehavior !== 'desktop' && !win.isDestroyed()
      && !win.isMinimized() && !win.isMaximized() && !win.isFullScreen();
  }

  function release(restore = true, target = expanded, persist = true) {
    if (!persist && resizePersistTimer && side && expanded) remember(side, expanded);
    clearResizePersist();
    clearIntent();
    clearAnimation();
    expectedMoves.length = 0;
    if (pollTimer) clearIntervalFn(pollTimer);
    pollTimer = null;
    const remembered = target;
    const hadSide = Boolean(side);
    side = null;
    expanded = null;
    display = null;
    hidden = false;
    activeReveal = false;
    if (restore && hadSide && remembered && !win.isDestroyed()) {
      if (win.isMaximized() || win.isFullScreen()) pendingRestore = remembered;
      else moveTo(remembered, true);
    }
    if (hadSide && persist) remember(null, remembered || win.getBounds());
    if (hadSide) emit();
  }

  function startPolling() {
    if (!pollTimer) pollTimer = setIntervalFn(tick, 80);
  }

  function snap(candidate, persist = true) {
    clearIntent();
    side = candidate.side;
    display = candidate.display;
    expanded = candidate.bounds;
    hidden = false;
    activeReveal = false;
    moveTo(expanded);
    if (persist) remember(side, expanded);
    emit();
    startPolling();
  }

  function onMoveFinished() {
    if (disposed || !eligible() || side || !win.isVisible()) return;
    const candidate = dockTarget(win.getBounds(), screen.getAllDisplays());
    if (candidate) snap(candidate);
  }

  function onMoved() {
    if (disposed || win.isDestroyed()) return;
    if (win.isMinimized()) return;
    if (side && !win.isVisible()) return;
    const now = win.getBounds();
    const expectedIndex = expectedMoves.findIndex((bounds) => sameBounds(now, bounds));
    if (expectedIndex !== -1) { expectedMoves.splice(0, expectedIndex + 1); return; }
    if (sameBounds(now, lastProgrammaticBounds)) return;
    if (side && expanded && display && sameBounds(now, hidden ? hiddenTarget(expanded, display.workArea, side) : expanded)) return;
    lastProgrammaticBounds = null;
    clearAnimation();
    if (side && !eligible()) { release(true); return; }
    if (side) release(false);
    onMoveFinished();
  }

  function onResized() {
    if (!side || !expanded || !display || win.isDestroyed()) return;
    if (win.isMinimized()) return;
    if (!eligible()) { release(true); return; }
    const now = win.getBounds();
    if (now.width === expanded.width && now.height === expanded.height) return;
    clearIntent();
    expanded = dockBounds({
      ...now,
      ...(hidden ? { x: expanded.x, y: expanded.y } : {})
    }, display.workArea, side);
    clearResizePersist();
    resizePersistTimer = setTimeoutFn(() => {
      resizePersistTimer = null;
      if (side && expanded) remember(side, expanded);
    }, 400);
  }

  function reveal({ active = false } = {}) {
    if (!side || !expanded) return false;
    clearIntent();
    hidden = false;
    activeReveal = active;
    moveTo(expanded);
    emit();
    return true;
  }

  function hide() {
    if (!side || !expanded || !display || interacting || activeReveal || !eligible()) return false;
    clearIntent();
    hidden = true;
    moveTo(hiddenTarget(expanded, display.workArea, side));
    emit();
    return true;
  }

  function onMinimized() {
    if (!side || !hidden) return;
    setTimeoutFn(() => {
      if (disposed || !side || !hidden || win.isDestroyed() || !win.isMinimized()) return;
      win.restore();
      reveal({ active: true });
    }, 0);
  }

  function tick() {
    if (!side || disposed) return;
    if (win.isMinimized()) { clearIntent(); return; }
    if (!eligible() || !win.isVisible()) { if (!eligible()) release(true); return; }
    const cursor = screen.getCursorScreenPoint();
    if (hidden) {
      if (pointInside(cursor, win.getBounds()) && !fullscreen(display)) {
        if (!intentTimer) intentTimer = setTimeoutFn(() => {
          intentTimer = null;
          if (side && eligible() && pointInside(screen.getCursorScreenPoint(), win.getBounds()) && !fullscreen(display)) reveal();
        }, 150);
      } else clearIntent();
      return;
    }
    if (pointInside(cursor, expanded)) {
      activeReveal = false;
      clearIntent();
      return;
    }
    if (interacting || activeReveal) { clearIntent(); return; }
    if (!intentTimer) intentTimer = setTimeoutFn(() => {
      intentTimer = null;
      if (side && !pointInside(screen.getCursorScreenPoint(), expanded)) hide();
    }, 650);
  }

  function sync() {
    if (disposed) return;
    if (win.isMinimized()) return;
    if (pendingRestore && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) {
      moveTo(visibleBounds(pendingRestore, screen.getAllDisplays()), true);
      pendingRestore = null;
    }
    if (!eligible()) { release(true); return; }
    if (side) return;
    if (restoredInitialSide) return;
    restoredInitialSide = true;
    const savedSide = settings()?.mainWindowAutoHideSide;
    if (!SIDES.includes(savedSide)) return;
    const displays = screen.getAllDisplays();
    const safe = visibleBounds(win.getBounds(), displays);
    const candidate = restoredDockTarget(safe, displays, savedSide);
    if (candidate) snap(candidate);
    else {
      moveTo(safe, true);
      remember(null, safe);
    }
  }

  function onDisplayChange() {
    if (!side) return;
    clearResizePersist();
    const candidate = restoredDockTarget(expanded, screen.getAllDisplays(), side);
    if (candidate) {
      display = candidate.display;
      expanded = candidate.bounds;
      clearIntent();
      hidden = false;
      activeReveal = true;
      moveTo(expanded, true);
      remember(side, expanded);
      emit();
    } else release(true, visibleBounds(expanded, screen.getAllDisplays()));
  }

  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);

  return {
    sync, onMoved, onResized, onMoveFinished, onMinimized, tick, hide, reveal,
    isDocked: () => Boolean(side),
    state: () => ({ side, hidden }),
    expandedBounds: () => expanded,
    safeBounds: () => expanded || pendingRestore,
    setInteracting: (value) => { interacting = value === true; if (interacting) clearIntent(); },
    dispose: (restore = false) => {
      if (disposed) return;
      release(restore, expanded, restore);
      disposed = true;
      screen.removeListener('display-added', onDisplayChange);
      screen.removeListener('display-removed', onDisplayChange);
      screen.removeListener('display-metrics-changed', onDisplayChange);
    }
  };
}

module.exports = { createMainWindowAutoHide, dockTarget, hiddenTarget };
