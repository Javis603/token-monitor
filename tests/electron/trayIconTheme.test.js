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

const elapsed = (waits) => waits.reduce((total, ms) => total + ms, 0);

test('a typical flip is answered inside half a second', () => {
  // The measured shape: the first read still answers with the pre-flip value,
  // the write lands before the second, and the third confirms it. The schedule
  // is delays BETWEEN reads, so this is what the user actually waits.
  const io = readerReturning(true, false, false);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, false, 'the value that stopped moving is the one published');
    assert.deepEqual(io.waits, SYSTEM_UI_THEME_SETTLE_MS.slice(0, 3));
    assert.ok(elapsed(io.waits) <= 500, `answered in ${elapsed(io.waits)}ms`);
  });
});

test('a write slower than the measurement is waited out, not read as no change', () => {
  // The old value is stable too before the write has landed. Settling on it
  // would leave the tray on the previous ink for good, since the event has
  // already fired and nothing else is coming.
  const io = readerReturning(true, true, false, false);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, false);
    assert.ok(elapsed(io.waits) > 500, 'it kept watching past the point a fast write would have landed');
  });
});

test('flipping back inside the write delay does not park the tray on the value in between', () => {
  // Dark -> Light -> Dark faster than the write lands. This revision belongs to
  // the second flip, so `previous` is still dark and nothing was published for
  // the first one; the opening read then catches the FIRST flip's write arriving
  // late. Publishing that would have left the tray light for good. The user
  // ended on dark, which the renderer already holds, so nothing is published.
  const io = readerReturning(false, true, true);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, null);
  });
});

test('an unstable start still publishes the value it settles on when that differs', () => {
  const io = readerReturning(false, true, true);
  return settleSystemDarkUi({ ...io, previous: false }).then((settled) => {
    assert.equal(settled, true);
  });
});

test('a surface that never moved spends the whole window before giving up', () => {
  // An app-theme-only change raises the same event. Two agreeing reads of the
  // old value cannot prove the surface stayed put, so the watch runs to the end.
  const io = readerReturning(true);
  return settleSystemDarkUi({ ...io, previous: true }).then((settled) => {
    assert.equal(settled, null);
    assert.equal(io.waits.length, SYSTEM_UI_THEME_SETTLE_MS.length);
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
