// @ts-check
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchClaudeLimits, fetchClaudeAccountsLimits } = require('../../src/shared/providers/claude/limits');
const account = require('../../src/shared/providers/claude/account');
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
test('Claude declares only OAuth and CLI selectable, preserving complementary Web', () => {
  assert.deepEqual(account.sourceSelection, { sources: ['oauth', 'cli'] });
  assert.equal(account.sources.find(s => s.id === 'web').relation, 'complement');
});
test('explicit CLI reads CLI quota under the verified OAuth stable identity', async () => {
  const f = fixture();
  const oauth = await fetchClaudeLimits({}, f.deps);
  f.calls.length = 0;
  const cli = await fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps);
  assert.equal(cli.source, 'cli');
  assert.equal(cli.accountKey, oauth.accountKey);
  assert.equal(cli.accountEmail, oauth.accountEmail);
  assert.equal(cli.accountName, oauth.accountName);
  assert.deepEqual(f.calls, ['auth', 'https://api.anthropic.com/api/oauth/profile', 'cli', 'auth']);
});
test('explicit OAuth failure cannot run CLI fallback', async () => {
  const f = fixture(); f.deps.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'oauth' }, f.deps));
  assert.deepEqual(f.calls, []);
});
test('explicit CLI failure cannot read OAuth quota', async () => {
  const f = fixture(); f.deps.runClaudeUsageCli = async () => { throw new Error('CLI unavailable'); };
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps));
  assert.equal(f.calls.some(c => c.includes('/usage')), false);
});
for (const status of [
  { loggedIn: false }, { loggedIn: true, authMethod: 'api_key', email: 'owner@example.com', orgId: 'org' },
  { loggedIn: true, authMethod: 'claude.ai', email: 'other@example.com', orgId: 'org' },
  { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', orgId: 'other' },
  { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' }
]) test(`explicit CLI rejects unverified CLI identity ${JSON.stringify(status)}`, async () => {
  const f = fixture(); f.deps.runClaudeAuthStatus = async () => JSON.stringify(status);
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps));
  assert.equal(f.calls.includes('cli'), false);
});
test('explicit CLI rechecks identity after quota and refuses a concurrent account switch', async () => {
  const f = fixture(); const auth = f.deps.runClaudeAuthStatus;
  let reads = 0;
  f.deps.runClaudeAuthStatus = async () => ++reads === 1 ? auth() : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'other@example.com', orgId: 'org' });
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps));
  assert.equal(reads, 2);
});
test('explicit CLI does not reuse cached profile when fresh verification fails', async () => {
  const f = fixture(); Object.assign(f.deps, { providerRuntimeState: new Map() });
  await fetchClaudeLimits({}, f.deps);
  f.deps.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps));
  assert.equal(f.calls.includes('cli'), false);
});
test('disabled CLI setting is respected by explicit selection', async () => {
  const f = fixture();
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli', claudeCliFallbackEnabled: false }, f.deps));
  assert.deepEqual(f.calls, []);
});
test('draft Web probes stay isolated from collector CLI preference', async () => {
  const f = fixture();
  f.deps.fetch = async () => { throw new Error('unexpected OAuth'); };
  await assert.rejects(fetchClaudeAccountsLimits({ claudeSourcePreference: 'cli', claudeWebCookie: 'sk-ant-draft' }, { ...f.deps, probe: true,
    claudeWebFetch: async () => ({ ok: false, status: 401 }) }));
  assert.deepEqual(f.calls, []);
});
test('CLI preference preserves the complementary Web account', async () => {
  const f = fixture();
  const rows = await fetchClaudeAccountsLimits({ claudeSourcePreference: 'cli', claudeWebCookie: 'sk-ant-web', claudePrepaidBalanceEnabled: false }, { ...f.deps,
    claudeWebFetch: async (url) => ({ ok: true, json: async () => url.endsWith('/organizations') ? [{ uuid: 'web-org', capabilities: ['chat'] }] : url.endsWith('/account') ? { uuid: 'web-account', email_address: 'web@example.com' } : quota }) });
  assert.deepEqual(rows.map(r => r.source).sort(), ['cli', 'web']);
});

for (const source of ['oauth', 'cli']) test(`missing explicit ${source} source does not retire the existing account`, async () => {
  const f = fixture(); const previous = await fetchClaudeLimits({}, f.deps);
  Object.assign(f.deps, { env: {}, readMacKeychain: false, readWindowsCredential: false,
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  for (const scope of [undefined, { accountKey: previous.accountKey }]) {
    const rows = await fetchClaudeAccountsLimits({ claudeSourcePreference: source,
      previousLimits: { providers: [previous] }, limitRefreshScope: scope }, f.deps);
    assert.equal(rows.some(r => r.removed), false);
  }
});
test('explicit CLI rejects usage text identifying a different account', async () => {
  const f = fixture(); f.deps.runClaudeUsageCli = async () => usage + '\nEmail: other@example.com';
  await assert.rejects(fetchClaudeLimits({ claudeSourcePreference: 'cli' }, f.deps), { code: 'CLAUDE_IDENTITY_UNAVAILABLE' });
});
