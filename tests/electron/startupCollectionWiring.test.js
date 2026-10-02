'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { usageConfigFromSettings } = require('../../src/electron/runtimeConfig');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

test('Electron collectors opt into startup self-sync deferral', () => {
  const start = main.indexOf('function electronUsageConfig(');
  const end = main.indexOf('\nfunction electronLimitsConfig(', start);
  assert.ok(start >= 0 && end > start, 'electronUsageConfig should be present');
  assert.match(main.slice(start, end), /deferSelfSyncOnStartup:\s*true/);
  assert.equal(
    usageConfigFromSettings({}, { deferSelfSyncOnStartup: true }).deferSelfSyncOnStartup,
    true
  );
});
