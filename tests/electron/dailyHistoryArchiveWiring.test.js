'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'src/agent/agent.js'), 'utf8');

test('every Electron collector mode follows the retained-session setting for daily history', () => {
  assert.match(main, /function electronUsageConfig/);
  assert.match(main, /usageConfigFromSettings\(settings, \{/);
  assert.equal((main.match(/usageOptions:\s*electronUsageConfig\(/g) || []).length, 3);
});

test('every Electron collector mode yields daily-history writes to an external agent', () => {
  assert.match(main, /dailyHistoryArchiveWriteEnabled:\s*\(\) => !isExternalAgentActive\(\)/);
  assert.equal((main.match(/usageOptions:\s*electronUsageConfig\(/g) || []).length, 3);
});

test('clearing retained session usage also clears retained daily history', () => {
  assert.match(main, /clearSessionUsageArchive\(\);\s*clearDailyHistoryArchive\(\);/);
});

test('the headless agent retains daily history without mutating storage in dry-run mode', () => {
  assert.match(agent, /dailyHistoryArchiveEnabled:\s*sessionUsageArchiveEnabled/);
  assert.match(agent, /dailyHistoryArchiveWriteEnabled:\s*!dryRun/);
});

test('a non-dry-run one-shot agent claims archive ownership before collecting', () => {
  const ownership = agent.indexOf('if (!dryRun) registerPidFile(');
  const oneShot = agent.indexOf('if (once) {');
  assert.ok(ownership >= 0);
  assert.ok(oneShot >= 0);
  assert.ok(ownership < oneShot);
});
