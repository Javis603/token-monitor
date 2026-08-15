'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let archiveApi = {};
try {
  archiveApi = require('../../src/shared/clientUsageArchive');
} catch (_) {}

const {
  applyArchivedClientUsage,
  captureArchivedClientUsage,
  pruneArchivedClientUsage
} = archiveApi;

function deviceRecord() {
  return {
    deviceId: 'macbook',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { hermes: 100, codex: 50 },
      clientCosts: { hermes: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'hermes:h1': {
          client: 'hermes',
          sessionId: 'h1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 }
        },
        'codex:c1': {
          client: 'codex',
          sessionId: 'c1',
          totalTokens: 50,
          costUsd: 0.25,
          messageCount: 2,
          models: { 'gpt-5': 50 },
          modelCosts: { 'gpt-5': 0.25 }
        }
      }
    },
    month: {
      totalTokens: 450,
      costUsd: 4.5,
      clients: { hermes: 300, codex: 150 },
      clientCosts: { hermes: 3.75, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 300, 'gpt-5': 150 },
      modelCosts: { 'claude-3-5-sonnet': 3.75, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 300 }, codex: { 'gpt-5': 150 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 3.75 }, codex: { 'gpt-5': 0.75 } },
      sessions: {
        'hermes:h1': {
          client: 'hermes',
          sessionId: 'h1',
          totalTokens: 300,
          costUsd: 3.75,
          messageCount: 12,
          models: { 'claude-3-5-sonnet': 300 },
          modelCosts: { 'claude-3-5-sonnet': 3.75 }
        }
      }
    },
    allTime: {
      totalTokens: 1200,
      costUsd: 12,
      clients: { hermes: 900, codex: 300 },
      clientCosts: { hermes: 11.25, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 900, 'gpt-5': 300 },
      modelCosts: { 'claude-3-5-sonnet': 11.25, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 900 }, codex: { 'gpt-5': 300 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 11.25 }, codex: { 'gpt-5': 0.75 } },
      sessions: {
        'hermes:h1': {
          client: 'hermes',
          sessionId: 'h1',
          totalTokens: 900,
          costUsd: 11.25,
          messageCount: 24,
          models: { 'claude-3-5-sonnet': 900 },
          modelCosts: { 'claude-3-5-sonnet': 11.25 }
        }
      }
    }
  };
}

function liveSummaryWithoutHermes() {
  return {
    deviceId: 'macbook',
    today: {
      totalTokens: 50,
      costUsd: 0.25,
      outputTokens: 30,
      capabilities: { tokenComponents: true },
      clients: { codex: 50 },
      clientCosts: { codex: 0.25 },
      clientOutputs: { codex: 30 },
      models: { 'gpt-5': 50 },
      modelCosts: { 'gpt-5': 0.25 },
      modelOutputs: { 'gpt-5': 30 },
      clientModels: { codex: { 'gpt-5': 50 } },
      clientModelCosts: { codex: { 'gpt-5': 0.25 } }
    },
    month: {
      totalTokens: 150,
      costUsd: 0.75,
      outputTokens: 90,
      capabilities: { tokenComponents: true },
      clients: { codex: 150 },
      clientCosts: { codex: 0.75 },
      clientOutputs: { codex: 90 },
      models: { 'gpt-5': 150 },
      modelCosts: { 'gpt-5': 0.75 },
      modelOutputs: { 'gpt-5': 90 },
      clientModels: { codex: { 'gpt-5': 150 } },
      clientModelCosts: { codex: { 'gpt-5': 0.75 } }
    },
    allTime: {
      totalTokens: 300,
      costUsd: 0.75,
      outputTokens: 180,
      capabilities: { tokenComponents: true },
      clients: { codex: 300 },
      clientCosts: { codex: 0.75 },
      clientOutputs: { codex: 180 },
      models: { 'gpt-5': 300 },
      modelCosts: { 'gpt-5': 0.75 },
      modelOutputs: { 'gpt-5': 180 },
      clientModels: { codex: { 'gpt-5': 300 } },
      clientModelCosts: { codex: { 'gpt-5': 0.75 } }
    }
  };
}

test('archived client usage is added back while the client remains untracked', () => {
  assert.equal(typeof captureArchivedClientUsage, 'function');
  assert.equal(typeof applyArchivedClientUsage, 'function');

  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], new Date('2026-05-30T12:00:00.000Z'));
  const summary = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-05-30T13:00:00.000Z')
  });

  assert.equal(summary.today.totalTokens, 150);
  assert.equal(summary.today.clients.hermes, 100);
  assert.equal(summary.today.clientCosts.hermes, 1.25);
  assert.equal(summary.today.models['claude-3-5-sonnet'], 100);
  assert.equal(summary.today.modelCosts['claude-3-5-sonnet'], 1.25);
  assert.equal(summary.today.sessions['hermes:h1'].totalTokens, 100);
  assert.equal(summary.today.sessions['codex:c1'], undefined);
  assert.equal(summary.today.models['gpt-5'], 50);
  assert.equal(summary.month.totalTokens, 450);
  assert.equal(summary.allTime.totalTokens, 1200);
});

