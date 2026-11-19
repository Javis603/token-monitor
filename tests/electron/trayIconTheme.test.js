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
  watchSystemDarkUi
} = require('../../src/electron/tray');

const REG_OUTPUT = (value) => [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  `    SystemUsesLightTheme    REG_DWORD    ${value}`,
  ''
].join('\r\n');

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

function watcher(...values) {
  const queue = values.slice();
  const waits = [];
  const published = [];
  return {
    waits,
    published,
    wait: async (ms) => { waits.push(ms); },
    read: async () => (queue.length > 1 ? queue.shift() : queue[0]),
    publish: (value) => published.push(value)
  };
}

test('a typical flip is answered inside half a second', () => {
  // The measured shape: the first read still answers with the pre-flip value,
  // the write lands before the second, and the third agrees. The schedule is
  // delays BETWEEN reads, so this is what the user actually waits.
  const io = watcher(true, false, false);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, [false]);
    assert.ok(elapsed(io.waits.slice(0, 3)) <= 500, `answered in ${elapsed(io.waits.slice(0, 3))}ms`);
  });
});

test('a write slower than the measurement is waited out, not read as no change', () => {
  // The old value is stable too before the write lands. Stopping there would
  // leave the tray on the previous ink, with no further event coming.
  const io = watcher(true, true, false, false);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, [false]);
  });
});

test('a fast flip back is not published at all when it returns to what is held', () => {
  // Dark -> Light -> Dark. This revision belongs to the second flip, so the
  // opening read catches the FIRST flip's write arriving late, and the second
  // flip's value follows before the intermediate one is ever confirmed.
  const io = watcher(false, true, true);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, []);
  });
});

test('an intermediate value that does get confirmed is corrected, not left behind', () => {
  // The dangerous shape: the first flip's write is stable across two samples, so
  // it is published for responsiveness, and the second flip's write only lands
  // afterwards. Stopping at the publish would have parked the tray on light for
  // good — the watch keeps running precisely so the later write still corrects it.
  const io = watcher(false, false, true, true);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, [false, true], 'answered fast, then corrected');
  });
});

test('an unstable start still publishes the value it settles on when that differs', () => {
  const io = watcher(false, true, true);
  return watchSystemDarkUi({ ...io, held: false }).then(() => {
    assert.deepEqual(io.published, [true]);
  });
});

test('a correction first seen on the last sample still gets confirmed', () => {
  // Without the trailing confirmation read the window would only really cover
  // writes landing by 2600ms: a value first seen on the final scheduled sample
  // has nothing after it to agree with, so it could never be published.
  const io = watcher(false, false, false, false, false, false, false, true, true);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, [false, true]);
    assert.equal(io.waits.length, SYSTEM_UI_THEME_SETTLE_MS.length + 1, 'the window plus its confirmation');
  });
});

test('a surface that never moved publishes nothing and spends the whole window', () => {
  // An app-theme-only change raises the same event. Two agreeing reads of the
  // held value cannot prove the surface stayed put, so the watch runs to the end.
  const io = watcher(true);
  return watchSystemDarkUi({ ...io, held: true }).then(() => {
    assert.deepEqual(io.published, []);
    assert.equal(io.waits.length, SYSTEM_UI_THEME_SETTLE_MS.length + 1);
  });
});

test('a value that never stops moving publishes nothing rather than a guess', () => {
  // Never two in a row, confirmation read included.
  const io = watcher(true, false, true, false, true);
  return watchSystemDarkUi({ ...io, held: true, schedule: [1, 1, 1, 1], confirmMs: 1 }).then(() => {
    assert.deepEqual(io.published, []);
  });
});

test('an unreadable registry never publishes a guess', () => {
  const io = watcher(null);
  return watchSystemDarkUi({ ...io, held: false }).then(() => {
    assert.deepEqual(io.published, []);
  });
});

test('a flip overtaken by a newer one stops instead of repainting backwards', () => {
  const io = watcher(false, false);
  return watchSystemDarkUi({ ...io, held: true, isCurrent: () => false }).then(() => {
    assert.deepEqual(io.published, [], 'superseded: nothing is published');
    assert.equal(io.waits.length, 1, 'and the watch does not run on');
  });
});
