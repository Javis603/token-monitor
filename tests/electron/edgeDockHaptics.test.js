'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Edge Dock haptics default on and survive the complete settings round trip', () => {
  const main = read('src/electron/main.js');
  assert.match(main, /edgeDockMode: 'autoHide',\s+edgeDockHaptic: true,/);
  assert.match(main, /merged\.edgeDockHaptic = parseBoolean\(merged\.edgeDockHaptic, true\)/);
  assert.match(main, /edgeDockHaptic: parseBoolean\(patch\.edgeDockHaptic \?\? settings\.edgeDockHaptic, true\)/);
  assert.match(main, /performHaptic: \(pattern, performanceTime\) => performMacHaptic\(\{ pattern, performanceTime \}\)/);
});

test('macOS Edge Dock settings expose a localized haptic toggle', () => {
  const html = read('src/electron/renderer/index.html');
  const app = read('src/electron/renderer/app.js');
  const i18n = read('src/electron/renderer/i18n.js');

  assert.match(html, /id="edgeDockHapticRow"[\s\S]*id="edgeDockHapticInput"/);
  assert.match(app, /edgeDockHapticInput\.checked = state\.settings\?\.edgeDockHaptic !== false/);
  assert.match(app, /saveSettings\(\{ edgeDockHaptic: els\.edgeDockHapticInput\.checked \}\)/);
  assert.match(app, /edgeDockHapticRow\?\.classList\.toggle\('hidden', state\.appInfo\?\.platform !== 'darwin'\)/);
  assert.equal((i18n.match(/'settings\.edgeDock\.haptic':/g) || []).length, 5);
});
