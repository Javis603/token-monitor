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
  authDirectoriesForPlatform,
  authDirectoryForPlatform,
  createWorkbuddyLocalAuth,
  isAllowedWorkbuddyApiUrl,
  normalizeStoredSession,
  sanitizeRequestInit
} = require('../../src/electron/workbuddyLocalAuth');

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
    assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(requests[0].init.headers['X-User-Id'], 'local-user');
    assert.equal(requests[0].init.headers.Cookie, undefined);
    assert.equal(requests[0].init.headers['X-Refresh-Token'], undefined);
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
  assert.equal(isAllowedWorkbuddyApiUrl(personal, 'POST'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(enterprise, 'post'), true);
  assert.equal(isAllowedWorkbuddyApiUrl(personal, 'GET'), false);
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
    body: '{}'
  });
});
