'use strict';

// The tray tracked one theme change behind on Windows. Measured on Windows 11
// with Electron 43.3.0, a flip of the system theme lands like this:
//
//   'updated' fires | AppsUseLightTheme new | SystemUsesLightTheme still OLD
//   +250ms          |                       | SystemUsesLightTheme new
//   +1250ms         | shouldUseDarkColorsForSystemIntegratedUI STILL old
//
// So the cached property is useless here (it only catches up on the next flip)
// and one registry read at event time is simply too early. These pin the parse
// and the settle loop that replaced both.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SYSTEM_UI_THEME_SETTLE_MS,
  parseWindowsSystemUsesLightTheme,
  settleSystemDarkUi
} = require('../../src/electron/tray');

const REG_OUTPUT = (value) => [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  `    SystemUsesLightTheme    REG_DWORD    ${value}`,
  ''
].join('\r\n');

function readerReturning(...values) {
  const queue = values.slice();
  const waits = [];
  return {
    waits,
    wait: async (ms) => { waits.push(ms); },
    read: async () => (queue.length > 1 ? queue.shift() : queue[0])
  };
}

test('SystemUsesLightTheme is inverted into "is the system surface dark"', () => {
  assert.equal(parseWindowsSystemUsesLightTheme(REG_OUTPUT('0x0')), true, 'light theme off means a dark taskbar');
  assert.equal(parseWindowsSystemUsesLightTheme(REG_OUTPUT('0x1')), false);
  assert.equal(parseWindowsSystemUsesLightTheme('SystemUsesLightTheme\tREG_DWORD\t0x00000001'), false);
});

test('an answer that does not carry the value reads as unknown, not as light', () => {
  assert.equal(parseWindowsSystemUsesLightTheme(''), null);
  assert.equal(parseWindowsSystemUsesLightTheme(undefined), null);
  assert.equal(parseWindowsSystemUsesLightTheme('ERROR: The system was unable to find the specified registry key'), null);
  assert.equal(parseWindowsSystemUsesLightTheme('    AppsUseLightTheme    REG_DWORD    0x0'), null, 'the app theme is a different key');
  // Windows only writes 0 or 1; anything else must not be guessed as light.
  assert.equal(parseWindowsSystemUsesLightTheme(REG_OUTPUT('0x2')), null);
});

test('the settle loop waits out the stale read that landed before the write', () => {
  // Exactly the measured shape: the first read still answers with the old value.
  const io = readerReturning(true, false);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, false, 'the value that finally moved is the one published');
    assert.deepEqual(io.waits, [SYSTEM_UI_THEME_SETTLE_MS[0], SYSTEM_UI_THEME_SETTLE_MS[1]]);
  });
});

test('a reading equal to what the renderer already has is not a flip', () => {
  // An app-theme-only change raises the same event, and the system surface did
  // not move — publishing there would repaint the tray for nothing.
  const io = readerReturning(true);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, null);
    assert.equal(io.waits.length, SYSTEM_UI_THEME_SETTLE_MS.length, 'the whole schedule is spent before giving up');
  });
});

test('an unreadable registry never publishes a guess', () => {
  const io = readerReturning(null);
  return settleSystemDarkUi({ ...io, previous: false }).then((settled) => {
    assert.equal(settled, null);
  });
});

test('a flip overtaken by a newer one is dropped instead of repainting backwards', () => {
  const io = readerReturning(false);
  let current = true;
  return settleSystemDarkUi({ ...io, previous: true, isCurrent: () => current, schedule: [1, 1] })
    .then((settled) => {
      assert.equal(settled, false, 'still current: the reading is published');
      current = false;
      return settleSystemDarkUi({ ...readerReturning(false), previous: true, isCurrent: () => current });
    })
    .then((settled) => {
      assert.equal(settled, null, 'superseded: the reading is dropped');
    });
});
