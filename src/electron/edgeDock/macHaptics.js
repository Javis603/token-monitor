'use strict';

// Electron does not expose AppKit's trackpad haptics. Reach the public
// NSHapticFeedbackManager API through the Objective-C runtime, using the same
// lazy/best-effort bridge as the dock's native material mask. Nothing is loaded
// on other platforms, and Macs without haptic hardware simply produce no
// physical feedback.

const HAPTIC_FEEDBACK_PATTERNS = Object.freeze({
  generic: 0,
  alignment: 1,
  levelChange: 2
});
const HAPTIC_PERFORMANCE_TIMES = Object.freeze({
  default: 0,
  now: 1,
  drawCompleted: 2
});

let api = null;

function createMacHapticsApi(koffi) {
  // AppKit is already present in Electron, but loading it explicitly also makes
  // the bridge deterministic in small Node-based smoke tests.
  const appKit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const getClass = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const send = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const sendFeedback = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'int64_t', 'uint64_t']);
  const managerClass = getClass('NSHapticFeedbackManager');
  const defaultPerformer = sel('defaultPerformer');
  const performFeedback = sel('performFeedbackPattern:performanceTime:');

  return {
    perform(pattern, performanceTime) {
      if (!appKit || !managerClass) return false;
      const performer = send(managerClass, defaultPerformer);
      if (!performer) return false;
      sendFeedback(performer, performFeedback, pattern, performanceTime);
      return true;
    }
  };
}

function loadApi() {
  if (api !== null) return api;
  try {
    api = createMacHapticsApi(require('koffi'));
  } catch {
    api = false;
  }
  return api;
}

function performMacHaptic(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return false;
  const bridge = options.api || loadApi();
  if (!bridge) return false;
  const pattern = HAPTIC_FEEDBACK_PATTERNS[options.pattern || 'generic'];
  const performanceTime = HAPTIC_PERFORMANCE_TIMES[options.performanceTime || 'default'];
  if (pattern === undefined || performanceTime === undefined) return false;
  try {
    return bridge.perform(pattern, performanceTime) === true;
  } catch {
    return false;
  }
}

module.exports = {
  HAPTIC_FEEDBACK_PATTERNS,
  HAPTIC_PERFORMANCE_TIMES,
  createMacHapticsApi,
  performMacHaptic
};
