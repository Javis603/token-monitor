'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function rendererFunction(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return Function(`return (${app.slice(start, end).trim()})`)();
}

test('compact token formatter uses K, M, and B units', () => {
  const formatCompact = rendererFunction('formatCompact', 'updateTotalCompact');
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1_500), '1.5K');
  assert.equal(formatCompact(2_000_000), '2M');
  assert.equal(formatCompact(3_400_000_000), '3.4B');
});

test('compact token formatter promotes values that round across unit boundaries', () => {
  const formatCompact = rendererFunction('formatCompact', 'updateTotalCompact');
  assert.equal(formatCompact(999_949), '999.9K');
  assert.equal(formatCompact(999_950), '1M');
  assert.equal(formatCompact(999_950_000), '1B');
});

test('compact total is an opt-in appearance preference', () => {
  assert.match(html, /id="totalTokensCompact" class="total-compact hidden" aria-hidden="true"/);
  assert.match(html, /id="showCompactTotalTokensInput" type="checkbox"/);
  assert.match(html, /data-i18n="settings\.appearance\.compactTotalTokens"/);
  assert.match(css, /\.total-number-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.total-compact\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.total-compact\s*\{[^}]*font-weight:\s*500/s);
  assert.match(main, /showCompactTotalTokens:\s*false/);
  assert.match(main, /showCompactTotalTokens:\s*parseBoolean\(patch\.showCompactTotalTokens \?\? settings\.showCompactTotalTokens, false\)/);
  assert.match(app, /showCompactTotalTokensInput: document\.getElementById\('showCompactTotalTokensInput'\)/);
  assert.match(app, /showCompactTotalTokens: false/);
  assert.match(app, /showCompactTotalTokens: Boolean\(els\.showCompactTotalTokensInput\.checked\)/);
  assert.match(app, /els\.showCompactTotalTokensInput\.checked = state\.settings\.showCompactTotalTokens === true/);
  assert.match(app, /els\.showCompactTotalTokensInput\.addEventListener\('change',[\s\S]*?updateTotalCompact\(state\.currentTotal\)/);
  assert.match(app, /state\.settings\?\.showCompactTotalTokens !== true[\s\S]*?hideTotalCompact\(\)/);
});

test('compact total stays visible through the count-up, with the font pre-locked', () => {
  // The font is fitted to the widest endpoint before the roll starts, so the number
  // does not vanish, clip, or resize mid-animation in either direction.
  assert.match(app, /const widest = formatNumber\(nextTotal\)\.length >= formatNumber\(state\.currentTotal\)\.length \? nextTotal : state\.currentTotal;/);
  assert.match(app, /els\.totalTokens\.textContent = formatNumber\(widest\);\s*updateTotalCompact\(nextTotal\);\s*animateNumber\(els\.totalTokens, state\.currentTotal, nextTotal, state\.periodMotionActive \? 800 : 1000, fitTotalNumber\);/s);
  // animateNumber must not reset the font, or the pre-locked size would be lost.
  const animateBody = app.slice(app.indexOf('function animateNumber('), app.indexOf('function rowWidth('));
  assert.doesNotMatch(animateBody, /style\.fontSize/);
  // Tabular figures keep the number's width constant as it counts, so the chip
  // beside it does not jitter.
  assert.match(css, /\.total-number\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
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
