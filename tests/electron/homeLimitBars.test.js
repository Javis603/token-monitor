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
