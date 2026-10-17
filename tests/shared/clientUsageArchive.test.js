'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let archiveApi = {};
try {
  archiveApi = require('../../src/shared/usage/clientUsageArchive');
} catch (_) {}

const {
  applyArchivedClientUsage,
  applyDailyHistoryAllTimeFloor,
  captureArchivedClientUsage,
  normalizeArchivedClientUsage,
  pruneArchivedClientUsage
} = archiveApi;

const { localDate } = require('../helpers/localTime');

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
  // The day and month windows are cut at local midnight, so the three clocks
  // below are stated in local time: a `Z` noon is already the next calendar day
  // past UTC+12, which walks the capture and both reads a day forward together
  // and takes the month rollover with them.
  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], localDate(2026, 5, 30, 12));

  const nextDay = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: localDate(2026, 5, 31, 12)
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
    now: localDate(2026, 6, 1, 12)
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

test('archived Kilo Code usage migrates to the canonical Kilo client id', () => {
  const capturedAt = new Date('2026-05-30T12:00:00.000Z');
  const archive = captureArchivedClientUsage({}, deviceRecord(), ['hermes'], capturedAt);
  archive.clients.kilocode = {
    ...archive.clients.hermes,
    client: 'kilocode'
  };
  delete archive.clients.hermes;

  const normalized = normalizeArchivedClientUsage(archive);
  assert.equal(normalized.clients.kilo.client, 'kilo');
  assert.equal(normalized.clients.kilocode, undefined);

  const summary = applyArchivedClientUsage(liveSummaryWithoutHermes(), archive, {
    activeClients: 'codex',
    now: new Date('2026-05-30T13:00:00.000Z')
  });
  assert.equal(summary.allTime.clients.kilo, 900);
  assert.equal(summary.allTime.clients.kilocode, undefined);

  assert.deepEqual(pruneArchivedClientUsage(archive, 'codex,kilo').clients, {});
});

test('untracked Cursor default archive replays as cursor-auto without changing other clients', () => {
  const capturedAt = '2026-09-20T12:00:00.000Z';
  const archive = normalizeArchivedClientUsage({ clients: {
    cursor: { client: 'cursor', capturedAt, periods: { allTime: {
      totalTokens: 5, costUsd: 0.5, models: { default: 5 }, modelCosts: { default: 0.5 }
    } } },
    claude: { client: 'claude', capturedAt, periods: { allTime: {
      totalTokens: 11, costUsd: 1.1, models: { default: 11 }, modelCosts: { default: 1.1 }
    } } }
  } });
  const visible = applyArchivedClientUsage({ allTime: { sessions: {} } }, archive, {
    activeClients: '', now: new Date('2026-09-28T12:00:00.000Z')
  });

  assert.equal(visible.allTime.models['cursor-auto'], 5);
  assert.equal(visible.allTime.models.default, 11);
  assert.equal(visible.allTime.clientModels.cursor['cursor-auto'], 5);
  assert.equal(visible.allTime.clientModels.claude.default, 11);
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

// ---------------------------------------------------------------------------
// Client identity splits (clientIdentitySplits.js).
//
// Tokscale has scanned `.omp/agent/sessions` under the `pi` client since v2.0.19
// (2026-04-06) and Token Monitor has shipped that scanner continuously since
// these archives existed, so a `pi` entry written before the split covers both
// products. Splitting them makes that unsafe in two directions, and the entry's
// own generation is what tells the two kinds apart.
//
// Times are built from the local calendar rather than a fixed UTC instant: the
// archive buckets by local day, so a literal like 2026-09-01T12:00Z is already
// the next day in UTC+14 and the `today` assertions would move under CI's
// timezone matrix.
function localNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0);
}

function localDayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function session(client, id, tokens) {
  return { client, sessionId: id, totalTokens: tokens, costUsd: 0, models: { gpt: tokens }, modelCosts: {} };
}

// A pre-split entry: no clientIdentityGeneration, and one `pi` row whose sessions
// include an Oh My Pi session (id `omp1`) that the split id will later report.
function legacyMergedArchive(now) {
  const sessions = { 'pi:pi1': session('pi', 'pi1', 60), 'pi:omp1': session('pi', 'omp1', 40) };
  const period = { totalTokens: 100, costUsd: 0, models: { gpt: 100 }, modelCosts: {}, sessions };
  return {
    version: 1,
    clients: {
      pi: {
        client: 'pi',
        capturedAt: now.toISOString(),
        day: localDayKey(now),
        month: localDayKey(now).slice(0, 7),
        periods: { today: period, month: period, allTime: period }
      }
    }
  };
}

function liveSummary(now, sessionsByClient) {
  const clients = {};
  const clientCosts = {};
  const clientModels = {};
  const clientModelCosts = {};
  const models = {};
  const modelCosts = {};
  const sessions = {};
  for (const [client, entries] of Object.entries(sessionsByClient)) {
    let tokens = 0;
    let cost = 0;
    for (const [id, value] of entries) {
      const entry = session(client, id, value);
      sessions[`${client}:${id}`] = entry;
      tokens += value;
      cost += entry.costUsd;
      for (const [model, modelTokens] of Object.entries(entry.models)) {
        models[model] = (models[model] || 0) + modelTokens;
        if (!clientModels[client]) clientModels[client] = {};
        clientModels[client][model] = (clientModels[client][model] || 0) + modelTokens;
      }
      for (const [model, modelCost] of Object.entries(entry.modelCosts)) {
        modelCosts[model] = (modelCosts[model] || 0) + modelCost;
        if (!clientModelCosts[client]) clientModelCosts[client] = {};
        clientModelCosts[client][model] = (clientModelCosts[client][model] || 0) + modelCost;
      }
    }
    if (tokens > 0) clients[client] = tokens;
    if (cost > 0) clientCosts[client] = cost;
  }
  const totalTokens = Object.values(clients).reduce((sum, value) => sum + value, 0);
  const costUsd = Object.values(clientCosts).reduce((sum, value) => sum + value, 0);
  const period = { totalTokens, costUsd, clients, clientCosts, models, modelCosts, clientModels, clientModelCosts, sessions };
  return { periods: { today: period, month: { ...period }, allTime: { ...period } } };
}

// The merged snapshot already holds Oh My Pi, so replaying its live row on top
// would count that usage twice. The archived copy of the *same session* is what
// gets removed, which is what keeps this exact as live usage grows.
test('a merged Pi snapshot does not double count a live Oh My Pi session', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['omp1', 40]] }),
    legacyMergedArchive(now),
    { activeClients: 'omp', now }
  );
  // The live Oh My Pi session replaces the archived copy; archived Pi 60 remains.
  assert.equal(applied.periods.allTime.totalTokens, 100);
});

