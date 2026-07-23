'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  fetchOpenRouterLimits,
  openrouterToken
} = require('../../src/shared/openrouterLimits');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null }
  };
}

function apiFetch(keyBodies, creditsBodies = {}) {
  return async (url, init) => {
    const key = String(init.headers.Authorization).slice('Bearer '.length);
    if (url === OPENROUTER_KEY_URL) {
      const value = keyBodies[key];
      return value?.status ? response(value.status, value.body || {}) : response(200, { data: value });
    }
    assert.equal(url, OPENROUTER_CREDITS_URL);
    const value = creditsBodies[key];
    return value?.status ? response(value.status, value.body || {}) : response(200, { data: value });
  };
}

test('openrouterToken prefers explicit, then Token Monitor env, then standard env', () => {
  assert.equal(openrouterToken({ TOKEN_MONITOR_OPENROUTER_API_KEY: 'tm', OPENROUTER_API_KEY: 'std' }, '"explicit"'), 'explicit');
  assert.equal(openrouterToken({ TOKEN_MONITOR_OPENROUTER_API_KEY: 'tm', OPENROUTER_API_KEY: 'std' }), 'tm');
  assert.equal(openrouterToken({ OPENROUTER_API_KEY: "'std'" }), 'std');
});

test('fetchOpenRouterLimits exposes true key and credits denominators plus spend', async () => {
  const [provider] = await fetchOpenRouterLimits({
    openrouterProfiles: { personal: { apiKey: 'sk-or-personal', enabled: true } }
  }, {
    env: {},
    now: () => Date.parse('2026-07-23T08:00:00Z'),
    fetch: apiFetch({
      'sk-or-personal': {
        label: 'sk-or-v1-...',
        usage: 12,
        usage_daily: 1.25,
        usage_weekly: 4.5,
        usage_monthly: 9.75,
        limit: 30,
        limit_remaining: 18,
        limit_reset: 'monthly',
        is_management_key: true,
        is_free_tier: false
      }
    }, {
      'sk-or-personal': { total_credits: 100, total_usage: 40 }
    })
  });

  assert.equal(provider.provider, 'openrouter');
  assert.equal(provider.accountName, 'personal');
  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => [
    window.label,
    window.used,
    window.limit,
    window.remaining,
    window.showMeter,
    window.detail
  ]), [
    ['Monthly limit', 12, 30, 18, true, ''],
    ['Credits', 40, 100, 60, true, ''],
    ['Spend', null, null, null, false, 'Today $1.25 · Week $4.50 · Month $9.75 · All time $12.00']
  ]);
  assert.equal(provider.planLabel, 'Management');
  assert.equal(provider.balance.amount, 60);
  assert.equal(provider.balance.todaySpend, 1.25);
  assert.ok(!JSON.stringify(provider).includes('sk-or-personal'));
});

test('a standard key remains usable when the management credits endpoint is forbidden', async () => {
  const [provider] = await fetchOpenRouterLimits({
    openrouterProfiles: { standard: { apiKey: 'sk-standard', enabled: true } }
  }, {
    env: {},
    fetch: apiFetch({
      'sk-standard': {
        usage: 3,
        usage_daily: 0.5,
        usage_weekly: 1,
        usage_monthly: 2
      }
    }, {
      'sk-standard': { status: 403 }
    })
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.balance.amount, null);
  assert.deepEqual(provider.windows.map((window) => [window.label, window.showMeter]), [['Spend', false]]);
});

test('profiles and the official env key produce separate deduplicated accounts', async () => {
  const result = await fetchOpenRouterLimits({
    openrouterProfiles: {
      work: { apiKey: 'sk-work', enabled: true },
      duplicate: { apiKey: 'sk-env', enabled: true },
      disabled: { apiKey: 'sk-disabled', enabled: false }
    }
  }, {
    env: { OPENROUTER_API_KEY: 'sk-env' },
    fetch: apiFetch({
      'sk-work': { usage_monthly: 1 },
      'sk-env': { usage_monthly: 2 }
    }, {
      'sk-work': { status: 403 },
      'sk-env': { status: 403 }
    })
  });
  assert.deepEqual(result.map((provider) => provider.accountName), ['work', 'duplicate']);
});

test('scoped refresh fetches only the selected OpenRouter profile', async () => {
  const calls = [];
  const result = await fetchOpenRouterLimits({
    openrouterProfiles: {
      work: { apiKey: 'sk-work', enabled: true },
      personal: { apiKey: 'sk-personal', enabled: true }
    },
    limitRefreshScope: { provider: 'openrouter', accountName: 'personal' }
  }, {
    env: {},
    fetch: async (url, init) => {
      calls.push([url, init.headers.Authorization]);
      return url === OPENROUTER_KEY_URL
        ? response(200, { data: { usage_monthly: 2 } })
        : response(403, {});
    }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].accountName, 'personal');
  assert.ok(calls.every(([, authorization]) => authorization === 'Bearer sk-personal'));
});

test('both endpoints rejecting a key surfaces unauthorized', async () => {
  const [provider] = await fetchOpenRouterLimits({
    openrouterProfiles: { bad: { apiKey: 'sk-bad', enabled: true } }
  }, {
    env: {},
    fetch: async () => response(401, {})
  });
  assert.equal(provider.status, 'unauthorized');
});
