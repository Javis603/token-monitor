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
  dedupeAccounts,
  isCodexLiveAccount,
  localDeviceLimitsProviders,
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

  // Two keys decide, and the address is not evidence against them: one address
  // holds several Codex workspaces, which the hub already keeps apart by key
  // (limits.test.js, "preserves same-email Codex workspaces by hashed account
  // key"). Reading the equal address as sameness merged two accounts the rest of
  // the app treats as two, and the row the matcher then resolved was the wrong
  // workspace.
  assert.equal(sameAccount(codex({ accountKey: 'k1' }), codex({ accountKey: 'k2' })), false);
  assert.equal(
    sameAccount(codex({ accountKey: 'personal', accountEmail: 'member@example.com' }), codex({ accountKey: 'team', accountEmail: 'member@example.com' })),
    false
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
  // One copy keyed and one copy not: the address is what is left to compare.
  assert.equal(sameAccount(codex({ accountEmail: 'a@example.com' }), codex({ accountKey: 'k', accountEmail: 'a@example.com' })), true);

  // Nothing to tell them apart by, on either side: one account, which is also
  // what keeps the matcher's sole-account fallback able to heal a credential.
  assert.equal(sameAccount(codex({}), codex({ accountName: 'work' })), true);
  assert.equal(sameAccount(codex({}), codex({ status: 'notConfigured' })), true);

  // A record with no identity beside one that has one is not the same account:
  // the collector reports a provider nobody is signed into as a bare
  // `notConfigured` row, and reading "no identity" as a match let that row
  // absorb every identified account of the provider — the picker then offered
  // none of them, and the row lookup answered for all of them.
  assert.equal(sameAccount(codex({}), codex({ accountKey: 'k' })), false);
  assert.equal(sameAccount(codex({}), codex({ accountEmail: 'a@example.com' })), false);
  assert.equal(sameAccount(codex({ status: 'notConfigured' }), codex({ accountKey: 'k', accountEmail: 'a@example.com' })), false);
  // A key with no address beside an address with no key: named on both sides,
  // and nothing either can be compared against.
  assert.equal(sameAccount(codex({ accountKey: 'k' }), codex({ accountEmail: 'a@example.com' })), false);
  // Whatever this answers, it has to answer the same way round.
  assert.equal(sameAccount(codex({ accountKey: 'k' }), codex({})), false);

  // Keys are only unique within a provider, so the provider is part of the rule.
  assert.equal(sameAccount(codex({ accountKey: 'k' }), { provider: 'claude', accountKey: 'k' }), false);
});