// The case aggregate subtraction got wrong: live usage keeps growing after the
// split, and growth must not be eaten by a frozen snapshot.
test('a merged Pi snapshot keeps Oh My Pi growth that happened after the split', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['omp1', 120]] }),
    legacyMergedArchive(now),
    { activeClients: 'omp', now }
  );
  // 60 archived Pi + 120 live Oh My Pi (the same session, now larger).
  assert.equal(applied.periods.allTime.totalTokens, 180);
});

test('a merged Pi snapshot keeps an Oh My Pi session created after the split', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['ompNEW', 120]] }),
    legacyMergedArchive(now),
    { activeClients: 'omp', now }
  );
  // Nothing overlaps, so the whole archived 100 stands beside the live 120.
  assert.equal(applied.periods.allTime.totalTokens, 220);
});

// The mirror of the growth case for the merged id itself.
test('a merged Pi snapshot keeps Pi growth that happened while it was untracked', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { pi: [['pi1', 80]] }),
    legacyMergedArchive(now),
    { activeClients: 'pi', now }
  );
  // 40 archived Oh My Pi + 80 live Pi (same session id, grown).
  assert.equal(applied.periods.allTime.totalTokens, 120);
});

test('a merged Pi snapshot contributes nothing once both ids are live', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { pi: [['pi1', 60]], omp: [['omp1', 40]] }),
    legacyMergedArchive(now),
    { activeClients: 'pi,omp', now }
  );
  assert.equal(applied.periods.allTime.totalTokens, 100);
});

// A snapshot this version wrote is genuinely that client, so the live split id
// must not be subtracted from it. Treating it as merged would silently remove
// usage that never contained Oh My Pi at all.
test('a genuinely Pi-only snapshot written after the split keeps its full total', () => {
  const now = localNoon(2026, 9, 1);
  const piOnly = captureArchivedClientUsage({}, {
    updatedAt: now.toISOString(),
    periods: Object.fromEntries(['today', 'month', 'allTime'].map((periodName) => [periodName, {
      clients: { pi: 100 },
      sessions: { 'pi:pi1': session('pi', 'pi1', 100) }
    }]))
  }, 'pi', now);
  assert.equal(piOnly.clients.pi.clientIdentityGeneration, 2, 'the write must be marked');
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['ompX', 40]] }),
    piOnly,
    { activeClients: 'omp', now }
  );
  assert.equal(applied.periods.allTime.totalTokens, 140, 'archived Pi 100 + live Oh My Pi 40');
});

// Pruning means "the live scan owns this id now", which is not true of an entry
// holding two products: the archive is the only place the untracked one exists.
test('re-enabling Pi does not discard a pre-split merged snapshot', () => {
  const now = localNoon(2026, 9, 1);
  const pruned = pruneArchivedClientUsage(legacyMergedArchive(now), 'pi');
  assert.ok(pruned.clients.pi, 'the pre-split snapshot should survive pruning');
  // An ordinary client is still pruned exactly as before.
  const ordinary = captureArchivedClientUsage({}, {
    updatedAt: now.toISOString(),
    periods: Object.fromEntries(['today', 'month', 'allTime'].map((periodName) => [periodName, {
      clients: { opencode: 50 },
      sessions: { 'opencode:o1': session('opencode', 'o1', 50) }
    }]))
  }, 'opencode', now);
  assert.equal(pruneArchivedClientUsage(ordinary, 'opencode').clients.opencode, undefined);
});

// Provenance has to decide this, not the client id or the totals. Real captures
// can carry no session detail (a locally-parsed client, or a record written
// before sessions were kept), and then the aggregate fallback is the only path.
// A post-split Pi-only entry and a pre-split merged one are byte-identical apart
// from the generation marker, so the two must behave differently.
test('provenance, not the client id, decides whether a Pi snapshot is merged', () => {
  const now = localNoon(2026, 9, 1);
  const period = { totalTokens: 100, costUsd: 0, models: { gpt: 100 }, modelCosts: {}, sessions: {} };
  const entry = (generation) => ({
    version: 1,
    clients: {
      pi: {
        client: 'pi',
        capturedAt: now.toISOString(),
        day: localDayKey(now),
        month: localDayKey(now).slice(0, 7),
        ...(generation === undefined ? {} : { clientIdentityGeneration: generation }),
        periods: { today: period, month: period, allTime: period }
      }
    }
  });
  const live = liveSummary(now, { omp: [['ompFresh', 40]] });

  // Marked: this entry is genuinely Pi, so the live Oh My Pi row is additional.
  const fresh = applyArchivedClientUsage(live, entry(2), { activeClients: 'omp', now });
  assert.equal(fresh.periods.allTime.totalTokens, 140, 'a post-split Pi entry keeps Oh My Pi separate');

  // Unmarked: written before the split, so it may already contain Oh My Pi.
  const legacy = applyArchivedClientUsage(live, entry(undefined), { activeClients: 'omp', now });
  assert.equal(legacy.periods.allTime.totalTokens, 100, 'a pre-split entry nets out the live Oh My Pi row');
});

// The same distinction on the prune side: pruning must drop an ordinary client
// but keep a pre-split snapshot, which is the only holder of the other product.
test('provenance, not the client id, decides whether pruning keeps a Pi snapshot', () => {
  const now = localNoon(2026, 9, 1);
  const period = { totalTokens: 100, costUsd: 0, models: { gpt: 100 }, modelCosts: {}, sessions: {} };
  const legacy = {
    version: 1,
    clients: {
      pi: {
        client: 'pi',
        capturedAt: now.toISOString(),
        day: localDayKey(now),
        month: localDayKey(now).slice(0, 7),
        periods: { today: period, month: period, allTime: period }
      }
    }
  };
  assert.ok(pruneArchivedClientUsage(legacy, 'pi').clients.pi, 'a pre-split snapshot survives');
  const marked = JSON.parse(JSON.stringify(legacy));
  marked.clients.pi.clientIdentityGeneration = 2;
  assert.equal(
    pruneArchivedClientUsage(marked, 'pi').clients.pi, undefined,
    'a post-split entry is an ordinary client and prunes as before'
  );
});

// Netting out a session has to remove its model rows too: leaving the archived
// model map whole would replay the same tokens a second time through the
// per-model totals, so the breakdown would say 100 while the tool total says 60.
test('a merged snapshot nets out the removed sessions model rows too', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['omp1', 40]] }),
    legacyMergedArchive(now),
    { activeClients: 'omp', now }
  );
  const allTime = applied.periods.allTime;
  assert.equal(allTime.totalTokens, 100);
  assert.equal(allTime.models.gpt, 100, 'model totals must shrink with the token total');
  assert.equal(allTime.clientModels.pi.gpt, 60);
  assert.equal(allTime.clientModels.omp.gpt, 40);
});

