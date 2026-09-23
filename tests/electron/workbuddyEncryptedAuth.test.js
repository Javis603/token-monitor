'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WORKBUDDY_AUTH_FILE_NAME,
  createWorkbuddyLocalAuth
} = require('../../src/electron/providers/workbuddy/localAuth');

function createEncryptedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-workbuddy-encrypted-'));
  const authPath = path.join(root, WORKBUDDY_AUTH_FILE_NAME);
  fs.writeFileSync(authPath, JSON.stringify({
    account: { uid: 'fixture-user', accountType: 'personal', type: 'personal' },
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'fixture-envelope' },
      domain: 'copilot.tencent.com',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
  }), 'utf8');
  return { root, authPath };
}

test('WorkBuddy encrypted accessToken is opened through the injected codec and used only for billing', async () => {
  const fixture = createEncryptedFixture();
  const requests = [];
  let decodeCalls = 0;
  try {
    const auth = createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'win32',
      homeDir: fixture.root,
      decryptAccessToken: (value) => {
        decodeCalls += 1;
        assert.deepEqual(value, { $wbEncrypted: 1, envelope: 'fixture-envelope' });
        return 'fixture-decrypted-token';
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { status: 200, ok: true, json: async () => ({}) };
      }
    });

    assert.equal(auth.getSessionInfo().authenticated, true);
    assert.equal(auth.getSessionInfo().userId, 'fixture-user');
    assert.equal(decodeCalls, 0);
    await auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' });
    assert.equal(decodeCalls, 1);
    assert.equal(requests[0].init.headers.Authorization, 'Bearer fixture-decrypted-token');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy encrypted auth does not invoke the codec for expired or switched metadata', async () => {
  const fixture = createEncryptedFixture();
  let decodeCalls = 0;
  try {
    const auth = require('../../src/electron/providers/workbuddy/localAuth').createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'win32',
      homeDir: fixture.root,
      decryptAccessToken: () => { decodeCalls += 1; return 'fixture-token'; },
      fetch: async () => ({ status: 200, ok: true, json: async () => ({}) })
    });
    await assert.rejects(
      () => auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }, {
        authenticated: true, userId: 'other-user', enterpriseId: '', departmentInfo: '', domain: 'copilot.tencent.com', accountType: 'personal'
      }), /session changed/
    );
    assert.equal(decodeCalls, 0);
    const value = JSON.parse(fs.readFileSync(fixture.authPath, 'utf8'));
    value.auth.expiresAt = Date.now() - 60_000;
    fs.writeFileSync(fixture.authPath, JSON.stringify(value), 'utf8');
    await assert.rejects(
      () => auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }), (error) => error?.status === 'unauthorized'
    );
    assert.equal(decodeCalls, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy Windows keeps malformed encrypted wrappers fail-closed', () => {
  const fixture = createEncryptedFixture();
  try {
    const document = JSON.parse(fs.readFileSync(fixture.authPath, 'utf8'));
    document.auth.accessToken = { $wbEncrypted: 1, envelope: 'fixture-envelope', extra: true };
    fs.writeFileSync(fixture.authPath, JSON.stringify(document), 'utf8');
    const auth = require('../../src/electron/providers/workbuddy/localAuth').createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'win32',
      decryptAccessToken: () => 'must-not-run'
    });
    assert.equal(auth.getSessionInfo().authenticated, false);
    assert.equal(auth.getSessionInfo().reason, 'encrypted');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WorkBuddy Windows codec failure carries the encrypted reason to limits', async () => {
  const fixture = createEncryptedFixture();
  try {
    const auth = require('../../src/electron/providers/workbuddy/localAuth').createWorkbuddyLocalAuth({
      authDirectory: fixture.root,
      platform: 'win32',
      decryptAccessToken: () => null,
      fetch: async () => ({ status: 200, ok: true, json: async () => ({}) })
    });
    await assert.rejects(
      () => auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }),
      (error) => error?.workbuddySessionReason === 'encrypted'
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
