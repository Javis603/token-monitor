'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WORKBUDDY_AUTH_FILE_NAME,
  WORKBUDDY_LOGOUT_MARKER_SUFFIX,
  WORKBUDDY_SESSION_EXPIRY_SKEW_MS,
  WORKBUDDY_SESSION_READ_REASONS,
  authDirectoriesForPlatform,
  authDirectoryForPlatform,
  createWorkbuddyLocalAuth,
  inspectStoredSession,
  isAllowedWorkbuddyApiUrl,
  normalizeStoredSession,
  sanitizeRequestInit
} = require('../../src/electron/providers/workbuddy/localAuth');

function sessionDocument(overrides = {}) {
  const account = {
    uid: 'local-user',
    accountType: 'personal',
    type: 'personal',
    ...overrides.account
  };
  return {
    account,
    accounts: [account],
    allAccounts: [account],
    auth: {
      accessToken: 'fixture-access-token',
      domain: 'copilot.tencent.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
      ...overrides.auth
    }
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-workbuddy-'));
  const authPath = path.join(root, WORKBUDDY_AUTH_FILE_NAME);
  fs.writeFileSync(authPath, JSON.stringify(sessionDocument()), 'utf8');
  return { root, authPath };
}

test('Chinese department metadata remains an identity fence without an invalid Fetch header or session write', async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
    account: { enterpriseId: 'enterprise', departmentFullName: '研发部', type: 'ultimate' }
  })));
  const before = fs.readFileSync(fixture.authPath, 'utf8');
  const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin',
    fetch: async (url, init) => {
      const request = new Request(url, init);
      assert.equal(request.headers.get('X-Enterprise-Id'), 'enterprise');
      assert.equal(request.headers.get('X-Department-Info'), null);
      return { status: 200, json: async () => ({}) };
    } });
  const expected = auth.getSessionInfo();
  assert.equal(expected.departmentInfo, '研发部');
  await auth.request('https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage', { method: 'POST' }, expected);
  assert.equal(fs.readFileSync(fixture.authPath, 'utf8'), before);
});

