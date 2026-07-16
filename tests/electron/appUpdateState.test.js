'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

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
