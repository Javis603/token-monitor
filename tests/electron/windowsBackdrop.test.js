'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const rendererDir = path.join(root, 'src/electron/renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const {
  DEFAULT_ACCENT_ARGB,
  applyWindowsAccentBlur,
  createAccentApi
} = require('../../src/electron/windowsBackdrop');
const { normalizeWindowsBackdropMode } = require('../../src/electron/windowsBackdropMode');
const {
  appearanceState,
  normalizeWindowsBackdropMode: normalizeRendererMode
} = require('../../src/electron/renderer/windowsGlass');

test('Windows backdrop modes fail closed to documented Acrylic', () => {
  assert.equal(normalizeRendererMode, normalizeWindowsBackdropMode);
  for (const value of [undefined, null, '', 'mica', 'ACRYLIC']) {
    assert.equal(normalizeWindowsBackdropMode(value), 'acrylic');
    assert.equal(normalizeRendererMode(value), 'acrylic');
  }
  assert.equal(normalizeWindowsBackdropMode('accent'), 'accent');
  assert.equal(normalizeRendererMode('accent'), 'accent');
});

test('Windows glass appearance state covers platform and system-glass boundaries', () => {
  assert.deepEqual(appearanceState({}, { isWindows: false }), {
    showBackdropControl: false,
    showAccentNote: false,
    backdropMode: 'acrylic'
  });
  assert.deepEqual(appearanceState({ systemGlass: false, windowsBackdrop: 'accent' }, { isWindows: true }), {
    showBackdropControl: false,
    showAccentNote: false,
    backdropMode: 'accent'
  });
  assert.deepEqual(appearanceState({ systemGlass: true, windowsBackdrop: 'accent' }, { isWindows: true }), {
    showBackdropControl: true,
    showAccentNote: true,
    backdropMode: 'accent'
  });
  assert.deepEqual(appearanceState({ systemGlass: true, windowsBackdrop: 'acrylic' }, { isWindows: true }), {
    showBackdropControl: true,
    showAccentNote: false,
    backdropMode: 'acrylic'
  });
});

test('Accent blur passes the native HWND and configured tint to the native adapter', () => {
  const calls = [];
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x12345678n);
  const win = {
    getNativeWindowHandle: () => handle,
    isDestroyed: () => false
  };
  const api = {
    apply(hwnd, argb) {
      calls.push({ hwnd, argb });
      return true;
    }
  };

  assert.equal(applyWindowsAccentBlur(win, { platform: 'win32', api }), true);
  assert.deepEqual(calls, [{ hwnd: 0x12345678n, argb: DEFAULT_ACCENT_ARGB }]);
  assert.equal(applyWindowsAccentBlur(win, { platform: 'darwin', api }), false);
  assert.equal(applyWindowsAccentBlur({ ...win, isDestroyed: () => true }, { platform: 'win32', api }), false);
});

