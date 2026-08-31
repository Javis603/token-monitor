'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const antigravityOAuth = require('../../src/shared/antigravityOAuth');
const antigravityProbe = require('../../src/shared/antigravityProbe');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function fixtureOAuthClient(id, marker) {
  return {
    clientId: `${id}-${marker.repeat(4)}` + '.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-' + marker.repeat(28)
  };
}

test('authorizationUrl requests offline Google access with state and Antigravity scopes', () => {
  const url = new URL(antigravityOAuth.authorizationUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:1234/oauth-callback',
    state: 'random-state'
  }));
  assert.equal(url.origin + url.pathname, antigravityOAuth.AUTH_URL);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'select_account consent');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.deepEqual(url.searchParams.get('scope').split(' '), [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
  ]);
});

test('parseClientFromText selects the OAuth client next to the Antigravity module marker', () => {
  const oldClient = fixtureOAuthClient('111', 'a');
  const liveClient = fixtureOAuthClient('222', 'b');
  const client = antigravityOAuth.parseClientFromText(`
    ${oldClient.clientId} ${oldClient.clientSecret}
    vs/platform/cloudCode/common/oauthClient.js
    ${liveClient.clientId} ${liveClient.clientSecret}
  `);
  assert.deepEqual(client, liveClient);
});

test('parseClientFromText prefers the Antigravity Hub client when multiple clients are embedded', () => {
  const otherClient = fixtureOAuthClient('111', 'a');
  const officialClient = antigravityOAuth._officialOAuthClient();
  const client = antigravityOAuth.parseClientFromText(`
    ${otherClient.clientId} ${otherClient.clientSecret}
    ${officialClient.clientId}
    ${officialClient.clientSecret}
  `);
  assert.deepEqual(client, officialClient);
});

test('exchangeAuthorizationCode and refreshCredential preserve the refresh token', async () => {
  const requests = [];
  const exchanged = await antigravityOAuth.exchangeAuthorizationCode({
    code: 'code',
    client: { clientId: 'client', clientSecret: 'secret' },
    redirectUri: 'http://127.0.0.1/callback'
  }, {
    now: () => 1000,
    fetch: async (url, init) => {
      requests.push([url, init]);
      return response(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1 });
    }
  });
  let renewed = null;
  const refreshed = await antigravityOAuth.refreshCredential(exchanged, {
    now: () => 3000,
    onCredentialRenewed: async (next) => { renewed = next; },
    fetch: async (url, init) => {
      requests.push([url, init]);
      return response(200, { access_token: 'access-2', expires_in: 3600 });
    }
  });
  assert.equal(refreshed.accessToken, 'access-2');
  assert.equal(refreshed.refreshToken, 'refresh-1');
  assert.deepEqual(renewed, refreshed);
  assert.match(requests[0][1].body, /grant_type=authorization_code/);
  assert.match(requests[1][1].body, /grant_type=refresh_token/);
});

test('fetchRemoteSnapshot follows the Antigravity Hub daily onboarding protocol', async () => {
  const requests = [];
  const waits = [];
  let renewed = null;
  let onboardAttempts = 0;
  const snapshot = await antigravityOAuth.fetchRemoteSnapshot({
    id: 'account-1',
    accountEmail: 'user@example.com',
    credentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      clientId: 'client',
      clientSecret: 'secret'
    }
  }, {
    collapsePools: antigravityProbe._collapsePools,
    quotaSummaryWindows: antigravityProbe._quotaSummaryWindows,
    delay: async (ms) => { waits.push(ms); },
    onCredentialRenewed: async (_account, credential) => { renewed = credential; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, headers: init.headers, body });
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') {
        return response(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] });
      }
      if (url === 'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser') {
        onboardAttempts += 1;
        if (onboardAttempts === 1) return response(200, { done: false });
        return response(200, {
          done: true,
          response: { cloudaicompanionProject: { value: 'project-1' } }
        });
      }
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary') {
        return response(200, {
          groups: [{
            displayName: 'Gemini Models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.8 },
              { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.6 }
            ]
          }]
        });
      }
      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels') {
        return response(200, {
          models: {
            'gemini-3-pro': {
              displayName: 'Gemini Pro',
              quotaInfo: { remainingFraction: 0.6, resetTime: '2026-09-01T00:00:00Z' }
            }
          }
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  const loadRequest = requests[0];
  assert.deepEqual(loadRequest.body, { metadata: { ideType: 'ANTIGRAVITY' } });
  assert.match(loadRequest.headers['user-agent'], /^antigravity\/hub\/2\.9\.1 /);
  assert.equal(loadRequest.headers.accept, '*/*');
  const onboardRequest = requests[1];
  assert.deepEqual(onboardRequest.body, {
    tier_id: 'free-tier',
    metadata: {
      ide_type: 'ANTIGRAVITY',
      ide_version: '2.9.1',
      ide_name: 'antigravity'
    }
  });
  assert.match(onboardRequest.headers['user-agent'], /google-api-nodejs-client\/10\.3\.0$/);
  assert.equal(onboardRequest.headers['x-goog-api-client'], 'gl-node/22.21.1');
  assert.deepEqual(waits, [2000]);
  assert.equal(renewed.projectId, 'project-1');
  assert.equal(snapshot.accountPlan, '');
  assert.deepEqual(snapshot.windows.map((window) => [window.name, window.kind, window.remainingFraction]), [
    ['Gemini 5-hour', 'session', 0.6],
    ['Gemini weekly', 'weekly', 0.8]
  ]);
});

