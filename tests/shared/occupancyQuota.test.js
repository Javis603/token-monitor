'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  accountEmailHash,
  collectQuotaCandidates,
  enrichOccupancyWithLimits,
  maskEmail,
  normalizeQuotaLink,
  resolveQuotaLink
} = require('../../src/shared/occupancyQuota');

function provider(overrides = {}) {
  return {
    provider: 'codex',
    accountKey: 'sha256:key-one',
    accountEmail: 'primary.user@example.com',
    accountLabel: 'Plus',
    status: 'ok',
    updatedAt: '2026-07-16T10:00:00.000Z',
    windows: [{ kind: 'weekly', remainingPercent: 42 }],
    ...overrides
  };
}

function stats(providers, device = {}) {
  return {
    updatedAt: '2026-07-16T10:01:00.000Z',
    devices: [{
      deviceId: 'windows-workstation',
      stale: false,
      limits: { updatedAt: '2026-07-16T10:00:00.000Z', providers },
      ...device
    }],
    limits: { providers: [] }
  };
}

test('normalizes explicit links and hashes provider-scoped email identities', () => {
  const hash = accountEmailHash('codex', ' Primary.User@example.com ');
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(hash, accountEmailHash('claude', 'primary.user@example.com'));
  assert.deepEqual(normalizeQuotaLink({ provider: 'CODEX', accountEmailHash: hash, accountLabel: 'Plus' }), {
    provider: 'codex', accountKey: '', accountEmailHash: hash, accountLabel: 'Plus'
  });
  assert.throws(() => normalizeQuotaLink({ provider: 'codex', accountLabel: 'Plus' }), /identity_required/);
});

