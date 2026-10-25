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
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const { normalizeMacBackdropMode, appearanceState, isLiquidGlassBackdrop, liquidGlassStyle, normalizeLiquidGlassTint, liquidGlassTint } = require('../../src/electron/macBackdropMode');
const { normalizeNativeMaterialState } = require('../../src/electron/renderer/glassRendering');

test('Tint Reset buttons have localized accessible names without changing their visible glyph or styling', () => {
  const { applyTranslations, translate } = require('../../src/electron/renderer/i18n');
  const buttons = ['macGlassTintReset', 'macClearGlassTintReset'].map((id) => {
    const [, attributes, glyph] = html.match(new RegExp(`<button id="${id}"([^]*?)>([^]*?)</button>`));
    assert.match(attributes, /class="reset-appearance-button reset-inline"/);
    assert.match(attributes, /aria-label="Reset tint"/);
    assert.match(attributes, /data-i18n-aria-label="settings.appearance.resetTint"/);
    assert.equal(glyph, '↺');
    return { textContent: glyph, attributes: {}, dataset: {
      i18nAriaLabel: 'settings.appearance.resetTint'
    }, setAttribute(name, value) { this.attributes[name] = value; } };
  });
  const scope = { querySelectorAll: (selector) => selector === '[data-i18n-aria-label]' ? buttons : [] };
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt']) {
    applyTranslations(scope, locale);
    for (const button of buttons) {
      assert.equal(button.attributes['aria-label'], translate(locale, 'settings.appearance.resetTint'));
      assert.equal(button.attributes.title, undefined);
      assert.equal(button.textContent, '↺');
    }
  }
});

test('native glass tints are independent, bounded and retain their previous defaults', () => {
  assert.equal(liquidGlassTint({ macBackdrop: 'liquid-glass-clear', glassOpacity: 90 }), 0.35);
  assert.equal(liquidGlassTint({ macBackdrop: 'liquid-glass', glassOpacity: 90 }), 0);
  const settings = { macBackdrop: 'liquid-glass-clear', macGlassTint: 12, macClearGlassTint: 64 };
  assert.equal(liquidGlassTint(settings), 0.64);
  assert.equal(liquidGlassTint(settings, 'liquid-glass'), 0.12);
  for (const mode of ['liquid-glass', 'liquid-glass-clear']) {
    const fallback = mode === 'liquid-glass-clear' ? 35 : 0;
    for (const value of [undefined, null, '', NaN, Infinity, 'invalid']) assert.equal(normalizeLiquidGlassTint(value, mode), fallback);
    assert.equal(normalizeLiquidGlassTint(-1, mode), 0);
    assert.equal(normalizeLiquidGlassTint(101, mode), 100);
    assert.equal(normalizeLiquidGlassTint('27', mode), 27);
    assert.equal(normalizeLiquidGlassTint(0, mode), 0);
  }
});

