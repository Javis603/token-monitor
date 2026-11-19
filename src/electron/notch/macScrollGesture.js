'use strict';

// Native tracking is limited to precise horizontal gestures in the Notch window.
// Vertical scrolling, zoom and other windows retain their events.
let api = null;
const SCROLL_MASK = 1n << 22n;
const PHASES = [[16, 'cancelled'], [8, 'ended'], [4, 'changed'], [1, 'began']];
const phaseName = bits => PHASES.find(([bit]) => Number(bits) & bit)?.[1] || 'none';

function createMacScrollGestureMonitor(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const system = koffi.load('/usr/lib/libSystem.B.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const bind = (result, args = []) => objc.func('objc_msgSend', result, ['uintptr_t', 'uintptr_t', ...args]);
  const idOf = bind('uintptr_t'), bitsOf = bind('uint64_t'), flagOf = bind('bool'), numberOf = bind('double');
  const responds = bind('bool', ['uintptr_t']);
  const add = bind('uintptr_t', ['uint64_t', 'void *']), remove = bind('void', ['uintptr_t']);
  const track = bind('void', ['uint64_t', 'double', 'double', 'void *']);
  const location = cg.func('CGEventGetLocation', koffi.struct({ x: 'double', y: 'double' }), ['uintptr_t']);
  const eventClass = getClass('NSEvent');
  const names = Object.fromEntries(['window', 'phase', 'momentumPhase', 'scrollingDeltaX', 'scrollingDeltaY', 'modifierFlags',
    'hasPreciseScrollingDeltas', 'isDirectionInvertedFromDevice', 'CGEvent', 'isSwipeTrackingFromScrollEventsEnabled',
    'trackSwipeEventWithOptions:dampenAmountThresholdMin:max:usingHandler:', 'addLocalMonitorForEventsMatchingMask:handler:', 'removeMonitor:']
    .map(name => [name, sel(name)]));
  const trackSelector = names['trackSwipeEventWithOptions:dampenAmountThresholdMin:max:usingHandler:'];
  const descriptorType = koffi.struct({ reserved: 'uintptr_t', size: 'uintptr_t' });
  const blockType = koffi.struct({ isa: 'void *', flags: 'int', reserved: 'int', invoke: 'void *', descriptor: 'void *' });
  // Global-block buffers and callbacks remain valid throughout native ownership.
  const held = new Set();
  function block(fn, result, args) {
    const entry = { callback: koffi.register(fn, koffi.pointer(koffi.proto(result, ['void *', ...args]))),
      bytes: Buffer.alloc(koffi.sizeof(blockType)), descriptor: Buffer.alloc(koffi.sizeof(descriptorType)) };
    koffi.encode(entry.descriptor, descriptorType, { reserved: 0, size: entry.bytes.length });
    koffi.encode(entry.bytes, blockType, { isa: system.symbol('_NSConcreteGlobalBlock'), flags: 1 << 28,
      reserved: 0, invoke: entry.callback, descriptor: entry.descriptor });
    held.add(entry);
    return entry;
  }
  function release(entry) {
    // Unregister callbacks only after returning to AppKit.
    setImmediate(() => { if (held.delete(entry)) koffi.unregister(entry.callback); });
  }

  return {
    subscribe(onEvent, { view, shouldTrack = () => true } = {}) {
      if (!eventClass || !responds(eventClass, sel('instancesRespondToSelector:'), trackSelector)) return null;
      const nativeWindow = view ? idOf(view, names.window) : 0n;
      if (!nativeWindow) return null;
      let disposed = false, active = null, sequence = 0;
      const cancel = () => { if (active) active.cancelled = true; };
      const monitorBlock = block((_block, event) => {
        try {
          if (disposed || idOf(event, names.window) !== nativeWindow) return event;
          if (active && !active.lifted) return 0n;
          const phase = Number(bitsOf(event, names.phase));
          if (!(phase & 5) || bitsOf(event, names.momentumPhase)
            || !flagOf(event, names.hasPreciseScrollingDeltas)
            || Number(bitsOf(event, names.modifierFlags)) & (1 << 18)) return event;
          const dx = numberOf(event, names.scrollingDeltaX), dy = numberOf(event, names.scrollingDeltaY);
          if (Math.abs(dx) <= Math.abs(dy) || !shouldTrack()
            || !flagOf(eventClass, names.isSwipeTrackingFromScrollEventsEnabled)) return event;
          cancel();
          const point = location(idOf(event, names.CGEvent));
          // AppKit's signed progress is opposite the hand under natural scrolling.
          const token = { id: ++sequence, direction: flagOf(event, names.isDirectionInvertedFromDevice) ? -1 : 1 };
          active = token;
          let entry;
          entry = block((_handler, amount, phaseBits, complete, stop) => {
            try {
              if (disposed || token.cancelled || !shouldTrack()) {
                koffi.encode(stop, 'bool', true);
                if (active === token) {
                  active = null;
                  if (!disposed) onEvent({ id: token.id, amount: 0, phase: 'cancelled', complete: true, x: point.x, y: point.y });
                }
                release(entry);
                return;
              }
              const phase = phaseName(phaseBits);
              if (phase === 'ended' || phase === 'cancelled') token.lifted = true;
              onEvent({ id: token.id, amount: amount * token.direction, phase, complete, x: point.x, y: point.y });
              if (complete) { if (active === token) active = null; release(entry); }
            } catch {
              koffi.encode(stop, 'bool', true);
              if (active === token) active = null;
              release(entry);
            }
          }, 'void', ['double', 'uint64_t', 'bool', 'void *']);
          // A new finger gesture supersedes any settling animation.
          track(event, trackSelector, 2n, -1, 1, entry.bytes);
          return 0n;
        } catch { return event; }
      }, 'uintptr_t', ['uintptr_t']);
      const monitor = add(eventClass, names['addLocalMonitorForEventsMatchingMask:handler:'], SCROLL_MASK, monitorBlock.bytes);
      if (!monitor) { release(monitorBlock); return null; }
      return {
        cancel,
        dispose() {
          if (disposed) return;
          disposed = true;
          cancel();
          remove(eventClass, names['removeMonitor:'], monitor);
          release(monitorBlock);
        }
      };
    }
  };
}

function monitorMacScrollGesture(onEvent, { platform = process.platform, api: providedApi, logger = () => {}, ...options } = {}) {
  if (platform !== 'darwin') return null;
  try {
    if (!providedApi && !api) api = createMacScrollGestureMonitor(require('koffi'));
    return (providedApi || api).subscribe(onEvent, options);
  } catch (error) {
    logger(`[top-notch] swipe tracking unavailable: ${error.message}`);
    return null;
  }
}
module.exports = { SCROLL_MASK, createMacScrollGestureMonitor, monitorMacScrollGesture };
