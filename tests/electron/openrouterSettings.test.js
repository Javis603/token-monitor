'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('OpenRouter settings provide multi-account API key management without a custom URL', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const preload = read('src/electron/preload.js');

  assert.match(html, /id="openrouterAccountGroup"/);
  assert.match(html, /id="openrouterProfileList"/);
  assert.match(html, /id="openrouterProfileName"/);
  assert.match(html, /id="openrouterApiKeyInput"/);
  assert.match(html, /id="openrouterProfileSubmit"/);
  assert.match(html, /data-i18n="settings\.openrouter\.profileName"/);
  assert.doesNotMatch(html, /openrouter[^"]*(?:Base URL|baseUrl|base-url)/i);
  assert.match(app, /window\.tokenMonitor\.openExternal\('https:\/\/openrouter\.ai\/settings\/keys'\)/);
  assert.match(app, /renderOpenRouterProfiles/);
  assert.match(app, /setProfileEnabled/);
  assert.match(app, /renameProfile/);
  assert.match(app, /deleteProfile/);
  assert.match(preload, /getProfiles: \(\) => ipcRenderer\.invoke\('openrouter:getProfiles'\)/);
  assert.match(preload, /saveProfile: \(name, apiKey\) => ipcRenderer\.invoke\('openrouter:saveProfile', name, apiKey\)/);
});

test('OpenRouter credentials stay in the main process and renderer receives configured state only', () => {
  const main = read('src/electron/main.js');
  const credentials = read('src/shared/credentialStore.js');

  assert.match(credentials, /openrouterProfiles: \['providers', 'openrouter', 'profiles'\]/);
  assert.match(main, /function redactOpenRouterProfilesForRenderer/);
  assert.match(main, /apiKey: profile\?\.apiKey \? 'set' : ''/);
  assert.match(main, /delete normalizedPatch\.openrouterProfiles/);
  assert.match(main, /ipcMain\.handle\('openrouter:saveProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:deleteProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:renameProfile'/);
  assert.match(main, /ipcMain\.handle\('openrouter:setProfileEnabled'/);
  assert.match(main, /AbortSignal\.timeout\(15_000\)/);
  assert.match(main, /openrouterLimits\.openrouterProfileName\(rawName\)/);
  assert.match(main, /openrouterLimits\.openrouterProfileName\(rawNewName\)/);
});

test('OpenRouter Limits presentation distinguishes real meters from spend-only rows', () => {
  const app = read('src/electron/renderer/app.js');
  const presentation = read('src/electron/renderer/limitProviderPresentation.js');
  const styles = read('src/electron/renderer/styles.css');
  const colors = read('src/electron/renderer/usageCharts.js');

  assert.match(app, /\{ id: 'openrouter', label: 'OpenRouter' \}/);
  assert.match(app, /provider\.provider === 'openrouter'/);
  assert.match(app, /function renderOpenRouterAccountGroup/);
  assert.match(
    app,
    /if \(id === 'openrouter' && Array\.isArray\(visibleProviders\) && visibleProviders\.length > 1\) \{\s*nodes\.push\(renderOpenRouterAccountGroup\(label, visibleProviders, color\)\);\s*continue;\s*\}/
  );
  assert.match(app, /const hasMeter = quotaWindow\?\.showMeter !== false/);
  assert.match(app, /const valueOverride = hasMeter \? null : \(quotaWindow\?\.detail \|\| '—'\)/);
  assert.match(presentation, /openrouter: \['Pay-as-you-go', 'API key'\]/);
  assert.match(styles, /\.limit-icon-openrouter/);
  assert.match(colors, /openrouter: '#6467f2'/);
});

test('OpenRouter settings status uses collision-free row identity and a stable env account name', () => {
  const app = read('src/electron/renderer/app.js');
  assert.match(app, /info\.dataset\.openrouterProfileName = name/);
  assert.match(app, /info\.dataset\.openrouterEnvironment = 'true'/);
  assert.match(app, /byName\.get\('environment'\)/);
  assert.doesNotMatch(app, /openrouter-info-\$\{/);
});

test('OpenRouter key page is narrowly allowlisted', () => {
  const main = read('src/electron/main.js');
  assert.match(main, /parsed\.hostname === 'openrouter\.ai' && parsed\.pathname\.startsWith\('\/settings\/keys'\)/);
});
