'use strict';

// Windows-only: keep an always-on-top widget above the taskbar (#533).
//
// Two independent things push a topmost window behind Shell_TrayWnd, and they
// have to be fixed in this order:
//
//   1. Electron itself, for the `floating` z-order level — SetAlwaysOnTop and
//      every window activation re-run its own SetWindowPos(hwnd, taskbar).
//      floatingAlwaysOnTopLevel() in windowBehavior.js opts out of that set,
//      which is what makes re-asserting worth doing at all: before that, every
//      activation undid it again.
//   2. Windows, on its own. Handing activation to the taskbar raises
//      Shell_TrayWnd to the top of the topmost band. Nothing notifies us
//      directly: a window only gets WM_WINDOWPOSCHANGED when *it* moves, not
//      when another window overtakes it.
//
// Measured on Windows, (2) fires whenever activation moves *to* the taskbar,
// from whichever window held it. Only one of those transitions reaches us as an
// event — the widget losing its own activation — so nudge() covers that one
// from the window's blur, re-asserting immediately and again over the next half
// second, because the shell raises the taskbar a moment later and a single
// immediate call gets overtaken.
//
// Every other transition (app -> taskbar, with the widget never focused) sends
// us nothing at all, and that is the flow the bug was reported for: switching
// apps from the taskbar without touching the widget. Nothing observable exists
// to hook there short of a system-wide EVENT_SYSTEM_FOREGROUND hook, so that
// flow runs on the interval alone and a short cover-then-restore flicker stays
// visible on every app switch. Measured on Windows, shortening the interval
// only shortens the flicker. That flicker, plus a permanent timer, is why this
// is opt-in behind `keepAboveTaskbar` rather than how a floating widget
// behaves by default.
//
// The cost is contained by running only while the window actually overlaps the
// area the taskbar reserves: a widget inside the work area can never be covered
// by it, so nothing runs for anyone who has not dragged the widget onto the
// taskbar. moveTop() is SetWindowPos(HWND_TOP, SWP_NOACTIVATE), so re-asserting
// never steals focus or activates the widget.

const DEFAULT_INTERVAL_MS = 250;
// The shell raises the taskbar a moment after our blur, so the immediate call
// is reliably overtaken. These only have to bridge the gap to the next interval
// tick, which is why they stop where the interval takes over.
const NUDGE_DELAYS_MS = [60, 200];

function rectsIntersect(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function contains(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function validRect(rect) {
  return Boolean(rect)
    && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

// The taskbar lives in the part of a display that is not work area. Anything
// the window has outside the work area — on any edge, so a left/top/right
// taskbar counts too — is where it can be covered.
function overlapsReservedArea(bounds, display) {
  if (!validRect(bounds) || !display) return false;
  const screenBounds = display.bounds;
  const workArea = display.workArea;
  if (!validRect(screenBounds) || !validRect(workArea)) return false;
  if (!rectsIntersect(bounds, screenBounds)) return false;
  return !contains(workArea, intersection(bounds, screenBounds));
}

function createTaskbarZOrderKeeper(options = {}) {
  const platform = options.platform || process.platform;
  const screen = options.screen;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const nudgeDelays = options.nudgeDelays || NUDGE_DELAYS_MS;

  let timer = null;
  let target = null;
  const nudges = new Set();

  function clearNudges() {
    for (const handle of nudges) clearTimeoutFn(handle);
    nudges.clear();
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    target = null;
    clearNudges();
  }

  function displayFor(bounds) {
    if (!screen || typeof screen.getDisplayMatching !== 'function') return null;
    try {
      return screen.getDisplayMatching(bounds);
    } catch (_) {
      return null;
    }
  }

  // Every reason to stop is re-checked on each tick, not just at sync() time:
  // the window can be hidden, moved or unpinned by paths that have no reason to
  // know this keeper exists.
  function shouldKeep(window) {
    if (platform !== 'win32') return false;
    if (!window || window.isDestroyed?.()) return false;
    if (typeof window.moveTop !== 'function') return false;
    if (typeof window.isVisible === 'function' && !window.isVisible()) return false;
    if (typeof window.isMinimized === 'function' && window.isMinimized()) return false;
    if (typeof window.isAlwaysOnTop === 'function' && !window.isAlwaysOnTop()) return false;
    try {
      const bounds = window.getBounds();
      return overlapsReservedArea(bounds, displayFor(bounds));
    } catch (_) {
      return false;
    }
  }

  function tick() {
    if (!shouldKeep(target)) {
      stop();
      return;
    }
    try {
      target.moveTop();
    } catch (_) {
      // A window torn down between the check and the call is not worth logging.
    }
  }

  function sync(window) {
    if (!shouldKeep(window)) {
      stop();
      return false;
    }
    target = window;
    if (!timer) timer = setIntervalFn(tick, intervalMs);
    // Re-assert immediately so a drag onto the taskbar does not wait a tick.
    tick();
    return true;
  }

  // The widget just lost activation, which is the one transition that puts the
  // taskbar back on top. sync() re-asserts once; the follow-ups cover the shell
  // raising the taskbar a moment later.
  function nudge(window) {
    if (!sync(window)) return false;
    for (const delay of nudgeDelays) {
      const handle = setTimeoutFn(() => {
        nudges.delete(handle);
        tick();
      }, delay);
      nudges.add(handle);
    }
    return true;
  }

  return {
    sync,
    nudge,
    stop,
    isRunning: () => Boolean(timer)
  };
}

// The widget being on top at all is still the keeper's own check; this is only
// the opt-in that decides whether re-asserting happens.
function taskbarZOrderEnabled(settings, platform = process.platform) {
  if (platform !== 'win32') return false;
  return settings?.keepAboveTaskbar === true;
}

module.exports = {
  createTaskbarZOrderKeeper,
  overlapsReservedArea,
  taskbarZOrderEnabled
};
