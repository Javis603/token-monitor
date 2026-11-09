'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  createAccentApi,
  syncWindowsBackdrop,
  windowsBackdropFallback
} = require('../../src/electron/windowsBackdrop');
const { normalizeWindowsBackdropMode, normalizeWindowsDockBackdropMode } = require('../../src/electron/windowsBackdropMode');
const {
  appearanceState,
  normalizeWindowsBackdropMode: normalizeRendererMode
} = require('../../src/electron/renderer/windowsGlass');

test('history material options follow the live main-window Windows backdrop setting', () => {
  const source = main.slice(main.indexOf('function getLimitsHistoryController()'), main.indexOf('let statsPushSource'));
  const settings = { windowsBackdrop: 'accent' };
  const context = vm.createContext({ settings, BrowserWindow: {}, screen: {}, ipcMain: {}, mainWindow: {}, dashboardWindow: {},
    limitsHistoryPayload() {}, nativeMaterialOptions: () => ({ enabled: true }), createLimitsHistoryController: options => options });
  vm.runInContext(`let limitsHistoryController = null; ${source}`, context);
  const controller = vm.runInContext('getLimitsHistoryController()', context);
  assert.equal(controller.getMaterialOptions().windowsBackdrop, 'accent');
  settings.windowsBackdrop = 'acrylic';
  assert.equal(controller.getMaterialOptions().windowsBackdrop, 'acrylic');
});

test('Windows backdrop modes fail closed to documented Acrylic', () => {
  assert.equal(normalizeRendererMode, normalizeWindowsBackdropMode);
  for (const value of [undefined, null, '', 'mica', 'ACRYLIC']) {
    assert.equal(normalizeWindowsBackdropMode(value), 'acrylic');
    assert.equal(normalizeRendererMode(value), 'acrylic');
  }
  assert.equal(normalizeWindowsBackdropMode('accent'), 'accent');
  assert.equal(normalizeRendererMode('accent'), 'accent');
});

