'use strict';

// The tray was one theme change behind on Windows: Chromium's cached
// system-integrated-UI value is not refreshed by the time nativeTheme fires
// 'updated', so the push carried the state before the flip. The push path reads
// reg.exe instead; this pins the parse of what reg.exe answers.

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseWindowsSystemUsesLightTheme } = require('../../src/electron/tray');

const REG_OUTPUT = (value) => [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  `    SystemUsesLightTheme    REG_DWORD    ${value}`,
  ''
].join('\r\n');

test('SystemUsesLightTheme is inverted into "is the system surface dark"', () => {
  assert.equal(parseWindowsSystemUsesLightTheme(REG_OUTPUT('0x0')), true, 'light theme off means a dark taskbar');
  assert.equal(parseWindowsSystemUsesLightTheme(REG_OUTPUT('0x1')), false);
});

test('an answer that does not carry the value reads as unknown, not as light', () => {
  // null is what makes the caller fall back to the cached nativeTheme property
  // rather than repainting the tray from a value it never actually read.
  assert.equal(parseWindowsSystemUsesLightTheme(''), null);
  assert.equal(parseWindowsSystemUsesLightTheme(undefined), null);
  assert.equal(parseWindowsSystemUsesLightTheme('ERROR: The system was unable to find the specified registry key'), null);
  assert.equal(parseWindowsSystemUsesLightTheme('    AppsUseLightTheme    REG_DWORD    0x0'), null, 'the app theme is a different key');
});

test('the value is read as hex and tolerates reg.exe spacing', () => {
  assert.equal(parseWindowsSystemUsesLightTheme('SystemUsesLightTheme REG_DWORD 0x00000000'), true);
  assert.equal(parseWindowsSystemUsesLightTheme('SystemUsesLightTheme\tREG_DWORD\t0x00000001'), false);
});
