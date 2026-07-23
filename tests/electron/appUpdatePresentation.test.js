'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  automaticAppUpdateControlState
} = require('../../src/electron/renderer/appUpdatePresentation');

test('automatic download control is enabled only for supported idle builds', () => {
  assert.deepEqual(automaticAppUpdateControlState({
    preferenceEnabled: true,
    updateState: { installSupported: true, installBusy: false }
  }), {
    checked: true,
    disabled: false,
    unavailable: false,
    descriptionKey: 'settings.appUpdate.automaticDescription'
  });

  assert.deepEqual(automaticAppUpdateControlState({
    preferenceEnabled: true,
    updateState: { installSupported: true, installBusy: true }
  }), {
    checked: true,
    disabled: true,
    unavailable: false,
    descriptionKey: 'settings.appUpdate.automaticDescription'
  });
});

test('supported idle builds keep automatic downloads available when switched off', () => {
  assert.deepEqual(automaticAppUpdateControlState({
    preferenceEnabled: false,
    updateState: { installSupported: true, installBusy: false }
  }), {
    checked: false,
    disabled: false,
    unavailable: false,
    descriptionKey: 'settings.appUpdate.automaticDescription'
  });
});

test('unsupported automatic download controls are off, disabled, and explain why', () => {
  const reasons = new Map([
    ['unpackaged', 'settings.appUpdate.automaticUnsupportedUnpackaged'],
    ['windows-portable', 'settings.appUpdate.automaticUnsupportedWindowsPortable'],
    ['linux-not-appimage', 'settings.appUpdate.automaticUnsupportedLinux'],
    ['unsupported-platform', 'settings.appUpdate.automaticUnsupported']
  ]);

  for (const [reason, descriptionKey] of reasons) {
    assert.deepEqual(automaticAppUpdateControlState({
      preferenceEnabled: true,
      updateState: {
        installSupported: false,
        installSupportReason: reason,
        installBusy: false
      }
    }), {
      checked: false,
      disabled: true,
      unavailable: true,
      descriptionKey
    });
  }
});

test('automatic download control fails closed until install support is known', () => {
  assert.deepEqual(automaticAppUpdateControlState({
    preferenceEnabled: true,
    updateState: null
  }), {
    checked: false,
    disabled: true,
    unavailable: false,
    descriptionKey: 'settings.appUpdate.automaticCheckingSupport'
  });
});