test('a list of accounts is deduped by the same rule, over the whole list', () => {
  const codex = (overrides) => ({ provider: 'codex', ...overrides });
  const personal = codex({ accountKey: 'personal', accountEmail: 'member@example.com', accountName: 'Personal' });
  const team = codex({ accountKey: 'team', accountEmail: 'member@example.com', accountName: 'Team' });
  // A keyless copy: the address is the only thing it can be named by, which is
  // what the mapper emits when the payload carries an email and no key
  // (limitCollector.codex.test.js) and what a device with an older record posts.
  const keyless = codex({ accountEmail: 'member@example.com' });
  const keysOf = (records) => records.map((record) => record.accountKey || '(no key)');
  // The survivors' order follows the input (that is the local-first priority);
  // which accounts survive is not allowed to.
  const accountsOf = (records) => [...keysOf(records)].sort();

  // The three together are two accounts, and no order can say otherwise. Pair by
  // pair the keyless copy reads as the same account as *both* keyed ones, so the
  // pairwise rule cannot be what decides this: greedy first-record deduping kept
  // the copy and dropped both workspaces, and a subscription bound to the second
  // of them then resolved onto the copy and drew on either row.
  for (const order of [
    [keyless, personal, team],
    [personal, keyless, team],
    [team, personal, keyless],
    [personal, team, keyless]
  ]) {
    assert.deepEqual(accountsOf(dedupeAccounts(order)), ['personal', 'team'], `order ${keysOf(order)} keeps both workspaces`);
  }

  // With one keyed account on that address the copy is one of its two copies,
  // which is the heal the address rung exists for — and the keyed one is the one
  // that survives, since it is the one that can be bound by key.
  assert.deepEqual(keysOf(dedupeAccounts([keyless, personal])), ['personal']);
  assert.deepEqual(keysOf(dedupeAccounts([personal, keyless])), ['personal']);

  // Two copies of one account are one account, whichever member of the family
  // each of them happens to carry, and a record naming both keys bridges the two.
  assert.deepEqual(keysOf(dedupeAccounts([codex({ accountKey: 'k' }), codex({ accountKeyAliases: ['k'] })])), ['k']);
  assert.deepEqual(
    keysOf(dedupeAccounts([
      codex({ accountKey: 'old' }),
      codex({ accountKey: 'new', accountKeyAliases: ['old'], accountEmail: 'a@example.com' }),
      codex({ accountKey: 'newer', accountKeyAliases: ['new'], accountEmail: 'a@example.com' })
    ])),
    ['old'],
    'a record naming two keys makes the accounts that hold them one'
  );

  // The survivor stands for every member of the group, so it answers to every
  // key the members were named by. The Hub's collapse hands one account's
  // records different keys — the canonical one on the record, the ones it
  // replaced beside it as aliases (limits/core.js) — and a device whose own row
  // holds only the second of them would otherwise drop the key a binding made
  // elsewhere resolves by. The record itself is left alone; no caller's app
  // state gains an alias it did not have.
  const keyOnly = codex({ accountKey: 'sha256:keyonly', accountName: 'Work' });
  const collapsed = codex({ accountKey: 'sha256:workspace', webAccountKey: 'sha256:workspace', accountKeyAliases: ['sha256:keyonly'] });
  const survivor = dedupeAccounts([keyOnly, collapsed])[0];
  assert.deepEqual([...accountKeyFamily(survivor)].sort(), ['sha256:keyonly', 'sha256:workspace']);
  assert.equal(survivor.accountName, 'Work');
  assert.deepEqual(collapsed.accountKeyAliases, ['sha256:keyonly'], 'the input record is not amended');
  // A group whose members already agree needs no alias, and gets none — the
  // record comes back as it arrived rather than copied to say nothing.
  assert.equal(dedupeAccounts([codex({ accountKey: 'k' }), codex({ accountKey: 'k' })])[0].accountKeyAliases, undefined);
  assert.equal(dedupeAccounts([keyOnly])[0], keyOnly);

  // Two addresses with no key stay two accounts; one address with no key is one.
  assert.deepEqual(
    keysOf(dedupeAccounts([codex({ accountEmail: 'a@example.com' }), codex({ accountEmail: 'b@example.com' })])),
    ['(no key)', '(no key)']
  );
  assert.deepEqual(
    keysOf(dedupeAccounts([codex({ accountEmail: 'a@example.com' }), codex({ accountEmail: 'A@Example.com' })])),
    ['(no key)']
  );

  // Nothing named is one observation, and it is not one with anything named.
  assert.deepEqual(keysOf(dedupeAccounts([codex({}), codex({})])), ['(no key)']);
  assert.deepEqual(keysOf(dedupeAccounts([codex({}), codex({ accountKey: 'k' })])), ['(no key)', 'k']);
  assert.deepEqual(keysOf(dedupeAccounts([codex({}), codex({ accountEmail: 'a@example.com' })])), ['(no key)', '(no key)']);

  // Keys only mean anything within a provider.
  assert.deepEqual(
    keysOf(dedupeAccounts([codex({ accountKey: 'k' }), { provider: 'claude', accountKey: 'k' }])),
    ['k', 'k']
  );

  // First-seen order is what a caller's local-first priority is built on.
  const localCopy = codex({ accountKey: 'k', accountName: 'work' });
  assert.deepEqual(
    dedupeAccounts([localCopy, codex({ accountKey: 'k', accountName: 'Work' })]).map((record) => record.accountName),
    ['work']
  );

  // The list comes back in the order it arrived in, providers interleaved as the
  // caller had them: the settings picker draws this list, so deduping it must not
  // reshuffle the accounts the user is looking at.
  assert.deepEqual(
    dedupeAccounts([
      codex({ accountKey: 'k' }),
      { provider: 'claude', accountKey: 'c' },
      codex({ accountKey: 'k' }),
      { provider: 'claude', accountKey: 'c' }
    ]).map((record) => `${record.provider}:${record.accountKey}`),
    ['codex:k', 'claude:c']
  );
});

