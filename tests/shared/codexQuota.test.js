'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_API_PRICING_SNAPSHOT,
  FULL_CYCLE_ESTIMATE_METHOD,
  estimateRateLimitCapacities,
  lookupPrice
} = require('../../src/shared/quotaEngine');
const {
  MAX_ARCHIVE_ROWS,
  MAX_ARCHIVE_ROWS_PER_WINDOW,
  attachCodexQuotaEstimates,
  deriveCodexExclusiveUsage,
  emptyCodexQuotaArchive,
  normalizeCodexQuotaArchive,
  observeCodexQuota,
  projectCodexQuotaForProvider,
  scopeProfileId,
  trimCodexQuotaArchiveRows,
  wslUsageObscuresLocalCodex,
  WSL_MERGED_REASON
} = require('../../src/shared/codexQuota');
const { applyPeriodDelta, extractUsageFromTokscale } = require('../../src/shared/usage');

const SESSION_RESET = '2026-09-05T12:00:00.000Z';
const WEEKLY_RESET = '2026-09-08T00:00:00.000Z';
const NEXT_SESSION_RESET = '2026-09-05T17:00:00.000Z';
const ACCOUNT_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ACCOUNT_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const ACCOUNT_D = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const SECRETS = [
  'user@example.com',
  'session=secret-cookie',
  'sk-live-secret',
  'C:\\Users\\me\\.codex\\auth.json',
  'hello from chat body',
  ACCOUNT_A
];

function windowOf(kind, percent, extra = {}) {
  return {
    kind,
    limitId: 'codex',
    usedPercent: percent,
    remainingPercent: 100 - percent,
    resetsAt: kind === 'session' ? SESSION_RESET : WEEKLY_RESET,
    windowMinutes: kind === 'session' ? 300 : 10080,
    additional: false,
    ...extra
  };
}

function deviceAt({
  at,
  sessionPercent,
  weeklyPercent,
  tokens,
  model = 'gpt-6-astra',
  exclusive = true,
  accountKey = ACCOUNT_A,
  email = 'user@example.com',
  sourceDetail = 'rpc',
  sourceDeviceId = 'local-device',
  extraWindows = [],
  cacheRead = 0,
  cacheWrite = 0,
  output = 0,
  extraClients = {},
  wslStatus = null,
  capabilities = { tokenComponents: true }
}) {
  const models = { [model]: tokens, ...extraClients.models };
  return {
    deviceId: 'local-device',
    updatedAt: at,
    ...(wslStatus ? { wslStatus } : {}),
    allTime: {
      totalTokens: tokens + (extraClients.totalExtra || 0),
      clients: { codex: tokens, ...extraClients.clients },
      models: exclusive ? models : { ...models, [model]: tokens + 50 },
      clientModels: { codex: { [model]: tokens } },
      modelCacheReads: cacheRead ? { [model]: cacheRead } : {},
      modelCacheWrites: cacheWrite ? { [model]: cacheWrite } : {},
      modelOutputs: output ? { [model]: output } : {},
      ...(capabilities ? { capabilities } : {})
    },
    limits: {
      updatedAt: at,
      providers: [{
        provider: 'codex',
        status: 'ok',
        accountKey,
        accountEmail: email,
        sourceDetail,
        sourceDeviceId,
        windows: [
          windowOf('session', sessionPercent),
          windowOf('weekly', weeklyPercent),
          windowOf('billing', 10, { label: 'Monthly', windowMinutes: 43200, resetsAt: '2026-10-01T00:00:00.000Z' }),
          ...extraWindows
        ]
      }]
    }
  };
}

function observeMany(rows, snapshot) {
  let archive = emptyCodexQuotaArchive();
  for (const row of rows) {
    archive = observeCodexQuota(archive, { device: row, observedAt: row.updatedAt, snapshot });
  }
  return archive;
}

function summary(archive, accountKey, kind) {
  return projectCodexQuotaForProvider(archive, { accountKey }).byKind[kind];
}

test('scope ids are truncated hashes and never echo an email', () => {
  const hashed = scopeProfileId(ACCOUNT_A);
  assert.equal(hashed, 'sha256:aaaaaaaaaaaaaaaa');
  assert.equal(hashed.includes(ACCOUNT_A.slice(7)), false);
  const fromEmail = scopeProfileId('user@example.com');
  assert.match(fromEmail, /^sha256:[a-f0-9]{16}$/);
  assert.equal(fromEmail.includes('user@example.com'), false);
  assert.equal(scopeProfileId(''), 'codex-local');
});

test('exclusive Codex models recover input from the row-sum identity', () => {
  const usage = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelCacheWrites: { 'gpt-6-astra': 50 },
    modelOutputs: { 'gpt-6-astra': 200 },
    capabilities: { tokenComponents: true }
  });
  assert.deepEqual(usage.tokenComponents['gpt-6-astra'], {
    input: 650,
    output: 200,
    cacheRead: 100,
    cacheWrite: 50,
    complete: true
  });
});

test('explicit modelUnclassifiedTokens never leak into input', () => {
  // 1000 total, 100 cacheRead, 100 output and an explicit 600 unclassified:
  // the residual 200 is NOT proven input, so the whole row stays unpriced
  // instead of pricing 800 as input.
  const explicit = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelOutputs: { 'gpt-6-astra': 100 },
    modelUnclassifiedTokens: { 'gpt-6-astra': 600 },
    capabilities: { tokenComponents: true }
  });
  assert.deepEqual(explicit.tokenComponents['gpt-6-astra'], {
    unclassified: 1000,
    complete: false
  });

  // An explicit unclassified that exactly completes the decomposition keeps
  // the priced cache/output portion and prices nothing unknown.
  const exact = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 400 },
    modelOutputs: { 'gpt-6-astra': 100 },
    modelUnclassifiedTokens: { 'gpt-6-astra': 500 },
    capabilities: { tokenComponents: true }
  });
  assert.deepEqual(exact.tokenComponents['gpt-6-astra'], {
    input: 0,
    output: 100,
    cacheRead: 400,
    cacheWrite: 0,
    unclassified: 500,
    complete: true
  });
});

test('component sums beyond the trusted model total fail closed for the whole row', () => {
  const usage = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 600 },
    modelCacheWrites: { 'gpt-6-astra': 600 },
    modelOutputs: { 'gpt-6-astra': 100 },
    capabilities: { tokenComponents: true }
  });
  assert.deepEqual(usage.tokenComponents['gpt-6-astra'], { unclassified: 1000, complete: false });
});

test('missing tokenComponents capability keeps provenance-incomplete rows unpriced', () => {
  const withoutCapability = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelOutputs: { 'gpt-6-astra': 100 }
  });
  assert.deepEqual(withoutCapability.tokenComponents['gpt-6-astra'], {
    unclassified: 1000,
    complete: false
  });
  const capabilityFalse = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelOutputs: { 'gpt-6-astra': 100 },
    capabilities: { tokenComponents: false }
  });
  assert.deepEqual(capabilityFalse.tokenComponents['gpt-6-astra'], {
    unclassified: 1000,
    complete: false
  });
});

test('shared models stay unclassified instead of borrowing another client\'s cache map', () => {
  const usage = deriveCodexExclusiveUsage({
    clients: { codex: 1000, claude: 50 },
    models: { 'gpt-6-astra': 1050 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelOutputs: { 'gpt-6-astra': 200 }
  });
  assert.equal(usage.tokenComponents['gpt-6-astra'].unclassified, 1000);
  assert.equal(usage.tokenComponents['gpt-6-astra'].complete, false);
});

test('session and weekly stay isolated while both see the same local increment', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 20, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 30, tokens: 2_000_000 })
  ]);
  const session = summary(archive, ACCOUNT_A, 'session');
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(session.observedTokens, 1_000_000);
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.equal(session.pricedUsd, 10);
  assert.equal(weekly.pricedUsd, 10);
  assert.notEqual(session.confidence, 'unavailable');
  const sessionSamples = archive.accountingSamples.filter((row) => row.kind === 'session');
  const weeklySamples = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.equal(sessionSamples.every((row) => row.kind === 'session'), true);
  assert.equal(weeklySamples.every((row) => row.kind === 'weekly'), true);
  assert.notEqual(sessionSamples[0].segmentId, weeklySamples[0].segmentId);
});

test('different account scopes never share samples or totals', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000, accountKey: ACCOUNT_A }),
    deviceAt({ at: '2026-09-05T07:10:00.000Z', sessionPercent: 12, weeklyPercent: 12, tokens: 1_200_000, accountKey: ACCOUNT_A }),
    deviceAt({ at: '2026-09-05T07:20:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 5_000_000, accountKey: ACCOUNT_B }),
    deviceAt({ at: '2026-09-05T07:30:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 5_500_000, accountKey: ACCOUNT_B })
  ]);
  const accountA = summary(archive, ACCOUNT_A, 'weekly');
  const accountB = summary(archive, ACCOUNT_B, 'weekly');
  assert.equal(accountA.observedTokens, 200_000);
  assert.equal(accountB.observedTokens, 500_000);
  assert.ok(archive.accountingSamples.some((row) => row.profileId === scopeProfileId(ACCOUNT_A)));
  assert.ok(archive.accountingSamples.some((row) => row.profileId === scopeProfileId(ACCOUNT_B)));
  assert.equal(
    archive.accountingSamples.some((row) => row.profileId === scopeProfileId(ACCOUNT_A)
      && row.profileId === scopeProfileId(ACCOUNT_B)),
    false
  );
  assert.notEqual(accountA.pricedUsd, accountB.pricedUsd);
});

test('a successor session reset starts a new segment and drops the previous cycle increment', () => {
  let archive = observeMany([
    deviceAt({ at: '2026-09-05T10:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T11:00:00.000Z', sessionPercent: 80, weeklyPercent: 20, tokens: 2_000_000 })
  ]);
  const resetDevice = deviceAt({
    at: '2026-09-05T12:05:00.000Z',
    sessionPercent: 0,
    weeklyPercent: 21,
    tokens: 2_000_000
  });
  resetDevice.limits.providers[0].windows[0].resetsAt = NEXT_SESSION_RESET;
  archive = observeCodexQuota(archive, { device: resetDevice, observedAt: resetDevice.updatedAt });
  const grown = deviceAt({
    at: '2026-09-05T12:20:00.000Z',
    sessionPercent: 10,
    weeklyPercent: 22,
    tokens: 2_200_000
  });
  grown.limits.providers[0].windows[0].resetsAt = NEXT_SESSION_RESET;
  archive = observeCodexQuota(archive, { device: grown, observedAt: grown.updatedAt });
  const session = summary(archive, ACCOUNT_A, 'session');
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(session.observedTokens, 200_000);
  assert.equal(weekly.observedTokens, 1_200_000);
  const sessionSegments = [...new Set(archive.accountingSamples.filter((row) => row.kind === 'session').map((row) => row.segmentId))];
  assert.ok(sessionSegments.length >= 2);
});

