'use strict';

// The install-quit guard rests on facts about its dependencies rather than on our
// own code, so nothing in this repo fails when one of them changes. They are
// load-bearing: get any wrong and the app either cannot be quit or stacks install
// attempts. This pins each to what we actually ship against and fails the moment a
// bump moves it.
//
// Most are electron-updater implementation details, which upstream owes us nothing
// about. The last is Electron public API, pinned because a policy decision rests on
// it rather than because it is fragile.
//
// A red test here is not a bug in our code. It means the assumptions below have
// to be re-read against the new version before the guard can be trusted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'node_modules/electron-updater/out');
const ELECTRON_TYPES = path.join(ROOT, 'node_modules/electron/electron.d.ts');
const PINNED = '6.8.9';

function upstream(file) {
  try {
    return fs.readFileSync(path.join(OUT, file), 'utf8');
  } catch (_) {
    return null;
  }
}

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `${from} not found upstream`);
  const end = source.indexOf(to, start + from.length);
  return source.slice(start, end === -1 ? source.length : end);
}

const installed = (() => {
  try {
    return require('electron-updater/package.json').version;
  } catch (_) {
    return null;
  }
})();

test('the pinned electron-updater is the one these assumptions were read from', (t) => {
  if (!installed) return t.skip('electron-updater is not installed');
  assert.equal(
    require('../../package.json').dependencies['electron-updater'],
    PINNED,
    'the dependency must stay pinned exactly, since the guard reads implementation details'
  );
  assert.equal(installed, PINNED);
});

test('BaseUpdater announces a successful install on Electron own autoUpdater', (t) => {
  const source = upstream('BaseUpdater.js');
  if (!source) return t.skip('electron-updater is not installed');
  const fn = slice(source, 'quitAndInstall(isSilent', '\n    executeDownload(');
  // The hand-off signal the guard waits for, and the reason it listens on
  // require('electron').autoUpdater rather than electron-updater's own emitter.
  assert.match(fn, /require\("electron"\)\.autoUpdater\.emit\("before-quit-for-update"\)/);
  // Emitted only when install() actually succeeded, which is what makes its
  // absence a usable failure signal.
  assert.match(fn, /if \(isInstalled\) \{[\s\S]*?before-quit-for-update/);
});

test('BaseUpdater resets itself when an install fails, so a retry is clean', (t) => {
  const source = upstream('BaseUpdater.js');
  if (!source) return t.skip('electron-updater is not installed');
  const fn = slice(source, 'quitAndInstall(isSilent', '\n    executeDownload(');
  // This is why Windows and Linux end a failed attempt in `idle` rather than
  // `spent`: nothing is left attached and the call may be made again.
  assert.match(fn, /else \{\s*this\.quitAndInstallCalled = false;/);
});

test('MacUpdater attaches an update-downloaded listener it never detaches', (t) => {
  const source = upstream('MacUpdater.js');
  if (!source) return t.skip('electron-updater is not installed');
  const fn = slice(source, '\n    quitAndInstall() {', '\n    handleUpdateDownloaded(');
  // Anonymous, and `on` rather than `once`, so a second quitAndInstall() leaves two
  // of them and each re-enters the install when Squirrel answers. This is the whole
  // reason a macOS attempt is single-use.
  assert.match(fn, /this\.nativeUpdater\.on\("update-downloaded", \(\) => this\.handleUpdateDownloaded\(\)\)/);

  // And nothing anywhere takes it back off. The only listeners upstream removes
  // are the error/reject pair belonging to the download promise.
  const detachments = source.match(/(?:removeListener|removeAllListeners|off)\((?:"|')([^"']+)/g) || [];
  const targets = detachments.map((entry) => entry.replace(/.*[("']/, ''));
  assert.deepEqual(
    [...new Set(targets)].sort(),
    ['error'],
    'if upstream starts detaching update-downloaded, the single-use rule can be relaxed'
  );
  // The scan above only sees a named event, so a bare removeAllListeners() would
  // take update-downloaded off with everything else and leave this test green.
  assert.doesNotMatch(source, /removeAllListeners\(\s*\)/);
});

test('MacUpdater leaves Squirrel untouched until the install is requested', (t) => {
  const source = upstream('MacUpdater.js');
  if (!source) return t.skip('electron-updater is not installed');
  const fn = slice(source, 'async updateDownloaded(', '\n    handleUpdateDownloaded(');
  // We run with autoInstallOnAppQuit off, so the download never primes Squirrel and
  // quitAndInstall() always starts it from scratch. That is what makes the macOS
  // hand-off slow enough to need minutes rather than seconds.
  assert.match(fn, /if \(this\.autoInstallOnAppQuit\) \{[\s\S]*?this\.nativeUpdater\.checkForUpdates\(\)/);
  const beforeGuard = fn.slice(0, fn.indexOf('if (this.autoInstallOnAppQuit)'));
  assert.doesNotMatch(beforeGuard, /nativeUpdater\.checkForUpdates\(\)/);
});

// The guard keeps updating when the hand-off cannot be observed, losing only the
// recovery. Two tests sit under that choice, and between them they do not prove the
// emitter is registered at runtime. Nothing readable from here can: registration
// lives in Electron's native binding, and Electron documents the built-in updater
// as macOS and Windows only, so neither the declarations nor a dependant's use of
// them settles what Linux actually exposes.
//
// The decision does not rest on it being settled. What it needs is that installing
// anyway cannot be the worse option, and the second test is where that comes from:
// were the emitter absent, electron-updater's own install would fail on it first.
// Refusing would then trade a broken update path for a broken update path, and
// charge every working install for it.
test('the hand-off event is part of Electron public API, not something we inferred', (t) => {
  let types;
  try {
    types = fs.readFileSync(ELECTRON_TYPES, 'utf8');
  } catch (_) {
    return t.skip('electron is not installed');
  }
  // An EventEmitter, so observeUpdateInstallHandoff finds a callable `on`, carrying
  // the event we listen for. This is the type surface and nothing more: Electron
  // documents the built-in updater as macOS and Windows only, so a declaration here
  // is not evidence that the Linux runtime registers the binding.
  assert.match(types, /interface AutoUpdater extends NodeJS\.EventEmitter/);
  assert.match(types, /on\(event: 'before-quit-for-update', listener: \(\) => void\): this;/);
  assert.match(types, /^ {2}const autoUpdater: AutoUpdater;$/m);
});

test('the Linux install path in electron-updater needs that emitter to exist', (t) => {
  const base = upstream('BaseUpdater.js');
  const appImage = upstream('AppImageUpdater.js');
  if (!base || !appImage) return t.skip('electron-updater is not installed');
  // Shared fate, not registration: a caller assuming an API says nothing about the
  // provider implementing it. AppImageUpdater extends BaseUpdater, and BaseUpdater
  // emits on require("electron").autoUpdater with no platform guard, so an Electron
  // without the emitter breaks upstream's own Linux install before it can cost us a
  // recovery. That is what makes the missing listener not worth failing closed over.
  assert.match(appImage, /class AppImageUpdater extends BaseUpdater_1\.BaseUpdater/);
  const fn = slice(base, 'quitAndInstall(isSilent', '\n    executeDownload(');
  assert.match(fn, /require\("electron"\)\.autoUpdater\.emit\("before-quit-for-update"\)/);
  assert.doesNotMatch(fn, /process\.platform/);
});
