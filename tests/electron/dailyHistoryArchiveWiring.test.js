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
// Each keeps that exact object in a const: local shares it with the cold-start
// anchor check, while sync/host also register its structural fingerprint.
function assertEveryCollectorModeUsesUsageConfig() {
  for (const [name, label] of [
    ['startLocalCollector', 'collector'],
    ['startSyncCollector', 'sync-collector'],
    ['startHostCollector', 'host-collector']
  ]) {
    const collector = functionSource(main, `function ${name}()`);
    assert.match(collector, new RegExp(`const usageOptions = electronUsageConfig\\('${label}'\\);`));
    assert.match(collector, /^\s+usageOptions,$/m);
  }
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
