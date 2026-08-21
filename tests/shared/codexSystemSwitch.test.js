'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  codexAuthMaterialForWorkspace,
  codexAccountMatchesIdentity,
  findMatchingCodexAccount,
  liveCodexAuthPath,
  readCodexAuthMaterial,
  writeCodexAuthFile
} = require('../../src/shared/codexSystemSwitch');

function makeIdToken(payload) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment(payload)}.`;
}

test('liveCodexAuthPath respects CODEX_HOME and otherwise uses the default Codex home', () => {
  assert.equal(
    liveCodexAuthPath({ CODEX_HOME: '/tmp/scoped-codex-home' }, '/Users/example'),
    path.join('/tmp/scoped-codex-home', 'auth.json')
  );
  assert.equal(
    liveCodexAuthPath({}, '/Users/example'),
    path.join('/Users/example', '.codex', 'auth.json')
  );
});

test('managed Codex accounts match identities by stable key or lower-cased email', () => {
  const accounts = [
    { id: 'first', accountKey: 'sha256:first', email: 'first@example.com' },
    { id: 'second', accountKey: 'sha256:second', email: 'second@example.com' }
  ];

  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:first' }), true);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { email: 'FIRST@example.com' }), true);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:second' }), false);
  assert.equal(codexAccountMatchesIdentity(accounts[0], { accountKey: 'sha256:other', email: 'first@example.com' }), false);
  assert.equal(findMatchingCodexAccount(accounts, { email: 'SECOND@example.com' })?.id, 'second');
});

test('managed Codex accounts keep same-email workspaces distinct', () => {
  const accounts = [
    {
      id: 'personal',
      accountKey: 'sha256:personal',
      email: 'shared@example.com',
      workspaceAccountId: 'workspace-personal'
    },
    {
      id: 'team',
      accountKey: 'sha256:team',
      email: 'shared@example.com',
      workspaceAccountId: 'workspace-team'
    }
  ];

  assert.equal(codexAccountMatchesIdentity(accounts[0], {
    accountKey: 'sha256:team',
    email: 'shared@example.com',
    workspaceAccountId: 'workspace-team'
  }), false);
  assert.equal(findMatchingCodexAccount(accounts, {
    accountKey: 'sha256:team',
    email: 'shared@example.com',
    workspaceAccountId: 'workspace-team'
  })?.id, 'team');
});

test('system switching applies a JWT-proven workspace without mutating managed auth material', () => {
  const auth = {
    tokens: {
      access_token: 'access-token',
      account_id: 'workspace-default',
      id_token: makeIdToken({
        email: 'member@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-team',
          chatgpt_account_is_fedramp: true
        }
      })
    }
  };
  const material = {
    auth,
    data: JSON.stringify(auth),
    identity: { email: 'member@example.com', workspaceAccountId: 'workspace-default' },
    authPath: '/managed/auth.json'
  };

  const selected = codexAuthMaterialForWorkspace(material, ' WORKSPACE-TEAM ');

  assert.equal(codexAuthMaterialForWorkspace(material, ''), material);
  assert.equal(auth.tokens.account_id, 'workspace-default');
  assert.equal(material.data, JSON.stringify(auth));
  assert.equal(selected.auth.tokens.account_id, 'workspace-team');
  assert.equal(JSON.parse(selected.data).tokens.account_id, 'workspace-team');
  assert.equal(selected.identity.email, 'member@example.com');
  assert.equal(selected.identity.workspaceAccountId, 'workspace-team');
  assert.equal(selected.identity.isFedrampAccount, true);
  assert.equal(selected.authPath, '/managed/auth.json');
});

test('system switching refuses a workspace not proven by the auth snapshot', () => {
  const auth = {
    tokens: {
      access_token: 'access-token',
      account_id: 'workspace-default',
      id_token: makeIdToken({
        email: 'member@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-default',
          chatgpt_account_is_fedramp: false
        }
      })
    }
  };
  const material = {
    auth,
    data: JSON.stringify(auth),
    identity: { email: 'member@example.com', workspaceAccountId: 'workspace-default' }
  };

  assert.throws(
    () => codexAuthMaterialForWorkspace(material, 'workspace-gov'),
    /routing could not be verified/
  );
  assert.equal(auth.tokens.account_id, 'workspace-default');
});

test('Codex auth files are written atomically with private permissions and readable identity', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'token-monitor-codex-switch-'));
  const authPath = path.join(root, 'live', 'auth.json');
  const authData = JSON.stringify({
    account: { email: 'Primary.User@Example.com', planType: 'plus' }
  });

  await writeCodexAuthFile(authPath, authData);

  const stat = await fs.promises.stat(authPath);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }

  const material = await readCodexAuthMaterial(authPath);
  assert.equal(material.data, authData);
  assert.equal(material.identity.email, 'primary.user@example.com');
  assert.equal(material.identity.accountLabel, 'plus');
});
