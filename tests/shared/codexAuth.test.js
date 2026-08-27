'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  codexAccountKey,
  codexManagedAccountIdentityKey,
  codexManagedAccountMatchesIdentity,
  decodeJwtPayload,
  codexAuthIdentity,
  codexOAuthRequestContext,
  codexStoredAccountId,
  hashAccountKey,
  preserveCodexManagedHydrationCollisions,
  upgradeCodexManagedAccountIdentity,
  parseCodexAuthJson,
  authFromCodexAccessToken
} = require('../../src/shared/codexAuth');

function jwt(payload) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(payload)}.`;
}

function sampleAuthJson({ email = 'alice@example.com', plan = 'plus', accountId = 'acct_1' } = {}) {
  return {
    tokens: {
      access_token: 'access-jwt',
      id_token: jwt({ email, chatgpt_plan_type: plan, chatgpt_account_id: accountId })
    }
  };
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

test('OAuth request context prefers an explicit workspace, then stored account_id, then JWT fallback', () => {
  const auth = {
    tokens: {
      access_token: 'access-token',
      account_id: 'workspace-current',
      id_token: jwt({
        email: 'member@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-claimed'
        }
      })
    }
  };

  assert.equal(codexAuthIdentity(auth).workspaceAccountId, 'workspace-current');
  assert.deepEqual(codexOAuthRequestContext(auth), {
    accessToken: 'access-token',
    accountId: 'workspace-current',
    isFedrampAccount: false
  });
  assert.equal(codexOAuthRequestContext(auth, { accountId: 'workspace-selected' }).accountId, 'workspace-selected');
  assert.equal(codexOAuthRequestContext({
    tokens: {
      access_token: 'access-token',
      id_token: auth.tokens.id_token
    }
  }).accountId, 'workspace-claimed');
});

test('OAuth request context uses FedRAMP routing only for the claimed workspace', () => {
  const auth = {
    tokens: {
      access_token: 'access-token',
      account_id: 'workspace-government',
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-government',
          chatgpt_account_is_fedramp: true
        }
      })
    }
  };

  assert.equal(codexOAuthRequestContext(auth).isFedrampAccount, true);
  assert.equal(codexOAuthRequestContext(auth, {
    accountId: 'workspace-commercial'
  }).isFedrampAccount, false);
});

test('codexStoredAccountId does not use the JWT workspace fallback', () => {
  const idToken = jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-claimed'
    }
  });
  assert.equal(codexStoredAccountId({ tokens: { id_token: idToken } }), '');
  assert.equal(codexStoredAccountId({
    tokens: {
      account_id: 'workspace-stored',
      id_token: idToken
    }
  }), 'workspace-stored');
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

test('codexManagedAccountMatchesIdentity rejects incomplete same-workspace identities', () => {
  const identity = codexAuthIdentity({
    tokens: { account_id: 'workspace-team', id_token: jwt({ email: 'member@example.com' }) }
  });
  assert.equal(codexManagedAccountMatchesIdentity({
    email: '',
    workspaceAccountId: 'workspace-team',
    accountKey: hashAccountKey('workspace-team')
  }, identity), false);
  assert.equal(codexManagedAccountMatchesIdentity({
    email: 'member@example.com',
    workspaceAccountId: 'workspace-team',
    accountKey: identity.accountKey
  }, {
    ...identity,
    email: ''
  }), false);
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

test('upgradeCodexManagedAccountIdentity migrates legacy keys from the account auth identity', () => {
  const identity = codexAuthIdentity({
    tokens: {
      account_id: 'workspace-team',
      id_token: jwt({
        email: 'member@example.com',
        chatgpt_plan_type: 'team'
      })
    }
  });
  const upgraded = upgradeCodexManagedAccountIdentity({
    id: 'legacy',
    email: 'member@example.com',
    accountKey: hashAccountKey('member@example.com'),
    accountLabel: 'plus',
    workspaceAccountId: '',
    workspaceLabel: 'Acme Team'
  }, identity);

  assert.equal(upgraded.accountKey, identity.accountKey);
  assert.equal(upgraded.accountLabel, 'team');
  assert.equal(upgraded.workspaceAccountId, 'workspace-team');
  assert.equal(upgraded.workspaceLabel, 'Acme Team');
});

test('upgradeCodexManagedAccountIdentity preserves stored email in a composite workspace key', () => {
  const stored = {
    id: 'member',
    email: 'member@example.com',
    accountKey: codexAccountKey('member@example.com', 'workspace-team'),
    workspaceAccountId: 'workspace-team'
  };
  const identityWithoutEmail = codexAuthIdentity({
    tokens: { account_id: 'workspace-team' }
  });
  const upgraded = upgradeCodexManagedAccountIdentity(stored, identityWithoutEmail);

  assert.equal(upgraded.email, 'member@example.com');
  assert.equal(upgraded.workspaceAccountId, 'workspace-team');
  assert.equal(upgraded.accountKey, codexAccountKey('member@example.com', 'workspace-team'));
});

test('upgradeCodexManagedAccountIdentity fails closed on conflicting stored identity', () => {
  const identity = codexAuthIdentity({
    tokens: {
      account_id: 'workspace-team',
      id_token: jwt({ email: 'member@example.com' })
    }
  });
  const wrongEmail = {
    email: 'other@example.com',
    accountKey: 'sha256:old'
  };
  const wrongWorkspace = {
    email: 'member@example.com',
    workspaceAccountId: 'workspace-personal',
    accountKey: 'sha256:old'
  };

  assert.equal(upgradeCodexManagedAccountIdentity(wrongEmail, identity), wrongEmail);
  assert.equal(upgradeCodexManagedAccountIdentity(wrongWorkspace, identity), wrongWorkspace);
});

test('managed Codex hydration preserves legacy identities when upgrades collide', () => {
  const stored = [
    {
      id: 'legacy-personal',
      email: 'member@example.com',
      accountKey: 'sha256:legacy-personal'
    },
    {
      id: 'legacy-team',
      email: 'member@example.com',
      accountKey: 'sha256:legacy-team'
    },
    {
      id: 'other',
      email: 'other@example.com',
      accountKey: 'sha256:other'
    }
  ];
  const hydrated = [
    {
      ...stored[0],
      workspaceAccountId: 'workspace-personal',
      accountKey: codexAccountKey('member@example.com', 'workspace-personal')
    },
    {
      ...stored[1],
      workspaceAccountId: 'workspace-personal',
      accountKey: codexAccountKey('member@example.com', 'workspace-personal')
    },
    {
      ...stored[2],
      workspaceAccountId: 'workspace-other',
      accountKey: codexAccountKey('other@example.com', 'workspace-other')
    }
  ];

  const resolved = preserveCodexManagedHydrationCollisions(stored, hydrated);
  assert.equal(resolved[0], stored[0]);
  assert.equal(resolved[1], stored[1]);
  assert.equal(resolved[2], hydrated[2]);
  assert.equal(new Set(resolved.map(codexManagedAccountIdentityKey)).size, stored.length);
});

test('managed Codex hydration resolves cascading collisions without dropping accounts', () => {
  const stored = [
    { id: 'a', accountKey: 'a' },
    { id: 'b', accountKey: 'b' },
    { id: 'c', accountKey: 'c' }
  ];
  const hydrated = [
    { ...stored[0], accountKey: 'x' },
    { ...stored[1], accountKey: 'x' },
    { ...stored[2], accountKey: 'a' }
  ];

  const resolved = preserveCodexManagedHydrationCollisions(stored, hydrated);
  assert.deepEqual(resolved, stored);
  assert.equal(new Set(resolved.map(codexManagedAccountIdentityKey)).size, stored.length);
});

test('parseCodexAuthJson yields the same identity the web-login path derives', () => {
  const auth = sampleAuthJson();
  const { identity, data, source } = parseCodexAuthJson(JSON.stringify(auth));
  // The import path and the web-login path both run codexAuthIdentity over the parsed auth, so an
  // imported account lands on the identical id/email/keys as a browser sign-in.
  assert.deepEqual(identity, codexAuthIdentity(auth));
  assert.equal(identity.email, 'alice@example.com');
  assert.equal(identity.accountLabel, 'plus');
  assert.match(identity.accountKey, /^sha256:[0-9a-f]{64}$/);
  // Normalized storage text matches the shape writeCodexAuthFile stores for a web-login account.
  assert.equal(data, `${JSON.stringify(auth, null, 2)}\n`);
  assert.equal(source, 'authJson');
});

test('parseCodexAuthJson rejects malformed auth.json with a clear error', () => {
  assert.throws(() => parseCodexAuthJson('{not json'), /not valid JSON/);
  assert.throws(() => parseCodexAuthJson(''), /empty/);
  assert.throws(() => parseCodexAuthJson('   '), /empty/);
  assert.throws(() => parseCodexAuthJson('null'), /JSON object/);
  assert.throws(() => parseCodexAuthJson('[]'), /JSON object/);
  assert.throws(() => parseCodexAuthJson(JSON.stringify({ tokens: {} })), /Could not identify/);
});

test('authFromCodexAccessToken identifies a JWT and falls back to a pasted auth.json', () => {
  const token = jwt({ email: 'bob@example.com', chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct_2' });
  const { identity, auth, data, source } = authFromCodexAccessToken(token);
  assert.equal(identity.email, 'bob@example.com');
  assert.equal(identity.accountLabel, 'pro');
  assert.equal(identity.providerAccountId, 'acct_2');
  assert.equal(auth.tokens.access_token, token);
  assert.equal(auth.tokens.id_token, token);
  assert.ok(data.includes('"access_token"'));
  assert.ok(data.includes('"id_token"'));
  assert.equal(source, 'token');

  // A pasted full auth.json delegates to the structured parser for a consistent result, and is
  // tagged as authJson so the import handler stores it as a credential file, not a bare token.
  const pasted = JSON.stringify(sampleAuthJson({ email: 'carol@example.com' }));
  const fromJson = authFromCodexAccessToken(pasted);
  assert.equal(fromJson.identity.email, 'carol@example.com');
  assert.equal(fromJson.source, 'authJson');
  assert.deepEqual(fromJson.identity, codexAuthIdentity(JSON.parse(pasted)));
});

test('authFromCodexAccessToken rejects empty or identity-less tokens', () => {
  assert.throws(() => authFromCodexAccessToken(''), /empty/);
  assert.throws(() => authFromCodexAccessToken('   '), /empty/);
  assert.throws(() => authFromCodexAccessToken('opaque-token-without-claims'), /Could not identify/);
});
