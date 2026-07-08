'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  copilotToken,
  normalizedEnterpriseHost,
  copilotApiHost,
  copilotUsageUrl,
  parseQuotaSnapshot,
  isPlaceholder,
  parseCopilotUsageResponse,
  parseQuotaResetDate,
  mapCopilotUsageToProvider,
  fetchCopilotLimits
} = require('../../src/shared/copilotLimits');
const { parseLimitProviders } = require('../../src/shared/limitCollector');

test('parseLimitProviders includes Copilot in the default provider set', () => {
  assert.deepEqual(
    parseLimitProviders(),
    ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'deepseek', 'minimax', 'grok', 'copilot', 'kiro', 'zai', 'volcengine', 'qoder', 'zaiteam']
  );
});

test('copilotToken prefers explicit settings over env', () => {
  assert.equal(copilotToken({ COPILOT_API_TOKEN: 'env-token' }, { copilotApiToken: 'settings-token' }), 'settings-token');
  assert.equal(copilotToken({ COPILOT_API_TOKEN: 'env-token' }), 'env-token');
});

test('copilotToken accepts CodexBar-compatible Copilot env names only', () => {
  assert.equal(copilotToken({ GITHUB_COPILOT_TOKEN: '  "gho-copilot"  ' }), 'gho-copilot');
  assert.equal(copilotToken({ GITHUB_TOKEN: 'gho-generic' }), '');
});

test('normalizedEnterpriseHost accepts hostnames and URLs', () => {
  assert.equal(normalizedEnterpriseHost(''), 'github.com');
  assert.equal(normalizedEnterpriseHost('https://octocorp.ghe.com/login'), 'octocorp.ghe.com');
  assert.equal(copilotApiHost('octocorp.ghe.com'), 'api.octocorp.ghe.com');
  assert.equal(copilotUsageUrl('octocorp.ghe.com'), 'https://api.octocorp.ghe.com/copilot_internal/user');
});

test('parseQuotaSnapshot derives percent remaining from entitlement and remaining', () => {
  const snapshot = parseQuotaSnapshot({
    entitlement: 500,
    remaining: 450,
    quota_id: 'premium_interactions'
  });
  assert.equal(snapshot.percentRemaining, 90);
  assert.equal(snapshot.hasPercentRemaining, true);
});

test('isPlaceholder drops zero-entitlement business billing placeholders', () => {
  const snapshot = parseQuotaSnapshot({
    entitlement: 0,
    remaining: 0,
    percent_remaining: 100,
    quota_id: 'premium_interactions'
  });
  assert.equal(isPlaceholder(snapshot), true);
});

test('parseCopilotUsageResponse maps premium and chat windows', () => {
  const usage = parseCopilotUsageResponse({
    copilot_plan: 'pro',
    quota_reset_date: '2026-07-01',
    quota_snapshots: {
      premium_interactions: {
        entitlement: 500,
        remaining: 400,
        percent_remaining: 80,
        quota_id: 'premium_interactions'
      },
      chat: {
        entitlement: 300,
        remaining: 150,
        percent_remaining: 50,
        quota_id: 'chat'
      }
    }
  });
  assert.equal(usage.copilotPlan, 'pro');
  assert.equal(usage.premium.remaining, 400);
  assert.equal(usage.chat.remaining, 150);
});

test('parseCopilotUsageResponse falls back to monthly and limited quotas', () => {
  const usage = parseCopilotUsageResponse({
    copilot_plan: 'free',
    monthly_quotas: { chat: 500, completions: 300 },
    limited_user_quotas: { chat: 125, completions: 60 }
  });
  assert.equal(usage.chat.percentRemaining, 25);
  assert.equal(usage.premium.percentRemaining, 20);
});

test('parseCopilotUsageResponse keeps unlimited chat quotas', () => {
  const usage = parseCopilotUsageResponse({
    copilot_plan: 'individual',
    quota_snapshots: {
      chat_messages: {
        entitlement: 0,
        remaining: 0,
        quota_id: 'chat_messages',
        unlimited: true
      }
    }
  });
  assert.equal(usage.premium, null);
  assert.equal(usage.chat.unlimited, true);
  assert.equal(usage.chat.percentRemaining, 100);
});

