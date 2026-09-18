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
  const sessions = {};
  for (const [client, entries] of Object.entries(sessionsByClient)) {
    let tokens = 0;
    for (const [id, value] of entries) {
      sessions[`${client}:${id}`] = session(client, id, value);
      tokens += value;
    }
    if (tokens > 0) clients[client] = tokens;
  }
  const totalTokens = Object.values(clients).reduce((sum, value) => sum + value, 0);
  const period = { totalTokens, clients, sessions };
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
