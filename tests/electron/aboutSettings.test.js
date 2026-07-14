'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('General settings ends with a compact About section', () => {
  const html = read('index.html');
  const general = html.match(/<div id="generalSettingsDetails"[\s\S]*?<div id="mainSettingsDetails"/)?.[0] || '';

  assert.match(general, /class="settings-subgroup about-settings"/);
  assert.match(general, /id="aboutVersion">—<\/span>/);
  assert.match(general, /id="openRepositoryButton"[\s\S]*settings\.about\.repository/);
  assert.match(general, /id="reportIssueButton"[\s\S]*settings\.about\.reportIssue/);
  assert.ok(general.indexOf('settings.advanced.title') < general.indexOf('settings.about.title'));
});

test('About uses runtime version and allowlisted Token Monitor links', () => {
  const app = read('app.js');

  assert.match(app, /aboutVersion\.textContent = state\.appInfo\?\.version \? `v\$\{state\.appInfo\.version\}` : '—'/);
  assert.match(app, /TOKEN_MONITOR_REPOSITORY_URL = 'https:\/\/github\.com\/Javis603\/token-monitor'/);
  assert.match(app, /TOKEN_MONITOR_ISSUES_URL = `\$\{TOKEN_MONITOR_REPOSITORY_URL\}\/issues\/new\/choose`/);
  assert.match(app, /openRepositoryButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_REPOSITORY_URL/);
  assert.match(app, /reportIssueButton\?\.addEventListener\('click',[\s\S]*TOKEN_MONITOR_ISSUES_URL/);
});

test('About links stay visually secondary and wrap in narrow settings', () => {
  const css = read('styles.css');

  assert.match(css, /\.about-settings-links \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.about-settings-links \.inline-link \{ font-size: 10px; \}/);
});
