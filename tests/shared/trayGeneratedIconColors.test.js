'use strict';

// Generated tray icons used to be drawn in a hard-coded black. macOS survived it
// because its icons are template images the menubar re-inks, but Windows and
// Linux hand the bitmap to the shell as-is, so a dark taskbar swallowed the icon
// whole. These pin the platform split so a future refactor cannot collapse it.

const assert = require('node:assert/strict');
const test = require('node:test');

const { trayGeneratedIconColors, trayProviderGlyphInk } = require('../../src/shared/trayText');

const BLACK = { track: 'rgba(0, 0, 0, 0.32)', fill: 'rgba(0, 0, 0, 1)', text: 'rgba(0, 0, 0, 1)' };
const WHITE = { track: 'rgba(255, 255, 255, 0.32)', fill: 'rgba(255, 255, 255, 1)', text: 'rgba(255, 255, 255, 1)' };

test('macOS keeps the black ink in both themes so template inversion still works', () => {
  assert.deepEqual(trayGeneratedIconColors('darwin', false), BLACK);
  assert.deepEqual(trayGeneratedIconColors('darwin', true), BLACK, 'a dark menubar must not lighten a template source');
});

test('Windows and Linux switch to light ink on a dark system surface', () => {
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(trayGeneratedIconColors(platform, true), WHITE, `${platform} dark taskbar`);
    assert.deepEqual(trayGeneratedIconColors(platform, false), BLACK, `${platform} light taskbar`);
  }
});

test('the light-surface ink is unchanged from the historical hard-coded values', () => {
  // Nothing about a light taskbar should look different after this change.
  assert.deepEqual(trayGeneratedIconColors('win32', false), BLACK);
  assert.deepEqual(trayGeneratedIconColors(undefined, undefined), BLACK, 'unknown platform before appInfo lands');
});

test('only an explicit true darkens, so a missing or malformed payload stays readable on light', () => {
  for (const value of [undefined, null, 0, '', 'true', {}]) {
    assert.deepEqual(trayGeneratedIconColors('win32', value), BLACK, `systemDarkUi=${JSON.stringify(value)}`);
  }
});

test('callers cannot mutate the shared palette through the returned object', () => {
  const first = trayGeneratedIconColors('win32', true);
  first.fill = 'rgba(1, 2, 3, 1)';
  assert.deepEqual(trayGeneratedIconColors('win32', true), WHITE);
});

test('a flat-ink provider mark is inked to match the surface, in both directions', () => {
  assert.equal(trayProviderGlyphInk('win32', true, true), WHITE.text, 'dark taskbar');
  assert.equal(trayProviderGlyphInk('linux', true, true), WHITE.text);
  // pi and proma are authored white: leaving them as-is on a light taskbar is
  // the same disappearing act the black marks performed on a dark one.
  assert.equal(trayProviderGlyphInk('win32', false, true), BLACK.fill, 'light taskbar');
  assert.equal(trayProviderGlyphInk('linux', false, true), BLACK.fill);
  assert.equal(trayProviderGlyphInk('darwin', true, true), '', 'macOS re-inks through the template image instead');
  assert.equal(trayProviderGlyphInk('darwin', false, true), '');
});

test('full-colour brand artwork is never tinted, on any platform or theme', () => {
  // Flattening tray-claude.svg to one ink would throw its brand colour away.
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const dark of [true, false]) {
      assert.equal(trayProviderGlyphInk(platform, dark, false), '', `${platform} dark=${dark}`);
    }
  }
});

test('an unreadable or unknown flat-ink verdict leaves the artwork untouched', () => {
  // providerImageOpticalSample cannot always read pixels back; that must not
  // repaint a mark we failed to classify.
  for (const value of [undefined, null, 0, '', 'true', {}]) {
    assert.equal(trayProviderGlyphInk('win32', true, value), '', `flatInk=${JSON.stringify(value)}`);
  }
  // A non-boolean theme flag must not read as dark; it falls to the light ink.
  assert.equal(trayProviderGlyphInk('win32', 'yes', true), BLACK.fill);
});
