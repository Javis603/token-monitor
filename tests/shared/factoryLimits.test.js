'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { hashKey } = require('../../src/shared/hashKey');
const {
  factoryEnvApiKey,
  factoryLegacyPercent,
  fetchFactoryLimits,
  resolveFactoryAutomaticApiKey
} = require('../../src/shared/providers/factory/limits');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('Factory token-rate API uses the explicit key and maps identity, quotas, and balance', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-limits-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const factoryDir = path.join(homeDir, '.factory');
  fs.mkdirSync(factoryDir);
  fs.writeFileSync(path.join(factoryDir, '.env'), 'FACTORY_API_KEY=file-key\n');

  const now = Date.parse('2026-09-12T12:00:00Z');
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer settings-key');
    assert.equal(init.headers.Referer, 'https://app.factory.ai/');
    if (url.endsWith('/api/app/auth/me')) {
      return jsonResponse(200, {
        organization: { name: 'Factory Team', subscription: { factoryTier: 'team' } },
        userProfile: { id: 'user-1', email: 'dev@example.com' }
      });
    }
    if (url.endsWith('/api/billing/limits')) {
      return jsonResponse(200, {
        usesTokenRateLimitsBilling: true,
        limits: {
          standard: {
            fiveHour: { usedPercent: 12.5, secondsRemaining: 1800 },
            weekly: { usedPercent: 25, windowEnd: '2026-09-14T12:00:00Z' },
            monthly: { usedPercent: 40, windowEnd: 1788192000000 }
          },
          core: {
            fiveHour: { usedPercent: 5, secondsRemaining: 900 },
            weekly: { usedPercent: 10 },
            monthly: { usedPercent: 0, secondsRemaining: 1e300 }
          }
        },
        extraUsageBalanceCents: 1234
      });
    }
    return jsonResponse(404, {});
  };

  assert.deepEqual(
    resolveFactoryAutomaticApiKey({ homeDir }, { env: { FACTORY_API_KEY: 'env-key' }, homeDir }),
    { apiKey: 'env-key', source: 'env' }
  );
  assert.equal(factoryEnvApiKey({ homeDir }, { env: { FACTORY_API_KEY: 'env-key' }, homeDir }), 'env-key');
  const result = await fetchFactoryLimits({ factoryApiKey: " 'settings-key' ", homeDir }, {
    env: { FACTORY_API_KEY: 'env-key' },
    fetch,
    homeDir,
    now: () => now
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.accountKey, hashKey('factory', 'user-1'));
  assert.equal(result.accountEmail, 'dev@example.com');
  assert.equal(result.accountName, 'Factory Team');
  assert.equal(result.planLabel, 'Team');
  assert.deepEqual(result.windows.map(({ label, kind, additional }) => ({ label, kind, additional })), [
    { label: '5-hour', kind: 'session', additional: undefined },
    { label: 'Core 5-hour', kind: 'session', additional: true },
    { label: 'Weekly', kind: 'weekly', additional: undefined },
    { label: 'Core Weekly', kind: 'weekly', additional: true },
    { label: 'Monthly', kind: 'billing', additional: undefined },
    { label: 'Core Monthly', kind: 'billing', additional: true },
    { label: 'Balance', kind: 'billing', additional: undefined }
  ]);
  assert.equal(result.windows[0].resetsAt, '2026-09-12T12:30:00.000Z');
  assert.equal(result.windows[5].resetsAt, null);
  assert.equal(result.balance.amount, 12.34);
  assert.equal(result.balance.currency, 'USD');
  assert.equal(urls.some((url) => url.includes('/api/organization/subscription/usage')), false);
  assert.equal(JSON.stringify(result).includes('settings-key'), false);
});

