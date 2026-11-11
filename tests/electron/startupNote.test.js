'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MESSAGES } = require('../../src/electron/renderer/i18n');

function rendererSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
}

test('startup note block picks the note by login-item support and leaves platform wording to i18n', () => {
  const source = rendererSource();
  const match = source.match(/if \(els\.startupNote\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'startupNote render block should exist');
  const block = match[1];
  assert.match(block, /settings\.startup\.launchAtSignIn/, 'supported builds get the sign-in note');
  assert.match(block, /settings\.startup\.available/, 'unsupported builds keep the availability note');
  assert.doesNotMatch(block, /linux/, 'the renderer must not branch on the platform; i18n variants do');
});

test('the Linux sign-in note is translated and mentions moving the AppImage', () => {
  assert.match(MESSAGES.en['settings.startup.launchAtSignIn@linux'], /AppImage/);
  assert.match(MESSAGES.en['settings.startup.launchAtSignIn@linux'], /mov/i);
  assert.doesNotMatch(MESSAGES.en['settings.startup.launchAtSignIn'], /AppImage/);
});

test('the availability note only mentions AppImage on Linux', () => {
  assert.doesNotMatch(MESSAGES.en['settings.startup.available'], /macOS and Windows|Linux|AppImage/);
  assert.match(MESSAGES.en['settings.startup.available@linux'], /AppImage/);
});
