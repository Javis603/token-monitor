'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appUpdateActionMode,
  appUpdateErrorMessageKey,
  appUpdateInstallErrorMessageKey,
  appUpdateStatusPresentation,
  automaticAppUpdateControlState
} = require('../../src/electron/renderer/appUpdatePresentation');
const { MESSAGES } = require('../../src/electron/renderer/i18n');

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

test('the two install failures the user can act on get their own message', () => {
  // Both mean the app is still running and only a restart yields another attempt,
  // which the generic "couldn't install" cannot say.
  assert.equal(
    appUpdateInstallErrorMessageKey('installer-did-not-start'),
    'settings.appUpdate.installerDidNotStart'
  );
  assert.equal(
    appUpdateInstallErrorMessageKey('attempt-spent'),
    'settings.appUpdate.installAttemptSpent'
  );
  // Anything the updater merely reported stays generic.
  assert.equal(appUpdateInstallErrorMessageKey(null), 'settings.appUpdate.installError');
  assert.equal(appUpdateInstallErrorMessageKey(undefined), 'settings.appUpdate.installError');
  assert.equal(appUpdateInstallErrorMessageKey('some-updater-failure'), 'settings.appUpdate.installError');
});

test('every locale can say how to recover from an install that never started', () => {
  // The renderer never shows the main process error text, so a message with no key
  // behind it reaches nobody.
  for (const kind of ['installer-did-not-start', 'attempt-spent']) {
    const key = appUpdateInstallErrorMessageKey(kind);
    for (const locale of Object.keys(MESSAGES)) {
      assert.equal(typeof MESSAGES[locale][key], 'string', `${locale} is missing ${key}`);
      assert.ok(MESSAGES[locale][key].length > 0, `${locale} has an empty ${key}`);
    }
  }
});

test('the hand-off window has its own message, ahead of ready to install', () => {
  const app = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../../src/electron/renderer/app.js'),
    'utf8'
  );
  const chain = app.slice(app.indexOf("if (s.installPhase === 'downloading')"));
  const startingAt = chain.indexOf('s.installStarting');
  const downloadedAt = chain.indexOf('} else if (s.downloaded) {');
  assert.ok(startingAt >= 0, 'the hand-off window has to say something');
  assert.ok(downloadedAt >= 0, 'the ready branch has to still be there');
  // Order is the whole point: `downloaded` stays true through the hand-off, so a
  // branch placed after it would never run and the row would keep claiming the
  // update is merely ready while the installer is already starting.
  assert.ok(startingAt < downloadedAt, 'installStarting has to be tested first');
  assert.match(chain.slice(startingAt, downloadedAt), /settings\.appUpdate\.installStarting/);

  for (const locale of Object.keys(MESSAGES)) {
    const value = MESSAGES[locale]['settings.appUpdate.installStarting'];
    assert.equal(typeof value, 'string', `${locale} is missing the hand-off message`);
    assert.ok(value.length > 0, `${locale} has an empty hand-off message`);
  }
});

const READY = {
  hasUpdate: true,
  installSupported: true,
  downloaded: true,
  installRetryBlocked: false,
  latest: { version: '0.43.0', htmlUrl: 'https://example.invalid/r' }
};

test('the action follows what the app can actually do next', () => {
  assert.equal(appUpdateActionMode(READY), 'install');
  assert.equal(appUpdateActionMode({ ...READY, downloaded: false }), 'download');
  assert.equal(appUpdateActionMode({ ...READY, downloaded: false, installSupported: false }), 'release');
  assert.equal(appUpdateActionMode({ ...READY, downloaded: false, hasUpdate: false }), '');
  assert.equal(appUpdateActionMode(null), '');
});

test('a spent attempt closes the in-app path instead of offering a download', () => {
  // Re-downloading only buys another refusal, and on macOS it restarts a download
  // lifecycle while the first Squirrel request may still be live. This is the one
  // branch that has to win over `downloaded`, since a stalled attempt clears it and
  // the control would otherwise turn back into Download.
  const spent = { ...READY, downloaded: false, installRetryBlocked: true };
  assert.equal(appUpdateActionMode(spent), 'release');
  assert.equal(appUpdateActionMode({ ...spent, downloaded: true }), 'release');
  // With nowhere manual to send them either, offer nothing rather than a dead end.
  assert.equal(appUpdateActionMode({ ...spent, latest: { version: '0.43.0' } }), '');
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