test('Windows dock material preserves native glass by default and only accepts its own supported modes', () => {
  for (const value of [undefined, null, '', 'acrylic', 'accent', 'inherit']) {
    assert.equal(normalizeWindowsDockBackdropMode(value), 'inherit');
  }
  assert.equal(normalizeWindowsDockBackdropMode('host-backdrop'), 'host-backdrop');
  assert.equal(normalizeWindowsDockBackdropMode('transparent'), 'transparent');
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
  calls.length = 0;
  assert.equal(api.clear(7n), true);
  assert.deepEqual(calls.map(([name]) => name), ['accent', 'blur', 'frame']);
  assert.equal(calls[0][1].pvData.value.AccentState, 0);
  assert.equal(calls[1][1].dwFlags, 1);
  assert.equal(calls[1][1].fEnable, 0);
  assert.deepEqual(calls[2][1], { cxLeftWidth: 0, cxRightWidth: 0, cyTopHeight: 0, cyBottomHeight: 0 });
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

test('Windows material preferences keep transparent document hosts instead of replacing them', () => {
  assert.match(main, /windowsBackdrop: 'acrylic',/);
  assert.match(main, /windowsBackdrop: normalizeWindowsBackdropMode\(patch\.windowsBackdrop \?\? settings\.windowsBackdrop\)/);
  assert.match(main, /syncWindowsBackdrop\(mainWindow,/);
  assert.match(main, /windowsBackdropFallback: windowsBackdropFallback\(mainWindow\)/);
  assert.doesNotMatch(main, /previousNativeMaterial|nextNativeMaterial|replaceDashboardWindow|function rebuildWindow/);
  assert.doesNotMatch(main, /transparent: !/);
  assert.match(main, /dashboardWindow = win;[\s\S]*?syncWindowsBackdrop\(win, \{ enabled: nativeBlurEnabled\(\) \}\)/);
  assert.doesNotMatch(main, /windowsBackdropChanged/);
  assert.doesNotMatch(main, /windowsLayeredBlur/);
});

function materialFixture(result = true) {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8),
    setBackgroundMaterial: value => calls.push(['material', value]),
    setBackgroundColor: value => calls.push(['color', value])
  };
  const api = { apply: () => { calls.push(['accent']); return result; }, clear: () => { calls.push(['clear']); return true; } };
  return { win, calls, api, sync: settings => syncWindowsBackdrop(win, settings, { platform: 'win32', api }) };
}

test('failed Accent cleanup keeps the old transition retryable instead of caching success', () => {
  const f = materialFixture();
  f.sync({ mode: 'accent' });
  f.calls.length = 0;
  let cleaned = false;
  f.api.clear = () => { f.calls.push(['clear']); return cleaned; };
  const failed = f.sync({ mode: 'acrylic' });
  assert.equal(failed.mode, 'accent');
  assert.deepEqual(f.calls, [['clear']]);
  cleaned = true;
  const recovered = f.sync({ mode: 'acrylic' });
  assert.equal(recovered.mode, 'acrylic');
  assert.deepEqual(f.calls, [['clear'], ['clear'], ['material', 'acrylic']]);
});

test('partial Accent application keeps failed cleanup pending until a later sync succeeds', () => {
  const f = materialFixture(false);
  let clean = false;
  f.api.clear = () => { f.calls.push(['clear']); return clean; };
  const failed = f.sync({ mode: 'accent' });
  assert.equal(failed.accentCleanupPending, true);
  assert.equal(failed.fallback, true);
  f.api.clear = () => { f.calls.push(['clear']); throw new Error('native cleanup unavailable'); };
  assert.equal(f.sync({ enabled: false }).accentCleanupPending, true);
  assert.equal(f.calls.at(-1)[0], 'clear');
  clean = true;
  f.api.clear = () => { f.calls.push(['clear']); return clean; };
  const restored = f.sync({ enabled: false });
  assert.equal(restored.mode, 'transparent');
  assert.equal(restored.accentCleanupPending, false);
  assert.deepEqual(f.calls.slice(-3), [['clear'], ['material', 'none'], ['color', '#00000000']]);
});

test('appearance previews preserve fallback warnings unless the supplied patch replaces the flag', () => {
  const start = app.indexOf('  if (els.windowsBackdropNote) {', app.indexOf('function applyAppearanceSettings('));
  const snippet = app.slice(start, app.indexOf('  els.macBackdropRow', start));
  const classes = new Map();
  const note = { classList: { toggle(name, enabled) { classes.set(name, enabled); } } };
  const context = { els: { windowsBackdropNote: note }, windowsGlass: { showAccentNote: true },
    state: { settings: { windowsBackdropFallback: true } }, settings: {}, t: key => key };
  require('node:vm').runInNewContext(snippet, context);
  assert.equal(note.textContent, 'settings.appearance.windowsBackdropFallback');
  assert.equal(classes.get('hidden'), false);
  context.settings = { windowsBackdropFallback: false };
  require('node:vm').runInNewContext(snippet, context);
  assert.equal(note.textContent, '');
  assert.equal(classes.get('hidden'), true);
});

test('Acrylic and Accent switch both ways on the same window and unchanged preferences do no work', () => {
  const f = materialFixture();
  f.sync({ mode: 'acrylic' });
  f.sync({ mode: 'accent' });
  const count = f.calls.length;
  f.sync({ mode: 'accent' });
  assert.equal(f.calls.length, count);
  f.sync({ mode: 'acrylic' });
  assert.deepEqual(f.calls, [['material', 'acrylic'], ['material', 'none'], ['color', '#00000000'], ['accent'], ['clear'], ['material', 'acrylic']]);
  assert.equal(windowsBackdropFallback(f.win), false);
});

test('partial Accent failure is cleaned up before Acrylic fallback and fallback state follows the live choice', () => {
  const f = materialFixture(false);
  f.sync({ mode: 'accent' });
  assert.deepEqual(f.calls.slice(-3), [['accent'], ['clear'], ['material', 'acrylic']]);
  assert.equal(windowsBackdropFallback(f.win), true);
  f.sync({ mode: 'acrylic' });
  assert.equal(windowsBackdropFallback(f.win), false);
  const transparent = materialFixture();
  transparent.sync({ enabled: false, mode: 'accent' });
  assert.deepEqual(transparent.calls, [['material', 'none'], ['color', '#00000000']]);
});

test('turning system glass off clears native effects and restores desktop alpha on the same host', () => {
  const f = materialFixture();
  f.sync({ mode: 'acrylic' });
  f.sync({ enabled: false });
  f.sync({ mode: 'accent' });
  f.sync({ enabled: false });
  f.sync({ mode: 'acrylic' });
  assert.deepEqual(f.calls, [
    ['material', 'acrylic'], ['material', 'none'], ['color', '#00000000'],
    ['material', 'none'], ['color', '#00000000'], ['accent'],
    ['clear'], ['material', 'none'], ['color', '#00000000'], ['material', 'acrylic']
  ]);
});

test('Windows exposes an accessible Acrylic and experimental Accent selector', () => {
  assert.match(html, /role="radiogroup" aria-labelledby="windowGlassEffectLabel"/);
  assert.match(html, /input type="radio" name="systemGlassOption" value="system"/);
  assert.match(html, /input type="radio" name="systemGlassOption" value="off"/);
  assert.match(html, /id="windowsBackdropRow" class="settings-item hidden"/);
  assert.match(html, /id="windowsBackdropInput"/);
  assert.match(html, /option value="acrylic"/);
  assert.match(html, /option value="accent"/);
  assert.match(html, /option value="accent"[^>]*data-select-description="settings\.appearance\.windowsBackdropNote"/);
  assert.doesNotMatch(html, /data-i18n="settings\.appearance\.windowsBackdropNote"/);
  assert.match(html, /id="windowsBackdropNote"/);
  assert.match(html, /<script src="\.\.\/windowsBackdropMode\.js"><\/script>[\s\S]*<script src="windowsGlass\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(app, /windowsBackdropRow\?\.classList\.toggle\('hidden', !windowsGlass\.showBackdropControl\)/);
  assert.match(app, /windowsBackdropNote.classList\.toggle\('hidden', !accentFallback\)/);
  assert.doesNotMatch(app, /backdropControlDisabled/);
  assert.equal((i18n.match(/'settings\.appearance\.glassEffectSystem':/g) || []).length, 6);
  assert.equal((i18n.match(/'settings\.appearance\.glassEffectTransparent':/g) || []).length, 6);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdrop':/g) || []).length, 6);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdropAccent':/g) || []).length, 6);
  assert.equal((i18n.match(/'settings\.appearance\.windowsBackdropFallback':/g) || []).length, 6);
  assert.match(i18n, /Keeps the background translucent and blurred, even when the window is not focused\./);
  assert.doesNotMatch(css, /windows-native-blur-only/);
});

test('experimental Accent mode uses the shared glass surface treatment', () => {
  assert.doesNotMatch(app, /windows-accent-backdrop/);
  assert.doesNotMatch(css, /windows-accent-backdrop/);
  assert.match(html, /id="windowsBackdropNote"[^>]*class="[^"]*hidden"/);
});
