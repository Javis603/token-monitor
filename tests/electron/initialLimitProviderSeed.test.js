'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

test('first-run limit provider seeding is guarded by settings-file and env state', () => {
  assert.match(main, /const settingsFileExisted = fs\.existsSync\(settingsPath\);/);
  assert.match(main, /initialLimitProvidersPending = !settingsFileExisted[\s\S]*?TOKEN_MONITOR_LIMIT_PROVIDERS === undefined/);
  assert.match(main, /function seedInitialLimitProviders\(summary\)/);
  assert.match(main, /limitProvidersForDetectedClients\(summary\.clientStatus\)/);
});

test('all collector modes seed from the first completed discovery snapshot', () => {
  const enqueueCount = (main.match(/seedInitialLimitProviders\(summary\);/g) || []).length;
  assert.equal(enqueueCount, 3);
  assert.match(main, /if \(patch\?\.limitProviders !== undefined\) initialLimitProvidersPending = false;/);
  assert.match(main, /if \(saveSettings\(\)\) initialLimitProvidersPending = false;/);
});
