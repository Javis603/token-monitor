'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CLIENT_CATALOG } = require('../../src/shared/clientCatalog');
const { TOKEN_CONTRACT_CASES, applicableTokenContracts } = require('../../scripts/verify-vendored-tokscale');

// Existing Tokscale-parsed clients before this gate was introduced. Keep this
// baseline fixed when adding a client: each new id needs a runnable contract
// case in verify-vendored-tokscale.js. Fork-only clients are included: the
// gate runs against the pinned fork build that parses them.
const LEGACY_CLIENT_IDS = new Set(
  'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,amp,droid,kimi,qwen,grok,copilot,pi,omp,zed,kilo,commandcode,mimo,zcode,kiro,codebuddy,workbuddy,reasonix,dsh,cherrystudio,lmstudio,unsloth,devin'.split(',')
);

function missingContracts(clientIds) {
  const covered = new Set(TOKEN_CONTRACT_CASES.map(({ client }) => client));
  return clientIds.filter((id) => !LEGACY_CLIENT_IDS.has(id) && !covered.has(id));
}

test('every newly added Tokscale-parsed client has a runnable token contract fixture', () => {
  const tokScaleClients = CLIENT_CATALOG.map(({ id }) => id);
  const fixtureIds = TOKEN_CONTRACT_CASES.map(({ client }) => client);
  assert.equal(new Set(fixtureIds).size, fixtureIds.length, 'duplicate token contract fixture');
  assert.deepEqual(missingContracts(tokScaleClients), [], 'new Tokscale clients need a binary token contract fixture');
  assert.deepEqual([...LEGACY_CLIENT_IDS].filter((id) => !tokScaleClients.includes(id)), [], 'stale legacy Tokscale client');
  assert.deepEqual(fixtureIds.filter((id) => !tokScaleClients.includes(id)), [], 'fixture for an unregistered client');
  for (const contract of TOKEN_CONTRACT_CASES) {
    assert.equal(typeof contract.writeFixture, 'function', `${contract.client} fixture writer`);
    assert.equal(typeof contract.hasExplicitTotal, 'boolean', `${contract.client} explicit total contract`);
    assert.ok(contract.expectedRow && typeof contract.expectedRow === 'object', `${contract.client} expected binary row`);
    assert.ok(Number.isSafeInteger(contract.expectedPeriod?.totalTokens), `${contract.client} expected total`);
    assert.ok(Number.isSafeInteger(contract.expectedPeriod?.clientOutputTokens), `${contract.client} expected output`);
  }
});

test('the token contract gate rejects an untested future Tokscale client', () => {
  const tokScaleClients = CLIENT_CATALOG.map(({ id }) => id);
  assert.deepEqual(missingContracts([...tokScaleClients, 'future-client']), ['future-client']);
});


test('CatPaw nonzero fixtures run only on supported app platforms', () => {
  assert.ok(applicableTokenContracts('darwin').some(({ client }) => client === 'catpaw'));
  assert.ok(applicableTokenContracts('win32').some(({ client }) => client === 'catpaw'));
  assert.ok(!applicableTokenContracts('linux').some(({ client }) => client === 'catpaw'));
  assert.ok(applicableTokenContracts('linux').some(({ client }) => client === 'qodercn'));
});
