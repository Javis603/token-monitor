// @ts-check
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchClaudeLimits, fetchClaudeAccountsLimits } = require('../../src/shared/providers/claude/limits');
const profile = { account: { uuid: 'account', email: 'owner@example.com' }, organization: { uuid: 'org' } };
const quota = { five_hour: { utilization: 10 } };
const usage = 'Current session\n90% left\nCurrent week\n80% left';
function fixture() {
  const calls = [];
  return { calls, deps: {
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' }, platform: 'linux',
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => url.includes('/profile') ? profile : quota }; },
    runClaudeAuthStatus: async () => { calls.push('auth'); return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', orgId: 'org' }); },
    runClaudeUsageCli: async () => { calls.push('cli'); return usage; },
    isClaudeCliAuthenticated: async () => { calls.push('legacy-auth'); return true; }
  } };
}
test('a persisted pre-release source preference cannot force the CLI lane', async () => {
  const f = fixture();
  const row = await fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps);
  assert.equal(row.source, 'oauth');
  assert.equal(f.calls.includes('auth'), false);
  assert.equal(f.calls.includes('cli'), false);
});
test('draft Web probes never read the local OAuth or CLI account', async () => {
  const f = fixture();
  f.deps.fetch = async () => { throw new Error('unexpected OAuth'); };
  await assert.rejects(fetchClaudeAccountsLimits({ claudeWebCookie: 'sk-ant-draft' }, { ...f.deps, probe: true,
    claudeWebFetch: async () => ({ ok: false, status: 401 }) }));
  assert.deepEqual(f.calls, []);
});
test('the complementary Web account is collected beside the automatic local account', async () => {
  const f = fixture();
  const rows = await fetchClaudeAccountsLimits({ claudeWebCookie: 'sk-ant-web', claudePrepaidBalanceEnabled: false }, { ...f.deps,
    claudeWebFetch: async (url) => ({ ok: true, json: async () => url.endsWith('/organizations') ? [{ uuid: 'web-org', capabilities: ['chat'] }] : url.endsWith('/account') ? { uuid: 'web-account', email_address: 'web@example.com' } : quota }) });
  assert.deepEqual(rows.map(r => r.source).sort(), ['oauth', 'web']);
});
