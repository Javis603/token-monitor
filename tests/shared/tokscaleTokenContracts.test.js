'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLIENT_CATALOG } = require('../../src/shared/clientCatalog');
const { TOKEN_CONTRACT_CASES, KIMI_NATIVE_TIMING_CONTRACT, KIMI_UNTIMED_CONTRACT_CASES, applicableTokenContracts, assertTokenContract, hermeticEnv } = require('../../scripts/verify-vendored-tokscale');

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

test('the native-only Kimi fixture has no request anchor or default-model shortcut', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-kimi-native-shape-'));
  try {
    KIMI_NATIVE_TIMING_CONTRACT.writeFixture(home);
    const file = path.join(home, '.kimi-code', 'sessions', 'workspace', 'kimi-native-contract', 'agents', 'main', 'wire.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.some(record => record.type === 'llm.request'), false);
    assert.equal(records.filter(record => record.type === 'usage.record').length, 1);
    assert.equal(records.filter(record => record.event?.type === 'step.end').length, 1);
    assert.notEqual(KIMI_NATIVE_TIMING_CONTRACT.expectedRow.model, 'kimi-for-coding');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an inherited Kimi home cannot redirect the binary contract scan', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-kimi-env-'));
  const previous = process.env.KIMI_CODE_HOME;
  try {
    process.env.KIMI_CODE_HOME = path.join(home, 'host-override');
    const env = hermeticEnv(home);
    assert.equal(Object.hasOwn(env, 'KIMI_CODE_HOME'), false);
    assert.equal(env.HOME, home);
    assert.equal(env.USERPROFILE, home);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const contract of KIMI_UNTIMED_CONTRACT_CASES) {
  test(`${contract.expectedSession.id} rejects invented timing while preserving usage`, () => {
    const entry = { client: 'kimi', sessionId: contract.expectedSession.id, ...contract.expectedRow };
    const performance = contract.expectedPerformance;
    assert.doesNotThrow(() => assertTokenContract({ entries: [{ ...entry, performance }] }, contract));
    for (const key of Object.keys(performance)) {
      const invented = { ...performance, [key]: 1 };
      assert.throws(() => assertTokenContract({ entries: [{ ...entry, performance: invented }] }, contract), /timing contract mismatch/);
    }
    assert.throws(() => assertTokenContract({ entries: [{ ...entry, output: 0 }] }, contract), /fixture mismatch/);
  });
}


test('CatPaw nonzero fixtures run only on supported app platforms', () => {
  assert.ok(applicableTokenContracts('darwin').some(({ client }) => client === 'catpaw'));
  assert.ok(applicableTokenContracts('win32').some(({ client }) => client === 'catpaw'));
  assert.ok(!applicableTokenContracts('linux').some(({ client }) => client === 'catpaw'));
  assert.ok(applicableTokenContracts('linux').some(({ client }) => client === 'qodercn'));
});
