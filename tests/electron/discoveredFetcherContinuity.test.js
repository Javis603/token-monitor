'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { accountValuesFingerprint } = require('../../src/shared/limits/accountSlots');
const { limitProviderEntry } = require('../../src/shared/limits/registry');

const reading = (accountKey, status = 'ok') => ({ provider: 'factory', accountKey, status, accountName: 'Native', windows: [] });
const previous = (...keys) => ({ providers: keys.map(key => ({ ...reading(key), sourceDetail: 'app' })) });
function fixture({ label = '', savedKey = 'saved-key', serverIdentity = false } = {}) {
  const values = { factoryApiKey: 'same-credential' };
  const fingerprint = accountValuesFingerprint(values);
  const calls = [], resolved = [];
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('factory'),
    discoveredAccounts: () => [{ values, accountKey: 'discovery-key' }],
    serverAccountKey: 'provesServer', limits: { provesServer: key => key.startsWith('server-') },
    fetchLimits: () => { calls.push(true); return reading('server-current'); }
  });
  const options = { factoryAccountSlots: [{ id: 'saved', values, accountKey: savedKey, label: 'Saved name', serverIdentity }],
    factoryAmbientAccounts: { [fingerprint]: { accountKey: 'discovery-key', label, enabled: true } },
    previousLimits: previous(savedKey) };
  const deps = { env: {}, providerRuntimeState: new Map(), onAccountSlotResolved: (...args) => resolved.push(args) };
  return { fetch, options, deps, calls, resolved };
}

for (const label of ['', 'Discovered name']) test(`duplicate credentials share a request and preserve saved identity with label ${JSON.stringify(label)}`, async () => {
  const f = fixture({ label });
  const rows = await f.fetch(f.options, f.deps);
  assert.equal(f.calls.length, 1);
  const live = rows.filter(row => !row.removed);
  assert.equal(live.length, 1);
  assert.equal(live[0].accountName, label || 'Saved name');
  assert.ok(live[0].accountKeyAliases.includes('saved-key'));
  assert.ok(rows.some(row => row.removed && row.accountKey === 'saved-key'));
  const saved = f.resolved.find(call => call[1] === 'saved');
  assert.ok(saved, 'the saved slot receives its own identity callback');
  assert.equal(saved[2].accountKey, 'server-current');
  assert.equal(saved[2].accountName, 'Native', 'public identity remains separate from the local label');
  assert.ok(saved[2].accountKeyAliases.includes('saved-key'));
});

test('a reused response still separates a saved proven different server account', async () => {
  const f = fixture({ savedKey: 'server-previous', serverIdentity: true });
  const rows = await f.fetch(f.options, f.deps);
  assert.equal(f.calls.length, 1);
  assert.ok(rows.some(row => row.removed && row.accountKey === 'server-previous'));
  assert.ok(rows.filter(row => !row.removed).every(row => !row.accountKeyAliases?.includes('server-previous')));
  const saved = f.resolved.find(call => call[1] === 'saved');
  assert.ok(saved);
  assert.ok(!saved[2].accountKeyAliases.includes('server-previous'));
});

for (const key of ['known-b', 'rotated-credential-key']) test(`discovery failure ${key} retains only identities it cannot disprove`, async () => {
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('factory'),
    discoveredAccounts: () => [{ values: { factoryApiKey: 'current' }, accountKey: key }],
    fetchLimits: () => ({ provider: 'factory', status: 'unavailable', windows: [] })
  });
  const rows = await fetch({ previousLimits: previous('missing-a', 'known-b') }, { env: {} });
  assert.ok(rows.some(row => !row.removed && row.accountKey === key && row.status === 'unavailable'));
  assert.equal(rows.some(row => row.removed && row.accountKey === 'missing-a'), key === 'known-b');
  assert.ok(!rows.some(row => row.removed && row.accountKey === 'known-b'));
});

test('an unreadable discovery store retains the previous app identities', async () => {
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('factory'),
    discoveredAccounts: () => { throw new Error('unreadable'); }, fetchLimits: () => assert.fail('no credential')
  });
  const rows = await fetch({ previousLimits: previous('missing-a', 'known-b') }, { env: {} });
  assert.ok(!rows.some(row => row.removed));
});

test('consecutive failures never confirm an unknown rotated credential identity', async () => {
  let status = 'unauthorized';
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('factory'),
    discoveredAccounts: () => [{ values: { factoryApiKey: 'rotated' }, accountKey: 'rotated-key' }],
    fetchLimits: () => ({ provider: 'factory', status, windows: [] })
  });
  let previousLimits = previous('old-key');
  for (status of ['unauthorized', 'unavailable', 'unauthorized']) {
    const rows = await fetch({ previousLimits }, { env: {} });
    assert.ok(!rows.some(row => row.removed && row.accountKey === 'old-key'), status);
    assert.ok(rows.some(row => row.accountKey === 'rotated-key' && row.status === status));
    previousLimits = { providers: [previousLimits.providers.find(row => row.accountKey === 'old-key'), ...rows.filter(row => !row.removed)] };
  }
});

test('a failed known account with retained successful windows does not block another retirement', async () => {
  const fetch = createAccountSlotFetcher({ ...limitProviderEntry('factory'),
    discoveredAccounts: () => [{ values: { factoryApiKey: 'known' }, accountKey: 'known-b' }],
    fetchLimits: () => ({ provider: 'factory', status: 'unavailable', windows: [] })
  });
  const previousLimits = previous('missing-a', 'known-b');
  Object.assign(previousLimits.providers[1], { status: 'unavailable', windows: [{ kind: 'monthly', usedPercent: 10 }] });
  const rows = await fetch({ previousLimits }, { env: {} });
  assert.ok(rows.some(row => row.removed && row.accountKey === 'missing-a'));
});
