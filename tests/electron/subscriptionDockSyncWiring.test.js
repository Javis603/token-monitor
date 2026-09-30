'use strict';

// The subscription write path is the one settings change that does not come
// through settings:save, so it is also the one that no appearance push follows.
// The dock card decorates its plan cell from the subscription records the
// appearance carries, so a write that only updates `settings` leaves the card
// showing the list as it stood before the edit — until something unrelated
// pushes, or the app restarts. main.js cannot be required outside Electron,
// hence the source-level contract.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

function handlerSource(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `${channel} not found`);
  const end = main.indexOf('\n  ipcMain.handle(', start + 1);
  return main.slice(start, end === -1 ? main.length : end);
}

test('every successful subscription write re-syncs the dock', () => {
  for (const channel of ['subscriptions:save', 'subscriptions:adoptOrphans', 'subscriptions:discardOrphans']) {
    assert.match(
      handlerSource(channel),
      /syncEdgeDock\(\);/,
      `${channel} leaves the dock card on the list it wrote over`
    );
  }
});

test('the subscription write path re-syncs the dock alone, and only on success', () => {
  for (const channel of ['subscriptions:save', 'subscriptions:adoptOrphans']) {
    const source = handlerSource(channel);
    // pushSettingsToRenderer() would do it too, and would also re-send the whole
    // settings payload to the widget's renderer — which re-renders the settings
    // form the user is standing in. The renderer already holds what it wrote
    // back, so the appearance is the only thing owed.
    assert.doesNotMatch(source, /pushSettingsToRenderer\(/);
    // One call, on the success path between the write and its return: a refused
    // write left the list unchanged, and a rejected hub write changes nothing
    // this device can show.
    assert.equal((source.match(/syncEdgeDock\(\);/g) || []).length, 1, channel);
    assert.match(source, /try \{[\s\S]*?syncEdgeDock\(\);[\s\S]*?\} catch/);
  }
});

test('the dock is re-synced from the settings the write left behind', () => {
  // syncEdgeDock() reads the current settings when given no payload, so the
  // call has to stand on its own — passing the pre-write list would refresh the
  // card with the list it was already showing.
  const sync = main.slice(main.indexOf('function syncEdgeDock('));
  assert.match(sync.slice(0, sync.indexOf('\n}')), /edgeDockAppearance\(rendererSettings\)/);
  const appearance = main.slice(main.indexOf('function edgeDockAppearance('));
  assert.match(appearance.slice(0, appearance.indexOf('\n}')), /= settingsForRenderer\(\)/);
});
