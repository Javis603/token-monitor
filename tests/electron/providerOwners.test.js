'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexAccountService } = require('../../src/electron/providers/codex/accountService');
const { createAntigravityAccountService } = require('../../src/electron/providers/antigravity/accountService');
const { createMimoAccountService } = require('../../src/electron/providers/mimo/accountService');
const { createCursorAccountService } = require('../../src/electron/providers/cursor/accountService');
const { createOpencodeAccountService } = require('../../src/electron/providers/opencode/accountService');
const { createThirdpartyAccountService } = require('../../src/electron/providers/thirdparty/accountService');

async function waitForPhase(ready, phase) {
  const deadline = Date.now() + 1000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(ready(), `Missing login phase: ${phase}`);
}

function codex(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-account-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let records = [];
  const deps = { getUserDataPath: () => root, getCodexManagedAccounts: () => records,
    setCodexManagedAccounts: value => { records = value; }, saveSettings() {},
    pushSettingsToRenderer() {}, queueLimitInvalidation: async () => {}, isEnabled: () => false,
    electronProviderDeps: value => value, env: {}, ...extra };
  return { root, deps, service: createCodexAccountService(deps) };
}
test('Codex login owns singleflight, flow-specific cancellation and deferred cleanup', async t => {
  let release;
  const h = codex(t, { runLogin: () => new Promise(resolve => { release = resolve; }) });
  const login = h.service.login({ flowId: 'one' }, { ownerId: 7, onStatus() {} });
  t.after(async () => { h.service.cancelLogin({ flowId: 'one' }); release?.({ outcome: 'cancelled' }); await login.catch(() => {}); });
  await waitForPhase(() => release, 'runLogin');
  assert.equal((await h.service.login({ flowId: 'two' }, { ownerId: 8, onStatus() {} })).flowId, 'two');
  assert.deepEqual(h.service.cancelLogin({ flowId: 'two' }), { ok: true, cancelled: false });
  assert.deepEqual(h.service.cancelLogin({ flowId: 'one' }), { ok: true, cancelled: true });
  release({ outcome: 'success' });
  assert.equal((await login).outcome, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(h.root, 'managed-codex-homes')), []);
});
test('Codex managed homes cannot remove paths outside the managed root', async t => {
  const h = codex(t); const protectedPath = path.join(h.root, 'keep'); fs.mkdirSync(protectedPath);
  assert.equal(h.service.codexManagedHomePath('../keep'), '');
  await h.service.removeManagedHomeIfSafe(protectedPath);
  assert.equal(fs.existsSync(protectedPath), true);
});
test('Codex cancellation during workspace resolution leaves no managed credentials', async t => {
  const controller = new AbortController(); let h;
  h = codex(t, { runLogin: async ({ homePath }) => {
    fs.writeFileSync(path.join(homePath, 'auth.json'), JSON.stringify({ email: 'user@example.com' }));
    return { outcome: 'success' };
  }, listWorkspaces: async () => { controller.abort(); return []; } });
  const result = await h.service.addCodexManagedAccount(() => {}, { signal: controller.signal });
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(h.deps.getCodexManagedAccounts(), []);
});
test('Codex failed commit rolls managed auth and saved identity back together', async t => {
  const jwt = payload => 'e30.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
  const auth = { tokens: { id_token: jwt({ email: 'user@example.com', chatgpt_account_id: 'acct_fixture' }) } };
  const { codexAuthIdentity } = require('../../src/shared/providers/codex/auth');
  const h = codex(t, { runLogin: async ({ homePath }) => {
    fs.writeFileSync(path.join(homePath, 'auth.json'), JSON.stringify(auth));
    return { outcome: 'success' };
  }, listWorkspaces: async () => [], saveSettings() { throw Error('fixture commit failed'); } });
  const identity = codexAuthIdentity(auth);
  const homePath = h.service.codexManagedHomePath('existing');
  fs.mkdirSync(homePath, { recursive: true });
  fs.writeFileSync(path.join(homePath, 'auth.json'), 'original-auth');
  const original = [{ id: 'existing', homePath, ...identity }];
  h.deps.setCodexManagedAccounts(original);
  await assert.rejects(h.service.addCodexManagedAccount(() => {}), /fixture commit failed/);
  assert.equal(h.deps.getCodexManagedAccounts(), original);
  assert.equal(fs.readFileSync(path.join(homePath, 'auth.json'), 'utf8'), 'original-auth');
  assert.deepEqual(fs.readdirSync(path.dirname(homePath)), ['existing']);
});
test('Codex workspace selection rejects another sender, stale flow and unknown workspace', async t => {
  const jwt = payload => 'e30.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
  let selection;
  const h = codex(t, { runLogin: async ({ homePath }) => {
    fs.writeFileSync(path.join(homePath, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt({ email: 'user@example.com' }) } }));
    return { outcome: 'success' };
  }, listWorkspaces: async () => [{ id: 'acct_one' }, { id: 'acct_two' }] });
  const login = h.service.login({ flowId: 'flow' }, { ownerId: 7, onStatus: payload => { if (payload.phase === 'workspaceSelection') selection = payload; } });
  t.after(async () => { h.service.cancelLogin({ flowId: 'flow' }); await login.catch(() => {}); });
  await waitForPhase(() => selection, 'workspaceSelection');
  assert.deepEqual(h.service.selectWorkspace({ flowId: 'flow', workspaceId: 'acct_one' }, 8), { ok: false, stale: true });
  assert.deepEqual(h.service.selectWorkspace({ flowId: 'old', workspaceId: 'acct_one' }, 7), { ok: false, stale: true });
  assert.equal(h.service.selectWorkspace({ flowId: 'flow', workspaceId: 'unknown' }, 7).ok, false);
  h.service.cancelLogin({ flowId: 'flow' });
  assert.equal((await login).outcome, 'cancelled');
});
test('Antigravity retains complete credentials and CAS rejects stale token renewals', async () => {
  let accounts = []; let credential;
  const service = createAntigravityAccountService({ getAntigravityManagedAccounts: () => accounts,
    setAntigravityManagedAccounts: value => { accounts = value; }, getCredentialStore: () => ({
      readAntigravityCredential: () => credential, writeAntigravityCredential: (_id, next) => { credential = next; return true; }
    }), oauthLogin: async () => ({ identity: { email: 'fixture@example.com', name: 'Fixture' }, credential: { accessToken: 'private-access', refreshToken: 'private-refresh', clientId: 'client', clientSecret: 'private-client' } }),
    electronLimitsFetch: () => {}, openExternal() {}, saveSettings() {}, pushSettingsToRenderer() {}, sendAntigravityAccountsPush() {}, queueLimitInvalidation: async () => {} });
  assert.equal((await service.addAntigravityManagedAccount()).ok, true);
  assert.equal(credential.clientSecret, 'private-client');
  assert.doesNotMatch(JSON.stringify(service.antigravityAccountsForRenderer()), /private-/);
  assert.equal(service.persistAntigravityCredentialsRenewal({ account: accounts[0], previous: {}, credentials: { accessToken: 'late' } }), false);
  assert.equal(service.persistAntigravityCredentialsRenewal({ account: accounts[0], previous: credential, credentials: { ...credential, accessToken: 'next' } }), true);
});
test('MiMo collector preserves unreadable account rows while renderer excludes cookies', () => {
  const accounts = [{ id: 'fixture', accountKey: 'sha256:fixture', cookieHeader: 'private-cookie', enabled: true }];
  const service = createMimoAccountService({ getMimoManagedAccounts: () => accounts, getCredentialStore: () => ({ readMimoCredential() { throw Error('unavailable'); } }) });
  assert.equal(service.mimoManagedAccountsForCollector()[0].cookieHeader, '');
  assert.equal(service.mimoManagedAccountsForCollector().length, 1);
  assert.doesNotMatch(JSON.stringify(service.normalizeMimoManagedAccounts(accounts)), /private-cookie|cookieHeader/);
});
test('Cursor external agent is authoritative and prevents login, discovery and logout', async () => {
  const forbidden = () => { throw Error('must not touch Tokscale'); };
  const service = createCursorAccountService({ isExternalAgentActive: () => true,
    auth: { listAccounts: () => [], readCursorDesktopSignIn: () => null, runCursorDiscover: forbidden, runCursorLogin: forbidden, runCursorLogout: forbidden },
    getCursorDisabledAccountIds: () => [], getCursorManualAccountIds: () => [] });
  assert.equal((await service.loginManual('token')).code, 'EXTERNAL_AGENT_ACTIVE');
  assert.equal((await service.logout('fixture')).code, 'EXTERNAL_AGENT_ACTIVE');
  assert.equal((await service.status({ discover: true })).managementBlocked, true);
});
test('OpenCode pairing requires explicit merge and projections omit both credentials', async () => {
  let profiles = { fixture: { cookie: 'private-cookie', enabled: true } };
  const service = createOpencodeAccountService({ getOpencodeProfiles: () => profiles, setOpencodeProfiles: value => { profiles = value; },
    getOpencodeAmbientEnabled: () => true, env: {}, goApi: { readGoApiKey: () => 'private-key', goApiIdentity: () => 'sha256:fixture' },
    saveSettings() {}, queueLimitInvalidation: async () => {} });
  const refused = await service.saveProfile('fixture', '', 'ambient');
  assert.equal(refused.ok, false);
  assert.equal((await service.saveProfile('fixture', '', 'ambient', { merge: true })).ok, true);
  assert.doesNotMatch(JSON.stringify(await service.getProfiles()), /private-cookie|private-key/);
});
test('thirdparty token pair and canonical identity writes compare both original tokens', () => {
  let profiles = { fixture: { adapter: 'sub2api', baseUrl: 'https://fixture.example', accessToken: 'private-access', refreshToken: 'private-refresh', enabled: true } };
  const service = createThirdpartyAccountService({ getThirdPartyProfiles: () => profiles, setThirdPartyProfiles: next => { profiles = next; }, saveSettings() {}, env: {} });
  const previous = { accessToken: 'private-access', refreshToken: 'private-refresh' };
  assert.equal(service.persistThirdPartyCredentialsRenewal({ accountName: 'fixture', adapter: 'sub2api', previous: { ...previous, refreshToken: 'stale' }, next: { accessToken: 'next-access', refreshToken: 'next-refresh' } }), false);
  assert.equal(service.persistThirdPartyCredentialsRenewal({ accountName: 'fixture', adapter: 'sub2api', previous, next: { accessToken: 'next-access', refreshToken: 'next-refresh' } }), true);
  assert.equal(service.persistThirdPartyAccountKey({ accountName: 'fixture', adapter: 'sub2api', baseUrl: 'https://fixture.example', previous, accountKey: 'sha256:fixture' }), false);
});

