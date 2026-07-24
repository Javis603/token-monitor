'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE,
  createMacSpaceApi,
  setMoveToActiveSpace
} = require('../../src/electron/macosSpaceBehavior');

function fakeKoffi(initialBehavior) {
  const selectors = new Map([
    ['window', 11n],
    ['collectionBehavior', 12n],
    ['setCollectionBehavior:', 13n]
  ]);
  const calls = [];
  return {
    calls,
    load() {
      return {
        func(name, returnType, argumentTypes) {
          if (name === 'sel_registerName') return (selector) => selectors.get(selector);
          if (name === 'objc_msgSend' && returnType === 'uintptr_t') {
            return (receiver, selector) => selector === 11n ? 101n : initialBehavior;
          }
          if (name === 'objc_msgSend' && argumentTypes.length === 3) {
            return (receiver, selector, behavior) => calls.push({ receiver, selector, behavior });
          }
          throw new Error(`Unexpected native function: ${name}`);
        }
      };
    }
  };
}

test('AppKit bridge adds and removes moveToActiveSpace without changing other flags', () => {
  const addKoffi = fakeKoffi(8n);
  assert.equal(createMacSpaceApi(addKoffi).setMoveToActiveSpace(100n, true), true);
  assert.deepEqual(addKoffi.calls, [{
    receiver: 101n,
    selector: 13n,
    behavior: 8n | NS_WINDOW_COLLECTION_BEHAVIOR_MOVE_TO_ACTIVE_SPACE
  }]);

  const removeKoffi = fakeKoffi(10n);
  assert.equal(createMacSpaceApi(removeKoffi).setMoveToActiveSpace(100n, false), true);
  assert.deepEqual(removeKoffi.calls, [{ receiver: 101n, selector: 13n, behavior: 8n }]);
});

test('native bridge is a no-op away from macOS', () => {
  const win = {
    getNativeWindowHandle() {
      throw new Error('must not read a native handle');
    }
  };
  assert.equal(setMoveToActiveSpace(win, true, { platform: 'linux' }), false);
});

test('main process reapplies the complete Space policy before showing either mode', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const policy = main.match(/function applyMacSpaceBehavior[\s\S]*?\n}\n\nfunction applyWindowSettings/)[0];
  const popover = main.match(/function showPopover[\s\S]*?\n}\n\nfunction hidePopover/)[0];
  const focusWindow = main.match(/function focusExistingWindow[\s\S]*?\n}\n\nfunction currentWindowToggleShortcutStatus/)[0];

  assert.match(policy, /setMoveToActiveSpace\(mainWindow, false\)[\s\S]*setVisibleOnAllWorkspaces\(true, \{[\s\S]*visibleOnFullScreen: true,[\s\S]*skipTransformProcessType: true/);
  assert.match(policy, /setVisibleOnAllWorkspaces\(false\)[\s\S]*setHiddenInMissionControl\(false\)[\s\S]*setMoveToActiveSpace\(mainWindow, true\)/);
  assert.match(policy, /setHiddenInMissionControl\(true\)/);
  assert.match(popover, /applyMacSpaceBehavior\(true\)[\s\S]*mainWindow\.show\(\)/);
  assert.match(focusWindow, /applyMacSpaceBehavior\(false\)[\s\S]*mainWindow\.show\(\)/);
  assert.doesNotMatch(main, /mainWindow\.show\(\);\s*mainWindow\.focus\(\);/);
});