test('a merged snapshot nets out the removed sessions model costs too', () => {
  const now = localNoon(2026, 9, 1);
  const sessions = {
    'pi:pi1': { ...session('pi', 'pi1', 60), costUsd: 6, modelCosts: { gpt: 6 } },
    'pi:omp1': { ...session('pi', 'omp1', 40), costUsd: 4, modelCosts: { gpt: 4 } }
  };
  const period = { totalTokens: 100, costUsd: 10, models: { gpt: 100 }, modelCosts: { gpt: 10 }, sessions };
  const archive = {
    version: 1,
    clients: {
      pi: {
        client: 'pi',
        capturedAt: now.toISOString(),
        day: localDayKey(now),
        month: localDayKey(now).slice(0, 7),
        periods: { today: period, month: period, allTime: period }
      }
    }
  };
  const applied = applyArchivedClientUsage(
    liveSummary(now, { omp: [['omp1', 40]] }),
    archive,
    { activeClients: 'omp', now }
  );
  const allTime = applied.periods.allTime;
  assert.equal(allTime.totalTokens, 100);
  // The live scan owns the session now, so its archived cost leaves with it.
  assert.equal(allTime.costUsd, 6);
  assert.equal(allTime.modelCosts.gpt, 6);
});

// Session ids are matched only inside the split pair: an unrelated client that
// happens to mint the same id has no overlap with the snapshot at all.
test('an unrelated client sharing a session id does not eat the merged snapshot', () => {
  const now = localNoon(2026, 9, 1);
  const applied = applyArchivedClientUsage(
    liveSummary(now, { claude: [['omp1', 40]] }),
    legacyMergedArchive(now),
    { activeClients: 'claude', now }
  );
  assert.equal(applied.periods.allTime.totalTokens, 140, 'archived 100 + unrelated live 40');
  assert.ok(applied.periods.allTime.sessions['pi:omp1'], 'the archived session must survive');
});

// A merged snapshot and a separately-archived Oh My Pi entry hold the same
// session under two ids. The archive lists `pi` first — it is the older entry —
// so unless merged entries replay last the overlap is counted twice, and
// `allTime` never expires, so the inflation would be permanent.
test('a merged Pi snapshot nets out an Oh My Pi entry archived after it', () => {
  const now = localNoon(2026, 9, 1);
  const archive = legacyMergedArchive(now);
  const ompPeriod = {
    totalTokens: 40,
    costUsd: 0,
    models: { gpt: 40 },
    modelCosts: {},
    sessions: { 'omp:omp1': session('omp', 'omp1', 40) }
  };
  archive.clients.omp = {
    client: 'omp',
    capturedAt: now.toISOString(),
    day: localDayKey(now),
    month: localDayKey(now).slice(0, 7),
    clientIdentityGeneration: 2,
    periods: { today: ompPeriod, month: ompPeriod, allTime: ompPeriod }
  };
  const applied = applyArchivedClientUsage(liveSummary(now, {}), archive, { activeClients: '', now });
  assert.equal(applied.periods.allTime.totalTokens, 100, '60 archived Pi + 40 archived Oh My Pi, once');
});

// Untracking Pi again must not overwrite the merged snapshot with a Pi-only
// one: the Oh My Pi residue exists nowhere else once the session archive is
// off, so the recapture carries forward whatever the new Pi rows do not cover.
test('recapturing Pi carries the merged snapshot residue forward', () => {
  const now = localNoon(2026, 9, 1);
  const record = {
    updatedAt: now.toISOString(),
    periods: Object.fromEntries(['today', 'month', 'allTime'].map((periodName) => [periodName, {
      clients: { pi: 60 },
      clientModels: { pi: { gpt: 60 } },
      sessions: { 'pi:pi1': session('pi', 'pi1', 60) }
    }]))
  };
  const recaptured = captureArchivedClientUsage(legacyMergedArchive(now), record, 'pi', now);
  const entry = recaptured.clients.pi;
  assert.equal(entry.clientIdentityGeneration, undefined, 'still a merged snapshot');
  assert.equal(entry.periods.allTime.totalTokens, 100, '60 recaptured Pi + 40 carried Oh My Pi');
  assert.deepEqual(Object.keys(entry.periods.allTime.sessions).sort(), ['pi:omp1', 'pi:pi1']);

  // End to end: with nothing tracked, the recaptured archive still totals 100.
  const applied = applyArchivedClientUsage(liveSummary(now, {}), recaptured, { activeClients: '', now });
  assert.equal(applied.periods.allTime.totalTokens, 100);
});

// --- applyDailyHistoryAllTimeFloor (issue #808: rotated sources) ---

function allTimeOnly(fields) {
  return { allTime: { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, clientModels: {}, ...fields } };
}

