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

test('Windows Simplified Chinese adds Han fallback only to app font defaults', () => {
  const options = { platform: 'win32', locale: 'zh-CN' };
  const prefix = '"Token Monitor Noto Sans SC", "Token Monitor YaHei UI", ';
  assert.deepEqual(fontSettings.resolveEffectiveFontSettings({
    displayFontFamily: fontSettings.DEFAULT_DISPLAY_FONT
  }, options), {
    interfaceFont: prefix + fontSettings.DEFAULT_INTERFACE_FONT,
    displayFont: prefix + fontSettings.DEFAULT_DISPLAY_FONT
  });
  assert.deepEqual(fontSettings.resolveEffectiveFontSettings({}, options), {
    interfaceFont: prefix + fontSettings.DEFAULT_INTERFACE_FONT,
    displayFont: prefix + fontSettings.DEFAULT_INTERFACE_FONT
  });
  assert.deepEqual(fontSettings.resolveEffectiveFontSettings({
    interfaceFontFamily: 'Consolas', displayFontFamily: ''
  }, options), { interfaceFont: 'Consolas', displayFont: 'Consolas' });
  assert.equal(fontSettings.resolveEffectiveFontSettings({
    displayFontFamily: 'Custom Display'
  }, options).displayFont, 'Custom Display');
  for (const other of [
    { platform: 'win32', locale: 'en' },
    { platform: 'darwin', locale: 'zh-TW' },
    { platform: 'darwin', locale: 'zh-CN' },
    { platform: 'linux', locale: 'zh-CN' }
  ]) {
    assert.deepEqual(fontSettings.resolveEffectiveFontSettings({}, other),
      fontSettings.resolveEffectiveFontSettings());
  }
});

test('Windows Traditional Chinese preserves the first preferred regional glyph variant', () => {
  for (const [preferredLanguages, variant] of [
    [['en-HK', 'zh-Hant-HK', 'zh-TW'], 'HK'],
    [['zh-Hans-HK', 'zh-TW', 'zh-HK'], 'TC'],
    [['zh-Hant', 'ZH-hk'], 'HK'],
    [['en-HK', 'zh-Hant'], 'TC'],
    [undefined, 'TC']
  ]) {
    const options = { platform: 'win32', locale: 'zh-TW', preferredLanguages };
    const prefix = `"Token Monitor Noto Sans ${variant}", "Token Monitor JhengHei UI", `;
    assert.deepEqual(fontSettings.resolveEffectiveFontSettings({
      displayFontFamily: fontSettings.DEFAULT_DISPLAY_FONT
    }, options), {
      interfaceFont: prefix + fontSettings.DEFAULT_INTERFACE_FONT,
      displayFont: prefix + fontSettings.DEFAULT_DISPLAY_FONT
    });
    assert.deepEqual(fontSettings.resolveEffectiveFontSettings({
      interfaceFontFamily: fontSettings.SYSTEM_UI_FONT, displayFontFamily: ''
    }, options), {
      interfaceFont: fontSettings.SYSTEM_UI_FONT,
      displayFont: fontSettings.SYSTEM_UI_FONT
    });
  }
});

