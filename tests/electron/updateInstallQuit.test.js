'use strict';

// quitAndInstall() reports nothing back, so the app can be left running with the
// flags that were claimed on the way in. Those two flags make the tray Exit a
// no-op and disable the forced exit, which would strand the user in an app that
// cannot be quit until it is restarted. main.js cannot be required outside
// Electron, hence the source-level contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

const { updateInstallQuitGraceMs } = require('../../src/electron/runtimeConfig');

test('the grace period exists only where a failed hand-off is silent', () => {
  // BaseUpdater runs install() synchronously and quits on the next tick when it
  // worked; when it did not it resets its own state and emits nothing, so the
  // timer is the only recovery and success never approaches it.
  for (const platform of ['win32', 'linux']) {
    const graceMs = updateInstallQuitGraceMs(platform);
    assert.ok(graceMs > 0, `${platform} needs a fallback`);
    assert.ok(graceMs >= 5_000, `${platform} must not race a next-tick quit`);
  }

  // MacUpdater frequently returns from quitAndInstall() without quitting: it
  // waits on a native update-downloaded that has no deadline, and the real quit
  // follows whenever that lands. A timer would clear the flags mid-hand-off and
  // let the forced exit pre-empt the installer. Native errors are forwarded, so
  // the failure path stays covered without one.
  assert.equal(updateInstallQuitGraceMs('darwin'), null);
});

function functionSource(signature) {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = main.indexOf('\nfunction ', start + signature.length);
  return main.slice(start, end === -1 ? main.length : end);
}

test('the install hand-off claims the quit flags through the release helper', () => {
  const install = functionSource('function installDownloadedAppUpdate()');
  assert.match(install, /updateInstallQuitPending = true;/);
  assert.match(install, /quitRequested = true;/);
  assert.match(install, /skipForcedQuit = true;/);

  // A synchronous throw leaves the app running, so it has to give them back.
  const guarded = /try \{[\s\S]*?autoUpdater\.quitAndInstall\([\s\S]*?\} catch \(error\) \{[\s\S]*?releaseUpdateInstallQuit\(\);/.exec(install);
  assert.ok(guarded, 'quitAndInstall must release the flags when it throws');

  // Where a failed hand-off is silent, still being alive later is the signal, and
  // where it is unbounded the policy returns null so no timer is armed at all.
  assert.match(install, /const graceMs = updateInstallQuitGraceMs\(\);/);
  assert.match(install, /if \(graceMs !== null\) \{/);
  assert.match(install, /setTimeout\(releaseUpdateInstallQuit, graceMs\)/);
  // The fallback must never be the reason the process stays up.
  assert.match(install, /updateInstallQuitTimer\.unref\?\.\(\)/);
});

test('the release helper puts back everything the hand-off took', () => {
  const release = functionSource('function releaseUpdateInstallQuit()');
  assert.match(release, /updateInstallQuitPending = false;/);
  assert.match(release, /clearTimeout\(updateInstallQuitTimer\)/);
  // Both flags, not just the one this change introduced: quitRequested has been
  // set here since before the forced exit existed, and on its own it is already
  // enough to make requestAppQuit return early forever.
  assert.match(release, /quitRequested = false;/);
  assert.match(release, /skipForcedQuit = false;/);
});

test('an updater error releases the install flags ahead of the download guard', () => {
  const handler = main.slice(main.indexOf("autoUpdater.on('error'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  const releaseAt = body.indexOf('releaseUpdateInstallQuit();');
  const guardAt = body.indexOf('if (!appUpdateNativeBusy');
  assert.ok(releaseAt >= 0 && guardAt >= 0);
  // update-downloaded has already cleared appUpdateNativeBusy by the time an
  // install can fail, so a rollback behind that guard would never run.
  assert.ok(releaseAt < guardAt, 'the rollback has to come before the early return');
  assert.match(body, /wasInstalling/);
});