test('a partial same-model gap is not treated as proof of rotated history', () => {
  const cumulative = {
    claude: {
      totalTokens: 234000000,
      costUsd: 32.5,
      models: { 'claude-opus-4-8': 234000000 },
      modelCosts: { 'claude-opus-4-8': 32.5 }
    }
  };
  const summary = allTimeOnly({
    totalTokens: 10000000,
    costUsd: 1,
    clients: { claude: 10000000 },
    clientCosts: { claude: 1 },
    models: { 'claude-opus-4-8': 10000000 },
    clientModels: { claude: { 'claude-opus-4-8': 10000000 } },
    clientModelCosts: { claude: { 'claude-opus-4-8': 1 } }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(floored.allTime.totalTokens, 10000000);
  assert.equal(floored.allTime.clients.claude, 10000000);
  assert.equal(floored.allTime.models['claude-opus-4-8'], 10000000);
  assert.equal(Math.round(floored.allTime.costUsd * 100) / 100, 1);
  assert.strictEqual(floored, summary);
});

test('the floor never lowers or double counts a source still fully present', () => {
  const cumulative = { claude: { totalTokens: 100, costUsd: 1, models: { m: 100 }, modelCosts: { m: 1 } } };
  const present = allTimeOnly({
    totalTokens: 300,
    costUsd: 5,
    clients: { claude: 300 },
    clientCosts: { claude: 5 },
    models: { m: 300 },
    clientModels: { claude: { m: 300 } }
  });

  const once = applyDailyHistoryAllTimeFloor(present, cumulative);
  assert.equal(once.allTime.totalTokens, 300, 'live already exceeds the floor');
  const twice = applyDailyHistoryAllTimeFloor(once, cumulative);
  assert.equal(twice.allTime.totalTokens, 300, 're-applying adds nothing');
});

test('the floor is idempotent: applying to its own output adds nothing more', () => {
  const cumulative = { claude: { totalTokens: 500, costUsd: 4, models: { m: 500 }, modelCosts: { m: 4 } } };
  const summary = allTimeOnly({ totalTokens: 100, clients: { claude: 100 }, models: { current: 100 }, clientModels: { claude: { current: 100 } } });
  const first = applyDailyHistoryAllTimeFloor(summary, cumulative);
  const second = applyDailyHistoryAllTimeFloor(first, cumulative);
  assert.equal(first.allTime.totalTokens, 600);
  assert.equal(second.allTime.totalTokens, 600);
});

test('the floor only touches allTime, leaving today and month alone', () => {
  const cumulative = { claude: { totalTokens: 500, costUsd: 0, models: { m: 500 }, modelCosts: {} } };
  const summary = {
    today: { totalTokens: 5, clients: { claude: 5 } },
    month: { totalTokens: 20, clients: { claude: 20 } },
    allTime: { totalTokens: 100, costUsd: 0, clients: { claude: 100 }, clientCosts: {}, models: { current: 100 }, clientModels: { claude: { current: 100 } } }
  };
  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);
  assert.equal(floored.today.totalTokens, 5);
  assert.equal(floored.month.totalTokens, 20);
  assert.equal(floored.allTime.totalTokens, 600);
});

test('the floor is a no-op without an allTime period or without archive data', () => {
  const cumulative = { claude: { totalTokens: 500, costUsd: 0, models: { m: 500 }, modelCosts: {} } };
  const noAllTime = { today: { totalTokens: 5, clients: { claude: 5 } } };
  assert.deepEqual(applyDailyHistoryAllTimeFloor(noAllTime, cumulative), noAllTime);
  const summary = allTimeOnly({ totalTokens: 100, clients: { claude: 100 } });
  assert.equal(applyDailyHistoryAllTimeFloor(summary, {}).allTime.totalTokens, 100);
  assert.equal(applyDailyHistoryAllTimeFloor(summary, null).allTime.totalTokens, 100);
});

test('the floor restores a rotated model even when another model grew past the client total', () => {
  // opus (100) rotated away; sonnet grew from 50 to 300. The client-total live
  // (300) already exceeds the client-total floor (150), so a client-total floor
  // would restore nothing — but opus's 100 must come back. This is issue #808.
  const cumulative = {
    claude: {
      totalTokens: 150,
      costUsd: 3,
      models: { opus: 100, sonnet: 50 },
      modelCosts: { opus: 2, sonnet: 1 }
    }
  };
  const summary = allTimeOnly({
    totalTokens: 300,
    costUsd: 6,
    clients: { claude: 300 },
    clientCosts: { claude: 6 },
    models: { sonnet: 300 },
    clientModels: { claude: { sonnet: 300 } },
    clientModelCosts: { claude: { sonnet: 6 } }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(floored.allTime.models.opus, 100, 'rotated opus restored');
  assert.equal(floored.allTime.models.sonnet, 300, 'live sonnet untouched');
  assert.equal(floored.allTime.clients.claude, 400, 'client total = 300 live + 100 restored');
  assert.equal(floored.allTime.totalTokens, 400);
  // sonnet's cost floor (1) is under live (6) so only opus's cost (2) returns.
  assert.equal(Math.round(floored.allTime.costUsd * 100) / 100, 8);
});

test('the floor restores a model that carried cost but no tokens', () => {
  const cumulative = { claude: { totalTokens: 0, costUsd: 5, models: {}, modelCosts: { m: 5 } } };
  const summary = allTimeOnly({
    totalTokens: 100,
    costUsd: 0,
    clients: { claude: 100 },
    clientCosts: {},
    models: { surviving: 100 },
    clientModels: { claude: { surviving: 100 } },
    clientModelCosts: { claude: {} }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(Math.round(floored.allTime.costUsd * 100) / 100, 5, 'cost-only shortfall restored');
  assert.equal(floored.allTime.totalTokens, 100, 'tokens unchanged');
});

// --- merged-era Pi / Oh My Pi split (issue #808, author repro) ---

const {
  allTimeCumulativeFromArchive,
  captureDailyHistoryArchive,
  captureLiveDailyHistory,
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive
} = require('../../src/shared/dailyHistoryArchive');
const { normalizePeriod } = require('../../src/shared/usage');
const { parseGraphResult } = require('../../src/shared/history');

test('the floor does not recount a merged-era Pi row against split live usage', () => {
  // A day captured before the split: both products sit under `pi`, no generation
  // marker. The reduction must mark it merged-era.
  const archive = { version: 1, days: {
    '2026-08-01': { date: '2026-08-01', activeTimeMs: 0,
      observations: [{ client: 'pi', modelId: 'gpt', tokens: 100, cost: 6, messages: 2 }] }
  } };
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.equal(cumulative.pi.legacy.totalTokens, 100);
  assert.equal(cumulative.pi.totalTokens, 0);

  // Live allTime reports the two clients apart: pi 60 + omp 40 = the same 100 the
  // merged row already holds. Comparing against pi alone would read the 40 as a
  // shortfall and raise the total to 140.
  const summary = allTimeOnly({
    totalTokens: 100, costUsd: 6,
    clients: { pi: 60, omp: 40 },
    clientCosts: { pi: 4, omp: 2 },
    models: { gpt: 100 },
    clientModels: { pi: { gpt: 60 }, omp: { gpt: 40 } },
    clientModelCosts: { pi: { gpt: 4 }, omp: { gpt: 2 } }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(floored.allTime.totalTokens, 100, 'the merged Pi row must not add OMP again');
  assert.equal(floored.allTime.clients.pi, 60);
  assert.equal(floored.allTime.clients.omp, 40);
});

test('a partial legacy-family gap does not override current observations', () => {
  const archive = { version: 1, days: {
    '2026-08-01': { date: '2026-08-01', activeTimeMs: 0,
      observations: [{ client: 'pi', modelId: 'gpt', tokens: 100, cost: 6, messages: 2 }] }
  } };
  const cumulative = allTimeCumulativeFromArchive(archive);

  // The same aggregate could also mean an accepted lower correction.
  const summary = allTimeOnly({
    totalTokens: 15, costUsd: 1,
    clients: { pi: 10, omp: 5 },
    clientCosts: { pi: 1 },
    models: { gpt: 15 },
    clientModels: { pi: { gpt: 10 }, omp: { gpt: 5 } },
    clientModelCosts: { pi: { gpt: 1 } }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(floored.allTime.totalTokens, 15, 'a partial family gap stays unresolved');
  assert.equal(floored.allTime.clients.pi, 10, 'live pi stays authoritative');
  assert.equal(floored.allTime.clients.omp, 5, 'live omp untouched');
});

test('a post-split day keeps the two clients apart in the floor', () => {
  const archive = { version: 1, days: {
    '2026-09-01': { date: '2026-09-01', activeTimeMs: 0, clientIdentityGeneration: 2,
      observations: [
        { client: 'pi', modelId: 'gpt', tokens: 10, cost: 1, messages: 1 },
        { client: 'omp', modelId: 'gpt', tokens: 20, cost: 2, messages: 1 }
      ] }
  } };
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.equal(cumulative.pi.mergedEra, undefined, 'a generation-marked day is not merged-era');
  assert.equal(cumulative.omp.totalTokens, 20);

  // Live lost the whole omp source; only omp should be restored, never pi.
  const summary = allTimeOnly({
    totalTokens: 10, costUsd: 1,
    clients: { pi: 10 },
    clientCosts: { pi: 1 },
    models: { gpt: 10 },
    clientModels: { pi: { gpt: 10 } },
    clientModelCosts: { pi: { gpt: 1 } }
  });

  const floored = applyDailyHistoryAllTimeFloor(summary, cumulative);

  assert.equal(floored.allTime.clients.pi, 10, 'pi stays at its live value');
  assert.equal(floored.allTime.clients.omp, 20, 'omp restored on its own');
  assert.equal(floored.allTime.totalTokens, 30);
});

test('the floor restores a cache/output split when the archive kept one', () => {
  const archive = { version: 1, days: { '2026-06-01': { date: '2026-06-01', observations: [
    { client: 'claude-code', modelId: 'opus', tokens: 1000, cost: 5, messages: 1,
      tokenComponentsAvailable: true, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 100 }
  ] } } };
  const cumulative = allTimeCumulativeFromArchive(archive);

  const floored = applyDailyHistoryAllTimeFloor(allTimeOnly({ totalTokens: 0 }), cumulative);

  assert.equal(floored.allTime.totalTokens, 1000);
  assert.equal(floored.allTime.cacheReadTokens, 600, 'cache read lands in its own bucket');
  assert.equal(floored.allTime.cacheWriteTokens, 100);
  assert.equal(floored.allTime.outputTokens, 100);
  assert.equal(floored.allTime.modelCacheReads.opus, 600, 'model-level split restored too');
  // A complete archived split leaves plain input implicit, exactly as
  // normalizePeriod does for a live period, so nothing is called unclassified.
  assert.equal(floored.allTime.unclassifiedTokens, 0);
  assert.equal(floored.allTime.capabilities.tokenComponents, true);
});

test('the floor restores history that only a live day retained', () => {
  const archive = { version: 1, days: {}, liveDays: { '2026-07-01': { date: '2026-07-01', observations: [
    { client: 'codex', modelId: 'gpt', tokens: 50, cost: 1, messages: 1 }
  ] } } };
  const cumulative = allTimeCumulativeFromArchive(archive);

  const floored = applyDailyHistoryAllTimeFloor(allTimeOnly({ totalTokens: 0 }), cumulative);

  assert.equal(floored.allTime.totalTokens, 50);
  assert.equal(floored.allTime.clients.codex, 50);
});

function capturedGraph(date, rows) {
  return { contributions: [{ date, clients: rows.map(([client, modelId, tokens, cost, cacheRead = 0]) => ({
    client, modelId, tokens: { input: tokens - cacheRead, cacheRead, output: 0, cacheWrite: 0 }, cost, messages: 1
  })) }] };
}

function capturedPeriod(rows) {
  const period = allTimeOnly({ modelCosts: {}, clientModelCosts: {} }).allTime;
  for (const [client, model, tokens, cost] of rows) {
    period.totalTokens += tokens;
    period.costUsd += cost;
    period.clients[client] = (period.clients[client] || 0) + tokens;
    period.clientCosts[client] = (period.clientCosts[client] || 0) + cost;
    period.models[model] = (period.models[model] || 0) + tokens;
    period.modelCosts[model] = (period.modelCosts[model] || 0) + cost;
    (period.clientModels[client] ||= {})[model] = (period.clientModels[client][model] || 0) + tokens;
    (period.clientModelCosts[client] ||= {})[model] = (period.clientModelCosts[client][model] || 0) + cost;
  }
  return period;
}

for (const cost of [1.2, 0]) {
  test(`a larger graph repriced to ${cost} does not resurrect an older live price, including after source removal`, () => {
    const date = '2026-09-01';
    let archive = captureLiveDailyHistory({}, capturedPeriod([['claude', 'opus', 100, 10]]), {
      todayKey: date, pricingRevision: 'old'
    });
    archive = captureDailyHistoryArchive(archive, capturedGraph(date, [['claude', 'opus', 120, cost]]), {
      todayKey: date, pricingRevision: 'new', reprice: true
    });
    const before = JSON.stringify(archive);
    const cumulative = allTimeCumulativeFromArchive(archive);
    assert.equal(cumulative.claude.costUsd, cost);
    const present = { allTime: capturedPeriod([['claude', 'opus', 120, cost]]) };
    assert.strictEqual(applyDailyHistoryAllTimeFloor(present, cumulative), present);
    const removed = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative).allTime;
    assert.equal(removed.totalTokens, 120);
    assert.equal(removed.costUsd, cost);
    assert.equal(JSON.stringify(archive), before, 'reduction must not mutate the archive');
  });
}

test('repricing a larger source keeps archive-only recorded prices after source removal', () => {
  let archive = captureDailyHistoryArchive({}, capturedGraph('2026-08-31', [['claude', 'deleted', 50, 5]]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'opus', 100, 10]]), {
    todayKey: '2026-09-01', pricingRevision: 'old'
  });
  archive = captureDailyHistoryArchive(archive, capturedGraph('2026-09-01', [['claude', 'opus', 120, 0]]), {
    todayKey: '2026-09-01', pricingRevision: 'new', reprice: true
  });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 170);
  assert.equal(restored.costUsd, 5);
  assert.equal(restored.clientModelCosts.claude.deleted, 5);
});

test('the floor selects the same daily snapshot as history instead of mixing per-model maxima', () => {
  const date = '2026-09-01';
  let archive = captureLiveDailyHistory({}, capturedPeriod([
    ['claude', 'a', 90, 9], ['claude', 'b', 20, 2]
  ]), { todayKey: date });
  archive = captureDailyHistoryArchive(archive, capturedGraph(date, [
    ['claude', 'a', 100, 1], ['claude', 'b', 10, 0.1]
  ]), { todayKey: date });
  const selected = graphFromDailyHistoryArchive([], archive).contributions[0].clients;
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.equal(cumulative.claude.totalTokens, 110);
  assert.deepEqual({ ...cumulative.claude.models }, { a: 100, b: 10 });
  assert.equal(cumulative.claude.costUsd, selected.reduce((sum, row) => sum + row.cost, 0));
  const removed = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative).allTime;
  assert.equal(removed.totalTokens, 110);
  assert.deepEqual(removed.clientModels.claude, { a: 100, b: 10 });
  assert.equal(removed.costUsd, 1.1);
});

test('a legacy committed day reconciles with same-day split live identities after source removal', () => {
  const date = '2026-08-01';
  const legacy = { days: { [date]: { date, observations: [
    { client: 'pi', modelId: 'gpt', tokens: 100, cost: 1 }
  ] } } };
  const archive = captureLiveDailyHistory(legacy, capturedPeriod([
    ['pi', 'gpt', 60, 0.6], ['omp', 'gpt', 40, 0.4]
  ]), { todayKey: date });
  const cumulative = allTimeCumulativeFromArchive(archive);
  const removed = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative);
  assert.equal(removed.allTime.totalTokens, 100);
  assert.equal(removed.allTime.costUsd, 1);
  assert.equal(removed.allTime.clients.pi, 100);
  assert.equal(removed.allTime.clients.omp, undefined);
  assert.strictEqual(applyDailyHistoryAllTimeFloor(removed, cumulative), removed);
});

test('a later OMP increase cannot cover missing post-split Pi usage', () => {
  let archive = { days: { '2026-08-01': { observations: [
    { client: 'pi', modelId: 'gpt', tokens: 100, cost: 1 }
  ] } } };
  archive = captureDailyHistoryArchive(archive, capturedGraph('2026-09-01', [['pi', 'gpt', 50, 0.5]]));
  const cumulative = allTimeCumulativeFromArchive(archive);
  const surviving = { allTime: capturedPeriod([['omp', 'gpt', 200, 2]]) };
  const restored = applyDailyHistoryAllTimeFloor(surviving, cumulative);
  assert.equal(restored.allTime.clients.pi, 50);
  assert.equal(restored.allTime.clients.omp, 200);
  assert.equal(restored.allTime.totalTokens, 250);
  assert.equal(restored.allTime.costUsd, 2.5);
  assert.strictEqual(applyDailyHistoryAllTimeFloor(restored, cumulative), restored);
});

test('legacy and post-split floors do not consume the same live usage twice', () => {
  let archive = { days: { '2026-08-01': { observations: [
    { client: 'pi', modelId: 'gpt', tokens: 100, cost: 1 }
  ] } } };
  archive = captureDailyHistoryArchive(archive, capturedGraph('2026-09-01', [
    ['pi', 'gpt', 50, 0.5], ['omp', 'gpt', 30, 0.3]
  ]));
  const cumulative = allTimeCumulativeFromArchive(archive);
  for (const rows of [[], [['pi', 'gpt', 50, 0.5], ['omp', 'gpt', 30, 0.3]], [
    ['pi', 'gpt', 110, 1.1], ['omp', 'gpt', 70, 0.7]
  ]]) {
    const summary = { allTime: capturedPeriod(rows) };
    const restored = applyDailyHistoryAllTimeFloor(summary, cumulative);
    assert.equal(restored.allTime.totalTokens, rows.length ? summary.allTime.totalTokens : 180);
    assert.ok(Math.abs(restored.allTime.costUsd - (rows.length ? summary.allTime.costUsd : 1.8)) < 1e-12);
    assert.strictEqual(applyDailyHistoryAllTimeFloor(restored, cumulative), restored);
  }
});

test('an ambiguous partial restore leaves the current tokens and measured components unchanged', () => {
  const archive = captureDailyHistoryArchive({}, capturedGraph('2026-09-01', [['claude', 'opus', 1000, 5, 600]]));
  const surviving = capturedPeriod([['claude', 'opus', 400, 2]]);
  Object.assign(surviving, {
    cacheReadTokens: 400, clientCacheReads: { claude: 400 }, modelCacheReads: { opus: 400 },
    capabilities: { tokenComponents: true }
  });
  const restored = applyDailyHistoryAllTimeFloor({ allTime: surviving }, allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 400);
  assert.equal(restored.cacheReadTokens, 400);
  assert.equal(restored.clientCacheReads.claude, 400);
  assert.equal(restored.modelCacheReads.opus, 400);
  assert.equal(restored.unclassifiedTokens || 0, 0);
  assert.equal(restored.modelUnclassifiedTokens?.opus || 0, 0);
  assert.equal(restored.capabilities.tokenComponents, true);
});

test('a larger component-less live reading retains measured counts without scaling them up', () => {
  const date = '2026-09-01';
  let archive = captureDailyHistoryArchive({}, capturedGraph(date, [['claude', 'opus', 1000, 5, 600]]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'opus', 1200, 6]]), { todayKey: date });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 1200);
  assert.equal(restored.cacheReadTokens, 600);
  assert.equal(restored.unclassifiedTokens, 200);
  assert.equal(restored.capabilities.tokenComponents, false);
});

