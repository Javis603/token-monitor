'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
const windowBehaviorSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'windowBehavior.js'), 'utf8');
const { floatingAlwaysOnTopLevel } = require('../../src/electron/windowBehavior');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test('defaultSettings accepts an explicit platform argument and defaults glass off on Linux', () => {
  const defaults = sourceBetween(main, 'function defaultSettings', 'function normalizeCollectionMode');
  assert.match(defaults, /function defaultSettings\(platform = process\.platform\)/);
  assert.match(defaults, /const isLinux = platform === 'linux'/);
  assert.match(defaults, /glassBlur:\s*isLinux \? 0 : 32/);
  assert.match(defaults, /systemGlass:\s*!isLinux/);
});

test('renderer resetDepthButton sets 0 blur on Linux and default blur on non-Linux', () => {
  const resetHandler = sourceBetween(renderer, 'els.resetDepthButton.addEventListener', 'els.resetBackgroundImageOpacityButton');
  assert.match(resetHandler, /const defaultBlur = state\.appInfo\?\.platform === 'linux' \? 0 : defaultAppearance\.glassBlur;/);
  assert.match(resetHandler, /els\.blurInput\.value = String\(defaultBlur\);/);
  assert.match(resetHandler, /await saveSettings\(\{\s*glassBlur: defaultBlur\s*\}\);/);
});

test('floatingAlwaysOnTopLevel behavior and documentation align across platforms', () => {
  assert.equal(floatingAlwaysOnTopLevel('win32'), 'screen-saver');
  assert.equal(floatingAlwaysOnTopLevel('darwin'), 'floating');
  assert.equal(floatingAlwaysOnTopLevel('linux'), 'floating');

  const commentBlock = sourceBetween(windowBehaviorSource, '// Z-order level for an always-on-top widget', 'function floatingAlwaysOnTopLevel');
  assert.match(commentBlock, /macOS maps `floating` to NSFloatingWindowLevel/);
  assert.match(commentBlock, /Linux X11 ignores the level[\s\S]*standard window-manager above state/);
  assert.match(commentBlock, /Native Wayland[\s\S]*does not support `BrowserWindow\.setAlwaysOnTop`/);
});
