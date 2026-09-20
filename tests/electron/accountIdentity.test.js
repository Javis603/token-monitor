'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  accountKeyFamily,
  codexAccountDisplayLabel,
  codexAccountIdForProvider,
  codexAccountMatchesProvider,
  codexManagedAccountPlanLabel,
  isCodexLiveAccount,
  localLiveCodexProvider,
  maskEmailAddress,
  sameAccount
} = require('../../src/electron/renderer/accountIdentity');

test('Codex account email masking uses the final separator in quoted local parts', () => {
  assert.equal(maskEmailAddress('primary.user@example.com'), 'p***r@example.com');
  assert.equal(maskEmailAddress('ab@example.com'), 'a***b@example.com');
  assert.equal(maskEmailAddress('"user@name"@example.com'), '"***"@example.com');
});

test('Codex account labels add workspace context only when identity labels collide', () => {
  const unique = [
    { accountEmail: 'one@example.com', accountName: 'Personal' },
    { accountEmail: 'two@example.com', accountName: 'Acme Team' }
  ];
  assert.equal(codexAccountDisplayLabel(unique[0], unique), 'one@example.com');
  assert.equal(codexAccountDisplayLabel(unique[1], unique), 'two@example.com');

  const duplicateEmail = [
    { accountEmail: 'member@example.com', accountName: 'Personal' },
    { accountEmail: 'member@example.com', accountName: 'Acme Team' }
  ];
  assert.equal(
    codexAccountDisplayLabel(duplicateEmail[0], duplicateEmail),
    'member@example.com · Personal'
  );
  assert.equal(
    codexAccountDisplayLabel(duplicateEmail[1], duplicateEmail),
    'member@example.com · Acme Team'
  );

  const semanticPersonal = [
    { accountEmail: 'member@example.com', workspaceKind: 'personal' },
    { accountEmail: 'member@example.com', accountName: 'Acme Team' }
  ];
  assert.equal(
    codexAccountDisplayLabel(semanticPersonal[0], semanticPersonal),
    'member@example.com · Personal'
  );
  assert.equal(
    codexAccountDisplayLabel(semanticPersonal[0], semanticPersonal, {
      personalWorkspaceLabel: '個人'
    }),
    'member@example.com · 個人'
  );

  const maskedCollision = [
    { accountEmail: 'primary.user@example.com', accountName: 'Personal' },
    { accountEmail: 'power@example.com', accountName: 'Acme Team' }
  ];
  assert.equal(
    codexAccountDisplayLabel(maskedCollision[0], maskedCollision, { maskEmail: true }),
    'p***r@example.com · Personal'
  );
  assert.equal(
    codexAccountDisplayLabel(maskedCollision[1], maskedCollision, { maskEmail: true }),
    'p***r@example.com · Acme Team'
  );

  assert.equal(
    codexAccountDisplayLabel({ accountName: 'Workspace without email' }, unique),
    'Workspace without email'
  );

  const duplicateWorkspaceNames = [
    {
      accountEmail: 'member@example.com',
      accountName: 'Acme Team',
      accountKey: 'sha256:abcdef123456'
    },
    {
      accountEmail: 'member@example.com',
      accountName: 'Acme Team',
      accountKey: 'sha256:abcdef654321'
    }
  ];
  assert.equal(
    codexAccountDisplayLabel(duplicateWorkspaceNames[0], duplicateWorkspaceNames),
    'member@example.com · Acme Team · #abcdef1'
  );
  assert.equal(
    codexAccountDisplayLabel(duplicateWorkspaceNames[1], duplicateWorkspaceNames),
    'member@example.com · Acme Team · #abcdef6'
  );
});