test('archived day and month usage follow calendar boundaries', () => {
  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], new Date('2026-05-30T12:00:00.000Z'));

  const nextDay = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-05-31T12:00:00.000Z')
  });
  assert.equal(nextDay.today.clients.hermes, undefined);
  assert.equal(nextDay.today.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextDay.today.sessions?.['hermes:h1'], undefined);
  assert.equal(nextDay.month.clients.hermes, 300);
  assert.equal(nextDay.month.models['claude-3-5-sonnet'], 300);
  assert.equal(nextDay.month.sessions['hermes:h1'].totalTokens, 300);
  assert.equal(nextDay.allTime.clients.hermes, 900);
  assert.equal(nextDay.allTime.models['claude-3-5-sonnet'], 900);
  assert.equal(nextDay.allTime.sessions['hermes:h1'].totalTokens, 900);

  const nextMonth = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-06-01T12:00:00.000Z')
  });
  assert.equal(nextMonth.today.clients.hermes, undefined);
  assert.equal(nextMonth.month.clients.hermes, undefined);
  assert.equal(nextMonth.month.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextMonth.month.sessions?.['hermes:h1'], undefined);
  assert.equal(nextMonth.allTime.clients.hermes, 900);
  assert.equal(nextMonth.allTime.models['claude-3-5-sonnet'], 900);
});

test('archived client usage restores the cache/output breakdown from its sessions', () => {
  const record = deviceRecord();
  // Give the archived client's all-time session a real hit/write/output split.
  record.allTime.sessions['hermes:h1'].cacheReadTokens = 700;
  record.allTime.sessions['hermes:h1'].cacheWriteTokens = 110;
  record.allTime.sessions['hermes:h1'].outputTokens = 90;

  const archive = captureArchivedClientUsage({}, record, ['hermes'], new Date('2026-05-30T12:00:00.000Z'));
  const summary = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-05-30T13:00:00.000Z')
  });

  // Client-level breakdown restored so the tool row expands correctly.
  assert.equal(summary.allTime.clientCacheReads.hermes, 700);
  assert.equal(summary.allTime.clientCacheWrites.hermes, 110);
  assert.equal(summary.allTime.clientOutputs.hermes, 90);
  // Model-level breakdown restored (single-model session attributes fully) so
  // the model row expands correctly instead of showing everything as miss.
  assert.equal(summary.allTime.modelCacheReads['claude-3-5-sonnet'], 700);
  assert.equal(summary.allTime.modelCacheWrites['claude-3-5-sonnet'], 110);
  assert.equal(summary.allTime.modelOutputs['claude-3-5-sonnet'], 90);
  assert.equal(summary.allTime.capabilities.tokenComponents, true);
  assert.equal(summary.allTime.unclassifiedTokens, 0);
});

test('multi-model archived client sessions do not guess model component attribution', () => {
  const record = deviceRecord();
  record.allTime.clientModels.hermes = { alpha: 450, beta: 450 };
  record.allTime.clientModelCosts.hermes = { alpha: 5.625, beta: 5.625 };
  Object.assign(record.allTime.sessions['hermes:h1'], {
    models: { alpha: 450, beta: 450 },
    modelCosts: { alpha: 5.625, beta: 5.625 },
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    outputTokens: 100
  });

  const archive = captureArchivedClientUsage({}, record, ['hermes'], new Date('2026-05-30T12:00:00.000Z'));
  const summary = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-05-30T13:00:00.000Z')
  });

  assert.equal(summary.allTime.cacheReadTokens, 600);
  assert.equal(summary.allTime.cacheWriteTokens, 100);
  assert.equal(summary.allTime.outputTokens, 280);
  assert.equal(summary.allTime.clientCacheReads.hermes, 600);
  assert.equal(summary.allTime.clientCacheWrites.hermes, 100);
  assert.equal(summary.allTime.clientOutputs.hermes, 100);
  assert.equal(summary.allTime.modelCacheReads.alpha, undefined);
  assert.equal(summary.allTime.modelCacheReads.beta, undefined);
  assert.equal(summary.allTime.modelCacheWrites.alpha, undefined);
  assert.equal(summary.allTime.modelOutputs.beta, undefined);
  assert.equal(summary.allTime.modelUnclassifiedTokens.alpha, 450);
  assert.equal(summary.allTime.modelUnclassifiedTokens.beta, 450);
  assert.equal(summary.allTime.capabilities.tokenComponents, false);
});

test('archived client usage is ignored and pruned once the client is tracked again', () => {
  assert.equal(typeof pruneArchivedClientUsage, 'function');

  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], new Date('2026-05-30T12:00:00.000Z'));
  const trackedAgain = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex,hermes',
    now: new Date('2026-05-30T13:00:00.000Z')
  });
  assert.equal(trackedAgain.today.clients.hermes, undefined);

  const pruned = pruneArchivedClientUsage(archive, 'codex,hermes');
  assert.deepEqual(pruned.clients, {});
});

// A progressive preview carries only the periods it has finished scanning, and
// the ones it omits are exactly what marks the record partial — the signal
// deviceState uses to carry clientStatus / clientHealth / wslStatus /
// periodWindows forward from the last complete record. Creating a period here to
// hold archived usage made every preview look complete, and those four fields
// disappeared from the device for the length of a full scan: the tool tags fell
// back to "waiting" and the diagnostics panel closed itself mid-refresh.
test('an archive never invents a period the scan has not reported', () => {
  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], new Date('2026-05-30T12:00:00.000Z'));
  const preview = { deviceId: 'macbook', updatedAt: '2026-05-30T13:00:00.000Z', today: liveSummaryWithoutHermes().today };
  const applied = applyArchivedClientUsage(preview, archive, {
    activeClients: 'codex',
    now: new Date('2026-05-30T13:00:00.000Z')
  });
  assert.equal('month' in applied, false);
  assert.equal('allTime' in applied, false);
  // The period it does have still gets the archived usage.
  assert.equal(applied.today.clients.hermes, 100);
});
