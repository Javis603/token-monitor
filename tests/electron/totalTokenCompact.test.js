'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
const compactTokensSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'compactTokens.js'), 'utf8');
const compactTokens = require('../../src/shared/compactTokens');

function rendererFunction(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return Function(`return (${app.slice(start, end).trim()})`)();
}

test('compact token formatter uses K, M, and B units', () => {
  const formatCompact = compactTokens.formatCompactTokens;
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1_500), '1.5K');
  assert.equal(formatCompact(2_000_000), '2M');
  assert.equal(formatCompact(3_400_000_000), '3.4B');
});

test('compact token formatter promotes values that round across unit boundaries', () => {
  const formatCompact = compactTokens.formatCompactTokens;
  assert.equal(formatCompact(999_949), '999.9K');
  assert.equal(formatCompact(999_950), '1M');
  assert.equal(formatCompact(999_950_000), '1B');
});

test('localized compact token formatter uses ten-thousand units without a thousand unit', () => {
  const formatCompact = compactTokens.formatCompactTokens;
  assert.equal(formatCompact(9_999, 'localized', 'zh-TW'), '9999');
  assert.equal(formatCompact(15_000, 'localized', 'zh-TW'), '1.5萬');
  assert.equal(formatCompact(295_116_445, 'localized', 'zh-TW'), '2.95億');
  assert.equal(formatCompact(295_116_445, 'localized', 'zh-CN'), '2.95亿');
  assert.equal(formatCompact(15_000, 'localized', 'zh-Hans'), '1.5万');
  assert.equal(formatCompact(15_000, 'localized', 'zh-Hans-SG'), '1.5万');
  assert.equal(formatCompact(15_000, 'localized', 'zh-SG'), '1.5万');
  assert.equal(formatCompact(15_000, 'localized', 'zh-MY'), '1.5万');
  assert.equal(formatCompact(15_000, 'localized', 'zh-Hant-HK'), '1.5萬');
  assert.equal(formatCompact(295_116_445, 'localized', 'ja'), '2.95億');
  assert.equal(formatCompact(295_116_445, 'localized', 'ko'), '2.95억');
});

test('compact token module does not pollute the Node global scope', () => {
  assert.match(compactTokensSource, /typeof window !== 'undefined' \? window : null/);
  delete globalThis.TokenMonitorCompactTokens;
  delete require.cache[require.resolve('../../src/shared/compactTokens')];
  require('../../src/shared/compactTokens');
  assert.equal(Object.hasOwn(globalThis, 'TokenMonitorCompactTokens'), false);
});

test('localized compact token formatter promotes rounded values to the next unit', () => {
  const formatCompact = compactTokens.formatCompactTokens;
  assert.equal(formatCompact(99_999_500, 'localized', 'zh-TW'), '1億');
});

test('localized compact token units are available only for East Asian UI locales', () => {
  const supportsLocalizedCompactTokenUnits = compactTokens.supportsLocalizedCompactTokenUnits;
  assert.equal(supportsLocalizedCompactTokenUnits('en'), false);
  assert.equal(supportsLocalizedCompactTokenUnits('en-US'), false);
  assert.equal(supportsLocalizedCompactTokenUnits('zh-TW'), true);
  assert.equal(supportsLocalizedCompactTokenUnits('zh-CN'), true);
  assert.equal(supportsLocalizedCompactTokenUnits('ja'), true);
  assert.equal(supportsLocalizedCompactTokenUnits('ko'), true);
});

