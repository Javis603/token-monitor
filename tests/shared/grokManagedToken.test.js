'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  refreshGrokAccessToken,
  fetchGrokLimits
} = require('../../src/shared/grokLimits');

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => Buffer.from(body),
    headers: new Map()
  };
}

test('refreshGrokAccessToken exchanges a refresh_token for an access_token', async () => {
  const result = await refreshGrokAccessToken('rt-abc', 'cid-xyz', {
    fetch: async () => fakeResponse({
      access_token: 'new-access-token',
      refresh_token: 'new-rt',
      expires_in: 21600,
      token_type: 'Bearer'
    })
  });
  assert.equal(result.accessToken, 'new-access-token');
  assert.equal(result.refreshToken, 'new-rt');
  assert.equal(result.expiresIn, 21600);
  assert.equal(result.tokenType, 'Bearer');
});

test('refreshGrokAccessToken keeps the old refresh_token when rotation is absent', async () => {
  const result = await refreshGrokAccessToken('rt-abc', 'cid-xyz', {
    fetch: async () => fakeResponse({
      access_token: 'new-access-token',
      expires_in: 21600
    })
  });
  assert.equal(result.refreshToken, 'rt-abc');
});

test('refreshGrokAccessToken returns null when inputs are empty', async () => {
  assert.equal(await refreshGrokAccessToken('', 'cid', { fetch: async () => fakeResponse({}) }), null);
  assert.equal(await refreshGrokAccessToken('rt', '', { fetch: async () => fakeResponse({}) }), null);
});

test('refreshGrokAccessToken maps 401 to unauthorized', async () => {
  await assert.rejects(
    refreshGrokAccessToken('rt', 'cid', { fetch: async () => fakeResponse({}, 401) }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.status, 'unauthorized');
      return true;
    }
  );
});

test('refreshGrokAccessToken maps 500 to unavailable', async () => {
  await assert.rejects(
    refreshGrokAccessToken('rt', 'cid', { fetch: async () => fakeResponse({}, 500) }),
    (error) => {
      assert.equal(error.status, 'unavailable');
      return true;
    }
  );
});

test('refreshGrokAccessToken rejects when access_token is missing', async () => {
  await assert.rejects(
    refreshGrokAccessToken('rt', 'cid', { fetch: async () => fakeResponse({ refresh_token: 'x' }) }),
    (error) => {
      assert.equal(error.status, 'unavailable');
      return true;
    }
  );
});

// --- fetchGrokLimits managed-credential path ---

function fakeWebGrpcBilling(windows) {
  return async () => windows;
}

function fakeRefresh(successBody) {
  return async () => ({
    accessToken: successBody.access_token,
    refreshToken: successBody.refresh_token || 'rt-old',
    expiresIn: successBody.expires_in || 21600,
    tokenType: 'Bearer'
  });
}

test('fetchGrokLimits uses the managed refresh_token path when configured', async () => {
  const provider = await fetchGrokLimits(
    { grokRefreshToken: 'rt-managed', grokClientId: 'cid-managed' },
    {
      env: {},
      refreshAccessToken: fakeRefresh({ access_token: 'fresh-access', refresh_token: 'rt-rotated' }),
      fetchWebGrpcBilling: fakeWebGrpcBilling([{
        kind: 'billing',
        label: 'Weekly',
        usedPercent: 50,
        resetsAt: '2026-08-25T00:00:00.000Z',
        windowMinutes: 10080,
        showMeter: true
      }])
    }
  );
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
  assert.equal(provider.sourceDetail, 'managed');
  assert.equal(provider.accountLabel, 'SuperGrok');
  assert.equal(provider.windows.length, 1);
  assert.equal(provider.windows[0].usedPercent, 50);
});

test('fetchGrokLimits falls back to auth.json when managed refresh fails', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-fallback-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::test': {
      key: 'ambient-access-token',
      email: 'test@example.com',
      refresh_token: 'ambient-rt'
    }
  }));
  const provider = await fetchGrokLimits(
    { grokRefreshToken: 'rt-managed', grokClientId: 'cid-managed' },
    {
      env: {},
      grokHome: home,
      refreshAccessToken: async () => { throw new Error('refresh failed'); },
      fetchWebGrpcBilling: fakeWebGrpcBilling([{
        kind: 'billing',
        label: 'Weekly',
        usedPercent: 30,
        resetsAt: '2026-08-25T00:00:00.000Z',
        windowMinutes: 10080,
        showMeter: true
      }])
    }
  );
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
  assert.equal(provider.accountEmail, 'test@example.com');
});

test('fetchGrokLimits skips the managed path when no refresh_token is configured', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-skip-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::test': {
      key: 'ambient-access-token',
      email: 'test@example.com'
    }
  }));
  let refreshCalled = false;
  const provider = await fetchGrokLimits(
    {},
    {
      env: {},
      grokHome: home,
      refreshAccessToken: async () => { refreshCalled = true; return null; },
      fetchWebGrpcBilling: fakeWebGrpcBilling([{
        kind: 'billing',
        label: 'Weekly',
        usedPercent: 42,
        resetsAt: '2026-08-25T00:00:00.000Z',
        windowMinutes: 10080,
        showMeter: true
      }])
    }
  );
  assert.equal(refreshCalled, false);
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'web');
});

test('fetchGrokLimits managed path reads GROK_REFRESH_TOKEN env as fallback', async () => {
  const provider = await fetchGrokLimits(
    {},
    {
      env: { GROK_REFRESH_TOKEN: 'rt-env', GROK_CLIENT_ID: 'cid-env' },
      refreshAccessToken: fakeRefresh({ access_token: 'fresh-from-env' }),
      fetchWebGrpcBilling: fakeWebGrpcBilling([{
        kind: 'billing',
        label: 'Weekly',
        usedPercent: 60,
        resetsAt: '2026-08-25T00:00:00.000Z',
        windowMinutes: 10080,
        showMeter: true
      }])
    }
  );
  assert.equal(provider.status, 'ok');
  assert.equal(provider.sourceDetail, 'managed');
});