test('an exact plain-input restore does not lose component provenance', () => {
  const archive = captureDailyHistoryArchive({}, capturedGraph('2026-09-01', [['claude', 'opus', 100, 1]]));
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 100);
  assert.equal(restored.unclassifiedTokens, 0);
  assert.equal(restored.capabilities.tokenComponents, true);
});

test('restoring a detailed model and an unknown model does not hide the unknown share', () => {
  let archive = captureDailyHistoryArchive({}, capturedGraph('2026-09-01', [['claude', 'opus', 100, 1, 60]]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'sonnet', 50, 0.5]]), { todayKey: '2026-09-02' });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 150);
  assert.equal(restored.cacheReadTokens, 60);
  assert.equal(restored.unclassifiedTokens, 50);
  assert.equal(restored.modelUnclassifiedTokens.sonnet, 50);
  assert.equal(restored.capabilities.tokenComponents, false);
  assert.equal(normalizePeriod(restored).unclassifiedTokens, 50);
});

test('mixed plain-input and unknown models retain exact zero-counter provenance', () => {
  let archive = captureDailyHistoryArchive({}, capturedGraph('2026-09-01', [['claude', 'a', 100, 1]]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'b', 50, 0.5]]), { todayKey: '2026-09-02' });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 150);
  assert.equal(restored.unclassifiedTokens, 50);
  assert.deepEqual(restored.modelUnclassifiedTokens, { b: 50 });
  assert.equal(normalizePeriod(restored).unclassifiedTokens, 50);
});

