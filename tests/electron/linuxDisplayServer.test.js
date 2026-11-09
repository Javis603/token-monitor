'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

const { shouldUseXWayland, startWithXWayland, canPositionWindow } = require('../../src/electron/linuxDisplayServer');

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

function launchFixture({ packaged = false, env = waylandSession, argv = ['electron', '.'], spawnError } = {}) {
  const child = new EventEmitter();
  const calls = [];
  child.unref = () => calls.push(['unref']);
  const app = { isPackaged: packaged, exit: (code) => calls.push(['exit', code]) };
  startWithXWayland({
    app, platform: 'linux', env, argv, execPath: '/runtime/electron',
    start: () => calls.push(['start']), warn: (message) => calls.push(['warn', message]),
    spawn: (...args) => { calls.push(['spawn', ...args]); if (spawnError) throw spawnError; return child; }
  });
  return { child, calls };
}

test('packaged launcher waits for spawn before detaching and exiting', () => {
  const { child, calls } = launchFixture({ packaged: true, env: { ...waylandSession, APPIMAGE: '/app/Token Monitor.AppImage' } });
  assert.deepEqual(calls, [['spawn', '/app/Token Monitor.AppImage', ['.', '--ozone-platform=x11'], { detached: true, stdio: 'ignore' }]]);
  child.emit('spawn');
  assert.deepEqual(calls.slice(1), [['unref'], ['exit', 0]]);
});

test('development ignores inherited APPIMAGE and retains the terminal until the child exits', () => {
  const { child, calls } = launchFixture({ env: { ...waylandSession, APPIMAGE: '/foreign.AppImage' } });
  assert.deepEqual(calls, [['spawn', '/runtime/electron', ['.', '--ozone-platform=x11'], { detached: false, stdio: 'inherit' }]]);
  child.emit('spawn');
  assert.equal(calls.length, 1);
  child.emit('exit', 3);
  assert.deepEqual(calls.slice(1), [['exit', 3]]);
});

test('extracted packaged builds without APPIMAGE use their executable', () => {
  const { calls } = launchFixture({ packaged: true });
  assert.equal(calls[0][1], '/runtime/electron');
});

test('asynchronous spawn failure logs and continues normal startup without exiting', () => {
  for (const packaged of [true, false]) {
    const { child, calls } = launchFixture({ packaged });
    child.emit('error', new Error('ENOENT'));
    assert.deepEqual(calls.slice(1), [['warn', '[display] XWayland relaunch failed: ENOENT'], ['start']]);
  }
});

test('synchronous spawn failure also continues normal startup', () => {
  const { calls } = launchFixture({ spawnError: new Error('EACCES') });
  assert.deepEqual(calls.slice(1), [['warn', '[display] XWayland relaunch failed: EACCES'], ['start']]);
});

test('explicit backend skips relaunch and starts the widget once', () => {
  assert.deepEqual(launchFixture({ argv: ['electron', '.', '--ozone-platform=wayland'] }).calls, [['start']]);
});

test('window positioning is available on X11 but not native Wayland', () => {
  for (const argv of [[], ['--ozone-platform=wayland'], ['--ozone-platform', 'wayland'], ['--ozone-platform=auto']]) {
    assert.equal(canPositionWindow({ platform: 'linux', env: waylandSession, argv }), false);
  }
  for (const argv of [['--ozone-platform=x11'], ['--ozone-platform', 'x11']]) {
    assert.equal(canPositionWindow({ platform: 'linux', env: waylandSession, argv }), true);
  }
  assert.equal(canPositionWindow({ platform: 'linux', env: { DISPLAY: ':0' }, argv: [] }), true);
  assert.equal(canPositionWindow({ platform: 'darwin', env: waylandSession, argv: [] }), true);
});

test('native Wayland resizes preserve saved coordinates in the actual persistence callback', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const source = main.slice(main.indexOf('function persistBoundsSoon()'), main.indexOf('function applyZoomFactor'));
  for (const positionable of [false, true]) {
    let pending;
    let saves = 0;
    const settings = { windowBounds: { x: 330, y: 148, width: 480, height: 620 } };
    const context = {
      settings, mainWindow: { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 500, height: 640 }) },
      shouldPersistWindowBounds: () => true, stopPersistBoundsTimer: () => {},
      setTimeout: (fn) => { pending = fn; }, persistBoundsTimer: null,
      canPositionWindow: () => positionable, floatingBubbleState: { collapsed: false },
      saveSettings: () => { saves++; }
    };
    vm.runInNewContext(source + '\npersistBoundsSoon();', context);
    pending();
    assert.deepEqual(JSON.parse(JSON.stringify(settings.windowBounds)), { x: positionable ? 0 : 330, y: positionable ? 0 : 148, width: 500, height: 640 });
    assert.equal(saves, 1);
  }
});

test('package entry selects the backend before loading main', () => {
  const root = path.join(__dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/electron/launch.js');
  const entry = fs.readFileSync(path.join(root, pkg.main), 'utf8');
  assert.match(entry, /startWithXWayland\(\{ app, start: \(\) => require\('\.\/main'\) \}\)/);
});
