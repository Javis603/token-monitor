'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return main.slice(start, end);
}

test('manual update checks restore a matching dismissed version', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /if \(force && result\.newer\) restoreDismissedAppUpdate\(result\.latest\?\.version\)/);
});

test('manual checks preserve feedback when reusing an in-flight background check', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /if \(force\) sendAppUpdatePush\(\);\s*const activeResult = await appUpdateCheckPromise/);
  assert.match(check, /if \(activeResult\.newer\) restoreDismissedAppUpdate\(activeResult\.latest\?\.version\)/);
  assert.match(check, /resolveAppUpdateCheckError\(appUpdateLastError, activeResult, \{ force: true \}\)/);
  assert.match(check, /error: classified\.message,[\s\S]*errorKind: classified\.kind/);
});

test('background failures preserve the last visible update-check error', () => {
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.doesNotMatch(check, /appUpdateCheckInFlight = true;\s*appUpdateLastError = null/);
  assert.match(check, /resolveAppUpdateCheckError\(appUpdateLastError, result, \{ force \}\)/);
  assert.match(check, /resolveAppUpdateCheckError\(appUpdateLastError, \{\s*ok: false,[\s\S]*\}, \{ force \}\)/);
});

test('packaged update checks use electron-updater while source runs use the public fallback', () => {
  const check = sourceBetween('async function checkAppUpdateProvider', 'function deriveAppUpdateState');
  assert.match(check, /if \(!app\.isPackaged\) return checkLatestRelease\(app\.getVersion\(\)\)/);
  assert.match(check, /configureNativeAppUpdater\(\)/);
  assert.match(check, /await autoUpdater\.checkForUpdates\(\)/);
  assert.match(check, /providerUpdateCheckAvailability\(result, app\.getVersion\(\)\)/);
  assert.match(check, /newer: availability\.newer/);
  assert.match(check, /clearLatest: availability\.clearLatest/);
});

test('update state separates the last successful check from the latest attempt error', () => {
  const derive = sourceBetween('function deriveAppUpdateState', 'function restoreDismissedAppUpdate');
  assert.match(derive, /lastCheckedAt: block\.lastCheckedAt \|\| null/);
  assert.match(derive, /lastAttemptAt: appUpdateLastAttemptAt/);
  assert.match(derive, /lastError: appUpdateLastError\?\.message \|\| null/);
  assert.match(derive, /lastErrorKind: appUpdateLastError\?\.kind \|\| null/);
});

test('starting a user-requested download restores its dismissed notification', () => {
  const download = sourceBetween('async function downloadAndPrepareAppUpdate', 'function installDownloadedAppUpdate');
  assert.match(download, /if \(appUpdateCheckPromise\) await appUpdateCheckPromise/);
  assert.match(download, /providerUpdateCheckAvailability\(result, app\.getVersion\(\)\)/);
  assert.match(download, /if \(!availability\.newer \|\| !version\)/);
  assert.match(download, /restoreDismissedAppUpdate\(version\)/);
  assert.match(download, /await autoUpdater\.downloadUpdate\(\)/);
});

test('successful checks share one state transition that clears stale errors', () => {
  const success = sourceBetween('function rememberSuccessfulAppUpdateCheck', 'function setNativeAppUpdateState');
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  const download = sourceBetween('async function downloadAndPrepareAppUpdate', 'function installDownloadedAppUpdate');

  assert.match(success, /if \(!latest && !clearLatest\) return null/);
  assert.match(success, /lastKnownLatest: remembered/);
  assert.match(success, /appUpdateLastAttemptAt = checkedAt/);
  assert.match(success, /appUpdateLastError = null/);
  assert.match(check, /rememberSuccessfulAppUpdateCheck\(result\.latest, result\.checkedAt, \{ clearLatest: result\.clearLatest \}\)/);
  assert.match(download, /const checkedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(download, /rememberSuccessfulAppUpdateCheck\(\s*availability\.latest,\s*checkedAt,\s*\{ clearLatest: availability\.clearLatest \}\s*\)/);
});

test('automatic updates are opt-in and download without installing', () => {
  const defaults = sourceBetween('function defaultSettings', 'function normalizeCollectionMode');
  const automaticDownload = sourceBetween('async function maybeDownloadAutomaticAppUpdate', 'function maybeRunBackgroundUpdateCheck');
  assert.match(defaults, /automaticAppUpdates: false/);
  assert.match(automaticDownload, /shouldDownloadAutomaticAppUpdate\(\{\s*automaticAppUpdates: settings\?\.automaticAppUpdates,\s*updateState\s*\}\)/);
  assert.match(automaticDownload, /return downloadAndPrepareAppUpdate\(\)/);
  assert.doesNotMatch(automaticDownload, /installDownloadedAppUpdate/);
});

test('enabling automatic updates bypasses the background-check cooldown', () => {
  assert.match(main, /runAppUpdateCheck\(\{ force = false, bypassCooldown = false \} = \{\}\)/);
  const check = sourceBetween('async function runAppUpdateCheck', 'function maybeRunBackgroundUpdateCheck');
  assert.match(check, /if \(!bypassCooldown && shouldSkipAppUpdateCheck\(/);
  assert.match(main, /settings\.automaticAppUpdates && !previousAutomaticAppUpdates\) \{\s*runAppUpdateCheck\(\{ bypassCooldown: true \}\)\.catch\(\(\) => \{\}\);\s*\}/);
});

test('automatic update control persists through settings', () => {
  assert.match(html, /id="automaticAppUpdatesInput"[^>]*type="checkbox"/);
  assert.match(html, /<script src="appUpdatePresentation\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(renderer, /automaticAppUpdateControlState\(\{\s*preferenceEnabled: state\.settings\?\.automaticAppUpdates,\s*updateState: state\.appUpdate\s*\}\)/);
  assert.match(renderer, /saveSettings\(\{ automaticAppUpdates: els\.automaticAppUpdatesInput\.checked \}\)/);
});