function withNativeComponents(period, cacheReadTokens, outputTokens = 0, unclassifiedTokens = 0) {
  const client = Object.keys(period.clients)[0];
  const model = Object.keys(period.models)[0];
  return {
    ...period, cacheReadTokens, outputTokens, unclassifiedTokens,
    clientCacheReads: { [client]: cacheReadTokens }, modelCacheReads: { [model]: cacheReadTokens },
    clientOutputs: { [client]: outputTokens }, modelOutputs: { [model]: outputTokens },
    clientUnclassifiedTokens: { [client]: unclassifiedTokens }, modelUnclassifiedTokens: { [model]: unclassifiedTokens },
    capabilities: { tokenComponents: unclassifiedTokens === 0 }
  };
}

for (const tokens of [100, 120]) {
  test(`a selected native live summary keeps measured components for ${tokens} tokens after source removal`, () => {
    const date = '2026-09-01';
    const cacheReads = tokens === 100 ? 60 : 80;
    let archive = captureDailyHistoryArchive({}, capturedGraph(date, [['claude', 'opus', 100, 1, 60]]));
    const live = withNativeComponents(capturedPeriod([['claude', 'opus', tokens, 2]]), cacheReads, 10);
    archive = captureLiveDailyHistory(archive, live, { todayKey: date });
    const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
    assert.equal(restored.totalTokens, tokens);
    assert.equal(restored.cacheReadTokens, cacheReads);
    assert.equal(restored.outputTokens, 10);
    assert.equal(restored.unclassifiedTokens, 0);
    assert.equal(restored.capabilities.tokenComponents, true);
    assert.equal(graphFromDailyHistoryArchive([], archive).contributions[0].tokenComponentSummary.cacheReadTokens, cacheReads);
  });
}