test('floating glass previews share live tints without replacing styles or saved values, then yield to settings sync', () => {
  const definitions = ['dockAppearanceSettings', 'previewDockAppearance', 'syncDockSurfaces']
    .map((name) => main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  const settings = { macBackdrop: 'liquid-glass', edgeDockMacBackdrop: 'liquid-glass-clear', macGlassTint: 12, macClearGlassTint: 64 };
  const updates = [];
  let context;
  const read = () => {
    const source = context.dockAppearanceSettings();
    updates.push([source.macBackdrop, source.edgeDockMacBackdrop, liquidGlassTint(source), liquidGlassTint(source, 'liquid-glass-clear')]);
  };
  context = vm.createContext({
    settings, process: { platform: 'darwin' }, normalizeLiquidGlassTint,
    settingsForRenderer: () => { throw new Error('preview must not project account settings'); },
    edgeDockController: { setAppearance: read, isRunning: () => true, stop() {} },
    notchController: { setAppearance: read, isRunning: () => true },
    syncNotch: read, canUseEdgeDock: () => false
  });
  vm.runInContext(`let dockAppearancePreview = null;\n${definitions}`, context);
  context.previewDockAppearance({ macGlassTint: 80, macBackdrop: 'vibrancy', themeColors: { bg: '#fff' } });
  assert.deepEqual(updates.at(-1), ['liquid-glass', 'liquid-glass-clear', 0.8, 0.64]);
  assert.equal(updates.length, 2, 'both floating controllers update before commit');
  assert.equal(settings.macGlassTint, 12, 'preview does not save');
  context.previewDockAppearance({ macClearGlassTint: 0 });
  assert.deepEqual(updates.at(-1), ['liquid-glass', 'liquid-glass-clear', 0.8, 0]);
  settings.macGlassTint = 27;
  context.syncDockSurfaces();
  assert.equal(context.dockAppearanceSettings(), settings);
  assert.deepEqual(updates.at(-1), ['liquid-glass', 'liquid-glass-clear', 0.27, 0.64]);
});

test('frosted glass previews deliver opacity and depth to both floating renderers before saving', () => {
  const definitions = ['dockAppearanceSettings', 'previewDockAppearance', 'edgeDockAppearance', 'syncDockSurfaces']
    .map((name) => main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  const settings = { systemGlass: true, macBackdrop: 'vibrancy', glassOpacity: 68, glassBlur: 32 };
  const updates = [];
  const receive = (value, options) => {
    assert.equal(options?.preview, true);
    updates.push([value.glassOpacity, value.glassBlur]);
  };
  const context = vm.createContext({
    settings, process: { platform: 'darwin' }, normalizeLiquidGlassTint,
    settingsForRenderer: () => { throw new Error('preview must not project account settings'); },
    edgeDockController: { setAppearance: receive, isRunning: () => true, stop() {} },
    notchController: { setAppearance: receive, isRunning: () => true },
    syncNotch() {}, canUseEdgeDock: () => false
  });
  vm.runInContext(`let dockAppearancePreview = null;\n${definitions}`, context);
  context.previewDockAppearance({ glassOpacity: 17, glassBlur: 75 });
  assert.deepEqual(updates, [[17, 75], [17, 75]]);
  assert.equal(settings.glassOpacity, 68);
  assert.equal(settings.glassBlur, 32);
  context.previewDockAppearance({ glassOpacity: 0 });
  assert.deepEqual(updates.at(-1), [0, 75]);
  context.syncDockSurfaces();
  assert.equal(context.dockAppearanceSettings(), settings);
});

test('stopped floating controllers retain preview values without projection or dispatch; running ones receive every input', () => {
  const definitions = ['dockAppearanceSettings', 'previewDockAppearance']
    .map((name) => main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  const settings = { macBackdrop: 'liquid-glass', macGlassTint: 12, glassOpacity: 68 };
  const running = { dock: false, notch: false };
  const updates = [];
  const controller = (id) => ({
    isRunning: () => running[id],
    isVisible() { throw new Error('running hidden windows must not be skipped'); },
    setAppearance(value, options) { assert.equal(options.preview, true); updates.push([id, { ...value }]); }
  });
  const context = vm.createContext({ settings, normalizeLiquidGlassTint,
    settingsForRenderer() { throw new Error('must not project account settings'); },
    edgeDockAppearance() { throw new Error('must not rebuild the full appearance'); },
    edgeDockController: controller('dock'), notchController: controller('notch') });
  vm.runInContext(`let dockAppearancePreview = null;\n${definitions}`, context);
  context.previewDockAppearance({ macGlassTint: 80, glassOpacity: 17 });
  assert.deepEqual(updates, []);
  assert.equal(context.dockAppearanceSettings().macGlassTint, 80);
  assert.equal(context.dockAppearanceSettings().glassOpacity, 17);
  running.dock = true;
  for (const glassOpacity of [18, 19, 20]) context.previewDockAppearance({ glassOpacity });
  assert.deepEqual(updates.map(([id, value]) => [id, value.glassOpacity, value.macGlassTint]),
    [['dock', 18, 80], ['dock', 19, 80], ['dock', 20, 80]]);
  running.dock = false; running.notch = true;
  context.previewDockAppearance({ glassBlur: 75 });
  assert.equal(updates.at(-1)[0], 'notch');
  assert.equal(updates.at(-1)[1].glassOpacity, 20);
  assert.equal(settings.glassOpacity, 68);
  assert.equal(settings.macGlassTint, 12);
});

test('appearance controls keep both native tints separate from classic glass when switching modes', () => {
  const body = app.match(/function appearancePatchFromControls\(\) \{[^]*?\n\}/)[0];
  const els = {
    macBackdropInput: { value: 'liquid-glass-clear' },
    glassInput: { value: '76' }, blurInput: { value: '32' }, zoomInput: { value: '100' },
    macGlassTintInput: { value: '12' }, macClearGlassTintInput: { value: '64' }
  };
  for (const key of ['liveDotInput', 'toolIconsInput', 'titleIconInput', 'showCompactTotalTokensInput',
    'showLiveTokenRateInput', 'swapSettingsRefreshInput']) els[key] = { checked: true };
  const context = {
    els, macBackdropApi: { normalizeMacBackdropMode, normalizeLiquidGlassTint },
    nativeGlassTintSettings: [['macGlassTint', 'liquid-glass'], ['macClearGlassTint', 'liquid-glass-clear']],
    windowsGlassApi: { normalizeWindowsBackdropMode: () => 'acrylic' },
    tokenNumberAnimationApi: { normalize: () => 'roll' }, defaultAppearance: { backgroundImageOpacity: 28 }
  };
  for (const mode of ['liquid-glass-clear', 'liquid-glass', 'vibrancy', 'liquid-glass-clear']) {
    els.macBackdropInput.value = mode;
    const patch = vm.runInNewContext(`(${body})()`, context);
    assert.equal(patch.macBackdrop, mode);
    assert.equal(patch.glassOpacity, 76);
    assert.equal(patch.macGlassTint, 12);
    assert.equal(patch.macClearGlassTint, 64);
  }
});

test('macOS backdrop modes default to the classic vibrancy; Liquid Glass is opt-in', () => {
  for (const value of [undefined, null, '', 'hud', 'LIQUID-GLASS', 'vibrancy']) {
    assert.equal(normalizeMacBackdropMode(value), 'vibrancy');
  }
  assert.equal(normalizeMacBackdropMode('liquid-glass'), 'liquid-glass');
});

test('Clear survives normalization and inheritance and selects the native Clear style', () => {
  const { normalizeEdgeDockBackdropMode, edgeDockBackdropMode } = require('../../src/electron/macBackdropMode');
  const clear = 'liquid-glass-clear';
  assert.equal(normalizeMacBackdropMode(clear), clear);
  assert.equal(normalizeEdgeDockBackdropMode(clear), clear);
  assert.equal(edgeDockBackdropMode({ macBackdrop: clear }), clear);
  assert.equal(edgeDockBackdropMode({ macBackdrop: 'vibrancy', edgeDockMacBackdrop: clear }), clear);
  assert.equal(edgeDockBackdropMode({ macBackdrop: clear, edgeDockMacBackdrop: 'liquid-glass' }), 'liquid-glass');
  assert.equal(isLiquidGlassBackdrop(clear), true);
  assert.equal(isLiquidGlassBackdrop('liquid-glass'), true);
  assert.equal(isLiquidGlassBackdrop('vibrancy'), false);
  assert.equal(liquidGlassStyle(clear), 'clear');
  assert.equal(liquidGlassStyle('liquid-glass'), 'regular');
  for (const id of ['macBackdropInput', 'edgeDockMacBackdropInput', 'notchStyleInput']) {
    const select = html.match(new RegExp(`<select id="${id}">([^]*?)</select>`))[1];
    assert.match(select, /value="liquid-glass-clear" data-i18n="settings.appearance.macBackdropLiquidGlassClear"/);
  }
});

test('the macOS style control appears only where Liquid Glass exists and System Glass is on', () => {
  assert.deepEqual(appearanceState({ macBackdrop: 'liquid-glass' }), {
    showBackdropControl: false,
    backdropMode: 'liquid-glass'
  });
  assert.deepEqual(appearanceState({}, { liquidGlassSupported: true }), {
    showBackdropControl: true,
    backdropMode: 'vibrancy'
  });
  assert.equal(appearanceState({ systemGlass: false }, { liquidGlassSupported: true }).showBackdropControl, false);
  assert.equal(normalizeNativeMaterialState({ liquidGlassSupported: true }).liquidGlassSupported, true);
  assert.equal(normalizeNativeMaterialState({ liquidGlassSupported: 'yes' }).liquidGlassSupported, false);
});

test('main process persists the macOS style and feeds it to the native material', () => {
  assert.match(main, /macBackdrop: 'vibrancy',/);
  assert.match(app, /macBackdrop: 'vibrancy', reduceMotion/);
  assert.match(main, /macBackdrop: normalizeMacBackdropMode\(patch\.macBackdrop \?\? settings\.macBackdrop\)/);
  assert.match(main, /liquidGlass: isLiquidGlassBackdrop\(source\.macBackdrop\)/);
});

test('settings expose a localized macOS style selector wired to the saved preference', () => {
  assert.match(html, /id="macBackdropRow" class="settings-item hidden"/);
  assert.match(html, /<select id="macBackdropInput"><option value="vibrancy"[^>]*>[^<]*<\/option><option value="liquid-glass"/);
  assert.match(html, /<script src="\.\.\/macBackdropMode\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(app, /macBackdropRow\?\.classList\.toggle\('hidden', !macGlass\.showBackdropControl\)/);
  assert.match(app, /macBackdrop: macBackdropApi\.normalizeMacBackdropMode\(els\.macBackdropInput\?\.value\)/);
  assert.match(app, /els\.macBackdropInput\?\.addEventListener\('change', saveAppearanceFromControls\)/);
  for (const key of ['macBackdrop', 'macBackdropLiquidGlass', 'macBackdropLiquidGlassClear', 'macBackdropVibrancy']) {
    assert.equal((i18n.match(new RegExp(`'settings\\.appearance\\.${key}':`, 'g')) || []).length, 6, key);
  }
});

test('the edge dock follows the widget style unless it names its own', () => {
  const { normalizeEdgeDockBackdropMode, edgeDockBackdropMode } = require('../../src/electron/macBackdropMode');
  for (const value of [undefined, null, '', 'hud', 'inherit']) {
    assert.equal(normalizeEdgeDockBackdropMode(value), 'inherit');
  }
  assert.equal(edgeDockBackdropMode({}), 'vibrancy');
  assert.equal(edgeDockBackdropMode({ macBackdrop: 'liquid-glass' }), 'liquid-glass');
  assert.equal(edgeDockBackdropMode({ macBackdrop: 'vibrancy', edgeDockMacBackdrop: 'liquid-glass' }), 'liquid-glass');
  assert.equal(edgeDockBackdropMode({ macBackdrop: 'liquid-glass', edgeDockMacBackdrop: 'vibrancy' }), 'vibrancy');
  // Transparent is kept, but the material it would fall back to is the widget's.
  assert.equal(normalizeEdgeDockBackdropMode('transparent'), 'transparent');
  assert.equal(edgeDockBackdropMode({ macBackdrop: 'liquid-glass', edgeDockMacBackdrop: 'transparent' }), 'liquid-glass');
});

test('the edge dock style is persisted, feeds only the dock glass, and has a localized selector', () => {
  assert.match(main, /edgeDockMacBackdrop: 'inherit',/);
  assert.match(main, /merged\.edgeDockMacBackdrop = normalizeEdgeDockBackdropMode\(merged\.edgeDockMacBackdrop\)/);
  assert.match(main, /edgeDockMacBackdrop: normalizeEdgeDockBackdropMode\(patch\.edgeDockMacBackdrop \?\? settings\.edgeDockMacBackdrop\)/);
  // The controller decides whether there is material; Reduce Transparency still keeps Liquid Glass off.
  assert.match(main, /process\.platform === 'darwin'\s+&& isLiquidGlassBackdrop\(edgeDockBackdropMode\(source\)\)\s+&& !options\.reducedTransparency/);
  assert.match(html, /id="edgeDockMacBackdropRow" class="settings-item hidden"[\s\S]*?<select id="edgeDockMacBackdropInput"><option value="inherit"/);
  assert.match(html, /<select id="edgeDockMacBackdropInput">[^]*?<option value="transparent" data-i18n="settings\.appearance\.glassEffectTransparent">/);
  // The dock's own style overrides System Glass, so the row only needs macOS.
  assert.match(app, /edgeDockMacBackdropRow\?\.classList\.toggle\('hidden', !isMac\)/);
  assert.match(app, /edgeDockWindowsBackdropRow\?\.classList\.toggle\('hidden', !isWindows\)/);
  assert.match(app, /saveSettings\(\{ edgeDockMacBackdrop: macBackdropApi\.normalizeEdgeDockBackdropMode\(els\.edgeDockMacBackdropInput\.value\) \}\)/);
  for (const key of ['macBackdrop', 'macBackdropInherit']) {
    assert.equal((i18n.match(new RegExp(`'settings\\.edgeDock\\.${key}':`, 'g')) || []).length, 6, key);
  }
});

test('the notch style stores Frosted Glass as vibrancy and offers Liquid Glass on the widget selector terms', () => {
  assert.match(html, /<select id="notchStyleInput">[^]*?<option value="vibrancy"[^]*?<option value="liquid-glass"/);
  assert.doesNotMatch(html, /<select id="notchStyleInput">[^]*?<option value="default"/);
  // Material pushes and appearance previews re-run this pass, so the select follows both.
  assert.match(app, /syncEdgeDockMacBackdropInput\(settings\);\s+syncNotchStyleInput\(settings\);/);

  const start = app.indexOf('function syncNotchStyleInput(');
  const end = app.indexOf('function syncNotchCapabilities(', start);
  assert.ok(start >= 0 && end > start);
  const run = ({ saved, pending = [], preview, liquidGlassSupported = true }) => {
    const option = { hidden: false, disabled: false };
    const select = { value: '', querySelector: (selector) => selector === 'option[value="liquid-glass"]' ? option : null };
    const context = vm.createContext({
      els: { notchStyleInput: select },
      state: { settings: saved },
      pendingSettingsPatches: new Set(pending),
      nativeMaterialState: { liquidGlassSupported },
      macBackdropApi: { appearanceState, isLiquidGlassBackdrop }
    });
    vm.runInContext(`${app.slice(start, end)}; syncNotchStyleInput(${JSON.stringify(preview)});`, context);
    return { value: select.value, hidden: option.hidden, disabled: option.disabled };
  };

  // An appearance slider preview carries no notchStyle; the saved style must stay selected.
  assert.deepEqual(run({ saved: { notchStyle: 'vibrancy' }, preview: { systemGlass: true, macBackdrop: 'vibrancy' } }),
    { value: 'vibrancy', hidden: false, disabled: false });
  assert.equal(run({ saved: { notchStyle: 'vibrancy' }, pending: [{ notchStyle: 'inherit' }], preview: { systemGlass: true } }).value, 'inherit');
  assert.equal(run({ saved: {} }).value, 'inherit');
  assert.deepEqual(run({ saved: { notchStyle: 'liquid-glass' } }), { value: 'liquid-glass', hidden: false, disabled: false });
  assert.equal(run({ saved: { notchStyle: 'liquid-glass-clear' } }).value, 'liquid-glass-clear');
  assert.equal(run({ saved: { notchStyle: 'liquid-glass-clear' }, liquidGlassSupported: false }).value, 'vibrancy');
  // Where Liquid Glass cannot be drawn, the option hides and the saved choice shows its fallback.
  assert.deepEqual(run({ saved: { notchStyle: 'liquid-glass' }, liquidGlassSupported: false }), { value: 'vibrancy', hidden: true, disabled: true });
  // An explicit notch style overrides System Glass, so turning it off keeps the choice.
  assert.deepEqual(run({ saved: { notchStyle: 'liquid-glass' }, preview: { systemGlass: false } }), { value: 'liquid-glass', hidden: false, disabled: false });
});

test('the macOS dock style select offers Transparent everywhere and Liquid Glass only where it exists', () => {
  const start = app.indexOf('function syncNotchStyleInput(');
  const end = app.indexOf('function syncNotchCapabilities(', start);
  const { normalizeEdgeDockBackdropMode } = require('../../src/electron/macBackdropMode');
  const run = ({ saved, liquidGlassSupported = true }) => {
    const option = { hidden: false, disabled: false };
    const select = { value: '', querySelector: (selector) => selector === 'option[value="liquid-glass"]' ? option : null };
    const context = vm.createContext({
      els: { edgeDockMacBackdropInput: select },
      state: { settings: saved },
      pendingSettingsPatches: new Set(),
      nativeMaterialState: { liquidGlassSupported },
      macBackdropApi: { appearanceState, isLiquidGlassBackdrop, normalizeEdgeDockBackdropMode }
    });
    vm.runInContext(`${app.slice(start, end)}; syncEdgeDockMacBackdropInput();`, context);
    return { value: select.value, hidden: option.hidden };
  };

  assert.deepEqual(run({ saved: {} }), { value: 'inherit', hidden: false });
  assert.deepEqual(run({ saved: { edgeDockMacBackdrop: 'transparent' }, liquidGlassSupported: false }), { value: 'transparent', hidden: true });
  assert.deepEqual(run({ saved: { edgeDockMacBackdrop: 'liquid-glass' }, liquidGlassSupported: false }), { value: 'vibrancy', hidden: true });
  assert.deepEqual(run({ saved: { edgeDockMacBackdrop: 'liquid-glass' } }), { value: 'liquid-glass', hidden: false });
});
