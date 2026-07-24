'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  codexManagedAccountMatchesIdentity,
  decodeJwtPayload,
  codexAuthIdentity,
  hashAccountKey
} = require('../../src/shared/codexAuth');

function jwt(payload) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(payload)}.`;
}

test('decodeJwtPayload returns the decoded middle segment', () => {
  const token = jwt({ email: 'a@b.com', sub: 'user-1' });
  assert.deepEqual(decodeJwtPayload(token), { email: 'a@b.com', sub: 'user-1' });
});

test('decodeJwtPayload returns {} for malformed tokens', () => {
  assert.deepEqual(decodeJwtPayload('not-a-jwt'), {});
  assert.deepEqual(decodeJwtPayload(''), {});
  assert.deepEqual(decodeJwtPayload(null), {});
});

test('codexAuthIdentity reads modern auth.json with top-level claims', () => {
  const identity = codexAuthIdentity({
    tokens: {
      id_token: jwt({
        email: 'User@Example.com',
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acct_123'
      })
    }
  });
  assert.equal(identity.email, 'user@example.com');
  assert.equal(identity.accountLabel, 'plus');
  assert.equal(identity.providerAccountId, 'acct_123');
  assert.match(identity.accountKey, /^sha256:[0-9a-f]{64}$/);
});

test('codexAuthIdentity reads nested OpenAI auth claims', () => {
  const identity = codexAuthIdentity({
    tokens: {
      id_token: jwt({
        email: 'nested@example.com',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
          chatgpt_account_id: 'acct_nested'
        }
      })
    }
  });
  assert.equal(identity.email, 'nested@example.com');
  assert.equal(identity.accountLabel, 'pro');
  assert.equal(identity.providerAccountId, 'acct_nested');
});

test('codexAuthIdentity prefers the selected workspace from tokens.account_id', () => {
  const identity = codexAuthIdentity({
    tokens: {
      account_id: ' WORKSPACE-TEAM ',
      id_token: jwt({
        email: 'member@example.com',
        sub: 'user-stable',
        chatgpt_account_id: 'workspace-personal'
      })
    }
  });
  assert.equal(identity.providerAccountId, 'workspace-team');
  assert.equal(identity.workspaceAccountId, 'workspace-team');
});

test('codexAuthIdentity keys on the stable provider account id, not the rotating id_token', () => {
  const first = codexAuthIdentity({
    tokens: { id_token: jwt({ email: 'same@example.com', chatgpt_account_id: 'acct_stable' }) }
  });
  const afterRefresh = codexAuthIdentity({
    tokens: { id_token: jwt({ email: 'same@example.com', chatgpt_account_id: 'acct_stable', nonce: 'rotated' }) }
  });
  assert.equal(first.accountKey, afterRefresh.accountKey);
});

test('codexAuthIdentity separates same-email workspaces and same-workspace members', () => {
  const personal = codexAuthIdentity({
    tokens: { account_id: 'workspace-personal', id_token: jwt({ email: 'same@example.com' }) }
  });
  const team = codexAuthIdentity({
    tokens: { account_id: 'workspace-team', id_token: jwt({ email: 'same@example.com' }) }
  });
  const teammate = codexAuthIdentity({
    tokens: { account_id: 'workspace-team', id_token: jwt({ email: 'other@example.com' }) }
  });
  assert.notEqual(personal.accountKey, team.accountKey);
  assert.notEqual(team.accountKey, teammate.accountKey);
});

test('codexAuthIdentity does not treat JWT subject as a workspace id', () => {
  const identity = codexAuthIdentity({
    tokens: { id_token: jwt({ email: 'same@example.com', sub: 'user-stable' }) }
  });
  assert.equal(identity.providerAccountId, '');
  assert.equal(identity.workspaceAccountId, '');
});

test('codexAuthIdentity falls back to the account email when no id_token is present', () => {
  const identity = codexAuthIdentity({ account: { email: 'Legacy@Example.com', planType: 'team' } });
  assert.equal(identity.email, 'legacy@example.com');
  assert.equal(identity.accountLabel, 'team');
  assert.equal(identity.providerAccountId, '');
  assert.match(identity.accountKey, /^sha256:[0-9a-f]{64}$/);
});

test('codexAuthIdentity returns empty identity when nothing is resolvable', () => {
  const identity = codexAuthIdentity({});
  assert.equal(identity.email, '');
  assert.equal(identity.accountLabel, '');
  assert.equal(identity.providerAccountId, '');
  assert.equal(identity.workspaceAccountId, '');
  assert.equal(identity.accountKey, '');
});

test('codexManagedAccountMatchesIdentity keeps same-email workspaces distinct', () => {
  const team = codexAuthIdentity({
    tokens: { account_id: 'workspace-team', id_token: jwt({ email: 'same@example.com' }) }
  });
  assert.equal(codexManagedAccountMatchesIdentity({
    email: 'same@example.com',
    workspaceAccountId: 'workspace-personal',
    accountKey: 'sha256:personal'
  }, team), false);
  assert.equal(codexManagedAccountMatchesIdentity({
    email: 'same@example.com',
    workspaceAccountId: 'workspace-team',
    accountKey: team.accountKey
  }, team), true);
});

test('codexManagedAccountMatchesIdentity upgrades legacy workspace-only keys safely', () => {
  const identity = codexAuthIdentity({
    tokens: { account_id: 'workspace-team', id_token: jwt({ email: 'member@example.com' }) }
  });
  const legacy = {
    email: 'member@example.com',
    accountKey: hashAccountKey('workspace-team')
  };
  assert.equal(codexManagedAccountMatchesIdentity(legacy, identity), true);
  assert.equal(codexManagedAccountMatchesIdentity({
    ...legacy,
    email: 'other@example.com'
  }, identity), false);
});
