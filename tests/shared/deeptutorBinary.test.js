'use strict';

// Opt-in, offline integration test against a locally built fork. Unlike the
// full release gate it never requests unrelated clients or account roots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  TOKEN_CONTRACT_CASES, writeFixtureHome, runAgainstFixture, assertTokenContract
} = require('../../scripts/verify-vendored-tokscale');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

test('built DeepTutor parser preserves precision and disjoint token buckets through the collector', {
  skip: !process.env.TOKEN_MONITOR_TEST_TOKSCALE
}, () => {
  const bin = process.env.TOKEN_MONITOR_TEST_TOKSCALE;
  const home = writeFixtureHome();
  try {
    for (const contract of TOKEN_CONTRACT_CASES.filter(c => c.client.startsWith('deeptutor'))) {
      const read = () => runAgainstFixture(bin, home, 'client,session,model', contract.client);
      const first = read();
      assertTokenContract(first, contract);
      assert.deepEqual(read().entries, first.entries, 'unchanged ledger must not accumulate calls');
      assert.equal(first.entries[0].cost, 0, 'do not infer an API tariff for OAuth or estimates');
      assert.match(first.entries[0].provider, /^unpriced:/);
    }
    const combined = runAgainstFixture(bin, home, 'client,session,model', 'deeptutor,deeptutor-estimated');
    assert.equal(extractUsageFromTokscale(combined).totalTokens, 300);
    assert.equal(combined.entries.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
