'use strict';

// Windows tray icons (#314) rendered too small / blurry because every platform
// resized to a fixed height: 20. These tests pin the per-platform metric the
// main process resizes to: the macOS menubar height vs. the Windows small-icon
// metric (16px x the display scale factor, with no cap).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildTrayIcon,
  primaryDisplayScaleFactor,
  resizeTrayIconForPlatform,
  windowsTrayIconHeight
} = require('../../src/electron/tray');

test('windowsTrayIconHeight tracks the Windows small-icon metric across DPI without capping', () => {
  assert.equal(windowsTrayIconHeight(1), 16, 'SM_CXSMICON at 100%');
  assert.equal(windowsTrayIconHeight(1.25), 20);
  assert.equal(windowsTrayIconHeight(1.5), 24);
  assert.equal(windowsTrayIconHeight(2), 32, '@2x companion Microsoft asks for');
  assert.equal(windowsTrayIconHeight(2.5), 40, '250% wants the metric, not a 32px cap');
  assert.equal(windowsTrayIconHeight(3), 48, '300% wants the metric, not a 32px cap');
  for (const scaleFactor of [0.5, 1, 1.25, 1.5, 2, 2.5, 3, 4]) {
    const height = windowsTrayIconHeight(scaleFactor);
    assert.ok(height >= 16, `scaleFactor=${scaleFactor} -> ${height} never drops below the 100% metric`);
  }
});

test('resizeTrayIconForPlatform gives Windows a different, metric-sized target than macOS', () => {
  const calls = [];
  const img = {
    resize(opts) {
      calls.push(opts);
      return { opts };
    }
  };

  resizeTrayIconForPlatform(img, { platform: 'darwin' });
  resizeTrayIconForPlatform(img, { platform: 'win32', scaleFactor: 1 });
  resizeTrayIconForPlatform(img, { platform: 'win32', scaleFactor: 2 });
  // Generated tray icons (bars/sessions/limits) are wider than tall: Linux keeps
  // the aspect-preserving height-only resize the tray:setIcons handler always used.
  resizeTrayIconForPlatform(img, { platform: 'linux' });
  // The square default app icon opts into a force-square 20x20 tile.
  resizeTrayIconForPlatform(img, { platform: 'linux', square: true });

  const [darwin, win100, win200, linuxGenerated, linuxSquare] = calls;
  assert.deepEqual(darwin, { height: 20, quality: 'best' }, 'macOS menubar height');
  assert.deepEqual(win100, { height: 16, quality: 'best' }, '100% small-icon metric');
  assert.deepEqual(win200, { height: 32, quality: 'best' }, '200% small-icon metric');
  assert.deepEqual(linuxGenerated, { height: 20, quality: 'best' }, 'Linux keeps the aspect-preserving default');
  assert.deepEqual(linuxSquare, { width: 20, height: 20 }, 'square default app icon stays a 20x20 tile');
});

test('resizeTrayIconForPlatform derives the Windows metric from primaryDisplayScaleFactor when none is given', () => {
  // The production tray:setIcons path passes scaleFactor explicitly, but
  // resizeTrayIconForPlatform must still default to the primary display's factor.
  // In the test runner Electron is unavailable, so primaryDisplayScaleFactor()
  // falls back to 1 (= the 100% metric 16).
  assert.equal(primaryDisplayScaleFactor(), 1);
  const calls = [];
  const img = { resize(opts) { calls.push(opts); return {}; } };
  resizeTrayIconForPlatform(img, { platform: 'win32' });
  assert.deepEqual(calls[0], { height: windowsTrayIconHeight(primaryDisplayScaleFactor()), quality: 'best' });
  assert.equal(calls[0].height, 16);
});

test('resizeTrayIconForPlatform ignores scaleFactor on darwin (macOS menubar height is fixed)', () => {
  // main.js passes scaleFactor for every platform, so this guards against an
  // accidental darwin `height: 20 * factor` regression that would tie the macOS
  // menubar icon size to the display DPI instead of the fixed 22 pt slot.
  const calls = [];
  const img = { resize(opts) { calls.push(opts); return {}; } };
  resizeTrayIconForPlatform(img, { platform: 'darwin', scaleFactor: 2 });
  assert.deepEqual(calls[0], { height: 20, quality: 'best' }, 'darwin never scales its height by factor');
});

test('tray:setIcons does not force-square the generated tray icons', () => {
  // The generated bars/sessions/limits icons are wider than tall, so the
  // resizeTrayIconForPlatform call inside the tray:setIcons handler must NOT pass
  // square:true — that would squash their aspect ratio. Scope the search to the
  // handler so a future second call site elsewhere can't mask a regression here.
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const handlerStart = main.indexOf("ipcMain.handle('tray:setIcons'");
  assert.notEqual(handlerStart, -1, 'tray:setIcons handler exists');
  const callStart = main.indexOf('resizeTrayIconForPlatform(', handlerStart);
  assert.notEqual(callStart, -1, 'handler calls resizeTrayIconForPlatform');
  const callEnd = main.indexOf('});', callStart);
  assert.notEqual(callEnd, -1, 'resizeTrayIconForPlatform call terminates with });');
  const callText = main.slice(callStart, callEnd + '});'.length);
  assert.doesNotMatch(callText, /square/, 'tray:setIcons must keep generated icons aspect-preserving (no square:true)');
});

test('buildTrayIcon resizes the Windows default icon to the small-icon metric from the high-res app asset', () => {
  const calls = [];
  const image = {
    resize(opts) {
      calls.push(['resize', opts]);
      return { resized: true };
    }
  };
  const result = buildTrayIcon({
    platform: 'win32',
    scaleFactor: 1,
    nativeImage: {
      createFromPath(iconPath) {
        calls.push(['path', iconPath]);
        return image;
      }
    }
  });

  assert.match(calls[0][1], /assets[\\/]icon\.png$/);
  assert.deepEqual(calls[1], ['resize', { height: 16, quality: 'best' }]);
  assert.deepEqual(result, { resized: true });
});