test('font controls and zoom share a visible Appearance group', () => {
  const html = readProjectFile('src', 'electron', 'renderer', 'index.html');
  const start = html.indexOf('settings-subgroup settings-appearance-type');
  const end = html.indexOf('settings-subgroup settings-appearance-usage', start);
  assert.ok(start >= 0 && end > start);
  const typography = html.slice(start, end);
  assert.match(typography, /id="zoomInput"/);
  assert.match(typography, /id="textSizeInput" aria-labelledby="textSizeLabel" aria-describedby="textSizeNote"/);
  assert.match(typography, /<span id="textSizeLabel"[^>]*>Text size<\/span>/);
  assert.ok(typography.indexOf('id="textSizeInput"') < typography.indexOf('id="interfaceFontPreset"'));
  assert.match(typography, /id="interfaceFontPreset"/);
  assert.match(typography, /value="app" data-i18n="settings\.appearance\.fontPresetApp"/);
  assert.match(typography, /value="system" data-i18n="settings\.appearance\.fontPresetSystem"/);
  assert.doesNotMatch(typography, /fontPresetSans/);
  assert.match(typography, /id="interfaceFontInput"/);
  assert.match(typography, /id="interfaceFontPreview"/);
  assert.match(typography, /id="displayFontPreset"/);
  assert.match(typography, /value="follow" data-i18n="settings\.appearance\.fontPresetFollow"/);
  assert.match(typography, /id="displayFontInput"/);
  assert.match(typography, /id="displayFontPreview"/);
  assert.match(typography, /id="interfaceFontCustomRow"/);
  assert.match(typography, /id="displayFontCustomRow"/);
  assert.match(typography, /data-i18n="settings\.appearance\.fontDisplay">Display font<\/label>/);
  for (const preset of ['App', 'System', 'Mono', 'Follow', 'Custom']) {
    assert.ok(typography.includes(`data-select-description="settings.appearance.fontPreset${preset}Desc"`));
  }
  assert.doesNotMatch(typography, /fontSettingsNote/);
});

test('font settings wiring keeps renderer defaults concrete and technical monospace roles intact', () => {
  const app = readProjectFile('src', 'electron', 'renderer', 'app.js');
  const html = readProjectFile('src', 'electron', 'renderer', 'index.html');
  const dashboard = readProjectFile('src', 'electron', 'renderer', 'dashboard.js');
  const styles = readProjectFile('src', 'electron', 'renderer', 'styles.css');
  const dashboardStyles = readProjectFile('src', 'electron', 'renderer', 'dashboard.css');
  const main = readProjectFile('src', 'electron', 'main.js');

  assert.match(main, /interfaceFontFamily/);
  assert.match(main, /displayFontFamily/);
  assert.match(app, /resolveMainWindowFonts\(source\)/);
  assert.match(dashboard, /resolveEffectiveFontSettings\(settings, \{/);
  assert.doesNotMatch(`${app}\n${dashboard}`, /setProperty\('--display-font', 'var\(--ui-font\)'/);
  assert.match(styles, /font-family: var\(--ui-font,/);
  assert.match(styles, /font-family: var\(--display-font,/);
  const fontControlsCss = styles.match(/\.settings-font-controls \{([\s\S]*?)\}/)?.[1] || '';
  const fontInputRowCss = styles.match(/\.settings-font-input-row \{([\s\S]*?)\}/)?.[1] || '';
  assert.match(fontControlsCss, /border-top: 1px solid var\(--line\)/);
  assert.doesNotMatch(fontControlsCss, /border-bottom/);
  assert.match(fontInputRowCss, /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(html, /<span class="settings-reset-heading"><label[^>]*for="interfaceFontPreset"[^>]*>[^<]*<\/label><button id="resetInterfaceFontButton"/);
  assert.match(html, /<span class="settings-reset-heading"><label[^>]*for="displayFontPreset"[^>]*>[^<]*<\/label><button id="resetDisplayFontButton"/);
  assert.match(styles, /settings-font-preview/);
  assert.match(dashboardStyles, /font-family: var\(--ui-font,/);
  assert.match(dashboardStyles, /font-family: var\(--display-font, inherit\)/);
  assert.match(styles, /font-family: var\(--mono-font, ui-monospace/);
});


test('text size defaults remain compact across missing and invalid saved preferences', () => {
  for (const value of [undefined, null, '', 1.2, {}, '__proto__', 'unknown']) {
    assert.equal(fontSettings.normalizeTextSize(value), 'standard');
    assert.equal(fontSettings.textScaleForSize(value), 1);
  }
  assert.equal(fontSettings.textScaleForSize('standard'), 1);
  assert.equal(fontSettings.textScaleForSize('larger'), 1.1);
  assert.equal(fontSettings.textScaleForSize('largest'), 1.2);
});


test('text size labels exist in every supported locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const suffix of ['textSize', 'textSizeStandard', 'textSizeLarger', 'textSizeLargest', 'textSizeNote']) {
      assert.ok(messages[`settings.appearance.${suffix}`], `${locale}: ${suffix}`);
    }
  }
});