test('mapCopilotUsageToProvider renders Premium and Chat windows', () => {
  const provider = mapCopilotUsageToProvider({
    premium: parseQuotaSnapshot({
      entitlement: 500,
      remaining: 400,
      percent_remaining: 80,
      quota_id: 'premium_interactions'
    }),
    chat: parseQuotaSnapshot({
      entitlement: 300,
      remaining: 150,
      percent_remaining: 50,
      quota_id: 'chat'
    }),
    copilotPlan: 'pro',
    tokenBasedBilling: false,
    quotaResetDate: '2026-07-01'
  }, {
    accountKey: 'sha256:test',
    updatedAt: '2026-06-25T00:00:00.000Z',
    source: 'api'
  });

  assert.equal(provider.provider, 'copilot');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Pro');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[0].kind, 'billing');
  assert.equal(provider.windows[0].label, 'Premium');
  assert.equal(provider.windows[0].usedPercent, 20);
  assert.equal(provider.windows[1].kind, 'billing');
  assert.equal(provider.windows[1].label, 'Chat');
  assert.equal(provider.windows[1].usedPercent, 50);
  assert.equal(parseQuotaResetDate('2026-07-01'), provider.windows[0].resetsAt);
});

test('mapCopilotUsageToProvider marks token-based billing without quotas unavailable', () => {
  const provider = mapCopilotUsageToProvider({
    premium: null,
    chat: null,
    copilotPlan: 'business',
    tokenBasedBilling: true,
    quotaResetDate: null
  }, { updatedAt: '2026-06-25T00:00:00.000Z' });
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.accountLabel, 'Business');
  assert.deepEqual(provider.windows, []);
});

test('fetchCopilotLimits returns notConfigured without a token', async () => {
  const provider = await fetchCopilotLimits({}, { env: {}, now: () => Date.parse('2026-06-25T00:00:00.000Z') });
  assert.equal(provider.provider, 'copilot');
  assert.equal(provider.status, 'notConfigured');
});

test('fetchCopilotLimits uses the GitHub OAuth token directly for Copilot internal usage', async () => {
  const authorizations = [];
  const provider = await fetchCopilotLimits(
    { copilotApiToken: 'gho-token' },
    {
      env: {},
      now: () => Date.parse('2026-06-25T00:00:00.000Z'),
      fetch: async (url, init) => {
        authorizations.push(init.headers.Authorization);
        if (String(url).includes('/copilot_internal/user')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              copilot_plan: 'free',
              quota_reset_date: '2026-07-01',
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 500,
                  remaining: 450,
                  percent_remaining: 90,
                  quota_id: 'premium_interactions'
                },
                chat: {
                  entitlement: 300,
                  remaining: 150,
                  percent_remaining: 50,
                  quota_id: 'chat'
                }
              }
            })
          };
        }
        if (String(url) === 'https://api.github.com/user') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ login: 'octocat', id: 42 })
          };
        }
        throw new Error(`unexpected fetch url: ${url}`);
      }
    }
  );

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountName, 'octocat');
  assert.equal(provider.accountLabel, 'Free');
  assert.equal(provider.accountEmail, '');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[0].usedPercent, 10);
  assert.equal(provider.windows[1].usedPercent, 50);
  assert.equal(authorizations[0], 'token gho-token');
  assert.equal(authorizations[1], 'token gho-token');
});

test('fetchCopilotLimits surfaces unauthorized responses', async () => {
  const provider = await fetchCopilotLimits(
    { copilotApiToken: 'bad-token' },
    {
      env: {},
      now: () => Date.parse('2026-06-25T00:00:00.000Z'),
      fetch: async () => ({
        ok: false,
        status: 401,
        json: async () => ({})
      })
    }
  );
  assert.equal(provider.status, 'unauthorized');
});
