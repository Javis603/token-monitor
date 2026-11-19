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
  prepareTrayIconForPlatform,
  primaryDisplayScaleFactor,
  resizeTrayIconForPlatform,
  trayIconOpaqueBounds,
  trimTrayIconPadding,
  windowsTrayIconHeight
} = require('../../src/electron/tray');

// A 4-bytes-per-pixel buffer with one opaque rectangle, i.e. what
// nativeImage.toBitmap() hands back for a renderer-composed tray icon.
function bitmapWithOpaqueRect(width, height, rect, alpha = 255) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      bitmap[(y * width + x) * 4 + 3] = alpha;
    }
  }
  return bitmap;
}

function fakeTrayImage(width, height, bitmap) {
  const crops = [];
  const resizes = [];
  return {
    crops,
    resizes,
    getSize() { return { width, height }; },
    toBitmap() { return bitmap; },
    crop(bounds) {
      crops.push(bounds);
      return {
        cropped: bounds,
        resize(opts) { resizes.push(opts); return { resized: opts, source: 'cropped' }; }
      };
    },
    resize(opts) { resizes.push(opts); return { resized: opts, source: 'whole' }; }
  };
}

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
  const callStart = main.indexOf('prepareTrayIconForPlatform(', handlerStart);
  assert.notEqual(callStart, -1, 'handler calls prepareTrayIconForPlatform');
  const callEnd = main.indexOf('});', callStart);
  assert.notEqual(callEnd, -1, 'resizeTrayIconForPlatform call terminates with });');
  const callText = main.slice(callStart, callEnd + '});'.length);
  assert.doesNotMatch(callText, /square/, 'tray:setIcons must keep generated icons aspect-preserving (no square:true)');
});

function recordBuildTrayIcon(options) {
  const calls = [];
  const image = {
    resize(opts) {
      calls.push(['resize', opts]);
      return { resized: true };
    }
  };
  const result = buildTrayIcon({
    ...options,
    nativeImage: {
      createFromPath(iconPath) {
        calls.push(['path', iconPath]);
        return image;
      }
    }
  });
  return { calls, result };
}

test('buildTrayIcon resizes the Windows default icon to the small-icon metric from the full-bleed app asset', () => {
  const { calls, result } = recordBuildTrayIcon({ platform: 'win32', scaleFactor: 1 });

  // icon.png carries the macOS icon grid's inset margin (~75% artwork), which
  // the notification area has no reason to reserve — it would draw a quarter
  // smaller than the neighbouring icons even at the right pixel height (#314).
  assert.match(calls[0][1], /assets[\\/]icon-win\.png$/, 'Windows takes the full-bleed variant');
  assert.deepEqual(calls[1], ['resize', { height: 16, quality: 'best' }]);
  assert.deepEqual(result, { resized: true });
});

test('buildTrayIcon keeps the macOS-grid app icon everywhere except Windows', () => {
  const { calls } = recordBuildTrayIcon({ platform: 'linux' });
  assert.match(calls[0][1], /assets[\\/]icon\.png$/);
  assert.deepEqual(calls[1], ['resize', { width: 20, height: 20 }]);
});

test('trayIconOpaqueBounds finds the drawn pixels and ignores an antialiased tail', () => {
  const bounds = trayIconOpaqueBounds(bitmapWithOpaqueRect(44, 44, { x: 5, y: 9, width: 34, height: 26 }), 44, 44);
  assert.deepEqual(bounds, { x: 5, y: 9, width: 34, height: 26 });

  // Alpha at or below the threshold is the invisible tail of a soft edge; pinning
  // the bounds to it would make the trim a no-op for every antialiased icon.
  assert.equal(trayIconOpaqueBounds(bitmapWithOpaqueRect(8, 8, { x: 0, y: 0, width: 8, height: 8 }, 12), 8, 8), null);
  assert.deepEqual(
    trayIconOpaqueBounds(bitmapWithOpaqueRect(8, 8, { x: 0, y: 0, width: 8, height: 8 }, 13), 8, 8),
    { x: 0, y: 0, width: 8, height: 8 }
  );

  // Nothing drawn, and a buffer too short to be the bitmap it claims: both have
  // no answer, and must not be reported as an empty crop.
  assert.equal(trayIconOpaqueBounds(Buffer.alloc(44 * 44 * 4), 44, 44), null);
  assert.equal(trayIconOpaqueBounds(Buffer.alloc(16), 44, 44), null);
  assert.equal(trayIconOpaqueBounds(null, 44, 44), null);
  assert.equal(trayIconOpaqueBounds(Buffer.alloc(0), 0, 0), null);
});