test('a stale expired session window cannot absorb next-cycle usage while weekly keeps growing', () => {
  let archive = observeMany([
    deviceAt({ at: '2026-09-05T11:50:00.000Z', sessionPercent: 90, weeklyPercent: 20, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T11:55:00.000Z', sessionPercent: 100, weeklyPercent: 21, tokens: 2_000_000 })
  ]);

  archive = observeCodexQuota(archive, {
    device: deviceAt({
      at: '2026-09-05T12:01:00.000Z',
      sessionPercent: 100,
      weeklyPercent: 22,
      tokens: 3_000_000
    }),
    observedAt: '2026-09-05T12:01:00.000Z'
  });
  archive = observeCodexQuota(archive, {
    device: deviceAt({
      at: '2026-09-05T12:02:00.000Z',
      sessionPercent: 100,
      weeklyPercent: 22,
      tokens: 4_000_000
    }),
    observedAt: '2026-09-05T12:02:00.000Z'
  });

  const expiredSegment = archive.accountingSamples.filter((row) => (
    row.kind === 'session' && row.resetsAt === SESSION_RESET
  ));
  assert.equal(expiredSegment.length, 3, 'only the first stale tick adds an integrity boundary');
  assert.equal(expiredSegment.at(-1).observedTotalTokens, 1_000_000);
  assert.equal(expiredSegment.at(-1).unsettled, true);
  assert.equal(
    normalizeCodexQuotaArchive(archive).windowState[
      `${scopeProfileId(ACCOUNT_A)}|session|codex`
    ].expired,
    true,
    'the expired guard survives persistence and prevents later folds'
  );
  assert.equal(summary(archive, ACCOUNT_A, 'weekly').observedTokens, 3_000_000);

  const nextCycle = deviceAt({
    at: '2026-09-05T12:03:00.000Z',
    sessionPercent: 8,
    weeklyPercent: 23,
    tokens: 4_500_000
  });
  nextCycle.limits.providers[0].windows[0].resetsAt = NEXT_SESSION_RESET;
  archive = observeCodexQuota(archive, { device: nextCycle, observedAt: nextCycle.updatedAt });

  const nextGrowth = deviceAt({
    at: '2026-09-05T12:04:00.000Z',
    sessionPercent: 10,
    weeklyPercent: 23,
    tokens: 5_000_000
  });
  nextGrowth.limits.providers[0].windows[0].resetsAt = NEXT_SESSION_RESET;
  archive = observeCodexQuota(archive, { device: nextGrowth, observedAt: nextGrowth.updatedAt });

  assert.equal(summary(archive, ACCOUNT_A, 'session').observedTokens, 500_000);
  assert.equal(summary(archive, ACCOUNT_A, 'weekly').observedTokens, 4_000_000);
  assert.notEqual(
    archive.windowState[`${scopeProfileId(ACCOUNT_A)}|session|codex`].expired,
    true,
    'the successor cycle clears the expired marker'
  );
});

test('percent rollback is not spliced into the same run', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 2_000_000 }),
    deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_200_000 }),
    deviceAt({ at: '2026-09-05T10:00:00.000Z', sessionPercent: 30, weeklyPercent: 30, tokens: 2_400_000 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 200_000);
  assert.ok(weekly.reasons.includes('cycle-percent-rollback') || weekly.confidence !== 'stable');
});

test('cumulative watermark rollback reseeds instead of reporting a negative increment', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 2_000_000 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 3_000_000 }),
    deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T10:00:00.000Z', sessionPercent: 55, weeklyPercent: 55, tokens: 1_200_000 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, null);
  assert.equal(weekly.pricedUsd, null);
  assert.ok(weekly.reasons.includes('cumulative-rollback') || weekly.confidence === 'unstable');
});

test('two-point growth yields a preliminary or better estimate, never a fake zero', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 0, weeklyPercent: 0, tokens: 0 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 25, weeklyPercent: 25, tokens: 2_500_000 }),
    deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 5_000_000 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 5_000_000);
  assert.equal(weekly.pricedUsd, 50);
  assert.ok(weekly.capacityUsd === null || weekly.capacityUsd > 0);
  assert.ok(['collecting', 'preliminary', 'stable'].includes(weekly.confidence));
  assert.notEqual(weekly.pricedUsd, 0);
});

test('a gapped fit stays unstable while the projection keeps the raw capacity for audit', () => {
  // The real 0.54 GUI shape: two sparse fit points, then an official
  // percentage rise with no local token growth (web/other-device usage),
  // which leaves a cycle gap. The renderer must not present the resulting
  // single-point extrapolation as a settled full-cycle amount, so the
  // confidence stays unstable — while the projection contract still carries
  // the raw fit and its reasons so audits can see exactly what was hidden.
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 0, weeklyPercent: 0, tokens: 0 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 25, weeklyPercent: 25, tokens: 2_500_000 }),
    deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 2_500_000 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.confidence, 'unstable');
  assert.ok(weekly.reasons.includes('quota-rise-without-local-usage'));
  assert.ok(weekly.capacityUsd !== null && weekly.capacityUsd > 0, 'audit contract keeps the raw fit');
  assert.ok(weekly.observedTokens > 0);
  assert.ok(weekly.pricedUsd > 0);
  // A stable claim is exactly what this cycle must never make: the gap caps
  // the metric status, and the two-point fit cannot outvote it via R² = 1.
  assert.notEqual(weekly.capacityUsd, undefined);
  const session = summary(archive, ACCOUNT_A, 'session');
  assert.equal(session.confidence, 'unstable');
  assert.ok(session.capacityUsd === null || session.capacityUsd > 0);
});

test('unknown models stay unpriced and gpt-6-astra is an exact id', () => {
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra', 'input')?.unitPriceUsdPerMillion, 10);
  assert.equal(lookupPrice(DEFAULT_API_PRICING_SNAPSHOT, 'openai', 'gpt-6-astra-preview', 'input'), null);
  const archive = observeMany([
    deviceAt({
      at: '2026-09-05T07:00:00.000Z',
      sessionPercent: 10,
      weeklyPercent: 10,
      tokens: 1_000_000,
      model: 'gpt-6-astra-preview'
    }),
    deviceAt({
      at: '2026-09-05T08:00:00.000Z',
      sessionPercent: 40,
      weeklyPercent: 40,
      tokens: 2_000_000,
      model: 'gpt-6-astra-preview'
    })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.equal(weekly.pricedUsd, null);
  assert.equal(weekly.coverage, 0);
  assert.ok(weekly.reasons.includes('unpriced-usage') || weekly.confidence === 'unstable' || weekly.confidence === 'collecting');
});

test('a later pricing snapshot does not rewrite earlier sample amounts', () => {
  const first = DEFAULT_API_PRICING_SNAPSHOT;
  const second = {
    ...first,
    snapshotId: 'public-api-2099-01-01-test',
    sourceId: `${first.sourceId}-later`,
    models: {
      ...first.models,
      openai: {
        ...first.models.openai,
        'gpt-6-astra': { aliases: [], prices: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } }
      }
    }
  };
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 2_000_000 })
  ], first);
  const before = archive.accountingSamples.map((row) => ({
    snapshotId: row.snapshotId,
    apiEquivalentCostUsd: row.apiEquivalentCostUsd,
    pricedTokens: row.pricedTokens
  }));
  const later = observeCodexQuota(archive, {
    device: deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 2_100_000 }),
    observedAt: '2026-09-05T09:00:00.000Z',
    snapshot: second
  });
  const kept = later.accountingSamples.slice(0, before.length);
  assert.deepEqual(kept.map((row) => ({
    snapshotId: row.snapshotId,
    apiEquivalentCostUsd: row.apiEquivalentCostUsd,
    pricedTokens: row.pricedTokens
  })), before);
  assert.ok(later.accountingSamples.some((row) => row.snapshotId === second.snapshotId));
  assert.equal(summary(archive, ACCOUNT_A, 'weekly').pricedUsd, 10);
});

test('archive persistence drops credentials, email, paths and raw account keys', () => {
  const device = deviceAt({
    at: '2026-09-05T07:00:00.000Z',
    sessionPercent: 10,
    weeklyPercent: 10,
    tokens: 1_000_000,
    email: SECRETS[0]
  });
  device.limits.providers[0].cookie = SECRETS[1];
  device.limits.providers[0].token = SECRETS[2];
  device.authPath = SECRETS[3];
  device.message = SECRETS[4];
  const archive = observeCodexQuota(emptyCodexQuotaArchive(), {
    device,
    observedAt: device.updatedAt
  });
  const dirty = {
    ...archive,
    observations: archive.observations.map((row) => ({ ...row, email: SECRETS[0], cookie: SECRETS[1], accountKey: ACCOUNT_A })),
    note: SECRETS[4]
  };
  const text = JSON.stringify(normalizeCodexQuotaArchive(dirty));
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(text.includes('user@'), false);
  assert.equal(text.includes('auth.json'), false);
});

test('managed and remote Codex providers do not receive estimates', () => {
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 2_000_000 })
  ]);
  const live = deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 2_000_000 })
    .limits.providers[0];
  const managed = { ...live, sourceDetail: 'managed' };
  const remote = { ...live, sourceDeviceId: 'other-device' };
  const stats = attachCodexQuotaEstimates({
    devices: [{
      deviceId: 'local-device',
      limits: { providers: [live, managed, remote] }
    }],
    limits: { providers: [live, managed, remote] }
  }, archive, { localDeviceId: 'local-device', syncActive: true });
  const attached = stats.limits.providers;
  assert.ok(attached[0].windows.find((window) => window.kind === 'session').quotaEstimate?.observedTokens > 0);
  assert.equal(attached[1].windows.find((window) => window.kind === 'session').quotaEstimate, undefined);
  assert.equal(attached[2].windows.find((window) => window.kind === 'session').quotaEstimate, undefined);
  assert.equal(attached[0].windows.find((window) => window.kind === 'billing').quotaEstimate, undefined);
});

