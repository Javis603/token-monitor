'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchClaudeLimits, refreshClaudeCredentials } = require('../../src/shared/providers/claude/limits');

const quota = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
const profile = { account: { uuid: 'account', email: 'owner@example.com' }, organization: { uuid: 'org' } };
const response = (body) => ({ ok: true, json: async () => body });

function depsWithCliCounter(platform = 'darwin') {
  const calls = { auth: 0, usage: 0, status: 0, spawn: 0 };
  return {
    calls,
    deps: {
      platform,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
      isClaudeCliAuthenticated: async () => { calls.auth++; return true; },
      runClaudeUsageCli: async () => { calls.usage++; return 'Current session\n90% left\nCurrent week\n80% left'; },
      touchClaudeAuthPath: async () => { calls.status++; },
      spawn: () => { calls.spawn++; throw new Error('Unexpected subprocess'); }
    }
  };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`disabled Claude CLI fallback preserves OAuth failures without CLI calls on ${platform}`, async () => {
    for (const failure of [429, 503, 'timeout']) {
      const { calls, deps } = depsWithCliCounter(platform);
      deps.fetch = async () => {
        if (failure === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return { ok: false, status: failure };
      };
      await assert.rejects(fetchClaudeLimits({ claudeCliFallbackEnabled: false }, deps), (error) => {
        assert.equal(error.status, failure === 429 ? 'sourceRateLimited' : 'unavailable');
        return true;
      });
      assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
    }
  });
}

test('disabled Claude CLI fallback does not probe auth when credentials are missing', async () => {
  const { calls, deps } = depsWithCliCounter();
  Object.assign(deps, {
    env: {}, readMacKeychain: false,
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  });
  await assert.rejects(fetchClaudeLimits({ claudeCliFallbackEnabled: false }, deps), { status: 'notConfigured' });
  assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
});

for (const failedEndpoint of ['usage', 'profile']) {
  test(`disabled Claude CLI fallback skips delegated macOS refresh after ${failedEndpoint} auth failure`, async () => {
    const { calls, deps } = depsWithCliCounter();
    deps.fetch = async (url) => url.includes(`/api/oauth/${failedEndpoint}`)
      ? { ok: false, status: 401 } : response(quota);
    await assert.rejects(fetchClaudeLimits({ claudeCliFallbackEnabled: false }, deps));
    assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
  });
}

test('disabled Claude CLI fallback still returns successful OAuth quota', async () => {
  const { calls, deps } = depsWithCliCounter();
  deps.fetch = async (url) => response(url.includes('/profile') ? profile : quota);
  const result = await fetchClaudeLimits({ claudeCliFallbackEnabled: false }, deps);
  assert.equal(result.source, 'oauth');
  assert.equal(result.windows[0].usedPercent, 10);
  assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
});

test('disabled Claude CLI fallback still returns Web quota', async () => {
  const { calls, deps } = depsWithCliCounter();
  deps.claudeWebFetch = async (url) => response(url.includes('/organizations/') ? quota
    : url.endsWith('/organizations') ? [{ uuid: 'org', capabilities: ['chat'] }] : profile.account);
  const result = await fetchClaudeLimits({
    claudeCliFallbackEnabled: false, claudeWebCookie: 'sk-ant-test', claudePrepaidBalanceEnabled: false
  }, deps);
  assert.equal(result.source, 'web');
  assert.equal(result.windows[0].usedPercent, 10);
  assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
});

test('Claude CLI fallback remains enabled by default and when explicitly enabled', async () => {
  for (const options of [{}, { claudeCliFallbackEnabled: true }]) {
    const { calls, deps } = depsWithCliCounter();
    deps.fetch = async () => ({ ok: false, status: 503 });
    const result = await fetchClaudeLimits(options, deps);
    assert.equal(result.source, 'cli');
    assert.equal(calls.auth, 1);
    assert.equal(calls.usage, 1);
  }
});


test('disabled Claude CLI fallback retains direct OAuth refresh on non-macOS platforms', async () => {
  for (const platform of ['linux', 'win32']) {
    const { calls, deps } = depsWithCliCounter(platform);
    deps.fetch = async (url, options) => {
      assert.equal(url, 'https://console.anthropic.com/v1/oauth/token');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'test-refresh');
      return response({ access_token: 'renewed-token', refresh_token: 'renewed-refresh', expires_in: 3600 });
    };
    const result = await refreshClaudeCredentials(
      { accessToken: 'old-token', refreshToken: 'test-refresh' }, deps, { claudeCliFallbackEnabled: false }
    );
    assert.equal(result.accessToken, 'renewed-token');
    assert.deepEqual(calls, { auth: 0, usage: 0, status: 0, spawn: 0 });
  }
});

test('Claude delegated refresh remains enabled by default', async () => {
  const { calls, deps } = depsWithCliCounter();
  deps.env = { CLAUDE_CODE_OAUTH_TOKEN: 'renewed-token' };
  const result = await refreshClaudeCredentials({ accessToken: 'old-token' }, deps);
  assert.equal(result.accessToken, 'renewed-token');
  assert.equal(calls.status, 1);
});
