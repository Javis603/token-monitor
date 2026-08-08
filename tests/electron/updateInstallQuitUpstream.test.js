'use strict';

// The install-quit guard is built on four facts about electron-updater's own
// implementation, not on its public API. They are load-bearing: get any of them
// wrong and the app either cannot be quit or stacks install attempts. Upstream
// owes us none of them, so this pins each one to the code we actually ship
// against and fails the moment a bump changes it.
//
// A red test here is not a bug in our code. It means the assumptions below have
// to be re-read against the new version before the guard can be trusted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'node_modules/electron-updater/out');
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