test('collects per-device identities and exposes only masked candidate email', () => {
  const candidates = collectQuotaCandidates(stats([provider()]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceDeviceId, 'windows-workstation');
  assert.equal(candidates[0].maskedEmail, 'p***r@example.com');
  assert.equal(maskEmail('a@example.com'), 'a***@example.com');
});

test('exact account key wins before an email fallback', () => {
  const candidates = collectQuotaCandidates(stats([
    provider(),
    provider({ accountKey: 'sha256:key-two', updatedAt: '2026-07-16T11:00:00.000Z' })
  ]));
  const resolution = resolveQuotaLink({
    provider: 'codex',
    accountKey: 'sha256:key-one',
    accountEmailHash: accountEmailHash('codex', 'primary.user@example.com')
  }, candidates);
  assert.equal(resolution.matchBasis, 'account_key');
  assert.equal(resolution.candidate.accountKey, 'sha256:key-one');
});

test('email fallback refuses multiple distinct account keys unless label disambiguates', () => {
  const candidates = collectQuotaCandidates(stats([
    provider({ accountLabel: 'Plus' }),
    provider({ accountKey: 'sha256:key-two', accountLabel: 'Team' })
  ]));
  const hash = accountEmailHash('codex', 'primary.user@example.com');
  assert.equal(resolveQuotaLink({ provider: 'codex', accountEmailHash: hash }, candidates).linkState, 'ambiguous');
  const resolved = resolveQuotaLink({ provider: 'codex', accountEmailHash: hash, accountLabel: 'Team' }, candidates);
  assert.equal(resolved.matchBasis, 'account_email');
  assert.equal(resolved.candidate.accountLabel, 'Team');
});

test('email fallback refuses mixed keyed and keyless identities instead of silently rebinding', () => {
  const hash = accountEmailHash('codex', 'primary.user@example.com');
  const candidates = collectQuotaCandidates(stats([
    provider({ accountKey: 'sha256:key-one' }),
    provider({ accountKey: '', updatedAt: '2026-07-16T10:00:30.000Z' })
  ]));
  assert.equal(candidates.length, 2);
  assert.equal(resolveQuotaLink({ provider: 'codex', accountEmailHash: hash }, candidates).linkState, 'ambiguous');
});

test('email fallback keeps two keyless rows distinct and ambiguous', () => {
  const hash = accountEmailHash('codex', 'primary.user@example.com');
  const candidates = collectQuotaCandidates(stats([
    provider({ accountKey: '', sourceDeviceId: 'one' }),
    provider({ accountKey: '', sourceDeviceId: 'two', updatedAt: '2026-07-16T10:00:30.000Z' })
  ]));
  assert.equal(candidates.length, 2);
  assert.equal(resolveQuotaLink({ provider: 'codex', accountEmailHash: hash, accountLabel: 'Plus' }, candidates).linkState, 'ambiguous');
});

test('never auto-links a provider singleton or aliases ChatGPT to Codex', () => {
  const candidates = collectQuotaCandidates(stats([provider()]));
  assert.equal(resolveQuotaLink(null, candidates).linkState, 'unlinked');
  assert.equal(resolveQuotaLink({ provider: 'chatgpt', accountKey: 'sha256:key-one' }, candidates).linkState, 'missing');
});

test('raw device candidates preserve accounts hidden by aggregate provider collapse', () => {
  const rawStats = stats([
    provider({ provider: 'claude', accountKey: 'claude-one', accountEmail: 'one@example.com' }),
    provider({ provider: 'claude', accountKey: 'claude-two', accountEmail: 'two@example.com' })
  ]);
  rawStats.limits.providers = [provider({ provider: 'claude', accountKey: 'claude-two', accountEmail: 'two@example.com' })];
  const candidates = collectQuotaCandidates(rawStats);
  assert.deepEqual(candidates.map((candidate) => candidate.accountKey).sort(), ['claude-one', 'claude-two']);
});

test('enrichment keeps occupancy light separate and omits raw quota identity from the account quota', () => {
  const link = { provider: 'codex', accountKey: 'sha256:key-one' };
  const enriched = enrichOccupancyWithLimits({
    accounts: [{ id: 'gpt-pro', provider: 'chatgpt', light: 'yellow', quotaLink: link }]
  }, stats([provider({ windows: [{ kind: 'weekly', remainingPercent: 0 }] })]));
  const account = enriched.accounts[0];
  assert.equal(account.light, 'yellow');
  assert.equal(account.quota.light, 'red');
  assert.equal(account.quota.minimumRemainingPercent, 0);
  assert.equal(account.quota.accountKey, undefined);
  assert.equal(account.quota.accountEmail, undefined);
  assert.equal(account.quota.accountName, undefined);
});

test('quota freshness uses provider refresh cadence and keeps stale evidence gray', () => {
  const staleStats = stats([provider()], {
    limits: {
      updatedAt: '2026-07-16T10:00:00.000Z',
      refreshMs: 30_000,
      providers: [provider()]
    }
  });
  staleStats.updatedAt = '2026-07-16T10:02:00.001Z';
  const enriched = enrichOccupancyWithLimits({
    accounts: [{ id: 'gpt-pro', light: 'green', quotaLink: { provider: 'codex', accountKey: 'sha256:key-one' } }]
  }, staleStats);
  assert.equal(enriched.accounts[0].quota.linkState, 'stale');
  assert.equal(enriched.accounts[0].quota.light, 'gray');
});

test('fresh same-key evidence wins over a stale device copy', () => {
  const shared = provider();
  const multiDeviceStats = {
    updatedAt: '2026-07-16T10:01:00.000Z',
    devices: [
      { deviceId: 'offline', stale: true, limits: { providers: [shared] } },
      { deviceId: 'online', stale: false, limits: { providers: [provider({ updatedAt: '2026-07-16T10:00:30.000Z' })] } }
    ],
    limits: { providers: [] }
  };
  const resolution = resolveQuotaLink(
    { provider: 'codex', accountKey: 'sha256:key-one' },
    collectQuotaCandidates(multiDeviceStats)
  );
  assert.equal(resolution.linkState, 'linked');
  assert.equal(resolution.candidate.sourceDeviceId, 'online');
});