test('Factory follows legacy usage when the billing flag is false despite prefilled standard limits', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-limits-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const factoryDir = path.join(homeDir, '.factory');
  fs.mkdirSync(factoryDir);
  fs.writeFileSync(path.join(factoryDir, '.env'), "  export FACTORY_API_KEY='factory-api-key' # Droid key\n");

  assert.deepEqual(
    resolveFactoryAutomaticApiKey({ homeDir }, { env: {}, homeDir }),
    { apiKey: 'factory-api-key', source: 'droid-env' }
  );

  assert.equal(factoryLegacyPercent({ userTokens: 250, totalAllowance: 1000, usedRatio: 0 }), 25);
  assert.equal(factoryLegacyPercent({ totalAllowance: 1e20, usedRatio: 25 }), 25);

  const fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer factory-api-key');
    if (url.endsWith('/api/app/auth/me')) {
      return jsonResponse(200, {
        organization: { name: 'Factory Team', subscription: { factoryTier: 'team' } },
        userProfile: { id: 'user-1', email: 'dev@example.com' }
      });
    }
    if (url.endsWith('/api/billing/limits')) {
      return jsonResponse(200, {
        usesTokenRateLimitsBilling: false,
        limits: {
          standard: {
            fiveHour: { usedPercent: 99, secondsRemaining: 60 }
          }
        }
      });
    }
    if (url.includes('/api/organization/subscription/usage')) {
      return jsonResponse(200, {
        usage: {
          endDate: 1789344000000,
          standard: { userTokens: 250, totalAllowance: 1000, usedRatio: 0.25 },
          premium: { userTokens: 50, totalAllowance: 100, usedRatio: 0.5 }
        }
      });
    }
    return jsonResponse(404, {});
  };

  const result = await fetchFactoryLimits({ homeDir }, {
    env: {},
    fetch,
    homeDir,
    now: () => Date.parse('2026-09-12T12:00:00Z')
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'api');
  assert.equal(result.planLabel, 'Team');
  assert.deepEqual(result.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: 'Standard', usedPercent: 25 },
    { label: 'Premium', usedPercent: 50 }
  ]);
});

test('Factory refuses an oversized local .env and does not read Droid auth files', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-limits-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const factoryDir = path.join(homeDir, '.factory');
  fs.mkdirSync(factoryDir);
  fs.writeFileSync(path.join(factoryDir, '.env'), Buffer.alloc((256 * 1024) + 1, 65));
  fs.writeFileSync(path.join(factoryDir, 'auth.v2.loginkeychain'), JSON.stringify({ accessToken: 'oauth-token' }));

  assert.deepEqual(resolveFactoryAutomaticApiKey({ homeDir }, { env: {}, homeDir }), { apiKey: '', source: '' });
  assert.equal(factoryEnvApiKey({ homeDir }, { env: {}, homeDir }), '');
  let fetchCalls = 0;
  const result = await fetchFactoryLimits({ homeDir }, {
    env: {},
    homeDir,
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse(500, {});
    }
  });
  assert.equal(result.status, 'notConfigured');
  assert.equal(fetchCalls, 0);
});

test('Factory preserves classified API failures across host and endpoint fallbacks', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [429, 'sourceRateLimited']]) {
    const fetch = async (url) => jsonResponse(
      url.startsWith('https://api.factory.ai/api/app/auth/me') ? status : 404,
      {}
    );
    await assert.rejects(
      fetchFactoryLimits({ factoryApiKey: 'factory-api-key' }, { env: {}, fetch }),
      (error) => error?.status === expected
    );
  }

  await assert.rejects(
    fetchFactoryLimits({ factoryApiKey: 'factory-api-key' }, {
      env: {},
      fetch: async (url) => jsonResponse(
        url.endsWith('/api/billing/limits') ? 429 : 200,
        {}
      )
    }),
    (error) => error?.status === 'sourceRateLimited'
  );
});

test('Factory aborts hung requests and stalled response bodies within its deadline', async () => {
  for (const stalledFetch of [
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
    async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) })
  ]) {
    await assert.rejects(
      fetchFactoryLimits({ factoryApiKey: 'factory-api-key' }, {
        env: {},
        factoryFetchTimeoutMs: 5,
        fetch: stalledFetch
      }),
      (error) => error?.status === 'timeout'
    );
  }
});
