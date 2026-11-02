'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchAntigravityLimits, fetchClaudeLimits, mapCodexRateLimitsToProvider } = require('../../src/shared/limits/collector');

function codexProviderForPlan(plan) {
  return mapCodexRateLimitsToProvider({
    account: { planType: plan },
    rateLimits: {
      primary: {
        usedPercent: 12,
        resetsAt: '2026-06-01T00:00:00Z',
        windowDurationMins: 300
      }
    }
  }, { updatedAt: '2026-06-01T00:00:00Z' });
}

async function claudeProviderForCredentials(oauth) {
  return fetchClaudeLimits({}, {
    platform: 'linux',
    claudeCredentialPath: '/tmp/claude-credentials.json',
    stat: async () => ({ mtimeMs: 1 }),
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'access-token', ...oauth } }),
    fetch: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/api/oauth/profile')
        ? {
            account: { uuid: 'account-plan-test', email: 'owner@example.com' },
            organization: { uuid: 'organization-plan-test', name: 'Plan Test' }
          }
        : {
            five_hour: {
              utilization: 18,
              resets_at: '2026-06-01T00:00:00Z'
            }
          }
    })
  });
}

test('Codex plan labels show the Pro tiers by their monthly price', () => {
  assert.equal(codexProviderForPlan('pro').accountLabel, 'Pro 200');
  assert.equal(codexProviderForPlan('Codex Pro').accountLabel, 'Pro 200');
  assert.equal(codexProviderForPlan('OpenAI Codex Pro').accountLabel, 'Pro 200');
  assert.equal(codexProviderForPlan('prolite').accountLabel, 'Pro 100');
  assert.equal(codexProviderForPlan('pro_lite').accountLabel, 'Pro 100');
  assert.equal(codexProviderForPlan('pro-lite').accountLabel, 'Pro 100');
  assert.equal(codexProviderForPlan('Codex Pro Lite').accountLabel, 'Pro 100');
  assert.equal(codexProviderForPlan('promax').accountLabel, 'Pro 500');
  assert.equal(codexProviderForPlan('pro_max').accountLabel, 'Pro 500');
  assert.equal(codexProviderForPlan('pro-max').accountLabel, 'Pro 500');
  assert.equal(codexProviderForPlan('Codex Pro Max').accountLabel, 'Pro 500');
});

test('Codex plan labels compact common enterprise identifiers and humanize fallback identifiers', () => {
  assert.equal(codexProviderForPlan('free').accountLabel, 'Free');
  assert.equal(codexProviderForPlan('enterprise_cbp_usage_based').accountLabel, 'Enterprise');
  assert.equal(codexProviderForPlan('self_serve_business_usage_based').accountLabel, 'Business');
});

test('Claude plan labels use current names for legacy Max tiers without relabeling Team', async () => {
  const max = await claudeProviderForCredentials({
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x'
  });
  assert.equal(max.accountLabel, 'Ultra');

  const team = await claudeProviderForCredentials({
    subscriptionType: 'team',
    rateLimitTier: 'default_claude_max_5x'
  });
  assert.equal(team.accountLabel, 'Team');
});

test('Claude plan labels can fall back to rate limit tier when subscription type is absent', async () => {
  const provider = await claudeProviderForCredentials({
    rateLimitTier: 'default_claude_max_5x'
  });
  assert.equal(provider.accountLabel, 'Max');
});

test('Claude plan labels accept current names and legacy subscription labels', async () => {
  for (const [subscriptionType, accountLabel] of [
    ['max', 'Max'], ['ultra', 'Ultra'], ['max_5x', 'Max'], ['max_20x', 'Ultra']
  ]) {
    const provider = await claudeProviderForCredentials({ subscriptionType });
    assert.equal(provider.accountLabel, accountLabel);
  }
  const provider = await claudeProviderForCredentials({ rateLimitTier: 'default_claude_max_20x' });
  assert.equal(provider.accountLabel, 'Ultra');
});

test('Antigravity plan labels compact Google AI plan names for the provider row', async () => {
  async function antigravityLabel(accountPlan) {
    const provider = await fetchAntigravityLimits({}, {
      antigravityProbe: async () => ({
        accountPlan,
        accountEmail: 'a@b.com',
        pools: [
          { name: 'Gemini Pro', remainingFraction: 0.5, resetTime: null }
        ]
      })
    });
    return provider.accountLabel;
  }

  assert.equal(await antigravityLabel('Google AI Pro'), 'Pro');
  assert.equal(await antigravityLabel('Google AI Ultra'), 'Ultra');
  assert.equal(await antigravityLabel('Pro'), 'Pro');
});
