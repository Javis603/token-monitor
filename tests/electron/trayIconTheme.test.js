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
  // The measured shape: the first read still answers with the pre-flip value.
  const io = readerReturning(true, false, false);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, false, 'the value that stopped moving is the one published');
    assert.deepEqual(io.waits, SYSTEM_UI_THEME_SETTLE_MS.slice(0, 3));
  });
});

test('flipping back inside the write delay does not park the tray on the value in between', () => {
  // Dark -> Light -> Dark faster than the write lands. This revision belongs to
  // the second flip, so `previous` is still dark and nothing was ever published
  // for the first one; the opening read then catches the FIRST flip's write
  // arriving late. Settling on that reading would have published light and left
  // it there for good, since both events have already fired and nothing else is
  // coming to correct it. The user ended on dark, which the renderer already
  // holds, so the right answer is to publish nothing at all.
  const io = readerReturning(false, true, true);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, null);
  });
});

test('an unstable start still publishes the value it settles on when that differs', () => {
  // Same shape, but the surface really did end somewhere else: the intermediate
  // reading must not short-circuit the loop, and the settled one must land.
  const io = readerReturning(false, true, true);
  return settleSystemDarkUi({ ...io, previous: false }).then((settled) => {
    assert.equal(settled, true);
  });
});

test('a surface that never moved publishes nothing', () => {
  // An app-theme-only change raises the same event; repainting there is churn.
  const io = readerReturning(true);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, null);
    assert.equal(io.waits.length, 2, 'two agreeing reads are enough to stop looking');
  });
});

test('a value that never stops moving publishes nothing rather than a guess', () => {
  const io = readerReturning(true, false, true, false);
  return settleSystemDarkUi({ ...io, previous: true, schedule: [1, 1, 1, 1] }).then((settled) => {
    assert.equal(settled, null);
  });
});

test('an unreadable registry never publishes a guess', () => {
  const io = readerReturning(null);
  return settleSystemDarkUi({ ...io, previous: false }).then((settled) => {
    assert.equal(settled, null);
  });
});

test('a flip overtaken by a newer one is dropped instead of repainting backwards', () => {
  const io = readerReturning(false, false);
  let current = true;
  return settleSystemDarkUi({ ...io, previous: true, isCurrent: () => current, schedule: [1, 1] })
    .then((settled) => {
      assert.equal(settled, false, 'still current: the reading is published');
      current = false;
      return settleSystemDarkUi({ ...readerReturning(false, false), previous: true, isCurrent: () => current });
    })
    .then((settled) => {
      assert.equal(settled, null, 'superseded: the reading is dropped');
    });
});
