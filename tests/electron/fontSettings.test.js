'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..', '..');
const fontSettings = require('../../src/shared/fontSettings');

function readProjectFile(...parts) {
  return fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');
}

test('font settings preserve the built-in roles and reject declaration injection', () => {
  assert.equal(fontSettings.normalizeFontFamily('  Noto Sans CJK TC, sans-serif  '), 'Noto Sans CJK TC, sans-serif');
  assert.equal(fontSettings.normalizeFontFamily(''), '');
  assert.equal(fontSettings.normalizeFontFamily('font-family: sans-serif;'), '');
  assert.equal(fontSettings.normalizeFontFamily('A'.repeat(fontSettings.MAX_FONT_FAMILY_LENGTH + 1)), '');
  assert.deepEqual(
    fontSettings.resolveEffectiveFontSettings({ interfaceFontFamily: '', displayFontFamily: '' }),
    {
      interfaceFont: fontSettings.DEFAULT_INTERFACE_FONT,
      displayFont: fontSettings.DEFAULT_INTERFACE_FONT
    }
  );
});

test('font presets cover common roles and preserve custom values', () => {
  assert.equal(fontSettings.presetForFontFamily(''), 'app');
  assert.equal(fontSettings.presetForFontFamily('', 'display'), 'follow');
  assert.equal(fontSettings.presetForFontFamily(fontSettings.DEFAULT_DISPLAY_FONT, 'display'), 'app');
  assert.equal(fontSettings.presetForFontFamily(fontSettings.SYSTEM_UI_FONT), 'system');
  assert.equal(fontSettings.presetForFontFamily('sans-serif'), 'custom');
  assert.equal(fontSettings.presetForFontFamily(fontSettings.FONT_PRESETS.mono), 'mono');
  assert.equal(fontSettings.presetForFontFamily('Noto Sans CJK TC'), 'custom');
  assert.equal(fontSettings.fontFamilyForPreset('app'), '');
  assert.equal(fontSettings.fontFamilyForPreset('follow', '', 'display'), '');
  assert.equal(fontSettings.fontFamilyForPreset('app', '', 'display'), fontSettings.DEFAULT_DISPLAY_FONT);
  assert.equal(fontSettings.fontFamilyForPreset('system'), fontSettings.SYSTEM_UI_FONT);
  assert.equal(fontSettings.fontFamilyForPreset('mono'), fontSettings.FONT_PRESETS.mono);
  assert.equal(fontSettings.fontFamilyForPreset('custom', 'Noto Sans CJK TC'), 'Noto Sans CJK TC');
});

test('follow interface resolves against each renderer effective default', () => {
  const customA = 'Noto Sans CJK TC';
  const customB = 'IBM Plex Mono';
  const cases = [
    {
      name: 'App default + App default',
      settings: {
        interfaceFontFamily: '',
        displayFontFamily: fontSettings.DEFAULT_DISPLAY_FONT
      },
      expected: {
        interfaceFont: fontSettings.DEFAULT_INTERFACE_FONT,
        displayFont: fontSettings.DEFAULT_DISPLAY_FONT
      }
    },
    {
      name: 'App default + Follow interface',
      settings: { interfaceFontFamily: '', displayFontFamily: '' },
      expected: {
        interfaceFont: fontSettings.DEFAULT_INTERFACE_FONT,
        displayFont: fontSettings.DEFAULT_INTERFACE_FONT
      }
    },
    {
      name: 'System UI + Follow interface',
      settings: { interfaceFontFamily: fontSettings.SYSTEM_UI_FONT, displayFontFamily: '' },
      expected: {
        interfaceFont: fontSettings.SYSTEM_UI_FONT,
        displayFont: fontSettings.SYSTEM_UI_FONT
      }
    },
    {
      name: 'Mono + Follow interface',
      settings: { interfaceFontFamily: fontSettings.FONT_PRESETS.mono, displayFontFamily: '' },
      expected: {
        interfaceFont: fontSettings.FONT_PRESETS.mono,
        displayFont: fontSettings.FONT_PRESETS.mono
      }
    },
    {
      name: 'Custom A + Follow interface',
      settings: { interfaceFontFamily: customA, displayFontFamily: '' },
      expected: { interfaceFont: customA, displayFont: customA }
    },
    {
      name: 'Custom A + Custom B',
      settings: { interfaceFontFamily: customA, displayFontFamily: customB },
      expected: { interfaceFont: customA, displayFont: customB }
    }
  ];

  for (const scenario of cases) {
    assert.deepEqual(
      fontSettings.resolveEffectiveFontSettings(scenario.settings),
      scenario.expected,
      scenario.name
    );
  }

  assert.deepEqual(
    fontSettings.resolveEffectiveFontSettings(
      { interfaceFontFamily: '', displayFontFamily: '' },
      { interfaceDefault: fontSettings.DEFAULT_DASHBOARD_INTERFACE_FONT }
    ),
    {
      interfaceFont: fontSettings.DEFAULT_DASHBOARD_INTERFACE_FONT,
      displayFont: fontSettings.DEFAULT_DASHBOARD_INTERFACE_FONT
    }
  );
});

