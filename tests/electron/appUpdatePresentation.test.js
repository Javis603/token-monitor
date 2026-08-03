'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appUpdateErrorMessageKey,
  appUpdateStatusPresentation,
  automaticAppUpdateControlState
} = require('../../src/electron/renderer/appUpdatePresentation');

test('failed checks mark cached versions as last known instead of up to date', () => {
  assert.deepEqual(appUpdateStatusPresentation({
    currentVersion: '0.39.0',
    latest: { version: '0.39.0' },
    hasUpdate: false,
    lastCheckedAt: '2026-08-03T08:00:00.000Z',
    lastError: 'network down',
    lastErrorKind: 'network'
  }), {
    displayVersion: '0.39.0',
    latestStatusKey: 'settings.appUpdate.lastKnownShort',
    errorKey: 'settings.appUpdate.githubError',
    lastSuccessfulCheckAt: '2026-08-03T08:00:00.000Z'
  });
});

test('successful current-version checks retain the up-to-date status', () => {
  assert.deepEqual(appUpdateStatusPresentation({
    currentVersion: '0.39.0',
    latest: { version: '0.39.0' },
    hasUpdate: false,
    lastCheckedAt: '2026-08-03T08:00:00.000Z',
    lastError: null
  }), {
    displayVersion: '0.39.0',
    latestStatusKey: 'settings.appUpdate.upToDateShort',
    errorKey: '',
    lastSuccessfulCheckAt: null
  });
});

test('failed checks without cached data do not invent a latest version', () => {
  assert.deepEqual(appUpdateStatusPresentation({
    currentVersion: '0.39.0',
    latest: null,
    lastCheckedAt: null,
    lastError: 'rate limited',
    lastErrorKind: 'rateLimited'
  }), {
    displayVersion: '',
    latestStatusKey: '',
    errorKey: 'settings.appUpdate.rateLimited',
    lastSuccessfulCheckAt: null
  });
});

test('update error presentation distinguishes actionable failure classes', () => {
  assert.equal(appUpdateErrorMessageKey('rateLimited'), 'settings.appUpdate.rateLimited');
  assert.equal(appUpdateErrorMessageKey('timeout'), 'settings.appUpdate.timeout');
  assert.equal(appUpdateErrorMessageKey('githubUnavailable'), 'settings.appUpdate.githubUnavailable');
  assert.equal(appUpdateErrorMessageKey('metadata'), 'settings.appUpdate.metadataError');
  assert.equal(appUpdateErrorMessageKey('network'), 'settings.appUpdate.githubError');
  assert.equal(appUpdateErrorMessageKey('unknown'), 'settings.appUpdate.githubError');
});

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
