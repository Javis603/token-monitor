'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'src/agent/agent.js'), 'utf8');

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = source.indexOf('\nfunction ', start + signature.length);
  return source.slice(start, end === -1 ? source.length : end);
}

// Local / sync / host must every one of them take their usage options from
// electronUsageConfig, or a mode quietly stops honouring the settings below.
// Sync and host call it inline. Local hoists it into a const first, because the
// cold-start anchor seed has to validate against the very config the collector
// will then run with, so that one is asserted where it lives rather than by
// counting a bare `usageOptions` shorthand anywhere in the file.
function assertEveryCollectorModeUsesUsageConfig() {
  assert.equal((main.match(/usageOptions:\s*electronUsageConfig\(/g) || []).length, 2);
  const localCollector = functionSource(main, 'function startLocalCollector()');
  assert.match(localCollector, /const usageOptions = electronUsageConfig\('collector'\);/);
  assert.match(localCollector, /^\s+usageOptions,$/m);
}

test('every Electron collector mode follows the retained-session setting for daily history', () => {
  assert.match(main, /function electronUsageConfig/);
  assert.match(main, /usageConfigFromSettings\(settings, \{/);
  assertEveryCollectorModeUsesUsageConfig();
});

test('every Electron collector mode yields daily-history writes to an external agent', () => {
  assert.match(main, /dailyHistoryArchiveWriteEnabled:\s*\(\) => !isExternalAgentActive\(\)/);
  assertEveryCollectorModeUsesUsageConfig();
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
