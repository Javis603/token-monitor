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
// Every other transition (app -> taskbar, with the widget never focused) is the
// flow the widget is actually parked there for, and it reaches us only through
// windowsForegroundHook.js, which turns any foreground change in the system
// into the same event-driven re-assert. Measured on Windows, an interval alone
// cannot replace it: polling always covers-then-restores, and shortening the
// interval only shortens the visible flicker.
//
// The interval stays on at the same rate either way. Measured on Windows, the
// hook fires on every switch with sub-millisecond latency, but the shell does
// not always raise the taskbar inside the window the follow-ups cover — going
// widget -> other app -> taskbar lands the raise later than that — and a
// slower interval turns exactly that case back into a visible flicker. One
// SetWindowPos per interval is cheap enough that trading it for an unproven
// optimisation is not worth doing twice. Everything here is opt-in
// behind `keepAboveTaskbar`: a permanent timer, a system-wide hook and the
// flicker of the fallback are not things to hand to everyone who pins a
// widget.
//
// The cost is contained by running only while the window actually overlaps the
// area the taskbar reserves: a widget inside the work area can never be covered
// by it, so nothing runs for anyone who has not dragged the widget onto the
// taskbar. moveTop() is SetWindowPos(HWND_TOP, SWP_NOACTIVATE), so re-asserting
// never steals focus or activates the widget.

const INTERVAL_MS = 250;
// The shell raises the taskbar somewhere after the event that announced the
// switch, so the immediate call is reliably overtaken. How far after depends on
// the flow: taskbar-to-app lands inside the first two, widget -> other app ->
// taskbar lands later, which is why these run past the point where the interval
// would otherwise be the one to pick it up.
const NUDGE_DELAYS_MS = [60, 200, 400, 800];

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
  const intervalOverride = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 0;
  const subscribeForeground = options.subscribeForeground;
  const log = typeof options.log === 'function' ? options.log : null;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const nudgeDelays = options.nudgeDelays || NUDGE_DELAYS_MS;

  let timer = null;
  let target = null;
  let unsubscribeForeground = null;
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
    // The hook is released with the timer rather than kept for the lifetime of
    // the keeper: stop() is also how the setting being turned off arrives here,
    // and leaving a system-wide hook installed for a disabled feature is not a
    // thing to do.
    if (unsubscribeForeground) unsubscribeForeground();
    unsubscribeForeground = null;
  }

  function start() {
    if (timer) return;
    if (subscribeForeground) {
      try {
        unsubscribeForeground = subscribeForeground(onForegroundChange) || null;
      } catch (_) {
        unsubscribeForeground = null;
      }
    }
    const interval = intervalOverride || INTERVAL_MS;
    if (log) log(`start hook=${unsubscribeForeground ? 'installed' : 'none'} interval=${interval}ms`);
    timer = setIntervalFn(() => tick('tick'), interval);
  }

  // Some window somewhere took the foreground; if it was the taskbar we are now
  // under it, and if it was not, re-asserting costs one SetWindowPos.
  function onForegroundChange() {
    if (log) log('foreground-event');
    if (target) nudge(target, 'foreground');
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

  function tick(reason) {
    if (!shouldKeep(target)) {
      stop();
      return;
    }
    try {
      if (log) log(`moveTop ${reason}`);
      target.moveTop();
    } catch (_) {
      // A window torn down between the check and the call is not worth logging.
    }
  }

  function sync(window, reason = 'sync') {
    if (!shouldKeep(window)) {
      stop();
      return false;
    }
    target = window;
    start();
    // Re-assert immediately so a drag onto the taskbar does not wait a tick.
    tick(reason);
    return true;
  }

  // Something took the foreground — the widget losing activation, or any window
  // reported by the hook. sync() re-asserts once; the follow-ups cover the shell
  // raising the taskbar a moment later.
  function nudge(window, reason = 'nudge') {
    if (!sync(window, `${reason}+0`)) return false;
    for (const delay of nudgeDelays) {
      const handle = setTimeoutFn(() => {
        nudges.delete(handle);
        tick(`${reason}+${delay}`);
      }, delay);
      nudges.add(handle);
    }
    return true;
  }

  return {
    sync,
    nudge,
    stop,
    isRunning: () => Boolean(timer),
    isHooked: () => Boolean(unsubscribeForeground)
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