test('empty evidence projects collecting, never a precise zero dollar amount', () => {
  const projected = projectCodexQuotaForProvider(emptyCodexQuotaArchive(), { accountKey: ACCOUNT_A });
  assert.deepEqual(projected.byKind, {});
  const stats = attachCodexQuotaEstimates({
    limits: {
      providers: [deviceAt({
        at: '2026-09-05T07:00:00.000Z',
        sessionPercent: 10,
        weeklyPercent: 10,
        tokens: 0
      }).limits.providers[0]]
    }
  }, emptyCodexQuotaArchive(), { localDeviceId: 'local-device', syncActive: false });
  const estimate = stats.limits.providers[0].windows.find((window) => window.kind === 'session').quotaEstimate;
  assert.equal(estimate.confidence, 'collecting');
  assert.equal(estimate.pricedUsd, null);
  assert.equal(estimate.capacityUsd, null);
  assert.equal(estimate.observedTokens, null);
});

test('observeCodexQuota does not mutate the previous archive', () => {
  const first = observeCodexQuota(emptyCodexQuotaArchive(), {
    device: deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    observedAt: '2026-09-05T07:00:00.000Z'
  });
  const snapshot = JSON.stringify(first);
  const second = observeCodexQuota(first, {
    device: deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 2_000_000 }),
    observedAt: '2026-09-05T08:00:00.000Z'
  });
  assert.equal(JSON.stringify(first), snapshot);
  assert.notEqual(second, first);
  assert.ok(second.accountingSamples.length > first.accountingSamples.length);
});

test('thousands of same-percent token updates do not grow rows or evict the cycle baseline', () => {
  let archive = emptyCodexQuotaArchive();
  const tick = (index, percent, tokens) => {
    const at = new Date(Date.parse('2026-09-05T07:00:00.000Z') + index * 4000).toISOString();
    archive = observeCodexQuota(archive, {
      device: deviceAt({ at, sessionPercent: percent, weeklyPercent: percent, tokens }),
      observedAt: at
    });
  };
  tick(0, 10, 1_000_000);
  tick(1, 10, 1_010_000);
  // Baseline row plus the first folded change-point row, per window.
  const afterFirst = archive.accountingSamples.length;
  for (let index = 2; index <= 3000; index += 1) tick(index, 10, 1_000_000 + index * 10_000);
  // The remaining same-percent ticks grew the ledger by zero rows.
  assert.equal(archive.accountingSamples.length, afterFirst);
  assert.equal(archive.observations.length, 2);
  const folded = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.equal(folded.length, 2);
  assert.equal(folded[0].observedTotalTokens, 0);
  assert.equal(folded[1].observedTotalTokens, 30_000_000);
  assert.equal(folded[1].apiEquivalentCostUsd, 300);

  for (let index = 3001; index <= 6000; index += 1) tick(index, 11, 1_000_000 + index * 10_000);
  // One new change point per window at 11%, and the cycle baseline survived.
  assert.equal(archive.accountingSamples.filter((row) => row.kind === 'weekly').length, 3);
  assert.equal(archive.observations.filter((row) => row.kind === 'weekly').length, 2);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 60_000_000);
  assert.equal(weekly.pricedUsd, 600);
});

