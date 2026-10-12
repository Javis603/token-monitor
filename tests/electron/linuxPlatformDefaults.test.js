'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return main.slice(start, end);
}

test('defaultSettings defaults systemGlass to off and glassBlur to 0 on Linux to avoid software rasterization load', () => {
  const defaults = sourceBetween('function defaultSettings', 'function normalizeCollectionMode');
  assert.match(defaults, /function defaultSettings\(platform = process\.platform\)/);
  assert.match(defaults, /const isLinux = platform === 'linux'/);
  assert.match(defaults, /glassBlur:\s*isLinux \? 0 : 32/);
  assert.match(defaults, /systemGlass:\s*!isLinux/);
});

test('renderer resets glass blur to zero on Linux when depth reset is clicked', () => {
  assert.match(
    renderer,
    /els\.resetDepthButton\.addEventListener\('click',\s*async \(\) => \{\s*const defaultBlur = state\.appInfo\?\.platform === 'linux' \? 0 : defaultAppearance\.glassBlur;/
  );
});