test('main forwards slot credential renewal as the original promise', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const expression = source.match(/onAccountSlotCredentialRenewed: ([^\n]+),/)[1];
  const renewal = { provider: 'fixture' }; let received;
  const pending = Promise.resolve(true);
  const callback = vm.runInNewContext('(' + expression + ')', {
    accountSlotService: { renew: value => { received = value; return pending; } }
  });
  assert.equal(callback(renewal), pending);
  assert.equal(received, renewal);
  assert.equal(await pending, true);
});

test('Claude legacy renewal uses the existing owner and rejects a replaced cookie', () => {
  const { createClaudeManagedAccounts } = require('../../src/electron/providers/claude/managedAccounts');
  let settings = { claudeWebCookie: 'sessionKey=sk-ant-sid01-current', claudeManagedAccounts: [] }; let saves = 0;
  const service = createClaudeManagedAccounts({ getSettings: () => settings, setSettings: next => { settings = next; },
    saveSettings: () => { saves++; }, credentialStore: {}, probeDeps: () => ({}), projectSettings: () => ({}) });
  assert.equal(service.renewCookie({ previousCookie: 'sessionKey=sk-ant-sid01-stale', cookie: 'sessionKey=sk-ant-sid01-next' }), false);
  assert.equal(service.renewCookie({ previousCookie: settings.claudeWebCookie, cookie: 'sessionKey=sk-ant-sid01-next' }), true);
  assert.equal(saves, 1);
});
test('thirdparty validation rejects malformed custom configuration before any probe', async () => {
  const service = createThirdpartyAccountService({ getThirdPartyProfiles: () => ({}), env: {}, electronProviderDeps() { throw Error('must not probe invalid input'); } });
  assert.deepEqual(await service.saveProfile({ name: 'fixture', adapter: 'custom', baseUrl: 'https://fixture.example', apiKey: 'private-key', endpointPath: 'https://other.example' }), { ok: false, errorCode: 'invalidEndpointPath' });
});