test('a percentage change point carries every token accumulated at the previous percentage', () => {
  let archive = emptyCodexQuotaArchive();
  const at = (minutes) => new Date(Date.parse('2026-09-05T07:00:00.000Z') + minutes * 60_000).toISOString();
  archive = observeCodexQuota(archive, {
    device: deviceAt({ at: at(0), sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    observedAt: at(0)
  });
  for (let minute = 1; minute <= 500; minute += 1) {
    archive = observeCodexQuota(archive, {
      device: deviceAt({ at: at(minute), sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 + minute * 10_000 }),
      observedAt: at(minute)
    });
  }
  archive = observeCodexQuota(archive, {
    device: deviceAt({ at: at(501), sessionPercent: 11, weeklyPercent: 11, tokens: 6_010_000 }),
    observedAt: at(501)
  });
  const weekly = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.equal(weekly.length, 3);
  assert.equal(weekly[0].usedPercent, 10);
  assert.equal(weekly[0].observedTotalTokens, 0);
  assert.equal(weekly[1].usedPercent, 10);
  // The whole 10% span (5M tokens, $50) sits on the folded 10% row...
  assert.equal(weekly[1].observedTotalTokens, 5_000_000);
  assert.equal(weekly[1].apiEquivalentCostUsd, 50);
  // ...and the 11% change point carries it forward plus its own tick.
  assert.equal(weekly[2].usedPercent, 11);
  assert.equal(weekly[2].observedTotalTokens, 5_010_000);
  assert.equal(Number(weekly[2].apiEquivalentCostUsd.toFixed(2)), 50.10);
  const projected = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(projected.observedTokens, 5_010_000);
  assert.equal(Number(projected.pricedUsd.toFixed(2)), 50.10);
});

test('session and weekly resets stay independent while a shared increment continues', () => {
  let archive = emptyCodexQuotaArchive();
  const rows = [
    ['2026-09-05T10:00:00.000Z', 10, 10, 1_000_000, SESSION_RESET, WEEKLY_RESET],
    ['2026-09-05T10:30:00.000Z', 10, 10, 1_200_000, SESSION_RESET, WEEKLY_RESET],
    ['2026-09-05T12:05:00.000Z', 0, 21, 1_300_000, NEXT_SESSION_RESET, WEEKLY_RESET],
    ['2026-09-05T12:30:00.000Z', 5, 22, 1_400_000, NEXT_SESSION_RESET, WEEKLY_RESET]
  ];
  for (const [atTime, sessionPercent, weeklyPercent, tokens, sessionReset, weeklyReset] of rows) {
    const device = deviceAt({ at: atTime, sessionPercent, weeklyPercent, tokens });
    device.limits.providers[0].windows[0].resetsAt = sessionReset;
    device.limits.providers[0].windows[1].resetsAt = weeklyReset;
    archive = observeCodexQuota(archive, { device, observedAt: atTime });
  }
  const session = summary(archive, ACCOUNT_A, 'session');
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  // Session reset cut its baseline; the same increments still reached Weekly.
  assert.equal(session.observedTokens, 100_000);
  assert.equal(weekly.observedTokens, 400_000);
  assert.equal(Number(session.pricedUsd.toFixed(2)), 1);
  assert.equal(Number(weekly.pricedUsd.toFixed(2)), 4);
});

test('a restart through normalize neither double-counts nor loses accumulators', () => {
  let archive = emptyCodexQuotaArchive();
  const rows = [
    ['2026-09-05T07:00:00.000Z', 10, 10, 1_000_000],
    ['2026-09-05T07:05:00.000Z', 10, 10, 1_500_000],
    ['2026-09-05T07:10:00.000Z', 11, 11, 2_000_000]
  ];
  for (const [atTime, sessionPercent, weeklyPercent, tokens] of rows) {
    archive = observeCodexQuota(archive, {
      device: deviceAt({ at: atTime, sessionPercent, weeklyPercent, tokens }),
      observedAt: atTime
    });
  }
  // Simulated process restart: JSON round trip plus the defensive normalize.
  const reloaded = normalizeCodexQuotaArchive(JSON.parse(JSON.stringify(archive)));
  const scopeBefore = reloaded.scopes[scopeProfileId(ACCOUNT_A)];
  assert.equal(scopeBefore.pricedTokens, 1_000_000);
  assert.equal(scopeBefore.apiEquivalentCostUsd, 10);
  const next = observeCodexQuota(reloaded, {
    device: deviceAt({ at: '2026-09-05T07:15:00.000Z', sessionPercent: 12, weeklyPercent: 12, tokens: 2_500_000 }),
    observedAt: '2026-09-05T07:15:00.000Z'
  });
  const scopeAfter = next.scopes[scopeProfileId(ACCOUNT_A)];
  assert.equal(scopeAfter.pricedTokens, 1_500_000);
  assert.equal(scopeAfter.apiEquivalentCostUsd, 15);
  const weekly = summary(next, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_500_000);
  assert.equal(weekly.pricedUsd, 15);
});

test('returning to a previous account fails closed across the switch boundary', () => {
  let archive = emptyCodexQuotaArchive();
  const rows = [
    ['2026-09-05T07:00:00.000Z', 10, 10, 1_000_000, ACCOUNT_A],
    ['2026-09-05T07:05:00.000Z', 12, 12, 1_200_000, ACCOUNT_A],
    ['2026-09-05T07:10:00.000Z', 40, 40, 5_000_000, ACCOUNT_B],
    ['2026-09-05T07:15:00.000Z', 50, 50, 5_200_000, ACCOUNT_A]
  ];
  for (const [atTime, sessionPercent, weeklyPercent, tokens, accountKey] of rows) {
    archive = observeCodexQuota(archive, {
      device: deviceAt({ at: atTime, sessionPercent, weeklyPercent, tokens, accountKey }),
      observedAt: atTime
    });
  }
  const profileA = scopeProfileId(ACCOUNT_A);
  const scope = archive.scopes[profileA];
  // A's credited accumulators cover only A's own span; the 3.8M grown while
  // account B was live is never attributed to A.
  assert.equal(scope.pricedTokens, 200_000);
  assert.equal(scope.apiEquivalentCostUsd, 2);
  const next = observeCodexQuota(archive, {
    device: deviceAt({ at: '2026-09-05T07:20:00.000Z', sessionPercent: 55, weeklyPercent: 55, tokens: 5_300_000, accountKey: ACCOUNT_A }),
    observedAt: '2026-09-05T07:20:00.000Z'
  });
  assert.equal(next.scopes[profileA].pricedTokens, 300_000);
  const weekly = summary(next, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 300_000);
});

// Account-return integrity boundaries: switching back to a profile that
// already holds local evidence must reseed the watermark AND leave an
// `unsettled` gap marker, even when the official percentage is identical to
// the one seen before the switch. First sight of a profile must not.
function switchTickFactory() {
  let archive = emptyCodexQuotaArchive();
  let tickIndex = 0;
  const tick = (percent, tokens, accountKey, options = {}) => {
    const { mutate, at } = options;
    const observedAt = at || new Date(Date.parse('2026-09-05T07:00:00.000Z') + tickIndex * 60_000).toISOString();
    tickIndex += 1;
    const device = deviceAt({ at: observedAt, sessionPercent: percent, weeklyPercent: percent, tokens, accountKey });
    if (mutate) mutate(device);
    archive = observeCodexQuota(archive, { device, observedAt });
    return archive;
  };
  const weeklyRows = (accountKey) => {
    const profileId = scopeProfileId(accountKey);
    return archive.accountingSamples.filter((row) => row.profileId === profileId && row.kind === 'weekly');
  };
  return { tick, weeklyRows, getArchive: () => archive };
}

test('same-percent account return reseeds with gap evidence and prices only post-return growth', () => {
  const { tick, weeklyRows, getArchive } = switchTickFactory();
  const profileA = scopeProfileId(ACCOUNT_A);

  tick(0, 0, ACCOUNT_A);
  tick(10, 1_000_000, ACCOUNT_A);
  tick(30, 3_000_000, ACCOUNT_B);
  const beforeReturn = getArchive().scopes[profileA].pricedTokens;
  const preReturnRows = weeklyRows(ACCOUNT_A);
  const preReturnTokens = preReturnRows.at(-1).observedTotalTokens;

  // Return to A at the exact same official percentage: nothing is priced
  // across the boundary, but the fold must not swallow the return either.
  tick(10, 3_500_000, ACCOUNT_A);
  let archive = getArchive();
  assert.equal(archive.scopes[profileA].pricedTokens, beforeReturn);
  assert.equal(archive.scopes[profileA].totalTokens, 3_500_000);
  const returnRow = weeklyRows(ACCOUNT_A).at(-1);
  assert.equal(returnRow.unsettled, true);
  assert.equal(returnRow.usedPercent, 10);
  assert.equal(returnRow.observedTotalTokens, preReturnTokens);

  // The second consecutive A tick prices only the growth over the reseeded
  // watermark, and an ordinary same-percent tick folds instead of appending
  // another boundary row.
  tick(10, 3_700_000, ACCOUNT_A);
  archive = getArchive();
  assert.equal(archive.scopes[profileA].pricedTokens, beforeReturn + 200_000);
  const afterFold = weeklyRows(ACCOUNT_A);
  assert.equal(afterFold.length, preReturnRows.length + 1);
  assert.equal(afterFold.filter((row) => row.unsettled === true).length, 1);
  assert.equal(afterFold.at(-1).observedTotalTokens, preReturnTokens + 200_000);

  // Completing the cycle must not claim an unbroken local observation chain.
  tick(100, 10_000_000, ACCOUNT_A);
  archive = getArchive();
  const completed = summary(archive, ACCOUNT_A, 'weekly');
  assert.notEqual(completed.confidence, 'stable');
  const estimate = weeklyEstimate(archive, ACCOUNT_A);
  assert.notEqual(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.notEqual(estimate.localTokens?.cycleBasis, 'full');
  assert.notEqual(estimate.status, 'stable');

  // A brand-new, continuously observed cycle afterwards recovers full
  // confidence: the boundary marks the interrupted cycle, not the profile.
  // (The new-cycle ticks sit after the old weekly reset, so the engine
  // recognises them as a successor cycle rather than reset jitter.)
  const nextReset = '2026-09-15T00:00:00.000Z';
  const withNextReset = (device) => {
    device.limits.providers[0].windows[1].resetsAt = nextReset;
  };
  tick(0, 10_000_000, ACCOUNT_A, { mutate: withNextReset, at: '2026-09-08T01:00:00.000Z' });
  tick(50, 15_000_000, ACCOUNT_A, { mutate: withNextReset, at: '2026-09-08T02:00:00.000Z' });
  tick(100, 20_000_000, ACCOUNT_A, { mutate: withNextReset, at: '2026-09-08T03:00:00.000Z' });
  const nextEstimate = weeklyEstimate(getArchive(), ACCOUNT_A);
  assert.equal(nextEstimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.equal(nextEstimate.localTokens.cycleBasis, 'full');
  assert.equal(nextEstimate.status, 'stable');
});

test('an account return with a changed percentage keeps the same explicit gap', () => {
  const { tick, weeklyRows, getArchive } = switchTickFactory();
  const profileA = scopeProfileId(ACCOUNT_A);

  tick(0, 0, ACCOUNT_A);
  tick(10, 1_000_000, ACCOUNT_A);
  tick(30, 3_000_000, ACCOUNT_B);
  // The gap must be carried by an explicit marker, not inferred indirectly
  // from "percentage rose while local tokens stayed flat".
  tick(40, 3_500_000, ACCOUNT_A);
  const archive = getArchive();
  assert.equal(archive.scopes[profileA].pricedTokens, 1_000_000);
  const returnRow = weeklyRows(ACCOUNT_A).at(-1);
  assert.equal(returnRow.usedPercent, 40);
  assert.equal(returnRow.unsettled, true);
  assert.equal(returnRow.observedTotalTokens, 1_000_000);
  const view = summary(archive, ACCOUNT_A, 'weekly');
  assert.notEqual(view.confidence, 'stable');
});

test('a first switch to a never-recorded profile only establishes a baseline', () => {
  const { tick, getArchive } = switchTickFactory();

  tick(0, 0, ACCOUNT_A);
  tick(10, 1_000_000, ACCOUNT_A);
  // B is brand new: its first cycle is a clean baseline, not a return gap,
  // even though another profile ran right before it.
  tick(0, 1_500_000, ACCOUNT_B);
  tick(50, 6_500_000, ACCOUNT_B);
  tick(100, 11_500_000, ACCOUNT_B);
  const archive = getArchive();
  const profileB = scopeProfileId(ACCOUNT_B);
  assert.equal(archive.scopes[profileB].pricedTokens, 10_000_000);
  const bRows = archive.accountingSamples.filter((row) => row.profileId === profileB && row.kind === 'weekly');
  assert.equal(bRows.some((row) => row.unsettled === true), false);
  const estimate = weeklyEstimate(archive, ACCOUNT_B);
  assert.equal(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.equal(estimate.localTokens.cycleBasis, 'full');
  assert.equal(estimate.status, 'stable');
});

test('a return that lands on a fresh quota cycle baseline does not taint that cycle', () => {
  const { tick, weeklyRows, getArchive } = switchTickFactory();
  const nextReset = '2026-09-15T00:00:00.000Z';

  tick(0, 0, ACCOUNT_A);
  tick(10, 1_000_000, ACCOUNT_A);
  tick(30, 3_000_000, ACCOUNT_B);
  // The weekly window reset while B was live, so A returns onto a brand-new
  // cycle: the return reseeds the watermark, but the fresh baseline has no
  // pre-gap chain to protect and must stay unmarked.
  tick(0, 3_500_000, ACCOUNT_A, {
    mutate: (device) => {
      device.limits.providers[0].windows[1].resetsAt = nextReset;
    },
    at: '2026-09-08T01:00:00.000Z'
  });
  const returnRow = weeklyRows(ACCOUNT_A).at(-1);
  assert.equal(returnRow.usedPercent, 0);
  assert.notEqual(returnRow.unsettled, true);

  tick(50, 4_500_000, ACCOUNT_A, {
    mutate: (device) => {
      device.limits.providers[0].windows[1].resetsAt = nextReset;
    },
    at: '2026-09-08T02:00:00.000Z'
  });
  tick(100, 5_500_000, ACCOUNT_A, {
    mutate: (device) => {
      device.limits.providers[0].windows[1].resetsAt = nextReset;
    },
    at: '2026-09-08T03:00:00.000Z'
  });
  const estimate = weeklyEstimate(getArchive(), ACCOUNT_A);
  assert.equal(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.equal(estimate.localTokens.cycleBasis, 'full');
  assert.equal(estimate.status, 'stable');
});

test('repeated A/B toggles never credit cross-boundary tokens or duplicate boundaries', () => {
  const { tick, weeklyRows, getArchive } = switchTickFactory();
  const profileA = scopeProfileId(ACCOUNT_A);
  const profileB = scopeProfileId(ACCOUNT_B);

  tick(0, 0, ACCOUNT_A);
  tick(10, 1_000_000, ACCOUNT_A);
  tick(20, 2_000_000, ACCOUNT_B);
  tick(30, 2_500_000, ACCOUNT_A);
  tick(40, 3_000_000, ACCOUNT_B);
  tick(50, 3_200_000, ACCOUNT_A);
  tick(55, 3_400_000, ACCOUNT_A);
  tick(60, 3_800_000, ACCOUNT_B);
  tick(70, 4_000_000, ACCOUNT_B);
  const archive = getArchive();

  // Only same-account, post-reseed growth is credited: A gets its first
  // 1M span plus the 200k after its last return; B only the 200k after its
  // last return. Every cross-boundary increment is reseeded away.
  assert.equal(archive.scopes[profileA].pricedTokens, 1_200_000);
  assert.equal(archive.scopes[profileB].pricedTokens, 200_000);

  // Each return to an already-known profile leaves exactly one boundary
  // row; ordinary same-account ticks append plain change-point rows only.
  const aRows = weeklyRows(ACCOUNT_A);
  const bRows = weeklyRows(ACCOUNT_B);
  assert.deepEqual(aRows.map((row) => row.usedPercent), [0, 10, 30, 50, 55]);
  assert.deepEqual(aRows.map((row) => row.unsettled === true), [false, false, true, true, false]);
  assert.deepEqual(bRows.map((row) => row.usedPercent), [20, 40, 60, 70]);
  assert.deepEqual(bRows.map((row) => row.unsettled === true), [false, true, true, false]);
});

test('WSL-merged Codex usage fails closed while the official percentage stays visible', () => {
  const wslMerged = { state: 'active', detected: ['ubuntu'], withData: ['codex'] };
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  const wslDisabled = { state: 'disabled', detected: [], withData: [] };
  assert.equal(wslUsageObscuresLocalCodex({ wslStatus: wslMerged }), true);
  assert.equal(wslUsageObscuresLocalCodex({ wslStatus: wslClean }), false);
  assert.equal(wslUsageObscuresLocalCodex({ wslStatus: wslDisabled }), false);
  assert.equal(wslUsageObscuresLocalCodex({}), false);
  assert.equal(wslUsageObscuresLocalCodex(null), false);

  let archive = emptyCodexQuotaArchive();
  archive = observeCodexQuota(archive, {
    device: deviceAt({
      at: '2026-09-05T07:00:00.000Z',
      sessionPercent: 10,
      weeklyPercent: 10,
      tokens: 1_000_000
    }),
    observedAt: '2026-09-05T07:00:00.000Z'
  });
  const mergedDevice = deviceAt({
    at: '2026-09-05T07:05:00.000Z',
    sessionPercent: 20,
    weeklyPercent: 20,
    tokens: 2_000_000,
    wslStatus: wslMerged
  });
  archive = observeCodexQuota(archive, { device: mergedDevice, observedAt: mergedDevice.updatedAt });
  const profileA = scopeProfileId(ACCOUNT_A);
  // The merged 1M increment is not credited to the Windows account...
  assert.equal(archive.scopes[profileA].pricedTokens, 0);
  assert.equal(archive.scopes[profileA].wslMerged, true);
  // ...but the raw watermark advanced, and the official 20% change point was
  // still recorded as an observation with unsettled evidence.
  assert.equal(archive.scopes[profileA].totalTokens, 2_000_000);
  const weeklySamples = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.equal(weeklySamples.length, 2);
  assert.equal(weeklySamples[1].usedPercent, 20);
  assert.equal(weeklySamples[1].observedTotalTokens, 0);
  assert.equal(weeklySamples[1].unsettled, true);
  const mergedView = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(mergedView.observedTokens, null);
  assert.equal(mergedView.pricedUsd, null);
  assert.equal(mergedView.coverage, null);
  assert.equal(mergedView.confidence, 'collecting');
  assert.deepEqual(mergedView.reasons, [WSL_MERGED_REASON]);

  // First clean tick after the merged span: reseed only. Its 500k delta
  // versus the merged watermark cannot be proven to be Windows usage, so
  // nothing is credited even though the raw watermark re-baselines.
  const reseedDevice = deviceAt({
    at: '2026-09-05T07:10:00.000Z',
    sessionPercent: 30,
    weeklyPercent: 30,
    tokens: 2_500_000,
    wslStatus: wslClean
  });
  archive = observeCodexQuota(archive, { device: reseedDevice, observedAt: reseedDevice.updatedAt });
  assert.equal(archive.scopes[profileA].wslMerged, undefined);
  assert.equal(archive.scopes[profileA].totalTokens, 2_500_000);
  assert.equal(archive.scopes[profileA].pricedTokens, 0);
  assert.equal(archive.scopes[profileA].apiEquivalentCostUsd, 0);
  // The reseed tick's official change point is still recorded, as unsettled
  // gap evidence rather than trusted usage.
  const reseedRow = archive.accountingSamples.filter((row) => row.kind === 'weekly').at(-1);
  assert.equal(reseedRow.usedPercent, 30);
  assert.equal(reseedRow.unsettled, true);
  assert.equal(reseedRow.observedTotalTokens, 0);
  // The merged reason is gone, and the view shows no fake numbers while
  // there is still no trusted post-reseed growth.
  const reseedView = summary(archive, ACCOUNT_A, 'weekly');
  assert.notEqual(reseedView.reasons.includes(WSL_MERGED_REASON), true);
  assert.equal(reseedView.observedTokens, null);
  assert.equal(reseedView.pricedUsd, null);

  // Second consecutive clean tick: only growth measured against the fresh
  // baseline is credited.
  const grownDevice = deviceAt({
    at: '2026-09-05T07:15:00.000Z',
    sessionPercent: 40,
    weeklyPercent: 40,
    tokens: 3_000_000,
    wslStatus: wslClean
  });
  archive = observeCodexQuota(archive, { device: grownDevice, observedAt: grownDevice.updatedAt });
  assert.equal(archive.scopes[profileA].pricedTokens, 500_000);
  assert.equal(archive.scopes[profileA].apiEquivalentCostUsd, 5);
  const resumed = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(resumed.observedTokens, 500_000);
  assert.equal(resumed.pricedUsd, 5);
  assert.notEqual(resumed.reasons.includes(WSL_MERGED_REASON), true);
});

test('the exact three-step repro never prices the post-unblock boundary delta', () => {
  const wslMerged = { state: 'active', detected: ['ubuntu'], withData: ['codex'] };
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_000_000, wslStatus: wslMerged }),
    deviceAt({ at: '2026-09-05T07:10:00.000Z', sessionPercent: 30, weeklyPercent: 30, tokens: 2_500_000, wslStatus: wslClean }),
    deviceAt({ at: '2026-09-05T07:15:00.000Z', sessionPercent: 40, weeklyPercent: 40, tokens: 3_000_000, wslStatus: wslClean })
  ]);
  const scope = archive.scopes[scopeProfileId(ACCOUNT_A)];
  // The merged span and the first clean tick are both unattributable; only
  // the second clean tick's 500k over the 2.5M reseed baseline counts.
  assert.equal(scope.pricedTokens, 500_000);
  assert.equal(scope.apiEquivalentCostUsd, 5);
  assert.equal(scope.totalTokens, 3_000_000);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 500_000);
  assert.equal(weekly.pricedUsd, 5);
});

test('the merged-span reseed handshake survives a restart through normalize', () => {
  const wslMerged = { state: 'active', detected: ['ubuntu'], withData: ['codex'] };
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  let archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    deviceAt({ at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_000_000, wslStatus: wslMerged })
  ]);
  archive = normalizeCodexQuotaArchive(JSON.parse(JSON.stringify(archive)));
  const profileA = scopeProfileId(ACCOUNT_A);
  assert.equal(archive.scopes[profileA].wslMerged, true);
  // First clean tick after the restart: still a reseed, never a credit of
  // the growth that crossed the merged boundary.
  const reseed = observeCodexQuota(archive, {
    device: deviceAt({
      at: '2026-09-05T07:10:00.000Z',
      sessionPercent: 30,
      weeklyPercent: 30,
      tokens: 2_500_000,
      wslStatus: wslClean
    }),
    observedAt: '2026-09-05T07:10:00.000Z'
  });
  assert.equal(reseed.scopes[profileA].pricedTokens, 0);
  assert.equal(reseed.scopes[profileA].wslMerged, undefined);
  const next = observeCodexQuota(reseed, {
    device: deviceAt({
      at: '2026-09-05T07:15:00.000Z',
      sessionPercent: 40,
      weeklyPercent: 40,
      tokens: 3_200_000,
      wslStatus: wslClean
    }),
    observedAt: '2026-09-05T07:15:00.000Z'
  });
  assert.equal(next.scopes[profileA].pricedTokens, 700_000);
});