test('a partial native summary preserves explicit unclassified counts during full restoration', () => {
  const live = withNativeComponents(capturedPeriod([['claude', 'opus', 100, 1]]), 60, 10, 20);
  const archive = captureLiveDailyHistory({}, live, { todayKey: '2026-09-01' });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.cacheReadTokens, 60);
  assert.equal(restored.outputTokens, 10);
  assert.equal(restored.unclassifiedTokens, 20);
  assert.equal(restored.modelUnclassifiedTokens.opus, 20);
  assert.equal(restored.capabilities.tokenComponents, false);
});

test('ambiguous client-by-model summary components are never estimated', () => {
  const period = capturedPeriod([
    ['claude', 'a', 100, 1], ['claude', 'b', 100, 1], ['codex', 'a', 100, 1], ['codex', 'b', 100, 1]
  ]);
  Object.assign(period, {
    cacheReadTokens: 240, clientCacheReads: { claude: 120, codex: 120 }, modelCacheReads: { a: 120, b: 120 },
    capabilities: { tokenComponents: true }
  });
  const archive = captureLiveDailyHistory({}, period, { todayKey: '2026-09-01' });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 400);
  assert.equal(restored.cacheReadTokens, 0);
  assert.equal(restored.unclassifiedTokens, 400);
});

test('a selected modern live snapshot does not inherit legacy identity from an unrelated committed row', () => {
  const date = '2026-08-01';
  let archive = { days: { [date]: { observations: [{ client: 'claude', modelId: 'opus', tokens: 100, cost: 1 }] } } };
  archive = captureLiveDailyHistory(archive, capturedPeriod([
    ['claude', 'opus', 100, 1], ['pi', 'gpt', 50, 0.5], ['omp', 'gpt', 50, 0.5]
  ]), { todayKey: date });
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.equal(cumulative.pi.legacy, undefined);
  assert.equal(cumulative.pi.totalTokens, 50);
  assert.equal(cumulative.omp.totalTokens, 50);
  const surviving = { allTime: capturedPeriod([['claude', 'opus', 100, 1], ['omp', 'gpt', 100, 1]]) };
  const restored = applyDailyHistoryAllTimeFloor(surviving, cumulative).allTime;
  assert.equal(restored.totalTokens, 250);
  assert.equal(restored.clients.pi, 50);
});

test('a larger split live snapshot replaces the legacy family instead of adding its merged row', () => {
  const date = '2026-08-01';
  let archive = { days: { [date]: { observations: [{ client: 'pi', modelId: 'gpt', tokens: 100, cost: 1 }] } } };
  archive = captureLiveDailyHistory(archive, capturedPeriod([['omp', 'gpt', 120, 1.2]]), { todayKey: date });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 120);
  assert.equal(restored.clients.pi, undefined);
  assert.equal(restored.clients.omp, 120);
  assert.equal(restored.costUsd, 1.2);
});

test('larger live snapshots retain disjoint archive-only records without taking overlapping model maxima', () => {
  const date = '2026-09-01';
  let archive = captureDailyHistoryArchive({}, capturedGraph(date, [
    ['claude', 'a', 100, 1, 60], ['claude', 'b', 100, 1]
  ]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'b', 300, 3]]), { todayKey: date });
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.deepEqual({ ...cumulative.claude.models }, { b: 300, a: 100 });
  const surviving = { allTime: capturedPeriod([['claude', 'b', 300, 3]]) };
  const restored = applyDailyHistoryAllTimeFloor(surviving, cumulative).allTime;
  assert.equal(restored.totalTokens, 400);
  assert.equal(restored.costUsd, 4);
  assert.equal(restored.cacheReadTokens, 60);
  const history = graphFromDailyHistoryArchive([], archive).contributions[0].clients;
  assert.equal(history.reduce((sum, row) => sum + row.tokens.input + row.tokens.cacheRead, 0), 300);
  assert.equal(history.reduce((sum, row) => sum + row.cost, 0), 3);
});

for (const [archivedClient, archivedModel, liveClient, liveModel] of [
  ['claude', 'opus', 'claude', 'unknown'],
  ['claude', 'opus', 'unknown', 'unknown'],
  ['claude', 'unknown', 'claude', 'opus'],
  ['unknown', 'unknown', 'claude', 'opus'],
  ['pi', 'gpt', 'omp', 'unknown']
]) {
  test(`unidentified snapshot overlap ${archivedClient}/${archivedModel} to ${liveClient}/${liveModel} does not double count`, () => {
    const date = '2026-09-01';
    const previous = { days: { [date]: { observations: [
      { client: archivedClient, modelId: archivedModel, tokens: 100, cost: 1 }
    ] } } };
    const live = capturedPeriod([[liveClient, liveModel, 120, 1.2]]);
    const archive = captureLiveDailyHistory(previous, live, { todayKey: date });
    const before = JSON.stringify(archive);
    const [history] = parseGraphResult(graphFromDailyHistoryArchive([], archive)).contributions;
    assert.equal(history.tokens, 120);
    assert.equal(history.cost, 1.2);
    const cumulative = allTimeCumulativeFromArchive(archive);
    const present = { allTime: normalizePeriod(live) };
    assert.strictEqual(applyDailyHistoryAllTimeFloor(present, cumulative), present);
    const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative).allTime;
    assert.equal(restored.totalTokens, 120);
    assert.equal(restored.costUsd, 1.2);
    assert.strictEqual(applyDailyHistoryAllTimeFloor({ allTime: restored }, cumulative).allTime, restored);
    assert.equal(JSON.stringify(archive), before);
  });
}

