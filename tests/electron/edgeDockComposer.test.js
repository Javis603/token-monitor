'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { addableLimitProviders } = require('../../src/electron/renderer/edgeDock/composer');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

// A provider that reports no quota has no cell in automatic mode. The add menu
// still needs to offer it alongside the connected providers.
test('a provider the user enabled but that reports nothing is still offered', () => {
  assert.deepEqual(
    addableLimitProviders(['claude', 'codex', 'cursor'], ['codex']),
    ['claude', 'cursor']
  );
});

test('the order is the one it was handed, so the menu follows the limits order', () => {
  assert.deepEqual(
    addableLimitProviders(['cursor', 'claude', 'codex'], []),
    ['cursor', 'claude', 'codex']
  );
});

test('providers already added to the dock are skipped', () => {
  assert.deepEqual(addableLimitProviders(['claude', 'codex'], ['codex', 'claude']), []);
});

test('ids are compared case-insensitively, so a cased entry cannot double up', () => {
  assert.deepEqual(addableLimitProviders(['Claude', 'codex'], ['CLAUDE']), ['codex']);
});

test('nothing enabled and nothing left both yield an empty section', () => {
  assert.deepEqual(addableLimitProviders([], ['codex']), []);
  assert.deepEqual(addableLimitProviders(undefined, undefined), []);
  assert.deepEqual(addableLimitProviders(['claude'], ['claude']), []);
});

// The rule above is only worth anything if the menu asks it: a helper that exists
// but is never wired would pass every test above and still leave the gap open.
test('the add menu offers all enabled providers in one limits section', () => {
  const composer = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'composer.js'), 'utf8');
  assert.match(composer, /section\('settings\.edgeDock\.addLimits', addableLimitProviders\(/);
  assert.match(composer, /addableLimitProviders\(\s*enabledLimitProviders\?\.\(\) \|\| connectedProviders\(\),/);
});

test('the composer is handed the enabled providers in the user\'s limits order', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /enabledLimitProviders: \(\) => limitProviderOrderApi/);
  assert.match(app, /\.orderedLimitProviders\(LIMIT_PROVIDERS, state\.settings\?\.limitProviderOrder\)/);
  assert.match(app, /\.filter\(\(\{ id \}\) => enabledLimitProviderSet\(\)\.has\(id\)\)/);
});