test('an active WSL scan without Codex data never blocks accounting', () => {
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  const archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000, wslStatus: wslClean }),
    deviceAt({ at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_000_000, wslStatus: wslClean })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.equal(weekly.pricedUsd, 10);
});

test('a disabled WSL scan never blocks local Codex accounting', () => {
  let archive = emptyCodexQuotaArchive();
  const rows = [
    ['2026-09-05T07:00:00.000Z', 10, 10, 1_000_000],
    ['2026-09-05T07:05:00.000Z', 20, 20, 2_000_000]
  ];
  for (const [atTime, sessionPercent, weeklyPercent, tokens] of rows) {
    const device = deviceAt({
      at: atTime,
      sessionPercent,
      weeklyPercent,
      tokens,
      wslStatus: { state: 'disabled', detected: [], withData: [] }
    });
    archive = observeCodexQuota(archive, { device, observedAt: atTime });
  }
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.equal(weekly.pricedUsd, 10);
});

function weeklyEstimate(archive, accountKey = ACCOUNT_A) {
  const profileId = scopeProfileId(accountKey);
  const samples = archive.accountingSamples.filter((row) => row.profileId === profileId && row.kind === 'weekly');
  return estimateRateLimitCapacities(samples, profileId).at(-1) || null;
}

test('same-percent WSL mixed and reseed leave gap evidence and do not price the span', () => {
  const wslMerged = { state: 'active', detected: ['ubuntu'], withData: ['codex'] };
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  const profileA = scopeProfileId(ACCOUNT_A);
  let archive = emptyCodexQuotaArchive();
  let tickIndex = 0;
  const tick = (percent, tokens, wslStatus) => {
    const at = new Date(Date.parse('2026-09-05T07:00:00.000Z') + tickIndex * 60_000).toISOString();
    tickIndex += 1;
    archive = observeCodexQuota(archive, {
      device: deviceAt({
        at,
        sessionPercent: percent,
        weeklyPercent: percent,
        tokens,
        ...(wslStatus ? { wslStatus } : {})
      }),
      observedAt: at
    });
  };

  tick(0, 0);
  tick(10, 1_000_000);
  const beforeMixed = archive.scopes[profileA].pricedTokens;
  const weeklyBefore = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  const preMixedTokens = weeklyBefore.at(-1).observedTotalTokens;

  tick(10, 1_500_000, wslMerged);
  assert.equal(archive.scopes[profileA].wslMerged, true);
  assert.equal(archive.scopes[profileA].pricedTokens, beforeMixed);
  const mixedWeekly = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.ok(mixedWeekly.length > weeklyBefore.length);
  const mixedRow = mixedWeekly.at(-1);
  assert.equal(mixedRow.unsettled, true);
  assert.equal(mixedRow.usedPercent, 10);
  assert.equal(mixedRow.observedTotalTokens, preMixedTokens);
  assert.equal(summary(archive, ACCOUNT_A, 'weekly').confidence, 'collecting');
  assert.deepEqual(summary(archive, ACCOUNT_A, 'weekly').reasons, [WSL_MERGED_REASON]);

  const mixedCount = mixedWeekly.length;
  tick(10, 1_600_000, wslMerged);
  assert.equal(archive.accountingSamples.filter((row) => row.kind === 'weekly').length, mixedCount);
  assert.equal(archive.scopes[profileA].pricedTokens, beforeMixed);

  tick(10, 1_800_000, wslClean);
  assert.equal(archive.scopes[profileA].wslMerged, undefined);
  assert.equal(archive.scopes[profileA].pricedTokens, beforeMixed);
  const reseedRow = archive.accountingSamples.filter((row) => row.kind === 'weekly').at(-1);
  assert.equal(reseedRow.unsettled, true);
  assert.equal(reseedRow.usedPercent, 10);
  assert.equal(reseedRow.observedTotalTokens, preMixedTokens);
  const reseedView = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(reseedView.reasons.includes(WSL_MERGED_REASON), false);
  // Pre-gap credited usage remains visible; the mixed/reseed watermarks do not.
  assert.equal(reseedView.observedTokens, beforeMixed);
  assert.equal(reseedView.pricedUsd, beforeMixed / 100_000);

  tick(10, 2_000_000, wslClean);
  assert.equal(archive.scopes[profileA].pricedTokens, beforeMixed + 200_000);
  tick(20, 2_200_000, wslClean);
  assert.equal(archive.scopes[profileA].pricedTokens, beforeMixed + 400_000);
  const resumed = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(resumed.observedTokens, beforeMixed + 400_000);
  assert.equal(resumed.pricedUsd, (beforeMixed + 400_000) / 100_000);
  assert.equal(resumed.reasons.includes(WSL_MERGED_REASON), false);
});