test('an unidentified model in a different client partition is still independently retained', () => {
  const date = '2026-09-01';
  let archive = captureDailyHistoryArchive({}, capturedGraph(date, [['codex', 'unknown', 100, 1]]));
  archive = captureLiveDailyHistory(archive, capturedPeriod([['claude', 'unknown', 120, 1.2]]), { todayKey: date });
  const [history] = parseGraphResult(graphFromDailyHistoryArchive([], archive)).contributions;
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(history.tokens, 120);
  assert.equal(history.cost, 1.2);
  assert.equal(restored.totalTokens, 220);
  assert.equal(restored.clients.codex, 100);
  assert.equal(restored.clients.claude, 120);
});

test('preserving archive-only records updates selected native component summaries and keeps legacy provenance', () => {
  const date = '2026-08-01';
  let archive = { days: { [date]: { observations: [
    { client: 'pi', modelId: 'gpt', tokens: 100, cost: 1, tokenComponentsAvailable: true, cacheReadTokens: 60 }
  ] } } };
  const live = withNativeComponents(capturedPeriod([['claude', 'opus', 200, 2]]), 80);
  archive = captureLiveDailyHistory(archive, live, { todayKey: date });
  const cumulative = allTimeCumulativeFromArchive(archive);
  assert.equal(cumulative.pi.legacy.totalTokens, 100);
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative).allTime;
  assert.equal(restored.totalTokens, 300);
  assert.equal(restored.cacheReadTokens, 140);
  assert.equal(restored.unclassifiedTokens, 0);
  const selected = graphFromDailyHistoryArchive([], archive).contributions[0];
  assert.equal(selected.tokenComponentSummary.cacheReadTokens, 80);
  assert.equal(selected.tokenComponentSummary.tokenComponentsAvailable, true);
});

test('summary overlay preserves exact zero-unclassified axes beside archive-only unknown usage', () => {
  const date = '2026-08-01';
  let archive = { days: { [date]: { observations: [{ client: 'pi', modelId: 'gpt', tokens: 100, cost: 1 }] } } };
  const live = withNativeComponents(capturedPeriod([['claude', 'opus', 200, 2]]), 80);
  archive = captureLiveDailyHistory(archive, live, { todayKey: date });
  for (const value of [archive, normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(archive)))]) {
    const graph = graphFromDailyHistoryArchive([], value);
    const [day] = parseGraphResult(graph).contributions;
    assert.equal(day.unclassifiedTokens, 0);
    assert.equal(day.perClient.claude.unclassifiedTokens, 0);
    assert.equal(day.perClient.pi, undefined);
    assert.equal(day.perModel.opus.unclassifiedTokens, 0);
    const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(value)).allTime;
    assert.equal(restored.unclassifiedTokens, 100);
    assert.equal(restored.cacheReadTokens, 80);
  }
});

test('inexact native summaries preserve exact plain-input model axes through repeated normalization', () => {
  const date = '2026-09-01';
  const period = capturedPeriod([['claude', 'a', 100, 1], ['claude', 'b', 50, 0.5]]);
  Object.assign(period, {
    cacheReadTokens: 10, clientCacheReads: { claude: 10 }, modelCacheReads: { b: 10 },
    unclassifiedTokens: 40, clientUnclassifiedTokens: { claude: 40 }, modelUnclassifiedTokens: { a: 0, b: 40 },
    capabilities: { tokenComponents: false }
  });
  let archive = captureLiveDailyHistory({}, period, { todayKey: date });
  archive = normalizeDailyHistoryArchive(normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(archive))));
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  assert.equal(restored.totalTokens, 150);
  assert.equal(restored.cacheReadTokens, 10);
  assert.equal(restored.unclassifiedTokens, 40);
  assert.deepEqual(restored.modelUnclassifiedTokens, { b: 40 });
  assert.equal(parseGraphResult(graphFromDailyHistoryArchive([], archive)).contributions[0].perModel.a.unclassifiedTokens, 0);
});

test('adding archive-only tuples preserves native component attribution measured before the merge', () => {
  const date = '2026-09-01';
  let archive = captureDailyHistoryArchive({}, capturedGraph(date, [['codex', 'b', 100, 1, 60]]));
  const live = capturedPeriod([['codex', 'a', 100, 1], ['opencode', 'a', 200, 2]]);
  Object.assign(live, {
    cacheReadTokens: 110, clientCacheReads: { codex: 30, opencode: 80 }, modelCacheReads: { a: 110 },
    capabilities: { tokenComponents: true }
  });
  archive = captureLiveDailyHistory(archive, live, { todayKey: date });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  const [history] = parseGraphResult(graphFromDailyHistoryArchive([], archive)).contributions;
  assert.equal(restored.totalTokens, 400);
  assert.equal(restored.cacheReadTokens, 170);
  assert.equal(restored.unclassifiedTokens, 0);
  assert.equal(restored.modelCacheReads.a, 110);
  assert.equal(restored.modelCacheReads.b, 60);
  assert.equal(history.cacheReadTokens, 110);
  assert.equal(history.unclassifiedTokens, 0);
});

test('cost-only observations never inherit another row\'s native token components', () => {
  const date = '2026-09-01';
  let archive = captureDailyHistoryArchive({}, capturedGraph(date, [['claude', 'deleted', 10, 0.1, 5]]));
  const live = withNativeComponents(capturedPeriod([['claude', 'opus', 100, 2]]), 60);
  live.modelCosts.opus = 1;
  live.clientModelCosts.claude.opus = 1;
  archive = captureLiveDailyHistory(archive, live, { todayKey: date });
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), allTimeCumulativeFromArchive(archive)).allTime;
  const [history] = parseGraphResult(graphFromDailyHistoryArchive([], archive)).contributions;
  assert.equal(restored.totalTokens, 110);
  assert.equal(restored.cacheReadTokens, 65);
  assert.equal(restored.costUsd, 2.1);
  assert.equal(history.tokens, 100);
  assert.equal(history.cacheReadTokens, 60);
  assert.equal(history.perModel.unknown.tokens, 0);
  assert.equal(history.cost, 2);
});

test('fractional legacy costs are idempotent without losing real tiny cost-only restores', () => {
  let archive = { days: { '2026-08-01': { observations: [
    { client: 'pi', modelId: 'gpt', tokens: 10000, cost: 0.1 }
  ] } } };
  archive = captureDailyHistoryArchive(archive, capturedGraph('2026-09-01', [['pi', 'gpt', 90000, 0.9]]));
  const cumulative = allTimeCumulativeFromArchive(archive);
  const restored = applyDailyHistoryAllTimeFloor(allTimeOnly({}), cumulative);
  assert.equal(restored.allTime.totalTokens, 100000);
  assert.equal(restored.allTime.costUsd, 1);
  assert.strictEqual(applyDailyHistoryAllTimeFloor(restored, cumulative), restored);
  const tiny = { codex: { models: {}, modelCosts: { gpt: 1e-18 } } };
  assert.equal(applyDailyHistoryAllTimeFloor(allTimeOnly({}), tiny).allTime.costUsd, 1e-18);
});