test('trimTrayIconPadding crops a padded tray bitmap and leaves a full-bleed one untouched', () => {
  // The renderer composes provider marks at 78% of their box and text segments
  // at roughly half their canvas height, which is macOS menubar breathing room.
  // Windows fits the whole bitmap into one square cell, so that padding is cell
  // space the icon never gets back (#314).
  const padded = fakeTrayImage(44, 44, bitmapWithOpaqueRect(44, 44, { x: 5, y: 5, width: 34, height: 34 }));
  assert.deepEqual(trimTrayIconPadding(padded).cropped, { x: 5, y: 5, width: 34, height: 34 });
  assert.deepEqual(padded.crops, [{ x: 5, y: 5, width: 34, height: 34 }]);

  const fullBleed = fakeTrayImage(44, 44, bitmapWithOpaqueRect(44, 44, { x: 0, y: 0, width: 44, height: 44 }));
  assert.equal(trimTrayIconPadding(fullBleed), fullBleed, 'already edge to edge: no crop');
  assert.deepEqual(fullBleed.crops, []);

  // A wide composed icon is width-bound in the square cell, so the horizontal
  // trim is the part that buys anything — but the crop must keep both axes tight.
  const wide = fakeTrayImage(91, 44, bitmapWithOpaqueRect(91, 44, { x: 2, y: 11, width: 87, height: 22 }));
  assert.deepEqual(trimTrayIconPadding(wide).cropped, { x: 2, y: 11, width: 87, height: 22 });

  // An icon whose canvas is entirely transparent has no bounds to crop to;
  // cropping it to nothing would hand the tray an empty image.
  const blank = fakeTrayImage(44, 44, Buffer.alloc(44 * 44 * 4));
  assert.equal(trimTrayIconPadding(blank), blank);
  assert.deepEqual(blank.crops, []);
});

test('prepareTrayIconForPlatform trims before resizing on Windows only', () => {
  const padded = () => fakeTrayImage(44, 44, bitmapWithOpaqueRect(44, 44, { x: 5, y: 5, width: 34, height: 34 }));

  const windows = padded();
  const sized = prepareTrayIconForPlatform(windows, { platform: 'win32', scaleFactor: 1.5 });
  assert.deepEqual(windows.crops, [{ x: 5, y: 5, width: 34, height: 34 }]);
  assert.deepEqual(windows.resizes, [{ height: 24, quality: 'best' }]);
  assert.equal(sized.source, 'cropped', 'the resize consumes the trimmed image, not the original');

  // macOS must keep the padding: its menubar has no cell to fill and the icon
  // sits inline with the title text that the breathing room is measured against.
  for (const platform of ['darwin', 'linux']) {
    const other = padded();
    const result = prepareTrayIconForPlatform(other, { platform, scaleFactor: 1.5 });
    assert.deepEqual(other.crops, [], `${platform} never trims`);
    assert.deepEqual(other.resizes, [{ height: 20, quality: 'best' }]);
    assert.equal(result.source, 'whole');
  }

  // The bundled square app icon opts into the force-square tile, and that has to
  // survive the extra hop rather than being dropped by the wrapper.
  const linuxSquare = padded();
  prepareTrayIconForPlatform(linuxSquare, { platform: 'linux', square: true });
  assert.deepEqual(linuxSquare.resizes, [{ width: 20, height: 20 }]);
});

test('the full-bleed Windows icon ships in the Windows package and nowhere else', () => {
  // The tray reads this at runtime, but electron-builder only treats `win.icon`
  // as a build input — left out of `files` it would be missing from the asar and
  // the Windows tray would come up blank, which no CI job here would catch.
  // Platform `files` are appended to the shared list rather than replacing it,
  // so scoping it to `win` keeps a 1MB Windows-only asset out of the macOS and
  // Linux artifacts without narrowing what they package.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(__dirname, '../../assets/icon-win.png')), 'assets/icon-win.png exists');
  assert.ok(pkg.build.win.files.includes('assets/icon-win.png'), 'assets/icon-win.png is in build.win.files');
  assert.ok(!pkg.build.files.includes('assets/icon-win.png'), 'and not in the shared list');
});

test('Windows leaves the window icon to the executable that already carries an ICO', () => {
  // Electron falls back to the exe icon when a window names none, and
  // electron-builder converts win.icon into the ICO embedded there. Naming a
  // PNG here overrides the icon built for the platform, which is what reached
  // the taskbar and Alt-Tab entry (#314).
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.doesNotMatch(main, /\n\s*icon: APP_ICON_PATH,/, 'no window names the icon directly');
  assert.match(main, /function appWindowIcon\(\) \{[\s\S]*?return app\.isPackaged \? \{\} : \{ icon: WINDOWS_APP_ICON_PATH \};[\s\S]*?\}/);
  // app.dock.setIcon is darwin-only and keeps the macOS-grid artwork.
  assert.match(main, /process\.platform === 'darwin' && app\.dock\) app\.dock\.setIcon\(APP_ICON_PATH\)/);
});