test('a cycle that crossed a same-percent WSL gap is not a stable full cycle', () => {
  const wslMerged = { state: 'active', detected: ['ubuntu'], withData: ['codex'] };
  const wslClean = { state: 'active', detected: ['ubuntu'], withData: [] };
  let archive = emptyCodexQuotaArchive();
  let tickIndex = 0;
  const tick = (percent, tokens, wslStatus) => {
    const at = new Date(Date.parse('2026-09-05T07:00:00.000Z') + tickIndex * 60_000).toISOString();
    tickIndex += 1;
    archive = observeCodexQuota(archive, {
      device: deviceAt({
        at,
        sessionPercent: percent,
        weeklyPercent: percent,
        tokens,
        ...(wslStatus ? { wslStatus } : {})
      }),
      observedAt: at
    });
  };

  tick(0, 0);
  tick(10, 1_000_000);
  tick(10, 1_500_000, wslMerged);
  tick(10, 1_800_000, wslClean);
  for (let percent = 20; percent <= 100; percent += 10) {
    tick(percent, 2_000_000 + ((percent - 20) / 10) * 1_000_000, wslClean);
  }

  const weeklyRows = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.ok(weeklyRows.some((row) => row.unsettled === true));
  const completed = summary(archive, ACCOUNT_A, 'weekly');
  assert.notEqual(completed.confidence, 'stable');
  const estimate = weeklyEstimate(archive);
  assert.ok(estimate);
  assert.notEqual(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.notEqual(estimate.localTokens?.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.notEqual(estimate.localTokens?.cycleBasis, 'full');
  assert.notEqual(estimate.status, 'stable');

  const nextReset = '2026-09-15T00:00:00.000Z';
  const nextCycle = (at, percent, tokens) => {
    const device = deviceAt({
      at,
      sessionPercent: percent,
      weeklyPercent: percent,
      tokens,
      wslStatus: wslClean
    });
    device.limits.providers[0].windows[1].resetsAt = nextReset;
    archive = observeCodexQuota(archive, { device, observedAt: at });
  };
  nextCycle('2026-09-08T01:00:00.000Z', 0, 12_000_000);
  nextCycle('2026-09-08T02:00:00.000Z', 50, 17_000_000);
  nextCycle('2026-09-08T03:00:00.000Z', 100, 22_000_000);
  const nextWeekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.ok(['preliminary', 'stable'].includes(nextWeekly.confidence));
  const nextEstimate = weeklyEstimate(archive);
  assert.equal(nextEstimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.equal(nextEstimate.localTokens.cycleBasis, 'full');
  assert.equal(nextEstimate.status, 'stable');
  assert.equal(nextEstimate.segmentId.includes(nextReset), true);
});

// ---- Fair bounded retention across accounts and windows ----

function fourAccountPressureArchive() {
  const accounts = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D];
  let archive = emptyCodexQuotaArchive();
  const base = Date.parse('2026-09-05T07:00:00.000Z');
  let tick = 0;
  for (const accountKey of accounts) {
    for (let percent = 0; percent <= 100; percent += 1) {
      const at = new Date(base + tick * 60_000).toISOString();
      tick += 1;
      archive = observeCodexQuota(archive, {
        device: deviceAt({ at, sessionPercent: percent, weeklyPercent: percent, tokens: 1_000_000 + tick * 1_000, accountKey }),
        observedAt: at
      });
      // The caps hold at every step, not only at the end.
      assert.ok(archive.observations.length <= MAX_ARCHIVE_ROWS);
      assert.ok(archive.accountingSamples.length <= MAX_ARCHIVE_ROWS);
    }
  }
  return archive;
}

test('four accounts running 0%→100% keep every stream cycle anchor under the archive cap', () => {
  const archive = fourAccountPressureArchive();
  // Hard caps hold for both arrays and every stream, not only in total.
  assert.ok(archive.observations.length <= MAX_ARCHIVE_ROWS);
  assert.ok(archive.accountingSamples.length <= MAX_ARCHIVE_ROWS);
  const perStream = new Map();
  for (const row of archive.accountingSamples) {
    const key = `${row.profileId}|${row.kind}`;
    perStream.set(key, (perStream.get(key) || 0) + 1);
  }
  assert.ok([...perStream.values()].every((count) => count <= MAX_ARCHIVE_ROWS_PER_WINDOW));
  for (const accountKey of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D]) {
    const profileId = scopeProfileId(accountKey);
    for (const kind of ['session', 'weekly']) {
      const rows = archive.accountingSamples.filter((row) => row.profileId === profileId && row.kind === kind);
      const observationRows = archive.observations.filter((row) => row.profileId === profileId && row.kind === kind);
      assert.ok(rows.length > 50, `${kind} evidence for ${profileId}`);
      // The 0% baseline and the 100% latest point survive in both arrays, so
      // a fully observed cycle never degrades into a partial one.
      assert.equal(rows[0].usedPercent, 0, `${profileId}|${kind} baseline`);
      assert.equal(rows.at(-1).usedPercent, 100, `${profileId}|${kind} latest`);
      assert.equal(observationRows[0].usedPercent, 0);
      assert.equal(observationRows.at(-1).usedPercent, 100);
    }
  }
  // Retention keeps the two arrays explainable by each other: every stream
  // and every segment that still has samples still has its observations.
  const sampleStreams = new Set(archive.accountingSamples.map((row) => `${row.profileId}|${row.kind}`));
  const observationStreams = new Set(archive.observations.map((row) => `${row.profileId}|${row.kind}`));
  assert.deepEqual([...sampleStreams].sort(), [...observationStreams].sort());
  const sampleSegments = new Set(archive.accountingSamples.map((row) => `${row.profileId}|${row.kind}|${row.segmentId}`));
  const observationSegments = new Set(archive.observations.map((row) => `${row.profileId}|${row.kind}|${row.segmentId}`));
  for (const segment of sampleSegments) {
    assert.equal(observationSegments.has(segment), true, segment);
  }
});

test('a high-frequency session stream never evicts its own weekly baseline', () => {
  let archive = emptyCodexQuotaArchive();
  const base = Date.parse('2026-09-05T07:00:00.000Z');
  for (let tick = 0; tick < 300; tick += 1) {
    const at = new Date(base + tick * 60_000).toISOString();
    const device = deviceAt({
      at,
      sessionPercent: tick % 100,
      weeklyPercent: Math.floor(tick / 6),
      tokens: 1_000_000 + tick * 1_000
    });
    // Three clean 5h session cycles; weekly keeps one cycle throughout.
    device.limits.providers[0].windows[0].resetsAt = new Date(base + (Math.floor(tick / 100) + 1) * 5 * 3600_000).toISOString();
    archive = observeCodexQuota(archive, { device, observedAt: at });
  }
  const sessionRows = archive.accountingSamples.filter((row) => row.kind === 'session');
  const weeklyRows = archive.accountingSamples.filter((row) => row.kind === 'weekly');
  assert.ok(sessionRows.length <= MAX_ARCHIVE_ROWS_PER_WINDOW);
  // Every session cycle keeps its own 0% baseline even though the stream is
  // over its per-stream budget.
  assert.equal(sessionRows.filter((row) => row.usedPercent === 0).length, 3);
  // The slow weekly stream lost nothing: its baseline lives in its own
  // budget. (51 rows: the 0% baseline, one baseline-protect append, then one
  // row per percentage change point up to 49%.)
  assert.equal(weeklyRows.length, 51);
  assert.equal(weeklyRows[0].usedPercent, 0);
  assert.equal(weeklyRows.at(-1).usedPercent, 49);
});

test('a hyperactive account cannot evict other accounts cycle evidence', () => {
  const base = Date.parse('2026-09-05T07:00:00.000Z');
  let archive = emptyCodexQuotaArchive();
  let tick = 0;
  const quiet = [ACCOUNT_B, ACCOUNT_C, ACCOUNT_D];
  for (const accountKey of quiet) {
    for (let percent = 0; percent < 100; percent += 1) {
      const at = new Date(base + tick * 60_000).toISOString();
      tick += 1;
      archive = observeCodexQuota(archive, {
        device: deviceAt({ at, sessionPercent: percent, weeklyPercent: percent, tokens: 1_000_000 + tick * 1_000, accountKey }),
        observedAt: at
      });
    }
  }
  const before = new Map();
  for (const accountKey of quiet) {
    const profileId = scopeProfileId(accountKey);
    for (const kind of ['session', 'weekly']) {
      before.set(
        `${profileId}|${kind}`,
        archive.accountingSamples.filter((row) => row.profileId === profileId && row.kind === kind).length
      );
    }
  }
  // Account A bursts: both its windows change on every tick, far beyond its
  // own per-stream budget and the global cap.
  for (let index = 0; index < 600; index += 1) {
    const at = new Date(base + tick * 60_000).toISOString();
    tick += 1;
    const device = deviceAt({
      at,
      sessionPercent: index % 100,
      weeklyPercent: index % 100,
      tokens: 1_000_000 + tick * 1_000,
      accountKey: ACCOUNT_A
    });
    device.limits.providers[0].windows[0].resetsAt = new Date(base + (Math.floor(index / 100) + 1) * 5 * 3600_000).toISOString();
    archive = observeCodexQuota(archive, { device, observedAt: at });
    assert.ok(archive.observations.length <= MAX_ARCHIVE_ROWS);
    assert.ok(archive.accountingSamples.length <= MAX_ARCHIVE_ROWS);
  }
  assert.ok(archive.observations.length <= MAX_ARCHIVE_ROWS);
  assert.ok(archive.accountingSamples.length <= MAX_ARCHIVE_ROWS);
  for (const accountKey of quiet) {
    const profileId = scopeProfileId(accountKey);
    for (const kind of ['session', 'weekly']) {
      const rows = archive.accountingSamples.filter((row) => row.profileId === profileId && row.kind === kind);
      // The quiet accounts keep their baselines, latest points and the bulk
      // of their evidence; A's burst spent only its own fair share.
      assert.ok(rows.length >= 60, `${profileId}|${kind} kept ${rows.length}`);
      assert.ok(rows.length <= before.get(`${profileId}|${kind}`));
      assert.equal(rows[0].usedPercent, 0);
      assert.equal(rows.at(-1).usedPercent, 99);
    }
  }
});

test('retention is deterministic and stable across normalize/reload', () => {
  const archive = fourAccountPressureArchive();
  // A JSON round trip plus the defensive normalize must reproduce exactly
  // the trimmed arrays: no further rows are lost, none are rewritten.
  const once = normalizeCodexQuotaArchive(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual(once.observations, archive.observations);
  assert.deepEqual(once.accountingSamples, archive.accountingSamples);
  const twice = normalizeCodexQuotaArchive(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice.observations, once.observations);
  assert.deepEqual(twice.accountingSamples, once.accountingSamples);
});

function linearWeeklyArchive({ count, unsettledAt = [], profileId = scopeProfileId(ACCOUNT_A) }) {
  const snapshotId = DEFAULT_API_PRICING_SNAPSHOT.snapshotId;
  const segmentId = `${profileId}|weekly|${WEEKLY_RESET}|${snapshotId}`;
  const observations = [];
  const accountingSamples = [];
  const start = Date.parse('2026-09-05T07:00:00.000Z');
  for (let index = 0; index < count; index += 1) {
    const usedPercent = count === 1 ? 0 : (index / (count - 1)) * 100;
    const observedAt = new Date(start + index * 60_000).toISOString();
    const observedTotalTokens = index * 10_000;
    const apiEquivalentCostUsd = observedTotalTokens / 100_000;
    observations.push({
      observedAt,
      provider: 'codex',
      profileId,
      kind: 'weekly',
      limitId: 'codex',
      windowMinutes: 10080,
      resetsAt: WEEKLY_RESET,
      segmentId,
      usedPercent
    });
    accountingSamples.push({
      observedAt,
      provider: 'codex',
      profileId,
      kind: 'weekly',
      limitId: 'codex',
      windowMinutes: 10080,
      resetsAt: WEEKLY_RESET,
      segmentId,
      usedPercent,
      sampleId: `${profileId}-weekly-${index}`,
      scopeVersion: '1',
      snapshotId,
      observedTotalTokens,
      pricedTokens: observedTotalTokens,
      unpricedTokens: 0,
      apiEquivalentCostUsd,
      pricingCoverage: 1,
      ...(unsettledAt.includes(index) ? { unsettled: true } : {})
    });
  }
  return { observations, accountingSamples };
}

function trimLinearWeekly(options) {
  const source = linearWeeklyArchive(options);
  const trimmed = trimCodexQuotaArchiveRows(source.observations, source.accountingSamples);
  assert.ok(trimmed.accountingSamples.length <= MAX_ARCHIVE_ROWS_PER_WINDOW);
  assert.ok(trimmed.observations.length <= MAX_ARCHIVE_ROWS_PER_WINDOW);
  assert.ok(trimmed.accountingSamples.length <= MAX_ARCHIVE_ROWS);
  const reloaded = normalizeCodexQuotaArchive({
    version: 1,
    observations: trimmed.observations,
    accountingSamples: trimmed.accountingSamples,
    scopes: {},
    windowState: {},
    lastProfileId: ''
  });
  assert.deepEqual(reloaded.accountingSamples, trimmed.accountingSamples);
  assert.deepEqual(reloaded.observations, trimmed.observations);
  return trimmed;
}

function assertTrimmedCycleHasGap(trimmed) {
  assert.equal(trimmed.accountingSamples[0].usedPercent, 0);
  assert.equal(trimmed.accountingSamples.at(-1).usedPercent, 100);
  assert.ok(trimmed.accountingSamples.some((row) => row.unsettled === true));
  const [estimate] = estimateRateLimitCapacities(trimmed.accountingSamples);
  assert.ok(estimate);
  assert.notEqual(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.notEqual(estimate.localTokens?.cycleBasis, 'full');
  assert.notEqual(estimate.status, 'stable');
}

test('retention keeps a middle unsettled marker so a gapped cycle cannot become stable', () => {
  const trimmed = trimLinearWeekly({ count: 300, unsettledAt: [20] });
  assertTrimmedCycleHasGap(trimmed);
  const keptPercents = trimmed.accountingSamples.map((row) => row.usedPercent);
  assert.ok(keptPercents.some((percent) => Math.abs(percent - (20 / 299) * 100) < 1e-9));
});

test('retention keeps an unsettled marker at early, middle and late positions', () => {
  for (const index of [2, 150, 297]) {
    const trimmed = trimLinearWeekly({ count: 300, unsettledAt: [index] });
    assertTrimmedCycleHasGap(trimmed);
  }
});

test('many integrity markers stay bounded and still prove the cycle has a gap', () => {
  const everyTenth = [];
  for (let index = 10; index < 300; index += 10) everyTenth.push(index);
  const many = trimLinearWeekly({ count: 300, unsettledAt: everyTenth });
  assertTrimmedCycleHasGap(many);
  assert.ok(many.accountingSamples.filter((row) => row.unsettled === true).length >= 1);
  assert.ok(many.accountingSamples.length <= MAX_ARCHIVE_ROWS_PER_WINDOW);

  const allUnsettled = Array.from({ length: 300 }, (_, index) => index);
  const compressed = trimLinearWeekly({ count: 300, unsettledAt: allUnsettled });
  assertTrimmedCycleHasGap(compressed);
  assert.ok(compressed.accountingSamples.length <= MAX_ARCHIVE_ROWS_PER_WINDOW);
});

test('a linear 0%→100% cycle without gaps can still become a stable full cycle after trim', () => {
  const trimmed = trimLinearWeekly({ count: 300, unsettledAt: [] });
  assert.equal(trimmed.accountingSamples.some((row) => row.unsettled === true), false);
  assert.equal(trimmed.accountingSamples[0].usedPercent, 0);
  assert.equal(trimmed.accountingSamples.at(-1).usedPercent, 100);
  const [estimate] = estimateRateLimitCapacities(trimmed.accountingSamples);
  assert.equal(estimate.method, FULL_CYCLE_ESTIMATE_METHOD);
  assert.equal(estimate.localTokens.cycleBasis, 'full');
  assert.equal(estimate.status, 'stable');
});

test('remainingUsd is 0 at 100% used and null while collecting or without capacity', () => {
  const collectingArchive = observeCodexQuota(emptyCodexQuotaArchive(), {
    device: deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }),
    observedAt: '2026-09-05T07:00:00.000Z'
  });
  const collecting = summary(collectingArchive, ACCOUNT_A, 'weekly');
  assert.equal(collecting.confidence, 'collecting');
  assert.equal(collecting.capacityUsd, null);
  assert.equal(collecting.remainingUsd, null);

  let archive = observeMany([
    deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 0, weeklyPercent: 0, tokens: 0 }),
    deviceAt({ at: '2026-09-05T08:00:00.000Z', sessionPercent: 50, weeklyPercent: 50, tokens: 5_000_000 })
  ]);
  const mid = summary(archive, ACCOUNT_A, 'weekly');
  assert.ok(mid.capacityUsd > 0);
  assert.ok(mid.remainingUsd > 0);
  assert.ok(Math.abs(mid.remainingUsd - mid.capacityUsd * 0.5) < 1e-6);

  archive = observeCodexQuota(archive, {
    device: deviceAt({ at: '2026-09-05T09:00:00.000Z', sessionPercent: 100, weeklyPercent: 100, tokens: 10_000_000 }),
    observedAt: '2026-09-05T09:00:00.000Z'
  });
  const full = summary(archive, ACCOUNT_A, 'weekly');
  assert.ok(full.capacityUsd > 0);
  assert.equal(full.remainingUsd, 0);

  const nextReset = '2026-09-15T00:00:00.000Z';
  const zeroDevice = deviceAt({
    at: '2026-09-08T01:00:00.000Z',
    sessionPercent: 0,
    weeklyPercent: 0,
    tokens: 10_000_000
  });
  zeroDevice.limits.providers[0].windows[1].resetsAt = nextReset;
  archive = observeCodexQuota(archive, { device: zeroDevice, observedAt: zeroDevice.updatedAt });
  const atZero = summary(archive, ACCOUNT_A, 'weekly');
  assert.ok(atZero.capacityUsd > 0);
  assert.equal(atZero.remainingUsd, atZero.capacityUsd);

  const unknown = observeMany([
    deviceAt({
      at: '2026-09-05T07:00:00.000Z',
      sessionPercent: 0,
      weeklyPercent: 0,
      tokens: 0,
      model: 'gpt-6-astra-preview'
    }),
    deviceAt({
      at: '2026-09-05T08:00:00.000Z',
      sessionPercent: 50,
      weeklyPercent: 50,
      tokens: 5_000_000,
      model: 'gpt-6-astra-preview'
    }),
    deviceAt({
      at: '2026-09-05T09:00:00.000Z',
      sessionPercent: 100,
      weeklyPercent: 100,
      tokens: 10_000_000,
      model: 'gpt-6-astra-preview'
    })
  ]);
  const invalid = summary(unknown, ACCOUNT_A, 'weekly');
  assert.equal(invalid.capacityUsd, null);
  assert.equal(invalid.remainingUsd, null);
});