test('font controls live inside Appearance advanced customization', () => {
  const html = readProjectFile('src', 'electron', 'renderer', 'index.html');
  const advancedStart = html.indexOf('id="themeAdvancedDetails"');
  const colorGrid = html.indexOf('id="themeColorGrid"');
  const vendorGroup = html.indexOf('id="themeVendorGroup"', advancedStart);
  assert.ok(advancedStart >= 0);
  assert.ok(colorGrid > advancedStart);
  assert.ok(vendorGroup > colorGrid);
  const advanced = html.slice(advancedStart, vendorGroup);
  assert.ok(advanced.indexOf('id="themeColorGrid"') < advanced.indexOf('class="settings-font-controls"'));
  assert.doesNotMatch(advanced, /data-i18n="settings\.appearance\.fonts"/);
  assert.match(advanced, /id="interfaceFontPreset"/);
  assert.match(advanced, /value="app" data-i18n="settings\.appearance\.fontPresetApp"/);
  assert.match(advanced, /value="system" data-i18n="settings\.appearance\.fontPresetSystem"/);
  assert.doesNotMatch(advanced, /fontPresetSans/);
  assert.match(advanced, /id="interfaceFontInput"/);
  assert.match(advanced, /id="interfaceFontPreview"/);
  assert.match(advanced, /id="displayFontPreset"/);
  assert.match(advanced, /value="follow" data-i18n="settings\.appearance\.fontPresetFollow"/);
  assert.match(advanced, /id="displayFontInput"/);
  assert.match(advanced, /id="displayFontPreview"/);
  assert.match(advanced, /id="interfaceFontCustomRow"/);
  assert.match(advanced, /id="displayFontCustomRow"/);
  assert.match(advanced, /data-i18n="settings\.appearance\.fontDisplay">Display font<\/label>/);
  assert.match(advanced, /data-i18n="settings\.appearance\.fontNote"/);
});

test('font settings wiring keeps renderer defaults concrete and technical monospace roles intact', () => {
  const app = readProjectFile('src', 'electron', 'renderer', 'app.js');
  const dashboard = readProjectFile('src', 'electron', 'renderer', 'dashboard.js');
  const styles = readProjectFile('src', 'electron', 'renderer', 'styles.css');
  const dashboardStyles = readProjectFile('src', 'electron', 'renderer', 'dashboard.css');
  const main = readProjectFile('src', 'electron', 'main.js');

  assert.match(main, /interfaceFontFamily/);
  assert.match(main, /displayFontFamily/);
  assert.match(app, /resolveEffectiveFontSettings\(source\)/);
  assert.match(dashboard, /resolveEffectiveFontSettings\(settings, \{/);
  assert.doesNotMatch(`${app}\n${dashboard}`, /setProperty\('--display-font', 'var\(--ui-font\)'/);
  assert.match(styles, /font-family: var\(--ui-font,/);
  assert.match(styles, /font-family: var\(--display-font,/);
  const fontControlsCss = styles.match(/\.settings-font-controls \{([\s\S]*?)\}/)?.[1] || '';
  const fontInputRowCss = styles.match(/\.settings-font-input-row \{([\s\S]*?)\}/)?.[1] || '';
  assert.match(fontControlsCss, /border-top: 1px solid var\(--line\)/);
  assert.doesNotMatch(fontControlsCss, /border-bottom/);
  assert.match(fontInputRowCss, /grid-template-columns: minmax\(0, 1fr\) 18px/);
  assert.match(fontInputRowCss, /gap: 8px/);
  assert.match(styles, /settings-font-preview/);
  assert.match(dashboardStyles, /font-family: var\(--ui-font,/);
  assert.match(dashboardStyles, /font-family: var\(--display-font, inherit\)/);
  assert.match(styles, /font-family: var\(--mono-font, ui-monospace/);
});
