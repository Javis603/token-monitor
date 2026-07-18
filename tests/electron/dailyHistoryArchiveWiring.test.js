'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'src/agent/agent.js'), 'utf8');

test('every Electron collector mode follows the retained-session setting for daily history', () => {
  const matches = main.match(/dailyHistoryArchiveEnabled:\s*settings\.sessionUsageArchiveEnabled !== false/g) || [];
  assert.equal(matches.length, 3);
});

test('clearing retained session usage also clears retained daily history', () => {
  assert.match(main, /clearSessionUsageArchive\(\);\s*clearDailyHistoryArchive\(\);/);
});

test('the headless agent retains daily history without mutating storage in dry-run mode', () => {
  assert.match(agent, /dailyHistoryArchiveEnabled:\s*sessionUsageArchiveEnabled/);
  assert.match(agent, /dailyHistoryArchiveWriteEnabled:\s*!dryRun/);
});