test('Codex account identity matches by key or normalized email fields', () => {
  assert.equal(codexAccountMatchesProvider(
    { accountKey: 'account-1' },
    { provider: 'codex', accountKey: 'account-1' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { accountKey: 'account-1', email: 'shared@example.com' },
    { provider: 'codex', accountKey: 'account-2', accountEmail: 'shared@example.com' }
  ), false);
  assert.equal(codexAccountMatchesProvider(
    { accountEmail: 'User@Example.com' },
    { provider: 'codex', accountEmail: 'user@example.com' }
  ), true);
  assert.equal(codexAccountMatchesProvider(
    { email: 'user@example.com' },
    { provider: 'claude', accountEmail: 'user@example.com' }
  ), false);
  assert.equal(codexAccountIdForProvider([
    { id: 'one', accountKey: 'account-1' },
    { id: 'two', accountKey: 'account-2' }
  ], { provider: 'codex', accountKey: 'account-2' }), 'two');
  assert.equal(codexAccountIdForProvider([
    { id: 'one', accountKey: 'account-1', email: 'shared@example.com' },
    { id: 'two', accountKey: 'account-2', email: 'shared@example.com' }
  ], {
    provider: 'codex',
    accountKey: 'account-2',
    accountEmail: 'shared@example.com'
  }), 'two');
});

test('managed Codex plan labels prefer a matching successful provider', () => {
  const account = {
    accountKey: 'account-1',
    email: 'user@example.com',
    accountLabel: 'plus'
  };
  assert.equal(codexManagedAccountPlanLabel(account, [
    { provider: 'codex', status: 'error', accountKey: 'account-1', accountLabel: 'team' },
    { provider: 'codex', status: 'ok', accountKey: 'account-2', accountLabel: 'pro' },
    { provider: 'codex', status: 'ok', accountKey: 'account-1', accountLabel: 'free' }
  ]), 'free');
  assert.equal(codexManagedAccountPlanLabel(account, [
    { provider: 'codex', status: 'error', accountKey: 'account-1', accountLabel: 'free' }
  ]), 'plus');
});

test('live Codex provider selection uses local raw limits with a legacy aggregate fallback', () => {
  const localLive = { provider: 'codex', status: 'ok', sourceDetail: 'app', accountKey: 'local' };
  const remoteLive = { provider: 'codex', status: 'ok', sourceDetail: 'cli', accountKey: 'remote' };
  const managed = { provider: 'codex', status: 'ok', sourceDetail: 'managed', accountKey: 'managed' };
  const stats = {
    devices: [
      { deviceId: 'this-device', limits: { providers: [managed, localLive] } },
      { deviceId: 'other-device', limits: { providers: [remoteLive] } }
    ],
    limits: { providers: [remoteLive] }
  };

  assert.equal(isCodexLiveAccount(localLive), true);
  assert.equal(isCodexLiveAccount(managed), false);
  assert.equal(localLiveCodexProvider(stats, 'this-device'), localLive);
  assert.equal(localLiveCodexProvider(stats, 'missing-device'), null);
  assert.equal(localLiveCodexProvider({ limits: stats.limits }, 'this-device'), remoteLive);
});

test('one account is one account, whatever each copy of it is called', () => {
  const codex = (overrides) => ({ provider: 'codex', ...overrides });

  // The key a record is named by, and the keys it was named by before: the
  // family is what a rotation leaves behind, so it is a set rather than a string.
  assert.deepEqual([...accountKeyFamily(codex({ accountKey: 'k', webAccountKey: 'w', accountKeyAliases: ['old', ''] }))], [
    'k',
    'w',
    'old'
  ]);
  assert.equal(sameAccount(codex({ accountKey: 'k' }), codex({ webAccountKey: 'k' })), true);
  assert.equal(sameAccount(codex({ accountKey: 'new', accountKeyAliases: ['old'] }), codex({ accountKey: 'old' })), true);

  // The same key under two display names is one account: the name is the user's
  // own label, and it is not what makes an account one.
  assert.equal(sameAccount(codex({ accountKey: 'k', accountName: 'work' }), codex({ accountKey: 'k', accountName: 'Work' })), true);

  // Keys that disagree are two accounts, unless the address bridges them — the
  // rotation the matcher heals by falling through to it.
  assert.equal(sameAccount(codex({ accountKey: 'k1' }), codex({ accountKey: 'k2' })), false);
  assert.equal(
    sameAccount(codex({ accountKey: 'k1', accountEmail: 'me@example.com' }), codex({ accountKey: 'k2', accountEmail: 'me@example.com' })),
    true
  );
  assert.equal(
    sameAccount(codex({ accountKey: 'k1', accountEmail: 'me@example.com' }), codex({ accountKey: 'k2', accountEmail: 'you@example.com' })),
    false
  );

  // Accounts a provider reports by address alone: without keys the address is
  // the only thing telling them apart, and an identity that read neither counted
  // them as one.
  assert.equal(sameAccount(codex({ accountEmail: 'a@example.com' }), codex({ accountEmail: 'b@example.com' })), false);
  assert.equal(sameAccount(codex({ accountEmail: 'a@example.com' }), codex({ accountEmail: 'A@Example.com' })), true);
  assert.equal(sameAccount(codex({ accountEmail: 'a@example.com' }), codex({ accountKey: 'k', accountEmail: 'a@example.com' })), true);

  // Nothing to tell them apart by: one account, which is also what keeps the
  // matcher's sole-account fallback able to heal a credential.
  assert.equal(sameAccount(codex({}), codex({ accountName: 'work' })), true);

  // Keys are only unique within a provider, so the provider is part of the rule.
  assert.equal(sameAccount(codex({ accountKey: 'k' }), { provider: 'claude', accountKey: 'k' }), false);
});

test('renderer loads the shared Codex identity API before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  const identityIndex = html.indexOf('<script src="accountIdentity.js"></script>');
  assert.ok(identityIndex < html.indexOf('<script src="limitProviderPresentation.js"></script>'));
  assert.ok(identityIndex < html.indexOf('<script src="app.js"></script>'));
});