// ---------------------------------------------------------------------------
// Per-client row-level component evidence (clientModelTokenComponents)
// ---------------------------------------------------------------------------

function codexAllTime(tokens, components, model = 'gpt-6-astra') {
  return {
    totalTokens: tokens,
    clients: { codex: tokens },
    models: { [model]: tokens },
    clientModels: { codex: { [model]: tokens } },
    clientModelTokenComponents: { codex: { [model]: components } }
  };
}

function deviceWithAllTime(allTime, { at, sessionPercent, weeklyPercent, accountKey = ACCOUNT_A }) {
  return {
    deviceId: 'local-device',
    updatedAt: at,
    allTime,
    limits: {
      updatedAt: at,
      providers: [{
        provider: 'codex',
        status: 'ok',
        accountKey,
        accountEmail: 'user@example.com',
        sourceDetail: 'rpc',
        sourceDeviceId: 'local-device',
        windows: [
          windowOf('session', sessionPercent),
          windowOf('weekly', weeklyPercent)
        ]
      }]
    }
  };
}

test('per-client evidence prices Codex components through the archive without any aggregate capability', () => {
  // No capabilities field, no global model component maps: the row-level
  // cross-product alone carries the proof. The aggregate-only path would mark
  // every token unclassified here.
  const componentsFor = (tokens) => ({
    input: Math.round(tokens * 0.65),
    output: Math.round(tokens * 0.2),
    cacheRead: Math.round(tokens * 0.1),
    cacheWrite: Math.round(tokens * 0.05),
    complete: true
  });
  const archive = observeMany([
    deviceWithAllTime(codexAllTime(1_000_000, componentsFor(1_000_000)), {
      at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10
    }),
    deviceWithAllTime(codexAllTime(2_000_000, componentsFor(2_000_000)), {
      at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 30
    })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.ok(weekly.pricedUsd > 0);
  assert.equal(weekly.coverage, 1);
  // input 650k*$10 + output 200k*$50 + cacheRead 100k*$1 + cacheWrite 50k*$12.50, per million
  assert.ok(Math.abs(weekly.pricedUsd - 17.225) < 1e-9);
});

test('unclassified rows of another client do not poison attributable Codex evidence', () => {
  const shared = 'gpt-6-astra';
  const at = (codexTokens) => ({
    totalTokens: codexTokens + 500_000,
    clients: { codex: codexTokens, claude: 500_000 },
    models: { [shared]: codexTokens + 500_000 },
    clientModels: { codex: { [shared]: codexTokens }, claude: { [shared]: 500_000 } },
    // Claude's aggregate row could not be decomposed, so the GLOBAL capability
    // and model maps are poisoned — exactly the shape the aggregate-only path
    // fails closed on. Codex's own rows still close, even on the shared model.
    modelUnclassifiedTokens: { [shared]: 500_000 },
    capabilities: { tokenComponents: false },
    clientModelTokenComponents: {
      codex: {
        [shared]: {
          input: Math.round(codexTokens * 0.65),
          output: Math.round(codexTokens * 0.2),
          cacheRead: Math.round(codexTokens * 0.1),
          cacheWrite: Math.round(codexTokens * 0.05),
          complete: true
        }
      },
      claude: { [shared]: { unclassified: 500_000, complete: false } }
    }
  });
  const archive = observeMany([
    deviceWithAllTime(at(1_000_000), { at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10 }),
    deviceWithAllTime(at(2_000_000), { at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 30 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 1_000_000);
  assert.ok(Math.abs(weekly.pricedUsd - 17.225) < 1e-9);
  assert.equal(weekly.coverage, 1);
});

test('per-client component claims beyond the trusted total fail closed for the whole row', () => {
  const overClose = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    clientModelTokenComponents: { codex: { 'gpt-6-astra': { input: 800, output: 300, complete: true } } }
  });
  assert.deepEqual(overClose.tokenComponents['gpt-6-astra'], { unclassified: 1000, complete: false });

  const partial = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    clientModelTokenComponents: { codex: { 'gpt-6-astra': { input: 600, output: 100, complete: true } } }
  });
  // Partial evidence prices its own share; the residue stays unpriced rather
  // than being reconstructed as input.
  assert.deepEqual(partial.tokenComponents['gpt-6-astra'], {
    input: 600, output: 100, cacheRead: 0, cacheWrite: 0, complete: false
  });
  const archive = observeMany([
    deviceWithAllTime(codexAllTime(1_000, { input: 600, output: 100, complete: true }), {
      at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10
    }),
    deviceWithAllTime(codexAllTime(2_000, { input: 1_200, output: 200, complete: true }), {
      at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 30
    })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.ok(Math.abs(weekly.pricedUsd - 0.011) < 1e-12);
  assert.equal(weekly.coverage, 0.7);
});

test('payloads without per-client components fall back to the conservative aggregate path', () => {
  // The pre-existing aggregate-only derivation is unchanged for old payloads:
  // an exclusive model with proven capability still recovers input from the
  // row-sum identity.
  const legacy = deriveCodexExclusiveUsage({
    clients: { codex: 1000 },
    models: { 'gpt-6-astra': 1000 },
    clientModels: { codex: { 'gpt-6-astra': 1000 } },
    modelCacheReads: { 'gpt-6-astra': 100 },
    modelCacheWrites: { 'gpt-6-astra': 50 },
    modelOutputs: { 'gpt-6-astra': 200 },
    capabilities: { tokenComponents: true }
  });
  assert.deepEqual(legacy.tokenComponents['gpt-6-astra'], {
    input: 650, output: 200, cacheRead: 100, cacheWrite: 50, complete: true
  });

  // A poisoned aggregate path (no per-client field, shared model, unproven
  // capability) must not fabricate a closure from the global maps.
  const poisoned = deriveCodexExclusiveUsage({
    clients: { codex: 1000, claude: 500 },
    models: { 'gpt-6-astra': 1500 },
    clientModels: { codex: { 'gpt-6-astra': 1000 }, claude: { 'gpt-6-astra': 500 } },
    modelUnclassifiedTokens: { 'gpt-6-astra': 500 },
    capabilities: { tokenComponents: false }
  });
  assert.deepEqual(poisoned.tokenComponents['gpt-6-astra'], { unclassified: 1000, complete: false });
});

test('full tick, watch tick and full tick price each increment exactly once', () => {
  const rowsPre = [{ client: 'Codex', model: 'gpt-6-astra', totalTokens: 500, inputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 50 }];
  const rowsA = [{ client: 'Codex', model: 'gpt-6-astra', totalTokens: 100, inputTokens: 60, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 10 }];
  const rowsB = [{ client: 'Codex', model: 'gpt-6-astra', totalTokens: 50, inputTokens: 30, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 5 }];
  const rowsC = [{ client: 'Codex', model: 'gpt-6-astra', totalTokens: 25, inputTokens: 15, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 }];

  // T1 full tick: the all-time scan already contains today's rowsA.
  const fullTick1 = extractUsageFromTokscale([...rowsPre, ...rowsA]);
  const anchorToday = extractUsageFromTokscale(rowsA);
  // T2 watch tick: only --today is rescanned (rowsA + rowsB); month/allTime
  // are derived through the anchor identity.
  const freshToday = extractUsageFromTokscale([...rowsA, ...rowsB]);
  const watchTick = applyPeriodDelta(fullTick1, freshToday, anchorToday);
  // The watch-derived components are identical to a full rescan of the same
  // span: the delta path neither drops nor double-counts component evidence.
  const rescanShared = extractUsageFromTokscale([...rowsPre, ...rowsA, ...rowsB]);
  assert.deepEqual(watchTick.clientModelTokenComponents, rescanShared.clientModelTokenComponents);
  assert.equal(watchTick.clientModels.codex['gpt-6-astra'], 650);
  // T3 full tick: a real rescan of everything through rowsC.
  const fullTick3 = extractUsageFromTokscale([...rowsPre, ...rowsA, ...rowsB, ...rowsC]);

  const archive = observeMany([
    deviceWithAllTime(fullTick1, { at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10 }),
    deviceWithAllTime(watchTick, { at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20 }),
    deviceWithAllTime(fullTick3, { at: '2026-09-05T07:10:00.000Z', sessionPercent: 30, weeklyPercent: 30 })
  ]);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  // rowsB (watch tick) + rowsC (full tick) = 75 tokens, credited exactly once.
  assert.equal(weekly.observedTokens, 75);
  // rowsB + rowsC components priced at the v6 snapshot rates, per million.
  const expectedUsd = (45 * 10 + 7 * 50 + 15 * 1 + 8 * 12.5) / 1_000_000;
  assert.ok(Math.abs(weekly.pricedUsd - expectedUsd) < 1e-12);
  assert.equal(weekly.coverage, 1);
});

test('an all-unclassified watermark reseeds on the first evidenced tick and prices only later growth', () => {
  // Tick 1 is the shape the previous build produced: no per-client components
  // and no aggregate capability, so the whole model row lands unclassified in
  // the scope watermark.
  const oldWatermarkAllTime = {
    totalTokens: 1_000_000,
    clients: { codex: 1_000_000 },
    models: { 'gpt-6-astra': 1_000_000 },
    clientModels: { codex: { 'gpt-6-astra': 1_000_000 } }
  };
  // Tick 2 (fixed build): +500k tokens whose per-client evidence closes.
  const evidencedAllTime = {
    totalTokens: 1_500_000,
    clients: { codex: 1_500_000 },
    models: { 'gpt-6-astra': 1_500_000 },
    clientModels: { codex: { 'gpt-6-astra': 1_500_000 } },
    clientModelTokenComponents: {
      codex: { 'gpt-6-astra': { input: 975_000, output: 300_000, cacheRead: 150_000, cacheWrite: 75_000, complete: true } }
    }
  };
  // Tick 3: +250k more, pure input growth.
  const grownAllTime = {
    totalTokens: 1_750_000,
    clients: { codex: 1_750_000 },
    models: { 'gpt-6-astra': 1_750_000 },
    clientModels: { codex: { 'gpt-6-astra': 1_750_000 } },
    clientModelTokenComponents: {
      codex: { 'gpt-6-astra': { input: 1_225_000, output: 300_000, cacheRead: 150_000, cacheWrite: 75_000, complete: true } }
    }
  };
  const archive = observeMany([
    deviceWithAllTime(oldWatermarkAllTime, { at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10 }),
    deviceWithAllTime(evidencedAllTime, { at: '2026-09-05T08:00:00.000Z', sessionPercent: 20, weeklyPercent: 20 }),
    deviceWithAllTime(grownAllTime, { at: '2026-09-05T09:00:00.000Z', sessionPercent: 30, weeklyPercent: 30 })
  ]);
  // The evidenced tick regressed the watermark's unclassified counter, so the
  // delta rolled back: a forced new segment with an unsettled baseline, and
  // the 500k boundary increment is never priced.
  const boundary = archive.accountingSamples.find((row) => row.unsettled === true);
  assert.ok(boundary);
  const scope = archive.scopes[scopeProfileId(ACCOUNT_A)];
  assert.equal(scope.pricedTokens, 250_000);
  const weekly = summary(archive, ACCOUNT_A, 'weekly');
  assert.equal(weekly.observedTokens, 250_000);
  assert.equal(weekly.pricedUsd, 2.5);
  assert.equal(weekly.coverage, 1);
});

test('per-client evidence prices the exact gpt-6-astra id and never fuzzy-matches similar names', () => {
  const priced = observeMany([
    deviceWithAllTime(codexAllTime(1_000_000, { input: 650_000, output: 200_000, cacheRead: 100_000, cacheWrite: 50_000, complete: true }), {
      at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10
    }),
    deviceWithAllTime(codexAllTime(2_000_000, { input: 1_300_000, output: 400_000, cacheRead: 200_000, cacheWrite: 100_000, complete: true }), {
      at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40
    })
  ]);
  const weekly = summary(priced, ACCOUNT_A, 'weekly');
  assert.ok(weekly.pricedUsd > 0);
  assert.equal(weekly.coverage, 1);

  const unknown = observeMany([
    deviceWithAllTime(codexAllTime(1_000_000, { input: 650_000, output: 200_000, cacheRead: 100_000, cacheWrite: 50_000, complete: true }, 'gpt-6-astra-preview'), {
      at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10
    }),
    deviceWithAllTime(codexAllTime(2_000_000, { input: 1_300_000, output: 400_000, cacheRead: 200_000, cacheWrite: 100_000, complete: true }, 'gpt-6-astra-preview'), {
      at: '2026-09-05T08:00:00.000Z', sessionPercent: 40, weeklyPercent: 40
    })
  ]);
  const weeklyUnknown = summary(unknown, ACCOUNT_A, 'weekly');
  assert.equal(weeklyUnknown.pricedUsd, null);
  assert.equal(weeklyUnknown.coverage, 0);
});
