'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

test('Home low-limit indicators are opt-in and persist through the settings boundary', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');

  assert.match(main, /showHomeLimitBars:\s*false/);
  assert.match(main, /merged\.showHomeLimitBars = parseBoolean\(merged\.showHomeLimitBars, false\)/);
  assert.match(main, /showHomeLimitBars:\s*parseBoolean\(patch\.showHomeLimitBars \?\? settings\.showHomeLimitBars, false\)/);
  assert.match(app, /statusInput\.checked = state\.settings\?\.showHomeLimitBars === true/);
  assert.match(app, /saveSettings\(\{ showHomeLimitBars: statusInput\.checked \}\)/);
});

test('Home highlights only low and critical remaining limits', () => {
  const app = read('src/electron/renderer/app.js');
  const css = read('src/electron/renderer/styles.css');

  assert.match(app, /function limitMeterNode\(color, percent, tone = 1\)/);
  assert.match(app, /const meter = limitMeterNode\(color, fillPercent, tone\)/);
  assert.match(app, /state\.settings\?\.showHomeLimitBars === true && window\.remainingPercent != null/);
  assert.match(app, /remainingPercent < 20/);
  assert.match(app, /value\.classList\.add\('home-limit-value-critical'\)/);
  assert.match(app, /remainingPercent < 50/);
  assert.match(app, /value\.classList\.add\('home-limit-value-low'\)/);
  assert.match(app, /line\.append\(label, value\)/);
  assert.doesNotMatch(app, /'home-limit-meter'/);
  assert.match(css, /\.home-limit-value-low\s*\{[^}]*--home-limit-accent/s);
  assert.match(css, /\.home-limit-value-critical\s*\{[^}]*color:\s*var\(--red\)/s);
  assert.doesNotMatch(css, /\.home-limit-value-critical\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.home-limit-value-critical::before\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.limit-meter-fill,[\s\S]*?\.tab-indicator\s*\{[^}]*transition:\s*none;/);
});

test('Home low-limit indicator setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages['settings.home.showLimitBars'], `${locale} should translate the Home limit bar setting`);
  }
});

test('Home multi-account provider names are opt-in and persist through the settings boundary', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');
  const css = read('src/electron/renderer/styles.css');

  assert.match(main, /showHomeLimitProviderNames:\s*false/);
  assert.match(main, /merged\.showHomeLimitProviderNames = parseBoolean\(merged\.showHomeLimitProviderNames, false\)/);
  assert.match(main, /showHomeLimitProviderNames:\s*parseBoolean\(patch\.showHomeLimitProviderNames \?\? settings\.showHomeLimitProviderNames, false\)/);
  assert.match(app, /providerEntries\.length > 1/);
  assert.match(app, /homeLimitAccountTitle\(id, provider, index\)/);
  assert.match(app, /state\.settings\?\.showHomeLimitProviderNames === true \|\| state\.settings\?\.showToolIcons === false/);
  assert.match(app, /`\$\{providerTitle\} · \$\{accountTitle\}`/);
  assert.match(app, /const providerNamesRequired = state\.settings\?\.showToolIcons === false/);
  assert.match(app, /providerNamesInput\.checked = providerNamesRequired \|\| state\.settings\?\.showHomeLimitProviderNames === true/);
  assert.match(app, /providerNamesInput\.disabled = providerNamesRequired/);
  assert.match(app, /settings\.home\.providerNamesRequiredWithoutIcons/);
  assert.match(app, /requiredReasonText\.className = 'home-limit-provider-names-reason'/);
  assert.match(app, /providerNamesInput\.setAttribute\('aria-describedby', requiredReasonText\.id\)/);
  assert.match(css, /\.home-limit-provider-names-copy\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.home-limit-provider-names-reason\s*\{[^}]*font-size:\s*10px/s);
  assert.match(app, /saveSettings\(\{ showHomeLimitProviderNames: providerNamesInput\.checked \}\)/);
  assert.match(app, /renderHomeIfVisible\(\)/);
  assert.match(app, /els\.toolIconsInput\.addEventListener\('change', async \(\) => \{\s*state\.settings\.showToolIcons = els\.toolIconsInput\.checked;\s*renderHomeIfVisible\(\);\s*await saveAppearanceFromControls\(\);\s*\}\);/);
});

test('Home provider name setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  const expected = {
    en: 'Show provider names for multiple accounts',
    'zh-TW': '多帳號顯示提供者名稱',
    'zh-CN': '多账号显示提供商名称',
    ko: '여러 계정에 제공업체 이름 표시',
    ja: '複数アカウントでプロバイダー名を表示'
  };
  for (const [locale, label] of Object.entries(expected)) {
    assert.equal(MESSAGES[locale]['settings.home.showLimitProviderNames'], label);
    assert.ok(MESSAGES[locale]['settings.home.providerNamesRequiredWithoutIcons']);
  }
});

test('Home account display count defaults to three and is configurable', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');
  const html = read('src/electron/renderer/index.html');

  assert.match(main, /HOME_LIMIT_ACCOUNT_COUNT_DEFAULT = 3/);
  assert.match(main, /homeLimitAccountCount: HOME_LIMIT_ACCOUNT_COUNT_DEFAULT/);
  assert.match(main, /merged\.homeLimitAccountCount = normalizeHomeLimitAccountCount\(merged\.homeLimitAccountCount\)/);
  assert.match(main, /homeLimitAccountCount: normalizeHomeLimitAccountCount\(patch\.homeLimitAccountCount \?\? settings\.homeLimitAccountCount\)/);
  assert.match(app, /limit: state\.settings\?\.homeLimitAccountCount \?\? 3/);
  const renderSettings = app.slice(app.indexOf('function renderHomeLimitProviderList'), app.indexOf('function renderHomeSettingsList'));
  assert.match(renderSettings, /countInput\.type = 'number'/);
  assert.match(renderSettings, /countInput\.min = '1'/);
  assert.match(renderSettings, /countInput\.max = '12'/);
  assert.match(renderSettings, /saveSettings\(\{ homeLimitAccountCount: Number\(countInput\.value\) \}\)/);
  assert.doesNotMatch(html, /homeLimitAccountCountInput|settings\.limits\.homeAccountCount/);
});

test('Home account display count setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages['settings.home.limitAccountCount'], `${locale} should translate the Home account count setting`);
  }
});
