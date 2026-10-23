'use strict';

// Windows-only: keep the edge dock from being overtaken inside the topmost band.
//
// The dock windows are created with `alwaysOnTop: true` and promoted to
// 'pop-up-menu' the first time each one is shown. That level maps to
// HWND_TOPMOST, which is the highest band Windows has — and it is still only a
// band. Windows orders windows *within* a band by when they were last raised,
// and every topmost window that activates or is created afterwards is put in
// front of everything already there. So the dock can be perfectly topmost and
// still sit under a tray utility's floating status bar.
//
// Nothing re-asserts it afterwards, for three independent reasons:
//
//   1. The dock windows stay shown at opacity zero between reveals, so
//      controller.js's first-show repair (`if (!win.isVisible())`) never runs
//      again after the very first reveal.
//   2. controller.js does re-raise them on wake — but a wake is a wake, and the
//      overtake usually happens without one.
//   3. windowsTaskbarZOrder.js has a keeper, but it is scoped to the main
//      widget, is opt-in behind `keepAboveTaskbar`, and only runs while the
//      window overlaps the area the taskbar reserves. A dock parked on a screen
//      edge meets none of that, so the one existing mechanism is silent here.
//
// So this re-asserts on its own terms, and only when a probe says the dock has
// actually been overtaken — a blanket timer that moved the dock every tick
// would be wrong for a different reason: it would also raise the dock over IME
// candidate windows, which are topmost by design and which the user is looking
// straight at while typing. An IME window standing between the dock and the top
// of the band yields the round instead.

const DEFAULT_INTERVAL_MS = 750;

// Windows identifies IME windows by class, not by anything about who owns them,
// and the names differ between the TSF and legacy paths. TOOLITIPS2 is the
// classic candidate-window class and is topmost for the same reason.
const IME_CLASS = /^(IME|MSCTFIME UI|Default IME|TOOLITIPS2)$/i;

function isImeClass(className) {
  return typeof className === 'string' && IME_CLASS.test(className.trim());
}

// GetClassNameW reports a count of UTF-16 *characters*; Buffer.toString wants its
// end offset in *bytes*. Reading the count straight in as the offset decodes
// roughly half the name and truncates the last character into a replacement
// glyph, so on Windows the three-character class "IME" came out as "I" and no
// candidate window ever matched IME_CLASS — the guard this file exists for was
// silently inert. Decode the byte length the count actually implies, and strip
// the terminator the call leaves in the buffer.
function decodeClassName(buffer, written) {
  if (!Number.isInteger(written) || written <= 0) return '';
  return buffer.toString('utf16le', 0, Math.min(written * 2, buffer.length)).replace(/\0[\s\S]*$/, '').trim();
}

// Electron hands back the HWND as a raw little-endian buffer, not a number.
// A BigInt here would never === the plain number koffi returns for the same
// handle, which makes the whole "is the dock still above it" walk compare
// against nothing — so this normalises to a safe integer or gives up.
function nativeHandleOf(window) {
  try {
    const handle = window?.getNativeWindowHandle?.();
    if (!handle || typeof handle !== 'object' || handle.length < 4) return null;
    const value = handle.length >= 8
      ? handle.readBigUInt64LE(0)
      : BigInt(handle.readUInt32LE(0));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  } catch {
    return null;
  }
}

