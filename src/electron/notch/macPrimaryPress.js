'use strict';

// AppKit's local and global mouse monitors cover our app and other apps,
// respectively. They observe presses without capturing input or activating a
// window. Only leftMouseDown is monitored; no keyboard/accessibility access.
let api = null;

function createMacPrimaryPressMonitor(koffi) {
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const system = koffi.load('/usr/lib/libSystem.B.dylib');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const send = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const responds = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const add = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uint64_t', 'void *']);
  const remove = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const point = koffi.struct({ x: 'double', y: 'double' });
  const location = cg.func('CGEventGetLocation', point, ['uintptr_t']);
  const eventClass = getClass('NSEvent'), respondsSelector = sel('respondsToSelector:');
  const globalSelector = sel('addGlobalMonitorForEventsMatchingMask:handler:');
  const localSelector = sel('addLocalMonitorForEventsMatchingMask:handler:');
  const removeSelector = sel('removeMonitor:'), cgEventSelector = sel('CGEvent');
  const blockClass = system.symbol('_NSConcreteGlobalBlock');
  // No-capture blocks use the documented Clang Block ABI. Pin the buffers and
  // registered callbacks until AppKit has removed both monitors. A global
  // block's copy/release are no-ops; it needs no native capture helpers.
  // https://clang.llvm.org/docs/Block-ABI-Apple.html
  const descriptorType = koffi.struct({ reserved: 'uintptr_t', size: 'uintptr_t' });
  const blockType = koffi.struct({ isa: 'void *', flags: 'int', reserved: 'int', invoke: 'void *', descriptor: 'void *' });
  const globalCallback = koffi.pointer(koffi.proto('void', ['void *', 'uintptr_t']));
  const localCallback = koffi.pointer(koffi.proto('uintptr_t', ['void *', 'uintptr_t']));
  const subscriptions = new Set();

  return onPress => {
    if (!eventClass || ![globalSelector, localSelector, removeSelector].every(selector => responds(eventClass, respondsSelector, selector))) return null;
    const subscription = { active: true, entries: [] };
    subscriptions.add(subscription);
    const dispose = () => {
      if (!subscription.active) return;
      subscription.active = false;
      // Remove native ownership before freeing callback slots. If removal
      // fails, keep that entry pinned and inert rather than risk a native UAF.
      const removed = [];
      let failure;
      for (const entry of subscription.entries) {
        try { if (entry.monitor) remove(eventClass, removeSelector, entry.monitor); }
        catch (error) { failure ||= error; continue; }
        entry.monitor = null;
        removed.push(entry);
      }
      // Disposal may run from inside a monitored press; leave its native
      // callback frame before unregistering the trampoline or releasing buffers.
      setImmediate(() => {
        for (const entry of removed) koffi.unregister(entry.callback);
        subscription.entries = subscription.entries.filter(entry => entry.monitor);
        if (!subscription.entries.length) subscriptions.delete(subscription);
      });
      if (failure) throw failure;
    };
    const dispatch = event => {
      if (!subscription.active) return;
      const cgEvent = send(event, cgEventSelector);
      if (cgEvent) onPress(location(cgEvent));
    };
    try {
      for (const local of [false, true]) {
        const callback = koffi.register((_block, event) => {
          // Local monitors must return the original event even if JS handling
          // fails; throwing through Koffi would return nil and swallow the click.
          try { dispatch(event); } catch { /* Monitoring must never eat input. */ }
          if (local) return event;
        }, local ? localCallback : globalCallback);
        const entry = { callback, block: Buffer.alloc(koffi.sizeof(blockType)), descriptor: Buffer.alloc(koffi.sizeof(descriptorType)), monitor: null };
        subscription.entries.push(entry);
        koffi.encode(entry.descriptor, descriptorType, { reserved: 0, size: entry.block.length });
        koffi.encode(entry.block, blockType, { isa: blockClass, flags: 1 << 28, reserved: 0, invoke: callback, descriptor: entry.descriptor });
        entry.monitor = add(eventClass, local ? localSelector : globalSelector, 1n << 1n, entry.block);
        if (!entry.monitor) throw new Error('AppKit mouse monitor unavailable');
      }
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  };
}

function monitorMacPrimaryPress(onPress, { platform = process.platform, api: providedApi, logger = () => {} } = {}) {
  if (platform !== 'darwin') return null;
  try {
    if (!providedApi && api === null) api = createMacPrimaryPressMonitor(require('koffi'));
    return (providedApi || api)(onPress);
  } catch (error) {
    logger(`[top-notch] click monitoring unavailable: ${error.message}`);
    return null;
  }
}

module.exports = { createMacPrimaryPressMonitor, monitorMacPrimaryPress };
