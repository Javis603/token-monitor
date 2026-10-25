'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizePeriod } = require('../../src/shared/usage');
const { captureArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { captureSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { buildSyncPayload } = require('../../src/shared/syncPayload');

const AT = '2026-10-25T12:00:00.000Z';
const ID = 'abcdefab-1234-5678-abcd-abcdefabcdef';
const PERIODS = ['today', 'month', 'allTime'];

function fixture() {
  const rows = [
    ['claude', ID.toUpperCase(), 100, {}],
    ['claude', 'child', 40, { parentSessionId: ID }],
    ['claude', 'native', 20, { parentSessionId: ID, parentClient: 'codex' }],
    ['codex', ID, 30, {}]
  ];
  const period = normalizePeriod({
    totalTokens: 190, costUsd: 1.9,
    clients: { claude: 160, codex: 30 }, clientCosts: { claude: 1.6, codex: 0.3 },
    models: { model: 190 }, modelCosts: { model: 1.9 },
    clientModels: { claude: { model: 160 }, codex: { model: 30 } },
    clientModelCosts: { claude: { model: 1.6 }, codex: { model: 0.3 } },
    sessions: Object.fromEntries(rows.map(([client, sessionId, tokens, link]) => [
      `${client}:${sessionId}`, { client, sessionId, totalTokens: tokens, costUsd: tokens / 100,
        models: { model: tokens }, modelCosts: { model: tokens / 100 }, ...link }
    ]))
  });
  return { updatedAt: AT, ...Object.fromEntries(PERIODS.map(name => [name, structuredClone(period)])) };
}

for (const sessionUsageArchiveEnabled of [false, true]) {
  test(`mirror policy covers disabled-client display and upload, session archive ${sessionUsageArchiveEnabled}`, () => {
    const source = fixture();
    const archivedClientUsage = captureArchivedClientUsage(null, source, ['claude', 'codex'], new Date(AT));
    const sessionArchive = captureSessionUsageArchive(null, source, new Date(AT));
    const before = JSON.stringify({ archivedClientUsage, sessionArchive });
    const transform = createUsageTransform({ getSettings: () => ({
      clients: [], archivedClientUsage, sessionUsageArchiveEnabled, projectsEnabled: false
    }) });
    for (const [policy, expected] of [
      [{ excludedSessionKeys: [`claude:${ID}`] }, 50],
      [{ excludedSessionKeys: [`claude:${ID}`], claudeMirrorArchiveRecovery: true }, 30],
      [{}, 190]
    ]) {
      const empty = { updatedAt: AT, ...policy,
        ...Object.fromEntries(PERIODS.map(name => [name, normalizePeriod({})])) };
      const visible = transform.project(empty, sessionArchive, new Date(AT));
      const payload = buildSyncPayload(visible);
      for (const name of PERIODS) {
        for (const result of [visible, payload]) {
          assert.equal(result[name].totalTokens, expected, name);
          assert.ok(Math.abs(result[name].costUsd - expected / 100) < 1e-9);
          assert.equal(result[name].models.model, expected);
          assert.ok(Math.abs(result[name].modelCosts.model - expected / 100) < 1e-9);
          assert.equal(result[name].clients.codex, 30, 'same id on another client survives');
          assert.equal(result[name].clients.claude || 0, expected - 30);
          assert.ok(Math.abs((result[name].clientCosts.claude || 0) - (expected - 30) / 100) < 1e-9);
          assert.equal(result[name].clientModels.claude?.model || 0, expected - 30);
        }
        if (expected < 190) {
          assert.ok(!visible[name].sessions[`claude:${ID.toUpperCase()}`]);
          assert.ok(!visible[name].sessions['claude:child']);
        }
      }
      assert.equal(payload.excludedSessionKeys, undefined);
      assert.equal(payload.claudeMirrorArchiveRecovery, undefined);
      assert.equal(JSON.stringify({ archivedClientUsage, sessionArchive }), before, 'projection never destroys retained data');
    }
  });
}

test('recovery suppresses aggregate-only Claude archive without suppressing live usage', () => {
  const source = fixture();
  for (const name of PERIODS) source[name].sessions = {};
  const archivedClientUsage = captureArchivedClientUsage(null, source, ['claude'], new Date(AT));
  const transform = createUsageTransform({ getSettings: () => ({
    clients: [], archivedClientUsage, sessionUsageArchiveEnabled: false, projectsEnabled: false
  }) });
  const live = { updatedAt: AT, claudeMirrorArchiveRecovery: true,
    ...Object.fromEntries(PERIODS.map(name => [name, normalizePeriod({ totalTokens: 7, clients: { claude: 7 } })])) };
  const visible = transform.project(live, null, new Date(AT));
  for (const name of PERIODS) assert.equal(visible[name].totalTokens, 7);
});