test('compact total is an opt-in appearance preference', () => {
  assert.match(html, /id="totalTokensCompact" class="total-compact hidden" aria-hidden="true"/);
  assert.match(html, /id="showCompactTotalTokensInput" type="checkbox"/);
  assert.match(html, /data-i18n="settings\.appearance\.compactTotalTokens"/);
  assert.match(html, /id="compactTokenUnitsRow" class="settings-item hidden"/);
  assert.match(html, /id="compactTokenUnitsInput"/);
  assert.match(css, /\.total-number-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.total-compact\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.total-compact\s*\{[^}]*font-weight:\s*500/s);
  assert.match(main, /showCompactTotalTokens:\s*false/);
  assert.match(main, /compactTokenUnits:\s*'western'/);
  assert.match(main, /showCompactTotalTokens:\s*parseBoolean\(patch\.showCompactTotalTokens \?\? settings\.showCompactTotalTokens, false\)/);
  assert.match(main, /compactTokenUnits:\s*normalizeCompactTokenUnits\(patch\.compactTokenUnits \?\? settings\.compactTokenUnits\)/);
  assert.match(main, /require\('\.\.\/shared\/compactTokens'\)/);
  assert.match(main, /function compactTokenDisplayOptions\(\)[\s\S]*?locale: trayMenuLocale\(\)/);
  assert.match(main, /function updateDiscordRpcDisplay\(stats\)[\s\S]*?compactTokenDisplayOptions\(\)/);
  assert.match(main, /function settingsForRenderer\(\)[\s\S]*?locale: trayMenuLocale\(\)/);
  assert.match(app, /showCompactTotalTokensInput: document\.getElementById\('showCompactTotalTokensInput'\)/);
  assert.match(app, /compactTokenUnitsInput: document\.getElementById\('compactTokenUnitsInput'\)/);
  assert.match(app, /showCompactTotalTokens: false/);
  assert.match(app, /compactTokenUnits: 'western'/);
  assert.match(app, /showCompactTotalTokens: Boolean\(els\.showCompactTotalTokensInput\.checked\)/);
  assert.match(app, /compactTokenUnits: els\.compactTokenUnitsInput\?\.value === 'localized' \? 'localized' : 'western'/);
  assert.match(app, /els\.showCompactTotalTokensInput\.checked = state\.settings\.showCompactTotalTokens === true/);
  assert.match(app, /els\.compactTokenUnitsInput\.value = state\.settings\.compactTokenUnits === 'localized' \? 'localized' : 'western'/);
  assert.match(app, /!supportsLocalizedCompactTokenUnits\(currentLocale\(\)\)/);
  assert.doesNotMatch(app, /showCompactTotalTokens !== true \|\| !supportsLocalizedCompactTokenUnits/);
  assert.doesNotMatch(app, /!els\.showCompactTotalTokensInput\.checked \|\| !supportsLocalizedCompactTokenUnits/);
  assert.match(app, /els\.showCompactTotalTokensInput\.addEventListener\('change',[\s\S]*?saveAppearanceFromControls\(\)/);
  assert.match(app, /els\.compactTokenUnitsInput\?\.addEventListener\('change',[\s\S]*?saveAppearanceFromControls\(\)/);
  assert.match(app, /state\.settings\?\.showCompactTotalTokens !== true[\s\S]*?hideTotalCompact\(\)/);
  assert.match(app, /compactTokenApi\.compactTokenUnitThreshold\(unitSystem, currentLocale\(\)\)/);
  assert.match(app, /formatCompact\(num, unitSystem, currentLocale\(\)\)/);
  assert.match(app, /compactTokenApi\.formatCompactTokens\(/);
  assert.match(app, /function currentLocale\(\)[\s\S]*?i18n\.resolveLocale\(state\.settings\?\.locale \|\| currentLanguage\(\), preferredLanguages\(\)\)/);
  assert.match(app, /els\.languageInput\?\.addEventListener\('change',[\s\S]*?saveSettings\(\{ language: els\.languageInput\.value \}\)/);
  const languageHandler = app.slice(
    app.indexOf("els.languageInput?.addEventListener('change'"),
    app.indexOf("els.currencyInput?.addEventListener('change'")
  );
  const compactUnitsHandler = app.slice(
    app.indexOf("els.compactTokenUnitsInput?.addEventListener('change'"),
    app.indexOf("window.addEventListener('resize'")
  );
  const compactVisibilityHandler = app.slice(
    app.indexOf("els.showCompactTotalTokensInput.addEventListener('change'"),
    app.indexOf("els.compactTokenUnitsInput?.addEventListener('change'")
  );
  assert.doesNotMatch(languageHandler, /render\(\)/);
  assert.doesNotMatch(compactUnitsHandler, /render\(\)/);
  assert.doesNotMatch(compactVisibilityHandler, /updateTotalCompact|renderTokenRate|render\(\)/);
  assert.match(app, /prevShowCompactTotalTokens !== next\.showCompactTotalTokens\) \{[\s\S]*?updateTotalCompact\(state\.currentTotal\)/);
  assert.doesNotMatch(app, /prevCompactTokenUnits !== next\.compactTokenUnits[\s\S]*?\|\| prevShowCompactTotalTokens !== next\.showCompactTotalTokens/);
  assert.doesNotMatch(i18n, /settings\.tray\.(?:tokensToday|bothToday|tokensTotal|bothTotal)':[^\n]*(?:1\.2M|1\.36B)/);
});

test('compact total stays visible through the count-up, with the font pre-locked', () => {
  // The font is fitted to the widest endpoint before the roll starts, so the number
  // does not vanish, clip, or resize mid-animation in either direction.
  assert.match(app, /const animationFrom = numberAnimHandle \? numberAnimValue : state\.currentTotal;/);
  assert.match(app, /const widest = formatNumber\(nextTotal\)\.length >= formatNumber\(animationFrom\)\.length \? nextTotal : animationFrom;/);
  assert.match(app, /els\.totalTokens\.textContent = formatNumber\(widest\);\s*updateTotalCompact\(nextTotal\);\s*animateTotalNumber\(els\.totalTokens, animationFrom, nextTotal, state\.periodMotionActive \? 800 : 1000\);/s);
  // animateNumber must not reset the font, or the pre-locked size would be lost.
  const animateBody = app.slice(app.indexOf('function animateNumber('), app.indexOf('function rowWidth('));
  assert.doesNotMatch(animateBody, /style\.fontSize/);
  // Tabular figures keep the number's width constant as it counts, so the chip
  // beside it does not jitter.
  assert.match(css, /\.total-number\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
});

test('unit changes made during the count-up are applied when the animation settles', () => {
  const start = app.indexOf('function easeOutQuart(');
  const end = app.indexOf('const rowNumberAnimations', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const frames = [];
  const compactRenders = [];
  let unitSystem = 'western';
  const context = {
    cancelAnimationFrame() {},
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    performance: { now: () => 0 },
    prefersReducedMotion: () => false,
    formatNumber: (value) => String(Math.round(value)),
    updateTotalCompact(value) {
      compactRenders.push(`${value}:${unitSystem}`);
    }
  };
  vm.runInNewContext(
    `${app.slice(start, end)}\nthis.animateTotalNumberForTest = animateTotalNumber;`,
    context
  );

  context.animateTotalNumberForTest({ textContent: '' }, 0, 100_000, 1000);
  unitSystem = 'localized';
  assert.deepEqual(compactRenders, []);
  frames.shift()(1000);
  assert.deepEqual(compactRenders, ['100000:localized']);
});

test('total number font scale shrinks to fit instead of clipping', () => {
  const totalNumberFontScale = rendererFunction('totalNumberFontScale', 'fitTotalNumber');
  // Fits: never scale up past the base font size.
  assert.equal(totalNumberFontScale(200, 150), 1);
  assert.equal(totalNumberFontScale(200, 200), 1);
  // Overflows: shrink by the available/natural ratio.
  assert.equal(totalNumberFontScale(150, 200), 0.75);
  // Extreme overflow clamps at the minimum scale (ellipsis is the last resort).
  assert.equal(totalNumberFontScale(50, 200), 0.5);
  assert.equal(totalNumberFontScale(50, 200, 0.4), 0.4);
  // Missing measurements are a no-op.
  assert.equal(totalNumberFontScale(0, 200), 1);
  assert.equal(totalNumberFontScale(200, 0), 1);
});

test('exact total is fitted to width, not left to clip', () => {
  // updateTotalCompact always re-fits the number after toggling the chip.
  assert.match(app, /els\.totalTokensCompact\.classList\.remove\('hidden'\);\s*\}\s*fitTotalNumber\(\);/s);
  // fitTotalNumber measures the allotted vs natural width and scales the font.
  assert.match(app, /function fitTotalNumber\(\)[\s\S]*?getComputedStyle\(el\)\.fontSize/);
  assert.match(app, /totalNumberFontScale\(el\.clientWidth, el\.scrollWidth\)/);
  assert.match(app, /el\.style\.fontSize = `\$\{Math\.floor\(base \* scale\)\}px`/);
  // Resize re-fits the settled number.
  assert.match(app, /window\.addEventListener\('resize',[\s\S]*?fitTotalNumber\(\)/);
  // Ellipsis is kept only as the last-resort fallback.
  assert.match(css, /\.total-number\s*\{[^}]*text-overflow:\s*ellipsis/s);
});