test('WorkBuddy local auth resolves only supported platform paths', () => {
  const homeDir = '/Users/fixture';
  assert.equal(
    authDirectoryForPlatform('darwin', homeDir),
    path.join(homeDir, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  );
  assert.equal(
    authDirectoryForPlatform('win32', homeDir, {
      LOCALAPPDATA: '/Users/fixture/Local',
      APPDATA: '/Users/fixture/Roaming'
    }),
    path.join('/Users/fixture/Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  );
  assert.equal(
    authDirectoryForPlatform('win32', homeDir, {}),
    path.join(homeDir, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  );
  assert.deepEqual(authDirectoriesForPlatform('win32', homeDir, {
    LOCALAPPDATA: '/Users/fixture/Local',
    APPDATA: '/Users/fixture/Roaming'
  }), [
    path.join('/Users/fixture/Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join('/Users/fixture/Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  ]);
  assert.equal(authDirectoryForPlatform('linux', homeDir, {}), null);
});

test('WorkBuddy Windows auth prefers LocalAppData and only falls back when it has no canonical state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-workbuddy-windows-'));
  const localRoot = path.join(root, 'Local');
  const roamingRoot = path.join(root, 'Roaming');
  const suffix = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth');
  const localAuth = path.join(localRoot, suffix);
  const roamingAuth = path.join(roamingRoot, suffix);
  fs.mkdirSync(localAuth, { recursive: true });
  fs.mkdirSync(roamingAuth, { recursive: true });
  fs.writeFileSync(path.join(roamingAuth, WORKBUDDY_AUTH_FILE_NAME), JSON.stringify(sessionDocument({
    account: { uid: 'roaming-user' }
  })), 'utf8');
  try {
    const deps = {
      platform: 'win32',
      homeDir: root,
      env: { LOCALAPPDATA: localRoot, APPDATA: roamingRoot }
    };
    assert.equal(createWorkbuddyLocalAuth(deps).getSessionInfo().userId, 'roaming-user');

    const localPath = path.join(localAuth, WORKBUDDY_AUTH_FILE_NAME);
    fs.writeFileSync(localPath, JSON.stringify(sessionDocument({ account: { uid: 'local-user' } })), 'utf8');
    assert.equal(createWorkbuddyLocalAuth(deps).getSessionInfo().userId, 'local-user');

    fs.writeFileSync(`${localPath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`, 'logged-out', 'utf8');
    assert.equal(createWorkbuddyLocalAuth(deps).getSessionInfo().authenticated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth is unsupported on Linux and never reads an injected session path', () => {
  const fixture = createFixture();
  let fileSystemCalls = 0;
  const fsApi = Object.create(fs);
  fsApi.existsSync = () => { fileSystemCalls += 1; throw new Error('Linux local auth must not touch the filesystem'); };
  fsApi.readdirSync = () => { fileSystemCalls += 1; throw new Error('Linux local auth must not touch the filesystem'); };
  try {
    const auth = createWorkbuddyLocalAuth({
      platform: 'linux',
      homeDir: fixture.root,
      authDirectory: fixture.root,
      fs: fsApi
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
    assert.equal(fileSystemCalls, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth reads only non-secret session metadata for the collector', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
      account: {
        enterpriseId: 'enterprise-123',
        departmentFullName: 'Engineering'
      }
    })), 'utf8');
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root
    });
    const sessionInfo = auth.getSessionInfo();
    assert.equal(sessionInfo.userId, 'local-user');
    assert.equal(sessionInfo.enterpriseId, 'enterprise-123');
    assert.equal(sessionInfo.departmentInfo, 'Engineering');
    assert.equal(sessionInfo.domain, 'copilot.tencent.com');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth ignores oversized app session files without leaking their contents', () => {
  const fixture = createFixture();
  try {
    const oversizedSession = JSON.stringify(sessionDocument({
      account: { uid: 'oversized-user' },
      auth: { accessToken: 'oversized-access-token' }
    }));
    fs.writeFileSync(fixture.authPath, `${oversizedSession}${' '.repeat(1024 * 1024)}`, 'utf8');

    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth trusts only the canonical app session filename', () => {
  const fixture = createFixture();
  try {
    fs.rmSync(fixture.authPath);
    fs.writeFileSync(path.join(fixture.root, 'other.info'), JSON.stringify(sessionDocument()), 'utf8');
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth refuses a symlinked canonical app session', { skip: process.platform === 'win32' }, () => {
  const fixture = createFixture();
  try {
    const targetPath = path.join(fixture.root, 'session-target.info');
    fs.rmSync(fixture.authPath);
    fs.writeFileSync(targetPath, JSON.stringify(sessionDocument({
      account: { uid: 'symlink-user' },
      auth: { accessToken: 'symlink-access-token' }
    })), 'utf8');
    fs.symlinkSync(targetPath, fixture.authPath);

    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy logout marker on the canonical file cannot be bypassed by a sibling credential file', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(`${fixture.authPath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`, 'logged-out', 'utf8');
    fs.writeFileSync(path.join(fixture.root, 'other.info'), JSON.stringify(sessionDocument()), 'utf8');
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth injects app headers only for the allowlisted billing endpoint', async () => {
  const fixture = createFixture();
  const requests = [];
  try {
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { status: 200, ok: true, json: async () => ({}) };
      }
    });
    await auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', {
      method: 'post',
      headers: {
        Authorization: 'Bearer caller-token',
        Cookie: 'caller-cookie',
        'X-User-Id': 'caller-user',
        Accept: 'application/json'
      },
      body: '{}'
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(requests[0].init.headers['X-User-Id'], 'local-user');
    assert.equal(requests[0].init.headers.Cookie, undefined);
    assert.equal(requests[0].init.headers['X-Refresh-Token'], undefined);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth distinguishes missing and expired app sessions', async () => {
  const fixture = createFixture();
  let requests = 0;
  try {
    fs.rmSync(fixture.authPath);
    const missing = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      fetch: async () => { requests += 1; return { ok: true, status: 200 }; }
    });
    await assert.rejects(
      () => missing.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error?.status === 'notConfigured'
    );

    fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
      auth: { expiresAt: Date.now() - 60 * 1000 }
    })), 'utf8');
    const expired = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      fetch: async () => { requests += 1; return { ok: true, status: 200 }; }
    });
    await assert.rejects(
      () => expired.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error?.status === 'unauthorized'
    );
    assert.equal(requests, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy logout marker and expired app sessions require sign-in again', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(`${fixture.authPath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`, 'logged-out', 'utf8');
    const loggedOut = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin' });
    assert.equal(loggedOut.getSessionInfo().authenticated, false);

    fs.rmSync(`${fixture.authPath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`);
    fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
      auth: { expiresAt: Date.now() - 60 * 1000 }
    })), 'utf8');
    const expired = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin' });
    assert.equal(expired.getSessionInfo().authenticated, false);
    assert.deepEqual(normalizeStoredSession(null), null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy session expiry fails closed at the configured skew boundary', () => {
  const now = Date.parse('2026-08-11T00:00:00Z');
  assert.equal(normalizeStoredSession(sessionDocument({
    auth: { expiresAt: now + WORKBUDDY_SESSION_EXPIRY_SKEW_MS + 1 }
  }), now).expired, false);
  assert.equal(normalizeStoredSession(sessionDocument({
    auth: { expiresAt: now + WORKBUDDY_SESSION_EXPIRY_SKEW_MS }
  }), now).expired, true);
  assert.equal(normalizeStoredSession(sessionDocument({
    auth: { expiresAt: now - 1 }
  }), now).expired, true);
  const noExpiry = sessionDocument();
  delete noExpiry.auth.expiresAt;
  assert.equal(normalizeStoredSession(noExpiry, now).expired, false);
});

