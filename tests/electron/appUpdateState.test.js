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
  assert.match(check, /appUpdateLastError = activeResult\?\.error \|\| 'Update check failed'/);
  assert.match(check, /return \{ ok: false, newer: false, latest: null, error: message \}/);
});

test('starting a user-requested download restores its dismissed notification', () => {
  const download = sourceBetween('async function downloadAndPrepareAppUpdate', 'function installDownloadedAppUpdate');
  assert.match(download, /restoreDismissedAppUpdate\(latest\?\.version\)/);
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
