'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { shouldUseXWayland } = require('../../src/electron/linuxDisplayServer');

const waylandSession = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };

test('shouldUseXWayland selects XWayland on a Linux Wayland session', () => {
  assert.equal(shouldUseXWayland({ platform: 'linux', env: waylandSession, argv: [] }), true);
});

test('shouldUseXWayland is inert outside Linux or outside a Wayland session', () => {
  assert.equal(shouldUseXWayland({ platform: 'darwin', env: waylandSession, argv: [] }), false);
  assert.equal(shouldUseXWayland({ platform: 'win32', env: waylandSession, argv: [] }), false);
  // An X11 session never triggered Electron's Wayland default in the first place.
  assert.equal(shouldUseXWayland({ platform: 'linux', env: { DISPLAY: ':0' }, argv: [] }), false);
});

test('shouldUseXWayland keeps native Wayland when no XWayland is reachable', () => {
  // Wayland-only setups (e.g. minimal sway without XWayland) would fail to
  // start at all under --ozone-platform=x11.
  assert.equal(shouldUseXWayland({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' }, argv: [] }), false);
});

test('shouldUseXWayland never overrides an explicit --ozone-platform launch switch', () => {
  assert.equal(shouldUseXWayland({ platform: 'linux', env: waylandSession, argv: ['--ozone-platform=wayland'] }), false);
  assert.equal(shouldUseXWayland({ platform: 'linux', env: waylandSession, argv: ['--ozone-platform=x11'] }), false);
  assert.equal(shouldUseXWayland({ platform: 'linux', env: waylandSession, argv: ['--ozone-platform', 'auto'] }), false);
});

test('main relaunches with an argv switch instead of mutating the command line too late', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src/electron/main.js'), 'utf8');
  const spawnLine = "spawn(process.env.APPIMAGE || process.execPath, [...process.argv.slice(1), '--ozone-platform=x11'], {";
  assert.ok(main.includes(spawnLine));
  assert.ok(main.indexOf(spawnLine) < main.indexOf('const gotLock = app.requestSingleInstanceLock()'));
  assert.doesNotMatch(main, /appendSwitch\('ozone-platform'/);
});
