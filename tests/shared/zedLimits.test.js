'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  DEFAULT_ZED_API_URL,
  accountKey,
  fetchZedLimits,
  managedAccountsForCollector,
  normalizeZedAccessToken,
  normalizeZedServerUrl,
  normalizeZedUserId,
  normalizeManagedAccounts,
  parseZedResponse,
  zedApiUrl
} = require('../../src/shared/zedLimits');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function accountBody(limit = 1000) {
  return {
    user: { id: 42, github_login: 'zed-user', name: 'Zed User' },
    plan: {
      plan_v3: 'zed_pro',
      subscription_period: {
        started_at: '2026-08-01T00:00:00Z',
        ended_at: '2026-09-01T00:00:00Z'
      },
      usage: { edit_predictions: { used: 250, limit } },
      has_overdue_invoices: false
    }
  };
}

test('Zed credential inputs reject header injection and invalid server URLs', () => {
  assert.equal(normalizeZedUserId(' 42 '), '42');
  assert.equal(normalizeZedUserId('42 user'), '');
  assert.equal(normalizeZedAccessToken(' token-value '), 'token-value');
  assert.equal(normalizeZedAccessToken('token\r\ninjected'), '');
  assert.equal(normalizeZedServerUrl('https://zed.dev/'), 'https://zed.dev');
  assert.equal(normalizeZedServerUrl('http://zed.dev'), '');
  assert.equal(normalizeZedServerUrl('https://zed.dev/redirect'), '');
  assert.equal(zedApiUrl('https://zed.dev'), DEFAULT_ZED_API_URL);
  assert.equal(zedApiUrl('https://zed.example'), 'https://zed.example/client/users/me');
});

test('Zed limits do not read operating-system credential stores', () => {
  const source = fs.readFileSync(require.resolve('../../src/shared/zedLimits'), 'utf8');
  assert.doesNotMatch(source, /\bsecurity\b|secret-tool|CredRead|Credential Manager|Keychain|koffi/u);
});

test('Zed response maps finite edit-prediction quota and billing-cycle progress', () => {
  const parsed = parseZedResponse(accountBody({ limited: 1000 }), Date.parse('2026-08-16T12:00:00Z'));
  assert.equal(parsed.planLabel, 'Zed Pro');
  assert.deepEqual(parsed.windows, [{
    kind: 'billing',
    limitId: 'zed.edit-predictions',
    label: 'Edit Predictions',
    used: 250,
    limit: 1000,
    remaining: 750,
    usedPercent: 25,
    resetDescription: '250 / 1000 predictions',
    detail: '250 / 1000 predictions',
    showMeter: true
  }, {
    kind: 'billing',
    limitId: 'zed.billing-cycle',
    label: 'Billing cycle',
    usedPercent: 50,
    resetsAt: '2026-09-01T00:00:00.000Z',
    showMeter: true
  }]);
});

test('Zed response presents unlimited edit predictions as a full meter', () => {
  const parsed = parseZedResponse(accountBody('unlimited'));
  assert.equal(parsed.windows[0].detail, 'Unlimited');
  assert.equal(parsed.windows[0].showMeter, true);
  assert.equal(parsed.windows[0].usedPercent, 0);
  assert.equal(parsed.windows[0].limit, null);
});

test('Zed response adds an overdue invoice warning without replacing quota windows', () => {
  const body = accountBody('unlimited');
  body.plan.has_overdue_invoices = true;
  const parsed = parseZedResponse(body, Date.parse('2026-08-16T12:00:00Z'));
  assert.equal(parsed.overdue, true);
  assert.deepEqual(parsed.windows[2], {
    kind: 'billing',
    limitId: 'zed.overdue-invoices',
    label: 'Billing',
    resetDescription: 'Overdue invoices',
    detail: 'Overdue invoices',
    showMeter: false
  });
});

test('Zed response omits an invalid optional subscription period without dropping quota', () => {
  const body = accountBody();
  body.plan.subscription_period.started_at = 'invalid';
  const parsed = parseZedResponse(body);
  assert.deepEqual(parsed.windows.map((window) => window.limitId), ['zed.edit-predictions']);
});

test('Zed response requires an account identity before accepting quota data', () => {
  const body = accountBody();
  delete body.user.id;
  assert.throws(() => parseZedResponse(body), /unexpected Zed account response shape/);
});

test('manual Zed probe sends user ID plus access token and returns normalized limits', async () => {
  let request;
  const [provider] = await fetchZedLimits({
    zedUserId: '42',
    zedAccessToken: 'zed-access-token',
    zedServerUrl: 'https://zed.dev'
  }, {
    env: {},
    now: () => Date.parse('2026-08-15T12:00:00Z'),
    fetch: async (url, init) => {
      request = { url, init };
      return response(accountBody());
    }
  });

  assert.equal(request.url, DEFAULT_ZED_API_URL);
  assert.equal(request.init.headers.Authorization, '42 zed-access-token');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(provider.provider, 'zed');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.equal(provider.sourceDetail, 'managed');
  assert.equal(provider.accountName, 'zed-user');
  assert.equal(provider.planLabel, 'Zed Pro');
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[0].limitId, 'zed.edit-predictions');
  assert.equal(provider.windows[0].remainingPercent, 75);
  assert.equal(provider.windows[0].resetsAt, null);
  assert.equal(provider.windows[1].limitId, 'zed.billing-cycle');
  assert.equal(provider.windows[1].resetsAt, '2026-09-01T00:00:00.000Z');
});

test('Zed probe distinguishes missing, rejected, throttled, and unavailable credentials', async () => {
  const base = { zedUserId: '42', zedAccessToken: 'token' };
  const missing = await fetchZedLimits({}, { env: {} });
  const [unauthorized] = await fetchZedLimits(base, { env: {}, fetch: async () => response({}, 401) });
  const [limited] = await fetchZedLimits(base, { env: {}, fetch: async () => response({}, 429) });
  const [unavailable] = await fetchZedLimits(base, { env: {}, fetch: async () => response({}, 500) });
  assert.equal(missing.status, 'notConfigured');
  assert.equal(unauthorized.status, 'unauthorized');
  assert.equal(limited.status, 'sourceRateLimited');
  assert.equal(unavailable.status, 'unavailable');
});

test('Zed managed accounts keep credentials outside renderer metadata and probe independently', async () => {
  const metadata = normalizeManagedAccounts([
    { id: 'zed-one', userId: '42', accountName: 'one', enabled: true },
    { id: 'zed-two', userId: '84', accountName: 'two', enabled: false }
  ]);
  assert.equal(metadata.length, 2);
  assert.equal(Object.hasOwn(metadata[0], 'credentials'), false);
  const collector = managedAccountsForCollector(metadata, (id) => (
    id === 'zed-one' ? { userId: 'ignored', accessToken: 'token-one' } : { accessToken: 'token-two' }
  ));
  const providers = await fetchZedLimits({ zedManagedAccounts: collector }, {
    env: {},
    fetch: async (_url, init) => {
      assert.equal(init.headers.Authorization, '42 token-one');
      return response(accountBody());
    }
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountKey, accountKey('42'));
  assert.equal(providers[0].status, 'ok');
});
