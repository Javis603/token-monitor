'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { renderedGlassOpacity } = require('../../src/electron/renderer/glassRendering');

test('transparent mode keeps a stable backing surface on macOS below five percent', () => {
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 0, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 0, systemGlass: false },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 1, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 2, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 3, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 4, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 5, systemGlass: false },
    { platform: 'darwin' }
  ), 0.05);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 6, systemGlass: false },
    { platform: 'darwin' }
  ), 0.06);
});

test('system glass and other platforms retain true zero opacity', () => {
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 0, systemGlass: true },
    { platform: 'darwin' }
  ), 0);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 0, systemGlass: false },
    { platform: 'win32', userAgent: 'Windows' }
  ), 0);
  assert.equal(renderedGlassOpacity(
    { glassOpacity: 0, systemGlass: false },
    { platform: 'linux' }
  ), 0);
});

test('glass renderer normalizes invalid and out-of-range settings', () => {
  assert.equal(renderedGlassOpacity({}, { platform: 'darwin' }), 0.68);
  assert.equal(renderedGlassOpacity({ glassOpacity: null, systemGlass: false }, { platform: 'darwin' }), 0.68);
  assert.equal(renderedGlassOpacity({ glassOpacity: -10, systemGlass: true }, { platform: 'darwin' }), 0);
  assert.equal(renderedGlassOpacity({ glassOpacity: 120 }, { platform: 'win32' }), 1);
});

test('glass rendering helper loads before the renderer entry point', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="glassRendering.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});

test('background image opacity falls back to 28 for anything that is not a number', () => {
  const { normalizeBackgroundImageOpacity } = require('../../src/electron/renderer/glassRendering');
  for (const value of ['abc', NaN, Infinity, undefined, null, {}]) {
    assert.equal(normalizeBackgroundImageOpacity(value), 28, String(value));
  }
  assert.equal(normalizeBackgroundImageOpacity(0), 0);
  assert.equal(normalizeBackgroundImageOpacity('70'), 70);
  assert.equal(normalizeBackgroundImageOpacity(-5), 0);
  assert.equal(normalizeBackgroundImageOpacity(250), 100);
});