test('native Accent adapter enables a full blur region before applying policy and extending the frame', () => {
  const calls = [];
  const region = { pointer: 'region' };
  const fakeFunctions = {
    CreateRectRgn: (...args) => { calls.push(['region', ...args]); return region; },
    DwmEnableBlurBehindWindow: (_hwnd, value) => { calls.push(['blur', value]); return 0; },
    SetWindowCompositionAttribute: (_hwnd, value) => { calls.push(['accent', value]); return true; },
    DwmExtendFrameIntoClientArea: (_hwnd, value) => { calls.push(['frame', value]); return 0; },
    DeleteObject: (value) => { calls.push(['delete', value]); return true; }
  };
  const koffi = {
    load: () => ({
      func(signature) {
        const name = signature.match(/([A-Za-z0-9_]+)\(/)?.[1];
        return fakeFunctions[name];
      }
    }),
    struct: (name, fields) => ({ name, fields }),
    as: (value, type) => ({ value, type }),
    sizeof: () => 16
  };
  const api = createAccentApi(koffi);

  assert.equal(api.apply(7n, DEFAULT_ACCENT_ARGB), true);
  assert.deepEqual(calls.map(([name]) => name), ['region', 'blur', 'frame', 'accent', 'delete']);
  assert.equal(calls[1][1].dwFlags, 7);
  assert.equal(calls[1][1].hRgnBlur, region);
  assert.deepEqual(calls[2][1], {
    cxLeftWidth: -1,
    cxRightWidth: -1,
    cyTopHeight: -1,
    cyBottomHeight: -1
  });
  assert.equal(calls[3][1].Attrib, 19);
  assert.deepEqual(calls[3][1].pvData.value, {
    AccentState: 4,
    AccentFlags: 0,
    GradientColor: DEFAULT_ACCENT_ARGB,
    AnimationId: 0
  });
});

test('native Accent adapter rejects failed DWM setup before applying the Accent policy', () => {
  function run({ blurResult = 0, frameResult = 0 }) {
    const calls = [];
    const fakeFunctions = {
      CreateRectRgn: () => { calls.push('region'); return {}; },
      DwmEnableBlurBehindWindow: () => { calls.push('blur'); return blurResult; },
      DwmExtendFrameIntoClientArea: () => { calls.push('frame'); return frameResult; },
      SetWindowCompositionAttribute: () => { calls.push('accent'); return true; },
      DeleteObject: () => { calls.push('delete'); return true; }
    };
    const koffi = {
      load: () => ({
        func(signature) {
          return fakeFunctions[signature.match(/([A-Za-z0-9_]+)\(/)?.[1]];
        }
      }),
      struct: (name, fields) => ({ name, fields }),
      as: (value, type) => ({ value, type }),
      sizeof: () => 16
    };
    return { result: createAccentApi(koffi).apply(7n, DEFAULT_ACCENT_ARGB), calls };
  }

  assert.deepEqual(run({ blurResult: -1 }), {
    result: false,
    calls: ['region', 'blur', 'delete']
  });
  assert.deepEqual(run({ frameResult: -1 }), {
    result: false,
    calls: ['region', 'blur', 'frame', 'delete']
  });
  assert.deepEqual(run({ blurResult: 1, frameResult: 1 }), {
    result: true,
    calls: ['region', 'blur', 'frame', 'accent', 'delete']
  });
});

test('main process selects Accent at creation and falls back to Acrylic on failure', () => {
  assert.match(main, /windowsBackdrop: 'acrylic',/);
  assert.match(main, /windowsBackdrop: normalizeWindowsBackdropMode\(patch\.windowsBackdrop \?\? settings\.windowsBackdrop\)/);
  assert.match(main, /backgroundMaterial: 'acrylic'/);
  assert.match(main, /windowsAccent && !applyWindowsAccentBlur\(win\)/);
  assert.match(main, /win\.setBackgroundMaterial\('acrylic'\)/);
  assert.match(main, /windowsBackdropFallback: '1'/);
  assert.match(main, /previousWindowsBackdrop !== nextWindowsBackdrop/);
  assert.doesNotMatch(main, /windowsLayeredBlur/);
});

test('Windows exposes an accessible Acrylic and experimental Accent selector', () => {
  assert.match(html, /role="radiogroup" aria-labelledby="windowGlassEffectLabel"/);
  assert.match(html, /input type="radio" name="systemGlassOption" value="system"/);
  assert.match(html, /input type="radio" name="systemGlassOption" value="off"/);
  assert.match(html, /id="windowsBackdropRow" class="settings-item hidden"/);
  assert.match(html, /id="windowsBackdropInput"/);
  assert.match(html, /option value="acrylic"/);
  assert.match(html, /option value="accent"/);
  assert.match(html, /data-i18n="settings\.appearance\.windowsBackdropNote"/);
  assert.match(html, /id="windowsBackdropNote"/);
  assert.match(html, /<script src="\.\.\/windowsBackdropMode\.js"><\/script>[\s\S]*<script src="windowsGlass\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(app, /windowsBackdropRow\?\.classList\.toggle\('hidden', !windowsGlass\.showBackdropControl\)/);
  assert.match(app, /classList\.toggle\('hidden', !windowsGlass\.showAccentNote\)/);
  assert.doesNotMatch(app, /backdropControlDisabled/);
  assert.equal((i18n.match(/'settings\.appearance\.glassEffectSystem':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.appearance\.glassEffectTransparent':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdrop':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdropAccent':/g) || []).length, 5);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdropFallback':/g) || []).length, 5);
  assert.match(i18n, /Keeps the background translucent and blurred, even when the window is not focused\./);
  assert.doesNotMatch(css, /windows-native-blur-only/);
});

test('experimental Accent mode uses the shared glass surface treatment', () => {
  assert.doesNotMatch(app, /windows-accent-backdrop/);
  assert.doesNotMatch(css, /windows-accent-backdrop/);
  assert.match(css, /#windowsBackdropNote\.hidden \{ display: none; \}/);
});
