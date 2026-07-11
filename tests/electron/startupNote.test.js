'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MESSAGES } = require('../../src/electron/renderer/i18n');

function rendererSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
}

test('startup note block shows the AppImage caveat on Linux', () => {
  const source = rendererSource();
  const match = source.match(/if \(els\.startupNote\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'startupNote render block should exist');
  const block = match[1];
  assert.match(block, /settings\.startup\.appimageNote/, 'Linux should get the AppImage-specific note');
  assert.match(block, /['"]linux['"]/, 'the AppImage note should be gated on the linux platform');
  assert.match(block, /settings\.startup\.launchAtSignIn/, 'other platforms keep the sign-in note');
  assert.match(block, /settings\.startup\.available/, 'unsupported builds keep the availability note');
});

test('the AppImage caveat is translated and mentions moving the file', () => {
  assert.match(MESSAGES.en['settings.startup.appimageNote'], /AppImage/);
  assert.match(MESSAGES.en['settings.startup.appimageNote'], /mov/i);
});

test('the availability note no longer claims macOS/Windows only', () => {
  assert.doesNotMatch(MESSAGES.en['settings.startup.available'], /macOS and Windows/);
  assert.match(MESSAGES.en['settings.startup.available'], /AppImage/);
});