test('anonymous Muse accounts are scoped to their source device', () => {
  const muse = (overrides = {}) => ({ provider: 'muse', accountKey: '', status: 'ok', ...overrides });
  const devicesOf = (records) => records.map((record) => record.sourceDeviceId || '(unknown)');

  // The hub keeps synced Muse devices apart (aggregateLimits); deduping the
  // renderer's copy of that list must not coalesce them again.
  const cases = [
    ['different devices stay separate', [muse({ sourceDeviceId: 'a' }), muse({ sourceDeviceId: 'b' })], ['a', 'b']],
    ['input order is preserved', [muse({ sourceDeviceId: 'b' }), muse({ sourceDeviceId: 'a' })], ['b', 'a']],
    ['device ids are trimmed', [muse({ sourceDeviceId: ' a ' }), muse({ sourceDeviceId: 'a' })], [' a ']],
    ['device ids stay case-sensitive', [muse({ sourceDeviceId: 'Mac' }), muse({ sourceDeviceId: 'mac' })], ['Mac', 'mac']],
    ['missing and whitespace ids are one unknown bucket', [muse({}), muse({ sourceDeviceId: '   ' }), muse({ sourceDeviceId: '' })], ['(unknown)']],
    ['unknown never absorbs a known device', [muse({}), muse({ sourceDeviceId: 'a' })], ['(unknown)', 'a']],
    ['status does not split one device', [muse({ sourceDeviceId: 'a' }), muse({ sourceDeviceId: 'a', status: 'unavailable' })], ['a']],
    ['healthy and failed rows on different devices both stay', [muse({ sourceDeviceId: 'a' }), muse({ sourceDeviceId: 'b', status: 'error' })], ['a', 'b']]
  ];
  for (const [label, records, expected] of cases) {
    assert.deepEqual(devicesOf(dedupeAccounts(records)), expected, label);
  }

  // Same-device repeats keep the first record, whichever status arrived later.
  const first = muse({ sourceDeviceId: 'a' });
  assert.equal(dedupeAccounts([first, muse({ sourceDeviceId: 'a', status: 'error' })])[0], first);

  // Explicit identities keep the generic rules: keys and emails decide, the
  // device does not split a keyed account, and other providers are unchanged.
  assert.equal(dedupeAccounts([muse({ accountKey: 'k1', sourceDeviceId: 'a' }), muse({ accountKey: 'k2', sourceDeviceId: 'a' })]).length, 2);
  assert.equal(dedupeAccounts([muse({ accountKey: 'k1', sourceDeviceId: 'a' }), muse({ accountKey: 'k1', sourceDeviceId: 'b' })]).length, 1);
  assert.equal(dedupeAccounts([muse({ accountEmail: 'a@example.com' }), muse({ accountEmail: 'b@example.com' })]).length, 2);
  assert.equal(dedupeAccounts([
    { provider: 'codex', status: 'ok', sourceDeviceId: 'a' },
    { provider: 'codex', status: 'ok', sourceDeviceId: 'b' }
  ]).length, 1, 'non-Muse anonymous dedupe is unchanged');
  assert.equal(dedupeAccounts([muse({ sourceDeviceId: 'a' }), { provider: 'codex', status: 'ok', sourceDeviceId: 'a' }]).length, 2);

  // The pair rule answers the same way the list rule does.
  const pairCases = [
    [muse({ sourceDeviceId: 'a' }), muse({ sourceDeviceId: 'a' }), true],
    [muse({ sourceDeviceId: 'a' }), muse({ sourceDeviceId: 'b' }), false],
    [muse({ sourceDeviceId: ' a ' }), muse({ sourceDeviceId: 'a' }), true],
    [muse({ sourceDeviceId: 'Mac' }), muse({ sourceDeviceId: 'mac' }), false],
    [muse({}), muse({ sourceDeviceId: '  ' }), true],
    [muse({}), muse({ sourceDeviceId: 'a' }), false],
    [muse({ sourceDeviceId: 'a' }), muse({}), false],
    [muse({ accountKey: 'k', sourceDeviceId: 'a' }), muse({ accountKey: 'k', sourceDeviceId: 'b' }), true],
    [muse({ sourceDeviceId: 'a' }), muse({ accountKey: 'k', sourceDeviceId: 'a' }), false]
  ];
  for (const [left, right, expected] of pairCases) {
    assert.equal(sameAccount(left, right), expected);
    assert.equal(sameAccount(right, left), expected, 'sameAccount is symmetric');
  }

  // Records are never amended in place.
  const frozen = Object.freeze([Object.freeze(muse({ sourceDeviceId: 'a' })), Object.freeze(muse({ sourceDeviceId: 'b' }))]);
  assert.deepEqual(devicesOf(dedupeAccounts(frozen)), ['a', 'b']);
});

