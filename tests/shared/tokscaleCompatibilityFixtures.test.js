'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { DSH_MODEL_CONTRACT_CASES, writeFixtureHome, assertExpected } = require('../../scripts/verify-vendored-tokscale');

test('DSH vendor model gates preserve usage and isolate only the exact response sentinel', () => {
  for (const contract of DSH_MODEL_CONTRACT_CASES) {
    const home = writeFixtureHome(contract);
    try {
      const root = path.join(home, '.dsh', 'sessions', '-tmp-dsh-workspace');
      const session = fs.readdirSync(root)[0];
      const lines = fs.readFileSync(path.join(root, session, 'session.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const turn = lines.find(row => row.type === 'assistant/message');
      assert.deepEqual(turn.data.usage, { inputTokens: 2885, outputTokens: 25, cacheReadTokens: 0, reasoningTokens: 23 });
      assert.equal(turn.data.message.source.replayState.response.responseModel, contract.responseModel);
      assert.equal(turn.data.message.source.model, contract.sourceModel);
      if (contract.headerModel) assert.equal(lines.find(row => row.type === 'request/header').data.header.config.model, contract.headerModel);
      const expected = { client: 'dsh', model: contract.expectedModel, input: 2885, output: 2, reasoning: 23, cacheRead: 0 };
      assert.doesNotThrow(() => assertExpected({ entries: [expected] }, expected));
      assert.throws(() => assertExpected({ entries: [{ ...expected, output: 25 }] }, expected), /fixture mismatch/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  assert.ok(DSH_MODEL_CONTRACT_CASES.some(row => row.sourceModel === 'glm-5.2' && row.expectedModel === 'glm-5.3'));
  assert.ok(DSH_MODEL_CONTRACT_CASES.some(row => row.responseModel === 'keepalive-v2' && row.expectedModel === 'keepalive-v2'));
  assert.ok(DSH_MODEL_CONTRACT_CASES.some(row => row.sourceModel === 'keepalive' && row.expectedModel === 'keepalive'));
});
