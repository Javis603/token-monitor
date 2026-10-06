'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  applyCodexAdditionalLimitsMigration,
  codexAdditionalLimitsMigrationPatch
} = require('../../src/electron/codexAdditionalLimitsMigration');
const { isLimitWindowHidden, limitWindowKey } = require('../../src/shared/limits/usageItems');

const ROOT = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(ROOT, 'src/electron/main.js'), 'utf8');

const sparkSession = { kind: 'session', label: 'GPT-5.3-Codex-Spark', limitId: 'codex_spark', windowMinutes: 300, additional: true };
const sparkWeekly = { kind: 'weekly', label: 'GPT-5.3-Codex-Spark', limitId: 'codex_spark', windowMinutes: 10080, additional: true };
const statsWith = (...providers) => ({ limits: { providers } });
const codex = (...windows) => ({ provider: 'codex', windows: [{ kind: 'session', label: 'Session' }, ...windows] });

test('every presented stats push and presentation refresh can carry the switch over', () => {
  assert.equal((main.match(/migrateCodexAdditionalLimits\(visibleStats\);/g) || []).length, 2);
  assert.match(main, /function migrateCodexAdditionalLimits\(visibleStats\) \{[\s\S]*?onPersisted: pushSettingsToRenderer/);
});

test('a stored false hides every pool it can see and turns the switch back on', () => {
  const patch = codexAdditionalLimitsMigrationPatch(
    { showCodexAdditionalLimits: false, limitProviderHiddenItems: { claude: ['credits'] } },
    statsWith(codex(sparkSession), codex(sparkWeekly), { provider: 'claude', windows: [{ ...sparkSession }] })
  );
  assert.deepEqual(patch, {
    showCodexAdditionalLimits: true,
    limitProviderHiddenItems: {
      claude: ['credits'],
      codex: [limitWindowKey(sparkSession), limitWindowKey(sparkWeekly)]
    }
  });
  for (const window of [sparkSession, sparkWeekly]) {
    assert.equal(isLimitWindowHidden(patch.limitProviderHiddenItems, 'codex', window), true);
  }
  assert.equal(isLimitWindowHidden(patch.limitProviderHiddenItems, 'codex', { kind: 'session', label: 'Session' }), false);
});

test('nothing moves until a pool is reported and fits, or when the switch was on', () => {
  assert.equal(codexAdditionalLimitsMigrationPatch({ showCodexAdditionalLimits: false }, statsWith(codex())), null);
  assert.equal(codexAdditionalLimitsMigrationPatch({ showCodexAdditionalLimits: false }, null), null);
  assert.equal(codexAdditionalLimitsMigrationPatch({ showCodexAdditionalLimits: true }, statsWith(codex(sparkSession))), null);
  assert.equal(codexAdditionalLimitsMigrationPatch({}, statsWith(codex(sparkSession))), null);
  const full = Array.from({ length: 64 }, (_, index) => limitWindowKey({ kind: 'session', label: `Pool ${index}` }));
  assert.equal(codexAdditionalLimitsMigrationPatch(
    { showCodexAdditionalLimits: false, limitProviderHiddenItems: { codex: full } },
    statsWith(codex(sparkSession))
  ), null, 'a pool id the full hidden list would drop keeps the switch off');
});

test('the carried-over selection persists and pushes once, and a failed save leaves settings untouched', () => {
  const events = [];
  const settings = { showCodexAdditionalLimits: false, limitProviderHiddenItems: {} };
  assert.equal(applyCodexAdditionalLimitsMigration(statsWith(codex(sparkSession)), {
    settings,
    saveSettings: () => { events.push('save'); return true; },
    onPersisted: () => events.push('push')
  }), true);
  assert.deepEqual(events, ['save', 'push']);
  assert.equal(settings.showCodexAdditionalLimits, true);
  assert.deepEqual(settings.limitProviderHiddenItems, { codex: [limitWindowKey(sparkSession)] });

  assert.equal(applyCodexAdditionalLimitsMigration(statsWith(codex(sparkSession)), {
    settings,
    saveSettings: () => assert.fail('an already carried-over switch must not save again')
  }), false);

  const failed = { showCodexAdditionalLimits: false, limitProviderHiddenItems: {} };
  assert.equal(applyCodexAdditionalLimitsMigration(statsWith(codex(sparkSession)), {
    settings: failed,
    saveSettings: () => false,
    onPersisted: () => assert.fail('a failed save must not push')
  }), false);
  assert.deepEqual(failed, { showCodexAdditionalLimits: false, limitProviderHiddenItems: {} });
});