test('fetchRemoteSnapshot prefers the paid Antigravity tier over the base free tier', async () => {
  const snapshot = await antigravityOAuth.fetchRemoteSnapshot({
    id: 'account-1',
    accountEmail: 'user@example.com',
    credentials: {
      accessToken: 'access',
      expiresAt: Date.now() + 3600_000,
      clientId: 'client',
      clientSecret: 'secret',
      projectId: 'project-1'
    }
  }, {
    collapsePools: antigravityProbe._collapsePools,
    quotaSummaryWindows: antigravityProbe._quotaSummaryWindows,
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return response(200, { currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } });
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return response(200, {
          groups: [{
            displayName: 'Claude and GPT models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.75 }]
          }]
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(snapshot.accountPlan, 'Pro');
  assert.equal(snapshot.windows[0].name, 'Claude/GPT weekly');
});

test('fetchRemoteSnapshot falls back to the daily model endpoint', async () => {
  const modelUrls = [];
  const snapshot = await antigravityOAuth.fetchRemoteSnapshot({
    id: 'account-1',
    accountEmail: 'user@example.com',
    credentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      clientId: 'client',
      clientSecret: 'secret',
      projectId: 'project-1'
    }
  }, {
    collapsePools: antigravityProbe._collapsePools,
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) return response(200, { currentTier: { id: 'free-tier' } });
      if (url.endsWith(':fetchAvailableModels')) {
        modelUrls.push(url);
        if (url.startsWith('https://cloudcode-pa.googleapis.com/')) {
          return response(403, { error: { message: 'The caller does not have permission' } });
        }
        return response(200, {
          models: {
            'gemini-3-pro': {
              displayName: 'Gemini Pro',
              quotaInfo: { remainingFraction: 0.5, resetTime: '2026-09-01T00:00:00Z' }
            }
          }
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.deepEqual(modelUrls, [
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
  ]);
  assert.equal(snapshot.pools[0].remainingFraction, 0.5);
});

test('fetchRemoteSnapshot verifies suspicious full quotas and collapses model pools', async () => {
  const calls = [];
  const snapshot = await antigravityOAuth.fetchRemoteSnapshot({
    id: 'account-1',
    accountEmail: 'User@Example.com',
    credentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      clientId: 'client',
      clientSecret: 'secret',
      projectId: 'project-1'
    }
  }, {
    collapsePools: antigravityProbe._collapsePools,
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith(':loadCodeAssist')) {
        return response(200, { currentTier: { id: 'standard-tier' } });
      }
      if (url.endsWith(':fetchAvailableModels')) {
        return response(200, {
          models: {
            'gemini-2.5-pro': { displayName: 'Gemini Pro', quotaInfo: { remainingFraction: 1, resetTime: '2026-09-01T00:00:00Z' } },
            'claude-sonnet': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 1, resetTime: '2026-09-01T01:00:00Z' } }
          }
        });
      }
      if (url.endsWith(':retrieveUserQuota')) {
        return response(200, {
          buckets: [
            { modelId: 'gemini-2.5-pro', remainingFraction: 0.4, resetTime: '2026-09-01T02:00:00Z' },
            { modelId: 'claude-sonnet', remainingFraction: 0.7, resetTime: '2026-09-01T03:00:00Z' }
          ]
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  assert.equal(snapshot.accountEmail, 'user@example.com');
  assert.equal(snapshot.accountPlan, 'Paid');
  assert.equal(snapshot.sourceDetail, 'oauth');
  assert.deepEqual(snapshot.pools.map((pool) => [pool.name, pool.remainingFraction]), [
    ['Gemini Pro', 0.4],
    ['Claude', 0.7]
  ]);
  assert.equal(calls.some((url) => url.endsWith(':retrieveUserQuota')), true);
});

test('fetchRemoteSnapshot preserves the account plan when both quota endpoints deny access', async () => {
  const snapshot = await antigravityOAuth.fetchRemoteSnapshot({
    id: 'account-1',
    accountEmail: 'User@Example.com',
    credentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      clientId: 'client',
      clientSecret: 'secret',
      projectId: 'project-1'
    }
  }, {
    collapsePools: antigravityProbe._collapsePools,
    fetch: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return response(200, { currentTier: { id: 'standard-tier' } });
      }
      if (url.endsWith(':fetchAvailableModels') || url.endsWith(':retrieveUserQuota')) {
        return response(403, { error: { message: 'The caller does not have permission' } });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.equal(snapshot.accountEmail, 'user@example.com');
  assert.equal(snapshot.accountPlan, 'Paid');
  assert.deepEqual(snapshot.pools, []);
});

test('normalizeManagedAccounts does not expose credentials unless explicitly requested', () => {
  const value = [{
    id: 'one',
    accountEmail: 'USER@example.com',
    credentials: { accessToken: 'secret' }
  }];
  assert.equal(antigravityOAuth.normalizeManagedAccounts(value)[0].credentials, undefined);
  assert.equal(
    antigravityOAuth.normalizeManagedAccounts(value, { includeCredentials: true })[0].credentials.accessToken,
    'secret'
  );
});
