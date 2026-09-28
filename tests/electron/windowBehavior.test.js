'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  describeWindowBehavior,
  floatingAlwaysOnTopLevel,
  normalizeWindowBehavior,
  normalizeWindowBehaviorSettings,
  windowBehaviorSelection
} = require('../../src/electron/windowBehavior');

test('normalizes supported window behavior modes', () => {
  assert.equal(normalizeWindowBehavior('floating'), 'floating');
  assert.equal(normalizeWindowBehavior('NORMAL'), 'normal');
  assert.equal(normalizeWindowBehavior(' desktop '), 'desktop');
  assert.equal(normalizeWindowBehavior('unknown', 'normal'), 'normal');
});

test('maps window behavior modes to window flags', () => {
  assert.deepEqual(describeWindowBehavior({ windowBehavior: 'floating' }), {
    mode: 'floating',
    alwaysOnTop: true,
    draggable: true,
    resizable: true,
    focusable: true,
    mousePassthrough: false,
    showInactive: false,
    requiresTrayControl: false,
    cssClass: ''
  });
  assert.deepEqual(describeWindowBehavior({ windowBehavior: 'normal' }), {
    mode: 'normal',
    alwaysOnTop: false,
    draggable: true,
    resizable: true,
    focusable: true,
    mousePassthrough: false,
    showInactive: false,
    requiresTrayControl: false,
    cssClass: ''
  });
  assert.deepEqual(describeWindowBehavior({ windowBehavior: 'desktop' }), {
    mode: 'desktop',
    alwaysOnTop: false,
    draggable: false,
    resizable: false,
    focusable: true,
    mousePassthrough: false,
    showInactive: false,
    requiresTrayControl: false,
    cssClass: 'desktop-mode'
  });
});

test('migrates legacy alwaysOnTop settings when no behavior is saved', () => {
  assert.equal(normalizeWindowBehaviorSettings({ alwaysOnTop: true }).windowBehavior, 'floating');
  assert.equal(normalizeWindowBehaviorSettings({ alwaysOnTop: false }).windowBehavior, 'normal');
});

test('keeps alwaysOnTop synchronized with behavior updates', () => {
  assert.deepEqual(
    normalizeWindowBehaviorSettings({ windowBehavior: 'floating', alwaysOnTop: true }, { windowBehavior: 'desktop' }),
    { windowBehavior: 'desktop', alwaysOnTop: false }
  );
  assert.deepEqual(
    normalizeWindowBehaviorSettings({ windowBehavior: 'desktop', alwaysOnTop: false }, { alwaysOnTop: true }),
    { windowBehavior: 'floating', alwaysOnTop: true }
  );
  assert.deepEqual(
    normalizeWindowBehaviorSettings({ windowBehavior: 'floating', alwaysOnTop: true }, { alwaysOnTop: false }),
    { windowBehavior: 'normal', alwaysOnTop: false }
  );
});

test('windowBehaviorSelection keeps only the keys that select a mode', () => {
  assert.deepEqual(windowBehaviorSelection({ windowBehavior: 'desktop' }), { windowBehavior: 'desktop' });
  assert.deepEqual(windowBehaviorSelection({ alwaysOnTop: true }), { alwaysOnTop: true });
  assert.deepEqual(windowBehaviorSelection({}), {});
  assert.deepEqual(windowBehaviorSelection(), {});
  assert.deepEqual(
    windowBehaviorSelection({ windowBehavior: 'normal', alwaysOnTop: false, glassOpacity: '9999', deviceId: '   ' }),
    { windowBehavior: 'normal', alwaysOnTop: false }
  );
});

// settings:update normalizes ~50 keys into an object and then hands it here. Passing the
// raw patch a second time reinstated every value the clamps and fallbacks had just
// removed, so the narrowed selection has to leave the merged object alone.
test('a narrowed selection leaves already-normalized values intact', () => {
  const normalized = { deviceId: 'my-box', glassOpacity: 68, refreshMs: 15000, hubHostPort: 17321 };
  const rawPatch = { deviceId: '   ', glassOpacity: '9999', refreshMs: 1, hubHostPort: 70000, windowBehavior: 'desktop' };

  const narrowed = normalizeWindowBehaviorSettings(normalized, windowBehaviorSelection(rawPatch));
  assert.equal(narrowed.deviceId, 'my-box');
  assert.equal(narrowed.glassOpacity, 68);
  assert.equal(narrowed.refreshMs, 15000);
  assert.equal(narrowed.hubHostPort, 17321);
  assert.equal(narrowed.windowBehavior, 'desktop');
  assert.equal(narrowed.alwaysOnTop, false);
});

test('settings:update hands the mode selection over, not the whole patch', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src/electron/main.js'), 'utf8');
  assert.match(main, /\}, windowBehaviorSelection\(normalizedPatch\)\);/);
  assert.doesNotMatch(main, /\}, normalizedPatch\);/);
});

// Electron places the `floating` z-order level behind the Windows taskbar on
// purpose, so a widget dragged onto the taskbar vanishes behind it (#533).
test('always-on-top windows opt out of the Windows behind-taskbar levels', () => {
  assert.equal(floatingAlwaysOnTopLevel('win32'), 'screen-saver');
  assert.equal(floatingAlwaysOnTopLevel('darwin'), 'floating');
  assert.equal(floatingAlwaysOnTopLevel('linux'), 'floating');
});

// Both always-on-top call sites (the expanded widget and the collapsed bubble)
// have to go through the helper; a bare 'floating' literal reintroduces #533.
test('main.js never passes a bare floating level to setAlwaysOnTop', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src/electron/main.js'), 'utf8');
  const calls = main.match(/setAlwaysOnTop\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    assert.match(call, /floatingAlwaysOnTopLevel\(\)/);
  }
});
