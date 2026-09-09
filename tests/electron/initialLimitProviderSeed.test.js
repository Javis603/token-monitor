'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { applyInitialLimitProviderSeed } = require('../../src/electron/initialLimitProviderSeed');
const { parseLimitProviders } = require('../../src/shared/limits/collector');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

test('first-run limit provider seeding is guarded by settings-file and env state', () => {
  assert.match(main, /const settingsFileExisted = fs\.existsSync\(settingsPath\);/);
  assert.match(main, /initialLimitProvidersPending = !settingsFileExisted[\s\S]*?TOKEN_MONITOR_LIMIT_PROVIDERS === undefined/);
  assert.match(main, /function seedInitialLimitProviders\(summary\)/);
  assert.match(main, /applyInitialLimitProviderSeed\(initialLimitProvidersPending, summary/);
  assert.match(main, /onPersisted\(\) \{[\s\S]*?initialLimitProvidersPending = false;[\s\S]*?reconfigureLimits\(electronLimitsConfig\(\)\);[\s\S]*?pushSettingsToRenderer\(\);/);
});

test('all collector modes seed from the first completed discovery snapshot', () => {
  const enqueueCount = (main.match(/seedInitialLimitProviders\(summary\);/g) || []).length;
  assert.equal(enqueueCount, 3);
});

test('a completed source snapshot persists, reconfigures, and pushes once', () => {
  let pending = true;
  const settings = { limitProviders: 'claude,codex,cursor' };
  const events = [];

  assert.equal(applyInitialLimitProviderSeed(pending, {
    clientHealth: {
      clients: {
        cursor: { source: { state: 'detected' } },
        claude: { source: { state: 'detected' } },
        codex: { source: { state: 'missing' } }
      }
    }
  }, {
    settings,
    saveSettings: () => { events.push(`save:${settings.limitProviders}`); return true; },
    onPersisted: () => {
      pending = false;
      events.push(`reconfigure:${settings.limitProviders}`);
      events.push(`push:${settings.limitProviders}`);
    }
  }), true);

  assert.equal(settings.limitProviders, 'claude,cursor');
  assert.deepEqual(events, [
    'save:claude,cursor',
    'reconfigure:claude,cursor',
    'push:claude,cursor'
  ]);
  assert.equal(pending, false);
  assert.equal(applyInitialLimitProviderSeed(pending, { clientHealth: { clients: {} } }, { settings }), false);
});

test('a source-free first run falls back to Codex so Limits remains available', () => {
  const settings = { limitProviders: 'claude,codex' };

  assert.equal(applyInitialLimitProviderSeed(true, { clientHealth: { clients: {} } }, {
    settings,
    saveSettings: () => true
  }), true);

  assert.equal(settings.limitProviders, 'codex');
  assert.deepEqual(parseLimitProviders(settings.limitProviders), ['codex']);
});

test('usage-derived active status alone does not consume the pending seed', () => {
  const settings = { limitProviders: 'claude,codex' };

  assert.equal(applyInitialLimitProviderSeed(true, { clientStatus: { claude: 'active' } }, {
    settings,
    saveSettings: () => assert.fail('an incomplete source snapshot must not be saved')
  }), false);
  assert.equal(settings.limitProviders, 'claude,codex');
});

test('a failed save restores the prior selection and retries the next snapshot', () => {
  let pending = true;
  const settings = { limitProviders: 'claude,codex' };
  const events = [];
  const summary = {
    clientHealth: { clients: { cursor: { source: { state: 'detected' } } } }
  };

  assert.equal(applyInitialLimitProviderSeed(pending, summary, {
    settings,
    saveSettings: () => false,
    onPersisted: () => events.push('persisted')
  }), false);
  assert.equal(settings.limitProviders, 'claude,codex');
  assert.equal(pending, true);
  assert.deepEqual(events, []);

  assert.equal(applyInitialLimitProviderSeed(pending, summary, {
    settings,
    saveSettings: () => true,
    onPersisted: () => { pending = false; events.push('persisted'); }
  }), true);
  assert.equal(settings.limitProviders, 'cursor');
  assert.equal(pending, false);
  assert.deepEqual(events, ['persisted']);
});

test('a cancelled pending seed cannot overwrite the user selection', () => {
  const settings = { limitProviders: 'codex' };

  assert.equal(applyInitialLimitProviderSeed(false, {
    clientHealth: { clients: { claude: { source: { state: 'detected' } } } }
  }, { settings, saveSettings: () => true }), false);
  assert.equal(settings.limitProviders, 'codex');
});

test('the settings path cancels pending discovery only after a successful save', () => {
  const updateHandler = main.slice(
    main.indexOf("ipcMain.handle('settings:update'"),
    main.indexOf("ipcMain.handle('appearance:preview'")
  );
  assert.ok(
    updateHandler.indexOf('saveSettings({ throwOnError: true });')
      < updateHandler.indexOf('initialLimitProvidersPending = false;')
  );
});