test('WorkBuddy local auth rejects an app session switch during a billing request', async () => {
  const fixture = createFixture();
  try {
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      homeDir: fixture.root,
      fetch: async () => {
        fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
          account: { uid: 'session-b-user' },
          auth: { accessToken: 'session-b-token' }
        })), 'utf8');
        return { status: 200, ok: true, json: async () => ({}) };
      }
    });
    await assert.rejects(
      auth.request(
        'https://copilot.tencent.com/v2/billing/meter/get-user-resource',
        { method: 'POST', body: '{}' },
        {
          authenticated: true,
          userId: 'local-user',
          enterpriseId: '',
          departmentInfo: '',
          domain: 'copilot.tencent.com',
          accountType: 'personal'
        }
      ),
      /session changed during the billing request/
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy local auth accepts only the exact production billing host', () => {
  const personal = 'https://copilot.tencent.com/v2/billing/meter/get-user-resource';
  const enterprise = 'https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage';
  // The Spend ledger is served unversioned, so it needs its own allowlist entry.
  const ledger = 'https://copilot.tencent.com/billing/meter/get-user-request-usage';
  const aiLedger = 'https://www.workbuddy.ai/billing/meter/get-user-request-usage';
  assert.equal(isAllowedWorkbuddyApiUrl(personal, 'POST'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(enterprise, 'post'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(ledger, 'POST'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(aiLedger, 'POST', 'ai'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(ledger, 'GET'), false);
  assert.equal(isAllowedWorkbuddyApiUrl(personal, 'GET'), false);
  // The versioned form of the ledger is not a route the server serves.
  assert.equal(isAllowedWorkbuddyApiUrl('https://copilot.tencent.com/v2/billing/meter/get-user-request-usage', 'POST'), false);
  assert.equal(isAllowedWorkbuddyApiUrl('https://copilot.tencent.com/v2/billing/meter/other', 'POST'), false);
  assert.equal(isAllowedWorkbuddyApiUrl(`${personal}?next=other`, 'POST'), false);
  assert.equal(isAllowedWorkbuddyApiUrl('https://staging-copilot.tencent.com/v2/billing/meter/get-user-resource', 'POST'), false);
  assert.equal(isAllowedWorkbuddyApiUrl('https://billing.copilot.tencent.com/v2/billing/meter/get-user-resource', 'POST'), false);
  assert.equal(isAllowedWorkbuddyApiUrl('http://copilot.tencent.com/v2/billing/meter/get-user-resource', 'POST'), false);
});

test('WorkBuddy request sanitization never forwards caller authentication material', () => {
  const init = sanitizeRequestInit({
    method: 'post',
    headers: {
      Authorization: 'Bearer caller-token',
      Cookie: 'caller-cookie',
      'X-Refresh-Token': 'refresh-token',
      'X-User-Id': 'caller-user',
      Accept: 'application/json'
    },
    body: '{}'
  });
  assert.deepEqual(init, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    body: '{}'
  });
});

// WorkBuddy 5.6.0 seals credential fields with the at-rest key its own runtime
// holds, so the access token arrives as a `{$wbEncrypted: 1, envelope: …}`
// shell. Reporting that as a signed-out app sends the user to a sign-in screen
// that cannot change the outcome, so the reader has to name the real reason.
const ENCRYPTED_ACCESS_TOKEN = Object.freeze({
  $wbEncrypted: 1,
  envelope: 'eyJzdWl0ZSI6MSwia2V5SWQiOiJmaXh0dXJlLWtleSJ9'
});

function writeSealedSession(authPath, auth = {}) {
  fs.writeFileSync(authPath, JSON.stringify({
    account: { uid: 'local-user', accountType: 'personal' },
    auth: {
      accessToken: ENCRYPTED_ACCESS_TOKEN,
      domain: 'copilot.tencent.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
      ...auth
    }
  }), 'utf8');
}

test('WorkBuddy sealed credential fields are reported as unreadable instead of signed out', () => {
  const fixture = createFixture();
  try {
    writeSealedSession(fixture.authPath);
    const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin' });
    const sessionInfo = auth.getSessionInfo();

    assert.equal(sessionInfo.authenticated, false);
    assert.equal(sessionInfo.reason, WORKBUDDY_SESSION_READ_REASONS.encrypted);
    assert.equal(sessionInfo.userId, '');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// Token Monitor only ever consumes the access token, so a sealed refresh
// token must not condemn a session whose billing credential still reads.
test('WorkBuddy local auth still reads a session whose refresh token alone is sealed', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
      auth: { refreshToken: ENCRYPTED_ACCESS_TOKEN }
    })), 'utf8');
    const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin' });

    const sessionInfo = auth.getSessionInfo();
    assert.equal(sessionInfo.authenticated, true);
    assert.equal(Object.hasOwn(sessionInfo, 'reason'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy session read reasons cover every unusable state and leave the legacy accessor alone', () => {
  const now = Date.parse('2026-08-11T00:00:00Z');

  assert.deepEqual(
    inspectStoredSession(sessionDocument({ auth: { accessToken: ENCRYPTED_ACCESS_TOKEN } }), now),
    { session: null, reason: WORKBUDDY_SESSION_READ_REASONS.encrypted }
  );
  assert.equal(inspectStoredSession(null, now).reason, WORKBUDDY_SESSION_READ_REASONS.malformed);
  assert.equal(
    inspectStoredSession({ auth: {}, account: {} }, now).reason,
    WORKBUDDY_SESSION_READ_REASONS.incomplete
  );
  assert.equal(inspectStoredSession(sessionDocument(), now).reason, '');
  // normalizeStoredSession still answers with a session or null, never a result pair.
  assert.equal(normalizeStoredSession(sessionDocument({ auth: { accessToken: ENCRYPTED_ACCESS_TOKEN } }), now), null);
  assert.equal(normalizeStoredSession(sessionDocument(), now).userId, 'local-user');
});

test('WorkBuddy local auth names absent, malformed and expired canonical files', () => {
  const fixture = createFixture();
  try {
    const read = () => createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin'
    }).getSessionInfo();

    fs.rmSync(fixture.authPath);
    assert.equal(read().reason, WORKBUDDY_SESSION_READ_REASONS.absent);

    fs.writeFileSync(fixture.authPath, '{ not json', 'utf8');
    assert.equal(read().reason, WORKBUDDY_SESSION_READ_REASONS.malformed);

    fs.writeFileSync(fixture.authPath, `${' '.repeat(1024 * 1024)} `, 'utf8');
    assert.equal(read().reason, WORKBUDDY_SESSION_READ_REASONS.malformed);

    fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({
      auth: { expiresAt: Date.now() - 60 * 1000 }
    })), 'utf8');
    assert.equal(read().reason, WORKBUDDY_SESSION_READ_REASONS.expired);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy readable app sessions stay free of a read reason', () => {
  const fixture = createFixture();
  try {
    const sessionInfo = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin'
    }).getSessionInfo();

    assert.equal(sessionInfo.authenticated, true);
    assert.equal(Object.hasOwn(sessionInfo, 'reason'), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy billing requests name a sealed credential instead of a missing sign-in', async () => {
  const fixture = createFixture();
  try {
    writeSealedSession(fixture.authPath);
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'darwin',
      fetch: async () => { throw new Error('the billing transport must not be reached'); }
    });

    await assert.rejects(
      () => auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error?.status === 'notConfigured' && /encrypted/.test(error.message)
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const { WORKBUDDY_AI_AUTH_FILE_NAME } = require('../../src/electron/providers/workbuddy/localAuth');
const { fetchWorkbuddyLimits, workbuddyAccountKey } = require('../../src/shared/providers/workbuddy/limits');

test('WorkBuddy canonical AI discovery exposes safe identity and preserves independent CN login', async () => {
  const fixture = createFixture();
  const requests = [];
  try {
    const aiPath = path.join(fixture.root, WORKBUDDY_AI_AUTH_FILE_NAME);
    fs.writeFileSync(aiPath, JSON.stringify(sessionDocument({
      account: { uid: 'local-user', name: 'AI account', email: 'private@example.test' },
      auth: { accessToken: 'ai-token', domain: 'www.workbuddy.ai' }
    })));
    const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin',
      fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200 }; } });
    const infos = auth.getSessionInfos();
    assert.deepEqual(infos.map((info) => info.realm), ['cn', 'ai']);
    assert.notEqual(infos[0].accountKey, infos[1].accountKey);
    assert.equal(infos[1].accountKey, workbuddyAccountKey({ realm: 'ai', userId: 'local-user' }));
    assert.equal(infos[1].accountName, 'AI account');
    assert.doesNotMatch(JSON.stringify(infos), /fixture-access-token|ai-token|private@example|expiresAt|refreshToken/);
    assert.equal(auth.getSessionInfo().realm, 'cn');
    const url = 'https://www.workbuddy.ai/billing/meter/get-user-resource';
    await auth.request(url, { method: 'POST', headers: { Host: 'evil.test', Referer: 'https://evil.test/path',
      Origin: 'https://evil.test', Authorization: 'caller', Cookie: 'caller' }, credentials: 'include' }, infos[1]);
    assert.equal(requests[0].init.headers.Authorization, 'Bearer ai-token');
    assert.equal(requests[0].init.headers.Host, undefined);
    assert.equal(requests[0].init.headers.Referer, undefined);
    assert.equal(requests[0].init.headers.Origin, undefined);
    assert.equal(requests[0].init.headers.Cookie, undefined);
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.redirect, 'error');
    await assert.rejects(auth.request(url, { method: 'POST' }, infos[0]), /endpoint is not allowed/);
    await assert.rejects(auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource',
      { method: 'POST' }, infos[1]), /endpoint is not allowed/);
    fs.writeFileSync(`${aiPath}${WORKBUDDY_LOGOUT_MARKER_SUFFIX}`, 'logged-out');
    assert.equal(auth.getSessionInfo().authenticated, true);
    assert.equal(auth.getSessionInfo().realm, 'cn');
    assert.equal(auth.getSessionInfos().find((info) => info.realm === 'ai').authenticated, false);
    await assert.rejects(auth.request(url, { method: 'POST' }), (error) => error.status === 'notConfigured');
    assert.equal(requests.length, 1);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('WorkBuddy AI request without an AI canonical file cannot borrow the CN token', async () => {
  const fixture = createFixture();
  try {
    let calls = 0;
    const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin',
      fetch: async () => { calls += 1; return { ok: true }; } });
    await assert.rejects(auth.request('https://www.workbuddy.ai/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error.status === 'notConfigured');
    assert.equal(calls, 0);
    const aiPath = path.join(fixture.root, WORKBUDDY_AI_AUTH_FILE_NAME);
    fs.writeFileSync(aiPath, JSON.stringify(sessionDocument()));
    assert.equal(auth.getSessionInfo().authenticated, true);
    assert.equal(auth.getSessionInfos().find((info) => info.realm === 'ai').authenticated, false);
    await assert.rejects(auth.request('https://www.workbuddy.ai/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error.status === 'notConfigured');
    assert.equal(calls, 0);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('WorkBuddy AI local billing rejects exact-host/path escape routes and wrong account key', async () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, WORKBUDDY_AI_AUTH_FILE_NAME), JSON.stringify(sessionDocument({
      auth: { accessToken: 'ai-token', domain: 'www.workbuddy.ai' }
    })));
    let calls = 0;
    const auth = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin',
      fetch: async () => { calls += 1; return { ok: true, status: 200 }; } });
    const info = auth.getSessionInfos().find((info) => info.realm === 'ai');
    for (const path of ['/billing/meter/get-user-resource', '/v2/billing/meter/get-user-resource',
      '/billing/meter/get-enterprise-user-usage', '/v2/billing/meter/get-enterprise-user-usage']) {
      assert.equal(isAllowedWorkbuddyApiUrl(`https://www.workbuddy.ai${path}`, 'POST', 'ai'), true);
      assert.equal(isAllowedWorkbuddyApiUrl(`https://copilot.tencent.com${path}`, 'POST', 'ai'), false);
    }
    for (const url of ['https://www.workbuddy.ai.evil.test/billing/meter/get-user-resource',
      'https://www.workbuddy.ai:444/billing/meter/get-user-resource',
      'https://user:pass@www.workbuddy.ai/billing/meter/get-user-resource',
      'http://www.workbuddy.ai/billing/meter/get-user-resource',
      'https://www.workbuddy.ai/billing/meter/get-user-resource?q=1',
      'https://www.workbuddy.ai/billing/meter/get-user-resource#fragment',
      'https://www.workbuddy.ai/billing/meter/other']) {
      await assert.rejects(auth.request(url, { method: 'POST' }, info), /endpoint is not allowed/);
    }
    await assert.rejects(auth.request('https://www.workbuddy.ai/billing/meter/get-user-resource',
      { method: 'POST' }, { ...info, accountKey: 'wrong' }), /session changed/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('WorkBuddy encrypted local metadata deduplicates against managed identity without exposing envelopes', async () => {
  const fixture = createFixture();
  try {
    writeSealedSession(fixture.authPath);
    const local = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin' });
    assert.equal(local.getSessionInfo().userId, '');
    const sessions = local.getSessionInfos();
    assert.equal(sessions[0].userId, 'local-user');
    assert.equal(sessions[0].reason, 'encrypted');
    assert.doesNotMatch(JSON.stringify(sessions), /envelope|eyJ|accessToken|refreshToken/);
    const managed = { id: 'managed', realm: 'cn', userId: 'local-user',
      accountKey: sessions[0].accountKey, domain: 'copilot.tencent.com', enabled: true };
    const options = { workbuddyManagedAccounts: [managed], workbuddyDesktopSessionEnabled: true,
      workbuddyLocalSessions: sessions };
    const deps = { env: {}, resolveWorkbuddyManagedCredential: async () => ({ accessToken: 'managed-token' }),
      workbuddyFetch: async () => { throw new Error('must not use encrypted local session'); },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { Accounts: [] } }) }) };
    const rows = await fetchWorkbuddyLimits(options, deps);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].sourceDetail, 'managed');
    assert.deepEqual(await fetchWorkbuddyLimits({ ...options,
      workbuddyManagedAccounts: [{ ...managed, enabled: false }] }, deps), []);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('WorkBuddy AI preferred logout marker cannot revive roaming AI credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-workbuddy-ai-windows-'));
  try {
    const env = { LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') };
    const [local, roaming] = authDirectoriesForPlatform('win32', root, env);
    fs.mkdirSync(local, { recursive: true });
    fs.mkdirSync(roaming, { recursive: true });
    fs.writeFileSync(path.join(roaming, WORKBUDDY_AI_AUTH_FILE_NAME), JSON.stringify(sessionDocument({
      auth: { domain: 'www.workbuddy.ai', accessToken: 'roaming-ai-token' }
    })));
    const auth = createWorkbuddyLocalAuth({ platform: 'win32', homeDir: root, env });
    assert.equal(auth.getSessionInfo().authenticated, true);
    fs.writeFileSync(path.join(local, WORKBUDDY_AI_AUTH_FILE_NAME + WORKBUDDY_LOGOUT_MARKER_SUFFIX), 'logged-out');
    assert.equal(auth.getSessionInfo().authenticated, false);
    assert.deepEqual(auth.getSessionInfos().map((info) => [info.realm, info.reason]), [['ai', 'absent']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WorkBuddy direct local requests enforce deadlines and reject switches without an explicit expected session', async () => {
  const fixture = createFixture();
  try {
    let signal;
    const stalled = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin', workbuddyFetchTimeoutMs: 10,
      fetch: async (_, init) => { signal = init.signal; return new Promise(() => {}); } });
    await assert.rejects(stalled.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource',
      { method: 'POST' }), (error) => error.status === 'timeout');
    assert.equal(signal.aborted, true);
    const switching = createWorkbuddyLocalAuth({ authDirectory: fixture.root, platform: 'darwin', fetch: async () => {
      fs.writeFileSync(fixture.authPath, JSON.stringify(sessionDocument({ account: { uid: 'another-user' } })));
      return { ok: true, status: 200 };
    } });
    await assert.rejects(switching.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource',
      { method: 'POST' }), /session changed/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
