'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HAPTIC_FEEDBACK_PATTERNS,
  HAPTIC_PERFORMANCE_TIMES,
  createMacHapticsApi,
  performMacHaptic
} = require('../../src/electron/edgeDock/macHaptics');

function fakeKoffi() {
  const selectors = new Map([
    ['defaultPerformer', 11n],
    ['performFeedbackPattern:performanceTime:', 12n]
  ]);
  const calls = [];
  return {
    calls,
    load() {
      return {
        func(name, returnType, argumentTypes) {
          if (name === 'objc_getClass') return (className) => className === 'NSHapticFeedbackManager' ? 100n : 0n;
          if (name === 'sel_registerName') return (selector) => selectors.get(selector);
          if (name === 'objc_msgSend' && returnType === 'uintptr_t') return () => 101n;
          if (name === 'objc_msgSend' && argumentTypes.length === 4) {
            return (receiver, selector, pattern, time) => calls.push({ receiver, selector, pattern, time });
          }
          throw new Error(`Unexpected native function: ${name}`);
        }
      };
    }
  };
}

test('AppKit bridge preserves the selected feedback pattern and timing', () => {
  const koffi = fakeKoffi();
  assert.equal(createMacHapticsApi(koffi).perform(
    HAPTIC_FEEDBACK_PATTERNS.alignment,
    HAPTIC_PERFORMANCE_TIMES.default
  ), true);
  assert.deepEqual(koffi.calls, [{
    receiver: 101n,
    selector: 12n,
    pattern: 1,
    time: 0
  }]);
});

test('semantic haptic names map to the AppKit enum values', () => {
  const calls = [];
  const api = {
    perform(pattern, time) {
      calls.push({ pattern, time });
      return true;
    }
  };
  assert.equal(performMacHaptic({ platform: 'darwin', pattern: 'generic', api }), true);
  assert.equal(performMacHaptic({ platform: 'darwin', pattern: 'alignment', api }), true);
  assert.deepEqual(calls, [
    { pattern: HAPTIC_FEEDBACK_PATTERNS.generic, time: HAPTIC_PERFORMANCE_TIMES.default },
    { pattern: HAPTIC_FEEDBACK_PATTERNS.alignment, time: HAPTIC_PERFORMANCE_TIMES.default }
  ]);
});

test('haptic bridge is a no-op away from macOS', () => {
  assert.equal(performMacHaptic({
    platform: 'win32',
    api: { perform: () => { throw new Error('must not call'); } }
  }), false);
});

test('haptic bridge fails closed when AppKit rejects feedback', () => {
  assert.equal(performMacHaptic({
    platform: 'darwin',
    api: { perform: () => { throw new Error('unavailable'); } }
  }), false);
});
