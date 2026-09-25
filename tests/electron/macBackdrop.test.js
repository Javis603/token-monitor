'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const rendererDir = path.join(root, 'src/electron/renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const { normalizeMacBackdropMode, appearanceState } = require('../../src/electron/macBackdropMode');
const { normalizeNativeMaterialState } = require('../../src/electron/renderer/glassRendering');

test('macOS backdrop modes default to the classic vibrancy; Liquid Glass is opt-in', () => {
  for (const value of [undefined, null, '', 'hud', 'LIQUID-GLASS', 'vibrancy']) {
    assert.equal(normalizeMacBackdropMode(value), 'vibrancy');
  }
  assert.equal(normalizeMacBackdropMode('liquid-glass'), 'liquid-glass');
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
  assert.match(main, /liquidGlass: normalizeMacBackdropMode\(source\.macBackdrop\) === MAC_BACKDROP_LIQUID_GLASS/);
});

test('settings expose a localized macOS style selector wired to the saved preference', () => {
  assert.match(html, /id="macBackdropRow" class="settings-item hidden"/);
  assert.match(html, /<select id="macBackdropInput"><option value="vibrancy"[^>]*>[^<]*<\/option><option value="liquid-glass"/);
  assert.match(html, /<script src="\.\.\/macBackdropMode\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(app, /macBackdropRow\?\.classList\.toggle\('hidden', !macGlass\.showBackdropControl\)/);
  assert.match(app, /macBackdrop: macBackdropApi\.normalizeMacBackdropMode\(els\.macBackdropInput\?\.value\)/);
  assert.match(app, /els\.macBackdropInput\?\.addEventListener\('change', saveAppearanceFromControls\)/);
  for (const key of ['macBackdrop', 'macBackdropLiquidGlass', 'macBackdropVibrancy']) {
    assert.equal((i18n.match(new RegExp(`'settings\\.appearance\\.${key}':`, 'g')) || []).length, 5, key);
  }
});