test('Muse web dedupes across devices without changing CLI device identity', () => {
  const cli = { provider: 'muse', source: 'cli', status: 'ok', sourceDeviceId: 'a' };
  const remoteCli = { ...cli, sourceDeviceId: 'b' };
  const web = { ...cli, source: 'web' };
  const remoteWeb = { ...web, sourceDeviceId: 'b' };
  assert.deepEqual(dedupeAccounts([cli, web, remoteCli, remoteWeb]), [cli, web, remoteCli]);
  assert.deepEqual(dedupeAccounts([remoteWeb, web]), [remoteWeb], 'caller priority matches other anonymous providers');
  assert.equal(sameAccount(cli, remoteCli), false);
  assert.equal(sameAccount(web, remoteWeb), true);
  assert.equal(sameAccount(web, { ...web, sourceDeviceId: '' }), true);
  assert.equal(sameAccount(cli, web), false);
  assert.equal(sameAccount(web, cli), false);
});

test('local Muse rows are stamped with their device id on copies only', () => {
  const localMuse = { provider: 'muse', accountKey: '', status: 'ok' };
  const localCodex = { provider: 'codex', accountKey: 'k', status: 'ok' };
  const stats = {
    devices: [
      { deviceId: 'device-a', limits: { providers: [localMuse, localCodex] } },
      { deviceId: 'device-b', limits: { providers: [{ provider: 'muse', accountKey: '', status: 'ok' }] } }
    ]
  };
  const providers = localDeviceLimitsProviders(stats, 'device-a');
  assert.equal(providers[0].sourceDeviceId, 'device-a');
  assert.notEqual(providers[0], localMuse, 'the stamped row is a copy');
  assert.equal(localMuse.sourceDeviceId, undefined, 'caller state is not mutated');
  assert.equal(providers[1], localCodex, 'non-Muse rows are not cloned');

  // The single-device fallback stamps from that device's own id.
  const single = { devices: [{ deviceId: 'only', limits: { providers: [{ provider: 'muse', status: 'ok' }] } }] };
  assert.equal(localDeviceLimitsProviders(single)[0].sourceDeviceId, 'only');
  assert.equal(single.devices[0].limits.providers[0].sourceDeviceId, undefined);

  // An existing id is retained, and no id is invented when the device has none.
  const stamped = { provider: 'muse', status: 'ok', sourceDeviceId: 'elsewhere' };
  const retained = { devices: [{ deviceId: 'device-a', limits: { providers: [stamped] } }] };
  assert.equal(localDeviceLimitsProviders(retained, 'device-a')[0], stamped);
  const anonymous = { devices: [{ deviceId: ' ', limits: { providers: [{ provider: 'muse', status: 'ok' }] } }] };
  assert.equal(localDeviceLimitsProviders(anonymous)[0].sourceDeviceId, undefined);

  // Legacy shapes keep their meaning.
  assert.equal(localDeviceLimitsProviders({}, 'device-a'), null);
  assert.deepEqual(localDeviceLimitsProviders(stats, 'missing'), []);
  assert.deepEqual(localDeviceLimitsProviders({ devices: [{ deviceId: 'x', limits: {} }] }, 'x'), []);
});

test('renderer loads the shared Codex identity API before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
  const identityIndex = html.indexOf('<script src="accountIdentity.js"></script>');
  assert.ok(identityIndex < html.indexOf('<script src="limits/providerPresentation.js"></script>'));
  assert.ok(identityIndex < html.indexOf('<script src="app.js"></script>'));
});
