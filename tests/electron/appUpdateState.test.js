'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

test('manual update checks restore a matching dismissed version', () => {
  const check = main.slice(
    main.indexOf('async function runAppUpdateCheck'),
    main.indexOf('function maybeRunBackgroundUpdateCheck')
  );
  assert.match(check, /if \(force && result\.newer\) restoreDismissedAppUpdate\(result\.latest\?\.version\)/);
});

test('starting a user-requested download restores its dismissed notification', () => {
  const download = main.slice(
    main.indexOf('async function downloadAndPrepareAppUpdate'),
    main.indexOf('function installDownloadedAppUpdate')
  );
  assert.match(download, /restoreDismissedAppUpdate\(latest\?\.version\)/);
});