// Reads the live topmost-to-bottom window stack. Kept behind a dependency so the
// keeper's decisions can be exercised without a desktop: the interesting part
// of this file is which window it decides to raise, not how the HWND walk works.
function createZOrderProbe(platform = process.platform) {
  return async function probe() {
    if (platform !== 'win32') return [];
    let koffi;
    try { koffi = require('koffi'); } catch { return []; }
    let getTop; let getNext; let isVisible; let getExStyle; let getClassName; let classBuffer;
    try {
      const lib = koffi.load('user32.dll');
      getTop = lib.func('void * __stdcall GetTopWindow(void *hWnd)');
      getNext = lib.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)');
      isVisible = lib.func('bool __stdcall IsWindowVisible(void *hWnd)');
      // GetWindowLongW, not GetWindowLongPtrW: the WS_EX_* flags all live in
      // the low 32 bits, and the PtrW twin does not exist on 32-bit Windows.
      getExStyle = lib.func('int32_t __stdcall GetWindowLongW(void *hWnd, int iIndex)');
      classBuffer = Buffer.alloc(512);
      getClassName = lib.func('int32_t __stdcall GetClassNameW(void *hWnd, uint16_t *s, int32_t n)');
    } catch {
      return [];
    }

    const GWL_EXSTYLE = -20;
    const WS_EX_TOPMOST = 0x00000008;
    const GW_HWNDNEXT = 2;
    const entries = [];
    try {
      let hwnd = getTop(0);
      // Bounded so a shell that grows the stack cannot turn this into a spin.
      let guard = 0;
      while (hwnd && guard < 512) {
        guard += 1;
        let name = '';
        try {
          name = decodeClassName(classBuffer, getClassName(hwnd, classBuffer, 256));
        } catch { name = ''; }
        entries.push({
          // koffi 3.1.5 hands back `void *` as a BigInt, while nativeHandleOf
          // returns a plain number. Comparing those with === finds nothing ever,
          // which reads as "the dock is not on the stack" and raises on every
          // tick. Normalise to the number the other side produces; window handles
          // are far below 2^53, and anything that somehow is not is left out
          // rather than silently compared as an approximate value.
          handle: (typeof hwnd === 'bigint' ? Number(hwnd) : hwnd),
          visible: Boolean(isVisible(hwnd)),
          topmost: (getExStyle(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0,
          ime: isImeClass(name)
        });
        hwnd = getNext(hwnd, GW_HWNDNEXT);
      }
    } catch {
      return [];
    }
    return entries;
  };
}

function createEdgeDockZOrderKeeper(options = {}) {
  const platform = options.platform || process.platform;
  const probe = options.probe || createZOrderProbe(platform);
  const subscribeForeground = options.subscribeForeground;
  const log = typeof options.log === 'function' ? options.log : null;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const interval = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;

  let timer = null;
  let unsubscribe = null;
  let targets = [];
  let inFlight = false;
  // controller.js calls sync() from setVisible, which runs on every reveal and
  // every retract. Without this the same three windows would re-walk the live
  // HWND stack dozens of times a second for no reason; the interval below is
  // what covers a real overtake.
  let signature = null;

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    targets = [];
    signature = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  // A dock window that is gone, hidden or no longer topmost must not keep the
  // keeper alive — every one of those is reachable without the keeper knowing.
  function claimable(window) {
    if (platform !== 'win32') return false;
    if (!window || window.isDestroyed?.()) return false;
    if (typeof window.isVisible === 'function' && !window.isVisible()) return false;
    if (typeof window.isMinimized === 'function' && window.isMinimized()) return false;
    if (typeof window.isAlwaysOnTop === 'function' && !window.isAlwaysOnTop()) return false;
    return nativeHandleOf(window) !== null;
  }

  function start() {
    if (timer) return;
    if (subscribeForeground) {
      try { unsubscribe = subscribeForeground(() => { tick('foreground'); }) || null; } catch { unsubscribe = null; }
    }
    timer = setIntervalFn(() => { tick('tick'); }, interval);
    if (log) log(`start hook=${unsubscribe ? 'installed' : 'none'} interval=${interval}ms`);
  }

  // The decision, split out so it can be read as a rule: walk the stack from the
  // top, and the first visible topmost window standing above the dock is the one
  // that overtook it — unless that window is an IME window.
  function verdictFor(entries, handle) {
    for (const entry of entries) {
      if (entry.handle === handle) return { raise: false, yieldToIme: false };
      if (!entry.visible || !entry.topmost) continue;
      if (entry.ime) return { raise: false, yieldToIme: true };
      return { raise: true, yieldToIme: false };
    }
    // The dock is not on the stack at all (being rebuilt, or a race with the
    // probe). Re-raising costs nothing and covers the case.
    return { raise: true, yieldToIme: false };
  }

  async function tick(reason) {
    if (platform !== 'win32' || !targets.length) return;
    if (inFlight) return;
    inFlight = true;
    try {
      let entries;
      try { entries = await probe(); } catch { return; }
      if (!Array.isArray(entries) || !entries.length) return;
      let raised = 0;
      let yielded = 0;
      for (const window of targets) {
        if (!claimable(window)) continue;
        const handle = nativeHandleOf(window);
        if (handle === null) continue;
        const verdict = verdictFor(entries, handle);
        if (verdict.yieldToIme) { yielded += 1; continue; }
        if (!verdict.raise) continue;
        try { window.moveTop(); raised += 1; } catch { /* torn down mid-call */ }
      }
      if (log && (raised || yielded)) log(`${reason} raised=${raised} ime-yield=${yielded}`);
    } finally {
      inFlight = false;
    }
  }

  function sync(windows) {
    const next = (Array.isArray(windows) ? windows : []).filter(claimable);
    targets = next;
    if (!next.length) { stop(); return false; }
    const nextSignature = next.map(nativeHandleOf).join(',');
    const changed = nextSignature !== signature;
    signature = nextSignature;
    start();
    // First sight of a window set gets an immediate check so a dock that comes
    // back from hidden does not wait out an interval to be put on top.
    if (changed) tick('sync');
    return true;
  }

  return {
    sync,
    stop,
    isRunning: () => Boolean(timer),
    isHooked: () => Boolean(unsubscribe)
  };
}

module.exports = {
  createEdgeDockZOrderKeeper,
  createZOrderProbe,
  decodeClassName,
  isImeClass,
  nativeHandleOf
};
